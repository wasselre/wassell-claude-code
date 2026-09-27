-- ============================================================================
-- Move the last values out of the legacy client preference fields (2026-09-27)
-- ============================================================================
-- Operator: "Are preferred projects and units different from client options?
-- Are the city, neighborhoods and direction different from the location field?"
-- They are not — each has a current home:
--   preferred_projects / preferred_units / preferred_market_listings
--       → client_property_options (Client Options) — copied there 2026-06-30;
--   preferred_city / preferred_neighborhoods / preferred_country
--       → the `location` cascade + `location_items` (what the Finder reads);
--   preferred_direction
--       → location_items district rules for the city's CURATED zone
--         (Settings → City Zones), the same resolution the geography card uses.
--
-- Measured before this migration (dry runs in the session):
--   project refs 228, already in Client Options 224, dangling 1  → add 3
--   unit / listing refs all already in Client Options             → add 0
--   preferred_city: 25 × «الرياض», every one already in location.city → nothing
--   preferred_country: 4 × «السعودية»                               → nothing
--   neighbourhoods: 2 missing from location → added as district items;
--                   2 match no Riyadh district → kept in preference_notes
--   direction: 13 clients with no district → curated-zone district items;
--              19 clients WITH districts → kept in preference_notes (adding a
--              whole zone would widen a customer who named specific districts)
--
-- This migration only MOVES values. It does not remove the fields from the
-- schema or strip keys from records.data — the schema removal ships after the
-- code that still reads them is switched over (2026-09-27_04).
-- Idempotent: every add checks presence, every note checks its marker.
-- Machine write: wassell.system_write set so the translation capture trigger
-- does not re-enqueue these clients.
-- ============================================================================
SET check_function_bodies = off;
BEGIN;

SELECT set_config('wassell.system_write', 'legacy_prefs_cleanup', true);

-- ── 0. Backup (re-runnable) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public._backup_clients_legacy_prefs_20260927 AS
SELECT r.id AS client_id, r.data AS data_before, now() AS backed_up_at
FROM public.records r JOIN public.models m ON m.id = r.model_id
WHERE m.name = 'clients'
  AND (r.data ?| array['preferred_projects','preferred_units','preferred_market_listings',
                       'preferred_city','preferred_neighborhoods','preferred_direction','preferred_country']);
REVOKE ALL ON public._backup_clients_legacy_prefs_20260927 FROM anon, authenticated;

-- ── 1. Projects / units / listings not yet in Client Options ────────────────
WITH cpo AS (SELECT id FROM public.models WHERE name = 'client_property_options'),
clients AS (
  SELECT r.id AS client_id, r.created_by_user_id, r.data
  FROM public.records r JOIN public.models m ON m.id = r.model_id WHERE m.name = 'clients'
),
refs AS (
  SELECT c.client_id, c.created_by_user_id, 'project'::text AS source_type, e.value #>> '{}' AS source_id
  FROM clients c, jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'preferred_projects')='array' THEN c.data->'preferred_projects' ELSE '[]'::jsonb END) e
  UNION ALL
  SELECT c.client_id, c.created_by_user_id, 'unit', e.value #>> '{}'
  FROM clients c, jsonb_array_elements(CASE WHEN jsonb_typeof(c.data->'preferred_units')='array' THEN c.data->'preferred_units' ELSE '[]'::jsonb END) e
),
d AS (
  SELECT DISTINCT client_id, created_by_user_id, source_type, source_id FROM refs
  WHERE source_id ~ '^[0-9a-f-]{36}$'
),
resolved AS (
  SELECT d.*, sr.data AS src_data,
         CASE d.source_type WHEN 'project' THEN sr.data->>'project_name' ELSE sr.data->>'unit_name' END AS source_name
  FROM d JOIN public.records sr ON sr.id = d.source_id::uuid   -- inner join: a deleted source is skipped (it stays in the backup)
)
INSERT INTO public.records (id, model_id, data, created_by_user_id, created_at, updated_at)
SELECT gen_random_uuid(), (SELECT id FROM cpo),
  jsonb_strip_nulls(jsonb_build_object(
    'client_id', r.client_id::text, 'source_type', r.source_type, 'source_id', r.source_id,
    'source_name', COALESCE(r.source_name, ''), 'status', 'suitable', 'is_main', false,
    'match_run_id', 'legacy_prefs_cleanup_2026-09-27', 'added_from', 'manual',
    'sales_notes', '', 'elimination_notes', '',
    'facts', CASE WHEN r.source_type = 'project' THEN jsonb_strip_nulls(jsonb_build_object(
        'city', CASE WHEN jsonb_typeof(r.src_data->'city_name')='string' THEN r.src_data->>'city_name' ELSE NULL END,
        'unit_types', r.src_data->'unit_types', 'price_range', r.src_data->'price_range',
        'area_range', r.src_data->'area_range', 'bedroom_range', r.src_data->'bedroom_range',
        'bathroom_range', r.src_data->'bathroom_range', 'available_units', r.src_data->'available_units'
      )) ELSE NULL END
  )),
  r.created_by_user_id, now(), now()
