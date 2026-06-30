-- One-time backfill: seed client_property_options from the existing client
-- preference selections so historical "preferred" projects/units/listings show
-- up in the new unified Client Options view (the model launched empty; it only
-- fills going forward from Project Finder otherwise).
--
-- Source → option mapping (status 'suitable', added_from 'manual'):
--   clients.data.preferred_projects[]        → source_type 'project'        (→ all_projects)
--   clients.data.preferred_units[]           → source_type 'unit'           (→ units)
--   clients.data.preferred_market_listings[] → source_type 'market_listing' (→ market_listings)
--
-- Each option snapshots source_name (and, for projects, the display facts
-- price/area/bed/bath/availability/unit_types/city) so the card renders without
-- re-resolving the source. created_by is set to the CLIENT's owner so the owning
-- rep keeps visibility under per-profile scope. Tagged match_run_id=
-- 'preference_backfill_2026-06-30' for identification + rollback. Idempotent via
-- the (client_id, source_type, source_id) NOT EXISTS guard.
--
-- The clients.preferred_* fields are NOT modified — they remain the preference
-- INPUTS. Applied live to wassell-prod 2026-06-30 (263 options / 251 clients).
--
-- Rollback:
--   DELETE FROM public.records
--   WHERE model_id = (SELECT id FROM public.models WHERE name='client_property_options')
--     AND data->>'match_run_id' = 'preference_backfill_2026-06-30';

WITH cpo AS (SELECT id FROM public.models WHERE name='client_property_options'),
clients AS (
  SELECT r.id AS client_id, r.created_by_user_id, r.data
  FROM public.records r JOIN public.models m ON m.id=r.model_id WHERE m.name='clients'
),
refs AS (
  SELECT c.client_id, c.created_by_user_id, 'project'::text AS source_type, e.value #>> '{}' AS source_id
  FROM clients c, jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'preferred_projects')='array' THEN c.data->'preferred_projects' ELSE '[]'::jsonb END) e
  UNION ALL
  SELECT c.client_id, c.created_by_user_id, 'unit', e.value #>> '{}'
  FROM clients c, jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'preferred_units')='array' THEN c.data->'preferred_units' ELSE '[]'::jsonb END) e
  UNION ALL
  SELECT c.client_id, c.created_by_user_id, 'market_listing', e.value #>> '{}'
  FROM clients c, jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'preferred_market_listings')='array' THEN c.data->'preferred_market_listings' ELSE '[]'::jsonb END) e
),
distinct_refs AS (
  SELECT DISTINCT client_id, created_by_user_id, source_type, source_id FROM refs WHERE source_id IS NOT NULL AND source_id <> ''
),
resolved AS (
  SELECT dr.*, sr.data AS src_data,
    CASE dr.source_type
      WHEN 'project' THEN sr.data->>'project_name'
      WHEN 'unit' THEN sr.data->>'unit_name'
      WHEN 'market_listing' THEN sr.data->>'title'
    END AS source_name
  FROM distinct_refs dr
  LEFT JOIN public.records sr ON sr.id = dr.source_id::uuid
)
INSERT INTO public.records (id, model_id, data, created_by_user_id, created_at, updated_at)
SELECT
  gen_random_uuid(),
  (SELECT id FROM cpo),
  jsonb_strip_nulls(jsonb_build_object(
    'client_id', r.client_id::text,
    'source_type', r.source_type,
    'source_id', r.source_id,
    'source_name', COALESCE(r.source_name,''),
    'status', 'suitable',
    'is_main', false,
    'match_score', NULL,
    'match_run_id', 'preference_backfill_2026-06-30',
    'priority_rank', NULL,
    'added_from', 'manual',
    'added_by', NULL,
    'sales_notes', '',
    'elimination_notes', '',
    'facts', CASE WHEN r.source_type='project' AND r.src_data IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
        'city', CASE WHEN jsonb_typeof(r.src_data->'city_name')='string' THEN r.src_data->>'city_name'
                     WHEN jsonb_typeof(r.src_data->'project_location')='string' THEN r.src_data->>'project_location' ELSE NULL END,
        'unit_types', r.src_data->'unit_types',
        'price_range', r.src_data->'price_range',
        'area_range', r.src_data->'area_range',
        'bedroom_range', r.src_data->'bedroom_range',
        'bathroom_range', r.src_data->'bathroom_range',
        'available_units', r.src_data->'available_units'
      )) ELSE NULL END
  )),
  r.created_by_user_id,
  now(), now()
FROM resolved r
WHERE NOT EXISTS (
  SELECT 1 FROM public.records x
  WHERE x.model_id = (SELECT id FROM cpo)
    AND x.data->>'client_id' = r.client_id::text
    AND x.data->>'source_type' = r.source_type
    AND x.data->>'source_id' = r.source_id
);
