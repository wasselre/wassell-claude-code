-- ============================================================================
-- Post Creative Director — files visual signals, rights view, asset RPCs
-- (2026-09-02_24)
--
-- 1. New AI/derived visual-signal columns on files: dominant_colors, has_text,
--    headline_space, ocr_text, visual_meta_version. All nullable — a file with
--    none set is still valid; the asset-meta/enrich lanes (A-ASSETS) fill them
--    and stamp visual_meta_version='enrich-v2'.
-- 2. files_rights_v — per-file rights trust resolved from the LATEST
--    file_metadata_provenance row for field_path='usage_rights':
--      human_approved / human_modified → verified
--      ai_suggested                    → NOT verified (human must confirm)
--      no provenance row               → 'unknown', NOT verified
--    security_invoker so the caller's files RLS still applies.
-- 3. creative_candidate_assets — the creative director's ranked project-image
--    picker (contracts §6): rights-verified approved/use_after_edit first,
--    then developer/internal source, raw production state, real/CGI nature,
--    recency. restricted/do_not_use are NEVER returned.
-- 4. creative_asset_backfill_targets — the backfill controller's work list:
--    'meta' (missing deterministic dims/colours) and 'enrich' (not yet
--    enrich-v2), project-linked images only.
--
-- Additive + idempotent. `files` is a physical registry table (no unified_
-- records / frozen-view chain to unwind).
-- ============================================================================

BEGIN;

-- ── 1. files columns ────────────────────────────────────────────────────────
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS dominant_colors     jsonb,   -- [{hex, share}] from the meta lane
  ADD COLUMN IF NOT EXISTS has_text            boolean,
  ADD COLUMN IF NOT EXISTS headline_space      text,    -- where a headline could sit
  ADD COLUMN IF NOT EXISTS ocr_text            text,
  ADD COLUMN IF NOT EXISTS visual_meta_version text;    -- e.g. 'enrich-v2'; NULL = never enriched

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_headline_space_chk') THEN
    ALTER TABLE public.files ADD CONSTRAINT files_headline_space_chk
      CHECK (headline_space IN ('none','top','bottom','left','right','center'));
  END IF;
END $c$;

COMMENT ON COLUMN public.files.dominant_colors     IS 'AI/derived palette [{hex, share}]. Filled by the asset-meta lane.';
COMMENT ON COLUMN public.files.has_text            IS 'The image carries meaningful rendered text.';
COMMENT ON COLUMN public.files.headline_space      IS 'Where a headline could be overlaid (none|top|bottom|left|right|center).';
COMMENT ON COLUMN public.files.ocr_text            IS 'OCR of rendered text on the image.';
COMMENT ON COLUMN public.files.visual_meta_version IS 'Version tag of the last visual enrichment pass (enrich-v2 …). NULL = never enriched.';

-- ── 2. files_rights_v ───────────────────────────────────────────────────────
-- security_invoker: the view must not become a definer-rights bypass around
-- files RLS. Rights trust comes from the LATEST provenance decision on the
-- usage_rights field; absence of a decision is 'unknown' (never "verified").
CREATE OR REPLACE VIEW public.files_rights_v
WITH (security_invoker = true) AS
SELECT f.id AS file_id,
       f.usage_rights,
       COALESCE(p.state, 'unknown') AS rights_provenance,
       (p.state IN ('human_approved','human_modified')) AS rights_verified,
       p.decided_by,
       p.decided_at
  FROM public.files f
  LEFT JOIN LATERAL (
    SELECT pr.state, pr.decided_by, pr.decided_at
      FROM public.file_metadata_provenance pr
     WHERE pr.file_id = f.id AND pr.field_path = 'usage_rights'
     ORDER BY pr.decided_at DESC
     LIMIT 1
  ) p ON true;

REVOKE ALL ON public.files_rights_v FROM PUBLIC, anon;
GRANT SELECT ON public.files_rights_v TO authenticated, service_role;

