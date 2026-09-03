-- Content readiness (Step 1): a project needs 1 brochure + 3 hero images; a unit
-- needs 1 unit-plan. We read the file's single MAIN type (file_vocabularies
-- dimension='primary_category'), the AI-set "what is this file" field.
--
-- Two parts:
--   1. Add `hero_image` as a valid main type. It does not exist today (photos are
--      raw_photo/design); Step 2's enrichment AI assigns it to the best 3 photos
--      per project. Adding it now lets the readiness page show a hero column
--      (0/3 everywhere until Step 2 populates it).
--   2. `mkt_content_readiness()` — one row per marketed project (our_projects →
--      all_projects) with brochure/hero counts (from the project's linked files'
--      primary_category) + total units and units that have a plan
--      (`units.unit_plan` set). Aggregated in SQL so the endpoint never fetches
--      the ~7.3k unit rows. Read-only; the marketing endpoint calls it with the
--      service client after the `read` capability gate.

BEGIN;

-- 1. New main type: hero_image (image-only), placed just after raw_photo (sort 50).
INSERT INTO public.file_vocabularies (dimension, value, label_ar, label_en, applies_to_kinds, sort, active)
SELECT 'primary_category', 'hero_image', 'صورة رئيسية للتسويق', 'Hero image', ARRAY['image']::text[], 55, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.file_vocabularies WHERE dimension = 'primary_category' AND value = 'hero_image'
);

-- 2. Per-project readiness rollup.
CREATE OR REPLACE FUNCTION public.mkt_content_readiness()
RETURNS TABLE (
  project_id      text,
  project_name    text,
  brochure_count  int,
  hero_count      int,
  total_units     int,
  units_with_plan int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ap AS (SELECT id FROM models WHERE name = 'all_projects'),
       u  AS (SELECT id FROM models WHERE name = 'units'),
       op AS (SELECT id FROM models WHERE name = 'our_projects'),
       ours AS (
         SELECT DISTINCT r.data->>'project' AS pid
         FROM records r JOIN op ON r.model_id = op.id
         WHERE coalesce(r.data->>'project', '') <> ''
       ),
       proj AS (
         SELECT r.id::text AS pid, r.data->>'project_name' AS name
         FROM records r JOIN ap ON r.model_id = ap.id
         WHERE r.id::text IN (SELECT pid FROM ours)
       ),
       broch AS (
         SELECT fl.record_id::text AS pid,
                count(DISTINCT f.id) FILTER (WHERE f.primary_category = 'brochure')   AS bc,
                count(DISTINCT f.id) FILTER (WHERE f.primary_category = 'hero_image') AS hc
         FROM file_links fl
         JOIN files f ON f.id = fl.file_id
         JOIN ap ON fl.model_id = ap.id
         GROUP BY fl.record_id::text
       ),
       un AS (
         SELECT r.data->>'project_id' AS pid,
                count(*) AS tu,
                count(*) FILTER (WHERE coalesce(r.data->>'unit_plan', '') <> '') AS wp
         FROM records r JOIN u ON r.model_id = u.id
         WHERE coalesce(r.data->>'project_id', '') <> ''
         GROUP BY r.data->>'project_id'
       )
  SELECT p.pid, p.name,
         coalesce(b.bc, 0)::int, coalesce(b.hc, 0)::int,
         coalesce(un.tu, 0)::int, coalesce(un.wp, 0)::int
  FROM proj p
  LEFT JOIN broch b ON b.pid = p.pid
  LEFT JOIN un    ON un.pid = p.pid
  ORDER BY p.name;
$$;

-- Called only server-side (marketing-os) with the service role after the cap gate.
REVOKE ALL ON FUNCTION public.mkt_content_readiness() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_content_readiness() TO service_role;

COMMIT;