FROM resolved r
WHERE NOT EXISTS (
  SELECT 1 FROM public.records x
  WHERE x.model_id = (SELECT id FROM cpo)
    AND x.data->>'client_id' = r.client_id::text
    AND x.data->>'source_type' = r.source_type
    AND x.data->>'source_id' = r.source_id
);

-- ── 2. Neighbourhoods → location_items district rules ──────────────────────
-- A name resolves when exactly ONE active Riyadh district has the same key
-- (fold أإآ/ة/ى, drop «حي » and the article) — the resolver's placeKey rule.
CREATE TEMP TABLE _legacy_geo ON COMMIT DROP AS
WITH c AS (
  SELECT r.id, r.data FROM public.records r JOIN public.models m ON m.id = r.model_id WHERE m.name = 'clients'
),
norm AS (
  SELECT d.id, COALESCE(d.name_ar, d.display_name) AS name,
         regexp_replace(translate(regexp_replace(COALESCE(d.name_ar, ''), '^\s*حي\s+', ''), 'أإآةى', 'اااهي'), '^ال', '') AS k
  FROM public.districts d WHERE d.is_active AND d.city_name_ar = 'الرياض'
),
nb AS (
  SELECT c.id AS client_id, v.value AS name,
         regexp_replace(translate(regexp_replace(v.value, '^\s*حي\s+', ''), 'أإآةى', 'اااهي'), '^ال', '') AS k
  FROM c, jsonb_array_elements_text(CASE jsonb_typeof(c.data->'preferred_neighborhoods') WHEN 'array' THEN c.data->'preferred_neighborhoods' ELSE '[]'::jsonb END) v
)
SELECT nb.client_id, nb.name,
       (SELECT CASE WHEN count(*) = 1 THEN min(n.id::text) END FROM norm n WHERE n.k = nb.k) AS district_id,
       (SELECT min(n.name) FROM norm n WHERE n.k = nb.k) AS district_name
FROM nb;

WITH present AS (
  SELECT r.id AS client_id,
    COALESCE((SELECT array_agg(i->>'district_id') FROM jsonb_array_elements(CASE jsonb_typeof(r.data->'location_items') WHEN 'array' THEN r.data->'location_items' ELSE '[]'::jsonb END) i WHERE i->>'kind' = 'district'), '{}') AS item_ids,
    COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(CASE jsonb_typeof(r.data->'location'->'district') WHEN 'array' THEN r.data->'location'->'district' ELSE '[]'::jsonb END) x), '{}') AS cascade_ids
  FROM public.records r WHERE r.id IN (SELECT client_id FROM _legacy_geo)
),
adds AS (
  SELECT g.client_id,
         jsonb_agg(jsonb_build_object('id', gen_random_uuid()::text, 'kind', 'district', 'polarity', 'include',
                                      'district_id', g.district_id, 'district_label', g.district_name)) AS items
  FROM _legacy_geo g JOIN present p ON p.client_id = g.client_id
  WHERE g.district_id IS NOT NULL
    AND NOT (g.district_id = ANY(p.item_ids)) AND NOT (g.district_id = ANY(p.cascade_ids))
  GROUP BY g.client_id
)
UPDATE public.records r
SET data = r.data || jsonb_build_object('location_items',
      (CASE jsonb_typeof(r.data->'location_items') WHEN 'array' THEN r.data->'location_items' ELSE '[]'::jsonb END) || a.items)
