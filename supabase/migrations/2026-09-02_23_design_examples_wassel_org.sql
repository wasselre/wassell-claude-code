-- ============================================================================
-- Post Creative Director — design examples + Wassel internal org (2026-09-02_23)
--
-- 1. mos_design_examples — human-approved exemplars the creative director
--    boosts in retrieval (approved_wassel) or holds up as study material
--    (study_only). A competitor post can NEVER be an approved example:
--    competitor material is reference-only by policy, so the CHECK forces
--    competitor_post ⇒ study_only.
-- 2. Wassel registered as mkt_organizations(org_type='internal') + its four
--    social accounts, so our own published content flows through the SAME
--    collection/understanding pipeline as competitors and can power design
--    reads + approved examples. collection_enabled is deliberately FALSE:
--    the operator enables collection explicitly (a flag flip per account),
--    never by a migration silently turning on scraping.
-- 3. mkt_content_library v5 — carousel media ordered by carousel_index (was
--    created_at) and internal-org rows excluded from the competitor shelves.
--    Full v4 body (2026-08-31_08) carried forward verbatim apart from those
--    two changes.
--
-- Additive + idempotent.
-- ============================================================================

BEGIN;

-- ── 1. mos_design_examples ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mos_design_examples (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind        text NOT NULL CHECK (subject_kind IN ('wassel_content','wassel_file','competitor_post')),
  subject_id          uuid NOT NULL,      -- mos_content/files id (wassel) or mkt_content_posts.id (competitor)
  example_kind        text NOT NULL CHECK (example_kind IN ('approved_wassel','study_only')),
  strengths           text[] NOT NULL DEFAULT '{}',
  caveats             text[] NOT NULL DEFAULT '{}',
  note                text,
  approved_by_user_id uuid NOT NULL,
  approved_at         timestamptz NOT NULL DEFAULT now(),
  retired_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_kind, subject_id),
  -- Competitor material is reference-only by policy — it can be studied,
  -- never approved as a Wassel example.
  CONSTRAINT mos_design_examples_competitor_study_chk
    CHECK (subject_kind <> 'competitor_post' OR example_kind = 'study_only')
);

ALTER TABLE public.mos_design_examples ENABLE ROW LEVEL SECURITY;
-- No policies by design: reads/writes go through the API (service client after
-- requireCap 'approve_creative') — same posture as the other mos_creative_* tables.

-- ── 2. Wassel internal org + accounts ───────────────────────────────────────
-- Guarded on name_en (the stable identity the brief fixes), NOT org_type —
-- a second internal org with a different name must not block this insert.
INSERT INTO public.mkt_organizations (org_type, name_ar, name_en, website, status)
SELECT 'internal', 'وصل العقارية', 'Wassel Real Estate', 'https://wassel.re', 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM public.mkt_organizations WHERE name_en = 'Wassel Real Estate'
);

-- The four handles from mos_platform_accounts. The unique key on the table is
-- an expression unique INDEX (platform, lower(handle)) — not a named constraint
-- — so ON CONFLICT cannot target it portably; a NOT EXISTS anti-join is the
-- idempotent guard. collection_enabled = FALSE on purpose (see header).
INSERT INTO public.mkt_social_accounts
  (organization_id, platform, handle, profile_url, provider, is_active, collection_enabled)
SELECT o.id, x.platform, x.handle, x.profile_url, 'apify', true, false
  FROM public.mkt_organizations o
  CROSS JOIN (VALUES
    ('instagram', 'wassel.re',  'https://www.instagram.com/wassel.re'),
    ('tiktok',    'wasselre',   'https://www.tiktok.com/@wasselre'),
    ('snapchat',  'wasselre',   'https://www.snapchat.com/add/wasselre'),
    ('x',         '@wassel_sa', 'https://x.com/wassel_sa')
  ) AS x(platform, handle, profile_url)
 WHERE o.name_en = 'Wassel Real Estate'
   AND o.org_type = 'internal'
   AND NOT EXISTS (
     SELECT 1 FROM public.mkt_social_accounts sa
      WHERE sa.platform = x.platform AND lower(sa.handle) = lower(x.handle)
   );

