-- ============================================================================
-- Post Creative Director — visual design reads + retrieval (2026-09-02_22)
--
-- visual_design_reads is the store for the visual-intelligence layer: one row
-- per (subject, level, model_used, rule_version) holding the structured design
-- read of a competitor/Wassel static post or slide, plus a nullable SigLIP-2
-- image embedding (768-d) for intent-similarity retrieval.
--
-- Three RPCs:
--   visual_design_read_upsert   — idempotent write from the design-read lanes
--   creative_design_read_targets— the backfill controller's "what's missing"
--                                 selector, tiered per contracts §9
--   mkt_creative_references     — ranked reference retrieval for the creative
--                                 director (contracts §6)
--
-- RLS enabled with NO policies: lanes and the API use service_role only.
-- Additive + idempotent. `vector` extension is already installed (guarded).
-- ============================================================================

BEGIN;

-- mkt_creative_references' body references mos_design_examples (created in _23);
-- skip body validation so 22→23 ordering is CI-safe (the table exists at call time).
SET LOCAL check_function_bodies = off;

CREATE EXTENSION IF NOT EXISTS vector;

-- ── table ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.visual_design_reads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind    text NOT NULL
                  CHECK (subject_kind IN ('competitor_media','competitor_post','wassel_file','wassel_content')),
  subject_id      uuid NOT NULL,        -- media id (slide) | post id (post) — internal org = Wassel
  level           text NOT NULL CHECK (level IN ('slide','post')),
  post_id         uuid,                 -- the owning mkt_content_posts.id (also set for slide reads)
  slide_index     int,                  -- carousel_index for slide reads
  organization_id uuid,
  model_task      text NOT NULL,        -- 'design_read_slide' | 'design_read_post'
  model_used      text NOT NULL,        -- resolved model id, or 'runner:<skill>' for the subscription lane
  rule_version    text NOT NULL,        -- prompt/validator version constant per module
  read            jsonb NOT NULL,       -- SlideRead | PostRead (contracts.ts)
  confidence      numeric,
  cost_usd        numeric,
  raw             jsonb,
  embedding       vector(768),          -- SigLIP-2 image embedding of the slide (nullable)
  status          text NOT NULL DEFAULT 'done' CHECK (status IN ('done','failed')),
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Generated columns for ranking/intent matching. Slide reads fill layout/
  -- density/palette_family/slide_role; post reads fill format/branding_intensity.
  -- Keys that a read shape does not carry are simply NULL (never an error).
  layout_family       text GENERATED ALWAYS AS (read->>'layout') STORED,
  density             text GENERATED ALWAYS AS (read->>'density') STORED,
  branding_intensity  int  GENERATED ALWAYS AS (
    CASE WHEN (read->>'branding_intensity') ~ '^[0-9]+$'
         THEN (read->>'branding_intensity')::int END) STORED,
  palette_family      text GENERATED ALWAYS AS (read->>'palette_family') STORED,
  format              text GENERATED ALWAYS AS (read->>'format') STORED,
  slide_role          text GENERATED ALWAYS AS (read->>'slide_role') STORED,
  UNIQUE (subject_kind, subject_id, level, model_used, rule_version)
);

CREATE INDEX IF NOT EXISTS visual_design_reads_subject_post_idx
  ON public.visual_design_reads (subject_kind, level, post_id);
-- Lookup shape used by mkt_creative_references' LATERAL joins (latest read per
-- post / per slide subject).
CREATE INDEX IF NOT EXISTS visual_design_reads_level_post_idx
  ON public.visual_design_reads (level, post_id);
CREATE INDEX IF NOT EXISTS visual_design_reads_level_subject_idx
  ON public.visual_design_reads (level, subject_id);
-- ANN over slide embeddings (cosine), only where an embedding exists.
CREATE INDEX IF NOT EXISTS visual_design_reads_embedding_hnsw
  ON public.visual_design_reads USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

ALTER TABLE public.visual_design_reads ENABLE ROW LEVEL SECURITY;
-- No policies by design.