-- ── 3. creative_candidate_assets ────────────────────────────────────────────
-- Project images (file_links → the all_projects model) with rights trust.
-- restricted/do_not_use are excluded outright — they are never selectable for
-- production (contract rule 9). Ranking: verified-and-usable rights →
-- developer/internal source → raw → real/CGI → recency.
CREATE OR REPLACE FUNCTION public.creative_candidate_assets(
  p_project_id uuid,
  p_limit      int DEFAULT 40
) RETURNS TABLE(
  file_id uuid, original_name text, primary_category text, document_type text,
  link_role text, asset_nature text, acquisition_source text, usage_rights text,
  rights_provenance text, rights_verified boolean, production_state text,
  aspect_ratio text, width_px int, height_px int, ai_description text,
  tags text[], subjects text[], dominant_colors jsonb, has_text boolean,
  headline_space text, storage_bucket text, storage_path text, created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
WITH linked AS (
  -- A file can reach the project through more than one role; keep one row per
  -- file, preferring a specific role over the role-neutral 'attachment'.
  SELECT DISTINCT ON (l.file_id)
         l.file_id, l.role AS link_role
    FROM public.file_links l
    JOIN public.models m ON m.id = l.model_id
   WHERE m.name = 'all_projects'
     AND l.record_id = p_project_id
   ORDER BY l.file_id, (l.role = 'attachment'), l.role
)
SELECT f.id, f.original_name, f.primary_category, f.document_type,
       linked.link_role, f.asset_nature, f.acquisition_source, f.usage_rights,
       rv.rights_provenance, COALESCE(rv.rights_verified, false) AS rights_verified,
       f.production_state, f.aspect_ratio, f.width_px, f.height_px, f.ai_description,
       f.tags,
       (SELECT COALESCE(array_agg(s.subject), '{}'::text[])
          FROM public.file_subjects s WHERE s.file_id = f.id) AS subjects,
       f.dominant_colors, f.has_text, f.headline_space,
       f.storage_bucket, f.storage_path, f.created_at
  FROM linked
  JOIN public.files f ON f.id = linked.file_id
  LEFT JOIN public.files_rights_v rv ON rv.file_id = f.id
 WHERE f.kind = 'image'
   AND f.archived_at IS NULL
   AND (f.usage_rights IS NULL OR f.usage_rights NOT IN ('restricted','do_not_use'))
 ORDER BY
   (COALESCE(rv.rights_verified, false) AND f.usage_rights IN ('approved','use_after_edit')) DESC,
   (f.acquisition_source IN ('developer','internal')) DESC,
   (f.production_state = 'raw') DESC,
   (f.asset_nature IN ('real','cgi_render')) DESC,
   f.created_at DESC
 LIMIT GREATEST(COALESCE(p_limit, 40), 0);
$$;

-- ── 4. creative_asset_backfill_targets ──────────────────────────────────────
-- 'meta':   project-linked images missing deterministic meta (dims/colours).
-- 'enrich': project-linked images not yet at enrich-v2 — projects with an
--           ACTIVE campaign first, then verified rights, then recency.
CREATE OR REPLACE FUNCTION public.creative_asset_backfill_targets(
  p_kind  text,
  p_limit int DEFAULT 50
) RETURNS TABLE(file_id uuid, storage_bucket text, storage_path text, mime_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
WITH linked AS (
  SELECT l.file_id, l.record_id AS project_id
    FROM public.file_links l
    JOIN public.models m ON m.id = l.model_id
   WHERE m.name = 'all_projects'
   GROUP BY l.file_id, l.record_id
),
per_file AS (
  -- One row per file even when it reaches several projects; the active-
  -- campaign boost fires when ANY linked project has an active campaign.
  SELECT l.file_id,
         bool_or(EXISTS (
           SELECT 1 FROM public.mos_campaigns c,
                         jsonb_array_elements_text(c.project_ids) pid
            WHERE c.status = 'active'
              AND pid = l.project_id::text)) AS has_active_campaign
    FROM linked l
   GROUP BY l.file_id
)
SELECT f.id, f.storage_bucket, f.storage_path, f.mime_type
  FROM per_file
  JOIN public.files f ON f.id = per_file.file_id
  LEFT JOIN public.files_rights_v rv ON rv.file_id = f.id
 WHERE f.kind = 'image'
   AND f.archived_at IS NULL
   AND (
     (p_kind = 'meta'   AND (f.width_px IS NULL OR f.dominant_colors IS NULL))
     OR
     (p_kind = 'enrich' AND f.visual_meta_version IS DISTINCT FROM 'enrich-v2')
   )
 ORDER BY
   CASE WHEN p_kind = 'enrich' THEN per_file.has_active_campaign END DESC NULLS LAST,
   CASE WHEN p_kind = 'enrich' THEN COALESCE(rv.rights_verified, false) END DESC NULLS LAST,
   f.created_at DESC
 LIMIT GREATEST(COALESCE(p_limit, 50), 0);
$$;

REVOKE ALL ON FUNCTION public.creative_candidate_assets(uuid, int)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.creative_asset_backfill_targets(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.creative_candidate_assets(uuid, int)  TO service_role;
GRANT EXECUTE ON FUNCTION public.creative_asset_backfill_targets(text, int) TO service_role;

COMMIT;