-- ── 3. mkt_content_library v5 ───────────────────────────────────────────────
-- v4 (2026-08-31_08) + two changes:
--   a. the media array is ordered by m.carousel_index (carousel slide order —
--      the creative surfaces need the real slide sequence, not insert order);
--   b. org_type='internal' posts are EXCLUDED from the competitor shelves
--      (Wassel's own content is not competition; it reaches the creative
--      system through mkt_creative_references with p_include_wassel).
CREATE OR REPLACE FUNCTION public.mkt_content_library(
  p_shelf     text    DEFAULT NULL,
  p_org       uuid    DEFAULT NULL,
  p_format    text    DEFAULT NULL,
  p_platform  text    DEFAULT NULL,
  p_has_offer boolean DEFAULT NULL,
  p_q         text    DEFAULT NULL,
  p_limit     int     DEFAULT 40,
  p_offset    int     DEFAULT 0
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
WITH base AS (
  SELECT
    p.id, p.platform, p.post_type, p.caption, p.engagement, p.published_at,
    p.post_url, p.duration_ms, p.organization_id,
    o.name_ar                                   AS org_name,
    o.developer_record_id                       AS developer_record_id,
    e.primary_project_id,
    e.result                                    AS r,
    (e.result->>'content_type')                 AS content_type
  FROM public.mkt_content_posts p
  JOIN public.mkt_organizations o        ON o.id = p.organization_id
  JOIN public.mkt_content_enrichment e   ON e.content_post_id = p.id AND e.status = 'done'
  WHERE o.org_type <> 'internal'   -- v5(b): Wassel's own posts are not competitor shelves
),
filt AS (
  SELECT * FROM base
  WHERE (p_org      IS NULL OR organization_id = p_org)
    AND (p_format   IS NULL OR post_type = p_format)
    AND (p_platform IS NULL OR platform = p_platform)
    AND (p_has_offer IS NULL OR (p_has_offer = ((COALESCE(r->>'offer','') <> '') OR content_type = 'offer')))
    AND (p_q IS NULL OR p_q = '' OR (
          caption               ILIKE '%'||p_q||'%'
       OR (r->>'campaign_message') ILIKE '%'||p_q||'%'
       OR (r->>'objective')        ILIKE '%'||p_q||'%'
    ))
),
shelved AS (
  SELECT * FROM filt WHERE (p_shelf IS NULL OR content_type = p_shelf)
),
page AS (
  SELECT jsonb_agg(to_jsonb(x)) AS rows FROM (
    SELECT
      s.id, s.org_name, s.organization_id, s.developer_record_id, s.platform,
      s.primary_project_id::text                      AS project_record_id,
      s.post_type                                     AS format,
      s.content_type                                  AS shelf,
      COALESCE(NULLIF(s.r->>'campaign_message',''), LEFT(s.caption, 180)) AS summary,
      LEFT(s.caption, 500)                            AS caption,
      (s.r->'selling_points')                         AS selling_points,
      (s.r->'unit_types')                             AS unit_types,
      (s.r->'amenities')                              AS amenities,
      (s.r->'ctas')                                   AS ctas,
      NULLIF(s.r->>'offer','')                        AS offer,
      NULLIF(s.r->>'price','')                        AS price,
      NULLIF(s.r->>'payment_plan','')                 AS payment_plan,
      NULLIF(s.r->>'district','')                     AS district,
      s.engagement, s.published_at, s.post_url,
      (s.duration_ms IS NOT NULL AND s.duration_ms > 0) AS is_video,
      EXISTS (SELECT 1 FROM public.mkt_transcripts t
               WHERE t.content_post_id = s.id AND t.status = 'done') AS has_transcript,
      (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name', ur.data->>'title')
         FROM public.unified_records ur
        WHERE ur.id = s.primary_project_id)          AS project_name,
      (SELECT m.stored_url FROM public.mkt_content_media m
         WHERE m.content_post_id = s.id AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
         ORDER BY (m.media_kind = 'thumbnail') DESC, (m.media_kind = 'image') DESC, m.created_at
         LIMIT 1)                                     AS thumb_url,
      -- v5(a): carousel order = carousel_index (was created_at)
      (SELECT jsonb_agg(jsonb_build_object('kind', m.media_kind, 'url', m.stored_url)
                        ORDER BY m.carousel_index)
         FROM public.mkt_content_media m
        WHERE m.content_post_id = s.id AND m.download_status = 'stored'
          AND m.stored_url IS NOT NULL
          AND m.media_kind IN ('image', 'video')) AS media
    FROM shelved s
    ORDER BY s.published_at DESC NULLS LAST, s.id
    LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0)
  ) x
),
shelves AS (
  SELECT jsonb_object_agg(content_type, c) AS obj FROM (
    SELECT COALESCE(content_type, 'unknown') AS content_type, count(*) AS c
    FROM filt GROUP BY 1
  ) f
)
SELECT jsonb_build_object(
  'total',   (SELECT count(*) FROM shelved),
  'shelves', COALESCE((SELECT obj FROM shelves), '{}'::jsonb),
  'rows',    COALESCE((SELECT rows FROM page), '[]'::jsonb)
);
$$;

COMMIT;