-- ── upsert (design-read lanes) ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.visual_design_read_upsert(
  p_subject_kind    text,
  p_subject_id      uuid,
  p_level           text,
  p_post_id         uuid,
  p_slide_index     int,
  p_organization_id uuid,
  p_model_task      text,
  p_model_used      text,
  p_rule_version    text,
  p_read            jsonb,
  p_confidence      numeric,
  p_cost_usd        numeric,
  p_raw             jsonb,
  p_status          text,
  p_failure         text,
  p_embedding       vector(768) DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.visual_design_reads AS t (
    subject_kind, subject_id, level, post_id, slide_index, organization_id,
    model_task, model_used, rule_version, read, confidence, cost_usd, raw,
    embedding, status, failure_reason)
  VALUES (
    p_subject_kind, p_subject_id, p_level, p_post_id, p_slide_index, p_organization_id,
    p_model_task, p_model_used, p_rule_version, COALESCE(p_read, '{}'::jsonb),
    p_confidence, p_cost_usd, p_raw, p_embedding, COALESCE(p_status, 'done'), p_failure)
  ON CONFLICT (subject_kind, subject_id, level, model_used, rule_version) DO UPDATE SET
    read           = EXCLUDED.read,
    confidence     = EXCLUDED.confidence,
    cost_usd       = EXCLUDED.cost_usd,
    raw            = EXCLUDED.raw,
    embedding      = EXCLUDED.embedding,
    status         = EXCLUDED.status,
    failure_reason = EXCLUDED.failure_reason
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ── backfill targets (contracts §9 tiers) ───────────────────────────────────
-- Returns subjects of ONE tier that lack a read for (level, model_used,
-- rule_version). Tiers (competitor statics — post_type image|carousel, image
-- media stored, internal org excluded):
--   1 = project-attributed AND not general branding
--   2 = not general branding AND published within 12 months
--   3 = carousels
--   4 = all remaining competitor statics
--   5 = internal-org (Wassel) statics — subject_kind 'wassel_content' (post
--       level, subject_id = post id) / 'wassel_file' (slide level, subject_id =
--       media id); the lane maps those onto its own subject vocabulary.
-- p_subject_kind filters to one kind (NULL = all kinds of the level).
CREATE OR REPLACE FUNCTION public.creative_design_read_targets(
  p_subject_kind text,
  p_level        text,
  p_rule_version text,
  p_model_used   text,
  p_tier         int,
  p_limit        int
) RETURNS TABLE(subject_kind text, subject_id uuid, post_id uuid, slide_index int,
                organization_id uuid, stored_url text, post_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
WITH base AS (
  SELECT p.id AS post_id, p.organization_id, p.post_type, p.published_at,
         o.org_type, e.primary_project_id,
         (e.result->>'is_general_branding')::boolean AS is_general_branding
    FROM public.mkt_content_posts p
    JOIN public.mkt_organizations o      ON o.id = p.organization_id
    LEFT JOIN public.mkt_content_enrichment e
           ON e.content_post_id = p.id AND e.status = 'done'
   WHERE p.post_type IN ('image','carousel')
),
tiered AS (
  SELECT b.*,
         CASE
           WHEN b.org_type = 'internal' THEN 5
           WHEN b.primary_project_id IS NOT NULL
                AND b.is_general_branding IS DISTINCT FROM true THEN 1
           WHEN b.is_general_branding IS DISTINCT FROM true
                AND b.published_at > now() - interval '12 months' THEN 2
           WHEN b.post_type = 'carousel' THEN 3
           ELSE 4
         END AS tier
    FROM base b
),
cand AS (
  -- slide level: one row per stored image media
  SELECT (CASE WHEN t.org_type = 'internal' THEN 'wassel_file' ELSE 'competitor_media' END) AS subject_kind,
         m.id            AS subject_id,
         t.post_id,
         m.carousel_index AS slide_index,
         t.organization_id,
         m.stored_url,
         t.post_type,
         t.tier,
         t.published_at
    FROM tiered t
    JOIN public.mkt_content_media m
      ON m.content_post_id = t.post_id
     AND m.media_kind = 'image'
     AND m.download_status = 'stored'
     AND m.stored_url IS NOT NULL
   WHERE p_level = 'slide'
  UNION ALL
  -- post level: one row per post (must have at least one stored image)
  SELECT (CASE WHEN t.org_type = 'internal' THEN 'wassel_content' ELSE 'competitor_post' END),
         t.post_id,
         t.post_id,
         NULL::int,
         t.organization_id,
         (SELECT m.stored_url FROM public.mkt_content_media m
           WHERE m.content_post_id = t.post_id
             AND m.media_kind = 'image'
             AND m.download_status = 'stored'
             AND m.stored_url IS NOT NULL
           ORDER BY m.carousel_index
           LIMIT 1),
         t.post_type,
         t.tier,
         t.published_at
    FROM tiered t
   WHERE p_level = 'post'
     AND EXISTS (SELECT 1 FROM public.mkt_content_media m
                  WHERE m.content_post_id = t.post_id
                    AND m.media_kind = 'image'
                    AND m.download_status = 'stored'
                    AND m.stored_url IS NOT NULL)
)
SELECT c.subject_kind, c.subject_id, c.post_id, c.slide_index,
       c.organization_id, c.stored_url, c.post_type
  FROM cand c
 WHERE c.tier = p_tier
   AND (p_subject_kind IS NULL OR c.subject_kind = p_subject_kind)
   AND NOT EXISTS (
         SELECT 1 FROM public.visual_design_reads v
          WHERE v.subject_kind = c.subject_kind
            AND v.subject_id   = c.subject_id
            AND v.level        = p_level
            AND v.model_used   = p_model_used
            AND v.rule_version = p_rule_version)
 ORDER BY c.published_at DESC NULLS LAST, c.subject_id
 LIMIT GREATEST(p_limit, 0);
$$;

-- ── reference retrieval (contracts §6) ──────────────────────────────────────
-- Ranked competitor + (optionally) Wassel static posts/slides for the creative
-- director. Scoring (all in SQL):
--   +3  purpose match (enrichment content_type ∈ p_purpose)
--   +2  district match (enrichment district ILIKE p_district)
--   +1  unit-type overlap (enrichment unit_types ∩ p_unit_types)
--   +1  recency (< 12 months)
--   −5  general branding when 'brand' ∉ p_purpose
--   +2 per matched intent key (format, layout, density, branding_intensity,
--       palette_family) against the post's latest post-level design read
--   +3 × cosine similarity to p_qvec (slide embedding; post = best slide)
--   +2  approved Wassel design example (only when p_include_wassel)
-- Tie-breaker: engagement likes; ≤ 2 candidates per organization (diversity).
-- p_project_id does not score (the brief's criteria have no project term); a
-- confident attribution to it is reported in why.project_match.
CREATE OR REPLACE FUNCTION public.mkt_creative_references(
  p_project_id     uuid,
  p_district       text,
  p_unit_types     text[],
  p_purpose        text[],
  p_intent         jsonb,
  p_include_wassel boolean,
  p_qvec           vector(768),
  p_limit          int
) RETURNS TABLE(ref_kind text, ref_id uuid, post_id uuid, slide_index int, level text,
                preview_url text, org_name text, platform text, published_at timestamptz,
                post_url text, score numeric, why jsonb, read jsonb)
-- pgvector's <=> operator lives in the `extensions` schema — the search_path
-- must include it (same as the sibling mkt_script_exemplars).
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $$
WITH posts AS (
  SELECT p.id, p.organization_id, p.platform, p.post_type, p.published_at, p.post_url,
         p.engagement, o.org_type,
         COALESCE(o.name_ar, o.name_en) AS org_name,
         e.result AS r, e.primary_project_id
    FROM public.mkt_content_posts p
    JOIN public.mkt_organizations o ON o.id = p.organization_id
    LEFT JOIN public.mkt_content_enrichment e
           ON e.content_post_id = p.id AND e.status = 'done'
   WHERE p.post_type IN ('image','carousel')
     AND (COALESCE(p_include_wassel, false) OR o.org_type <> 'internal')
),
cand AS (
  -- post-level candidates
  SELECT (CASE WHEN org_type = 'internal' THEN 'wassel_content' ELSE 'competitor_post' END) AS ref_kind,
         id AS ref_id, id AS post_id, NULL::int AS slide_index, 'post'::text AS level,
         (SELECT m.stored_url FROM public.mkt_content_media m
           WHERE m.content_post_id = posts.id
             AND m.media_kind = 'image'
             AND m.download_status = 'stored'
             AND m.stored_url IS NOT NULL
           ORDER BY m.carousel_index
           LIMIT 1) AS preview_url,
         org_name, platform, published_at, post_url, organization_id, r, primary_project_id,
         public.try_numeric(engagement->>'likes') AS likes
    FROM posts
   WHERE EXISTS (SELECT 1 FROM public.mkt_content_media m
                  WHERE m.content_post_id = posts.id
                    AND m.media_kind = 'image'
                    AND m.download_status = 'stored'
                    AND m.stored_url IS NOT NULL)
  UNION ALL
  -- slide-level candidates
  SELECT (CASE WHEN org_type = 'internal' THEN 'wassel_file' ELSE 'competitor_media' END),
         m.id, posts.id, m.carousel_index, 'slide',
         m.stored_url, org_name, platform, published_at, post_url, organization_id, r,
         primary_project_id,
         public.try_numeric(engagement->>'likes')
    FROM posts
    JOIN public.mkt_content_media m
      ON m.content_post_id = posts.id
     AND m.media_kind = 'image'
     AND m.download_status = 'stored'
     AND m.stored_url IS NOT NULL
),
joined AS (
  SELECT c.*,
         rp.read  AS post_read,
         rp.format AS dr_format, rp.layout_family AS dr_layout, rp.density AS dr_density,
         rp.branding_intensity AS dr_branding, rp.palette_family AS dr_palette,
         rs.read  AS slide_read,
         -- cosine similarity: the slide's own embedding; for a post candidate,
         -- the best across its slides. NULL when p_qvec or embeddings absent.
         CASE WHEN p_qvec IS NULL THEN NULL
              WHEN c.level = 'slide' THEN
                (SELECT 1 - (v.embedding <=> p_qvec)
                   FROM public.visual_design_reads v
                  WHERE v.level = 'slide' AND v.subject_id = c.ref_id
                    AND v.embedding IS NOT NULL
                  ORDER BY v.created_at DESC LIMIT 1)
              ELSE
                (SELECT max(1 - (v.embedding <=> p_qvec))
                   FROM public.visual_design_reads v
                  WHERE v.level = 'slide' AND v.post_id = c.post_id
                    AND v.embedding IS NOT NULL)
         END AS cosine_sim,
         (COALESCE(p_include_wassel, false) AND EXISTS (
            SELECT 1 FROM public.mos_design_examples d
             WHERE d.example_kind = 'approved_wassel' AND d.retired_at IS NULL
               AND d.subject_kind = c.ref_kind AND d.subject_id = c.ref_id)) AS is_approved_example
    FROM cand c
    LEFT JOIN LATERAL (
      SELECT v.format, v.layout_family, v.density, v.branding_intensity, v.palette_family, v.read
        FROM public.visual_design_reads v
       WHERE v.level = 'post' AND v.post_id = c.post_id AND v.status = 'done'
       ORDER BY v.created_at DESC LIMIT 1
    ) rp ON true
    LEFT JOIN LATERAL (
      SELECT v.read
        FROM public.visual_design_reads v
       WHERE v.level = 'slide' AND v.subject_id = c.ref_id AND v.status = 'done'
       ORDER BY v.created_at DESC LIMIT 1
    ) rs ON c.level = 'slide'
),
scored AS (
  SELECT j.*,
         (CASE WHEN p_purpose IS NOT NULL AND r->>'content_type' = ANY(p_purpose) THEN 3 ELSE 0 END)
       + (CASE WHEN p_district IS NOT NULL AND p_district <> ''
                AND COALESCE(r->>'district','') ILIKE '%'||p_district||'%' THEN 2 ELSE 0 END)
       + (CASE WHEN p_unit_types IS NOT NULL AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(COALESCE(r->'unit_types','[]'::jsonb)) u
                 WHERE u = ANY(p_unit_types)) THEN 1 ELSE 0 END)
       + (CASE WHEN published_at > now() - interval '12 months' THEN 1 ELSE 0 END)
       - (CASE WHEN (r->>'is_general_branding')::boolean IS TRUE
                AND NOT ('brand' = ANY(COALESCE(p_purpose, '{}'::text[]))) THEN 5 ELSE 0 END)
       + 2 * (
           (CASE WHEN p_intent->>'format'             IS NOT NULL AND dr_format   = p_intent->>'format'             THEN 1 ELSE 0 END)
         + (CASE WHEN p_intent->>'layout'             IS NOT NULL AND dr_layout   = p_intent->>'layout'             THEN 1 ELSE 0 END)
         + (CASE WHEN p_intent->>'density'            IS NOT NULL AND dr_density  = p_intent->>'density'            THEN 1 ELSE 0 END)
         + (CASE WHEN p_intent->>'branding_intensity' IS NOT NULL AND dr_branding::text = p_intent->>'branding_intensity' THEN 1 ELSE 0 END)
         + (CASE WHEN p_intent->>'palette_family'     IS NOT NULL AND dr_palette  = p_intent->>'palette_family'     THEN 1 ELSE 0 END))
       + COALESCE(3 * cosine_sim, 0)
       + (CASE WHEN is_approved_example THEN 2 ELSE 0 END)
         AS score,
         jsonb_strip_nulls(jsonb_build_object(
           'purpose',     CASE WHEN p_purpose IS NOT NULL AND r->>'content_type' = ANY(p_purpose)
                               THEN r->>'content_type' END,
           'district',    CASE WHEN p_district IS NOT NULL AND p_district <> ''
                               AND COALESCE(r->>'district','') ILIKE '%'||p_district||'%'
                               THEN r->>'district' END,
           'unit_types',  (SELECT jsonb_agg(u) FROM jsonb_array_elements_text(COALESCE(r->'unit_types','[]'::jsonb)) u
                            WHERE p_unit_types IS NOT NULL AND u = ANY(p_unit_types)),
           'recent',      CASE WHEN published_at > now() - interval '12 months' THEN true END,
           'general_branding_penalty',
                          CASE WHEN (r->>'is_general_branding')::boolean IS TRUE
                                AND NOT ('brand' = ANY(COALESCE(p_purpose, '{}'::text[]))) THEN true END,
           'intent_matches',
                          (SELECT jsonb_agg(m.k) FROM (VALUES
                              ('format',             p_intent->>'format'             IS NOT NULL AND dr_format   = p_intent->>'format'),
                              ('layout',             p_intent->>'layout'             IS NOT NULL AND dr_layout   = p_intent->>'layout'),
                              ('density',            p_intent->>'density'            IS NOT NULL AND dr_density  = p_intent->>'density'),
                              ('branding_intensity', p_intent->>'branding_intensity' IS NOT NULL AND dr_branding::text = p_intent->>'branding_intensity'),
                              ('palette_family',     p_intent->>'palette_family'     IS NOT NULL AND dr_palette  = p_intent->>'palette_family')
                            ) m(k, ok) WHERE m.ok),
           'cosine',      CASE WHEN cosine_sim IS NOT NULL THEN round(cosine_sim::numeric, 4) END,
           'approved_example', CASE WHEN is_approved_example THEN true END,
           'project_match',    CASE WHEN p_project_id IS NOT NULL AND primary_project_id = p_project_id THEN true END
         )) AS why
    FROM joined j
),
ranked AS (
  SELECT s.*,
         row_number() OVER (
           PARTITION BY s.organization_id
           ORDER BY s.score DESC, s.likes DESC NULLS LAST, s.published_at DESC NULLS LAST, s.ref_id
         ) AS org_rank
    FROM scored s
)
SELECT r.ref_kind, r.ref_id, r.post_id, r.slide_index, r.level,
       r.preview_url, r.org_name, r.platform, r.published_at, r.post_url,
       r.score, r.why,
       COALESCE(r.slide_read, r.post_read) AS read
  FROM ranked r
 WHERE r.org_rank <= 2
 ORDER BY r.score DESC, r.likes DESC NULLS LAST, r.published_at DESC NULLS LAST, r.ref_id
 LIMIT GREATEST(COALESCE(p_limit, 20), 0);
$$;

REVOKE ALL ON FUNCTION public.visual_design_read_upsert(text, uuid, text, uuid, int, uuid, text, text, text, jsonb, numeric, numeric, jsonb, text, text, vector) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.creative_design_read_targets(text, text, text, text, int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mkt_creative_references(uuid, text, text[], text[], jsonb, boolean, vector, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.visual_design_read_upsert(text, uuid, text, uuid, int, uuid, text, text, text, jsonb, numeric, numeric, jsonb, text, text, vector) TO service_role;
GRANT EXECUTE ON FUNCTION public.creative_design_read_targets(text, text, text, text, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_creative_references(uuid, text, text[], text[], jsonb, boolean, vector, int) TO service_role;

COMMIT;