FROM adds a WHERE r.id = a.client_id;

-- ── 3. Direction → curated-zone district rules (clients with NO districts) ──
WITH c AS (
  SELECT r.id, r.data FROM public.records r JOIN public.models m ON m.id = r.model_id WHERE m.name = 'clients'
),
dirs AS (
  SELECT c.id AS client_id, v.value AS dir,
    CASE v.value WHEN 'شمال' THEN 'north' WHEN 'جنوب' THEN 'south' WHEN 'شرق' THEN 'east' WHEN 'غرب' THEN 'west'
                 WHEN 'شمال شرق' THEN 'northeast' WHEN 'شمال غرب' THEN 'northwest'
                 WHEN 'جنوب شرق' THEN 'southeast' WHEN 'جنوب غرب' THEN 'southwest' END AS zone,
    COALESCE((SELECT d.city_id FROM public.districts d
              WHERE d.city_lookup::text = (c.data->'location'->'city'->>0) LIMIT 1), '3') AS city_code,   -- '3' = الرياض
    (jsonb_array_length(CASE jsonb_typeof(c.data->'location_items') WHEN 'array' THEN c.data->'location_items' ELSE '[]'::jsonb END) = 0
     AND jsonb_array_length(CASE jsonb_typeof(c.data->'location'->'district') WHEN 'array' THEN c.data->'location'->'district' ELSE '[]'::jsonb END) = 0) AS no_districts
  FROM c, jsonb_array_elements_text(CASE jsonb_typeof(c.data->'preferred_direction') WHEN 'array' THEN c.data->'preferred_direction' ELSE '[]'::jsonb END) v
),
zone_items AS (
  SELECT dz.client_id,
         jsonb_agg(DISTINCT jsonb_build_object('kind', 'district', 'polarity', 'include',
                                               'district_id', z.district_id::text, 'district_label', z.district_name)) AS items
  FROM dirs dz, LATERAL public.wassell_city_zone_districts(dz.city_code, dz.zone) z
  WHERE dz.no_districts AND dz.zone IS NOT NULL
  GROUP BY dz.client_id
)
UPDATE public.records r
SET data = r.data || jsonb_build_object('location_items',
      (SELECT jsonb_agg(i || jsonb_build_object('id', gen_random_uuid()::text)) FROM jsonb_array_elements(z.items) i))
FROM zone_items z
WHERE r.id = z.client_id
  AND jsonb_array_length(CASE jsonb_typeof(r.data->'location_items') WHEN 'array' THEN r.data->'location_items' ELSE '[]'::jsonb END) = 0;

-- ── 4. What could not be placed → preference_notes (never dropped) ──────────
WITH c AS (
  SELECT r.id, r.data FROM public.records r JOIN public.models m ON m.id = r.model_id WHERE m.name = 'clients'
),
note_parts AS (
  SELECT g.client_id, 'الأحياء (غير مطابقة): ' || string_agg(DISTINCT g.name, '، ') AS part
  FROM _legacy_geo g WHERE g.district_id IS NULL GROUP BY g.client_id
  UNION ALL
  SELECT c.id, 'الاتجاه المفضل: ' || string_agg(DISTINCT v.value, '، ')
  FROM c, jsonb_array_elements_text(CASE jsonb_typeof(c.data->'preferred_direction') WHEN 'array' THEN c.data->'preferred_direction' ELSE '[]'::jsonb END) v
  -- Always kept as text too: the zone rules (step 3) are what the Finder uses,
  -- the note is what the rep wrote, so the original wording is never lost.
  GROUP BY c.id
),
notes AS (
  SELECT client_id, '[من الحقول القديمة، ٢٧ سبتمبر] ' || string_agg(part, ' — ') AS line
  FROM note_parts GROUP BY client_id
)
UPDATE public.records r
SET data = r.data || jsonb_build_object('preference_notes',
      CASE WHEN COALESCE(r.data->>'preference_notes', '') = '' THEN n.line
           ELSE (r.data->>'preference_notes') || E'\n' || n.line END)
FROM notes n
WHERE r.id = n.client_id
  AND position('[من الحقول القديمة، ٢٧ سبتمبر]' in COALESCE(r.data->>'preference_notes', '')) = 0;

COMMIT;
