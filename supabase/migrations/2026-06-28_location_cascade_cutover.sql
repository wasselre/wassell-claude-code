-- ============================================================================
-- Location cascade cutover (2026-06-28)
--
-- Replaces every scattered district/city/region field across the platform with
-- ONE `location` cascade field (region → city → district). The five cutover
-- models are UNFROZEN (JSONB in `records`): all_projects, clients,
-- market_listings, real_estate_offices, units. The GEOGRAPHY models the cascade
-- points at are FROZEN physical tables: regions / cities / districts.
--   regions   d15a0001-0000-4000-8000-000000000001  (display name_ar)
--   cities    d15a0001-0000-4000-8000-000000000002  (display display_name)
--   districts d9a9db7e-b602-470c-b81b-5d6ff17048e9  (display display_name)
--
-- Value shape:
--   single (projects/listings/offices) → {region:id, city:id, district:id}
--   multi  (clients)                   → {region:[id], city:[id], district:[id]}
--
-- Per model: backfill `location`, add the `location` field to the schema, remove
-- the old geography fields from the schema. For all_projects/clients/
-- market_listings the backfill is a reliable copy of the record's own lookup
-- ids, so the old keys are also stripped from records.data. real_estate_offices
-- holds free TEXT geography (district stored without the "حي " prefix the
-- frozen table uses) — it's matched best-effort (normalized name + city) and its
-- raw text is KEPT for the rows that don't resolve (no silent loss).
--
-- SAFETY: fully transactional + per-model row/models backups. The matcher +
-- website reader cutover (app code) must deploy together with this migration.
-- ============================================================================

BEGIN;

-- ── 0. Backups (re-runnable) ─────────────────────────────────────────────────
DROP TABLE IF EXISTS public._backup_models_location_20260628;
CREATE TABLE public._backup_models_location_20260628 AS
  SELECT * FROM public.models
  WHERE name IN ('all_projects','clients','units','market_listings','real_estate_offices','marketing_operations','targeted_projects');

DROP TABLE IF EXISTS public._backup_records_location_20260628;
CREATE TABLE public._backup_records_location_20260628 AS
  SELECT * FROM public.records
  WHERE model_id IN (
    '220c49b9-de57-492d-9eca-c0d9f54fd40f', -- all_projects
    '2e86f197-385f-4853-908f-b4cb7237f7d8', -- clients
    '8f06bc39-4bee-42e9-9fab-77023fb89ede', -- market_listings
    '62256164-281b-4f1f-85a8-a3dac40b9ae9'  -- real_estate_offices
  );

-- ── 1. Helper functions (dropped at the end) ─────────────────────────────────
CREATE OR REPLACE FUNCTION public._loc_levels() RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_build_array(
    jsonb_build_object('key','region','model_id','d15a0001-0000-4000-8000-000000000001','display_field','name_ar'),
    jsonb_build_object('key','city','model_id','d15a0001-0000-4000-8000-000000000002','display_field','display_name','parent_link_field','region_lookup'),
    jsonb_build_object('key','district','model_id','d9a9db7e-b602-470c-b81b-5d6ff17048e9','display_field','display_name','parent_link_field','city_lookup')
  );
$fn$;

CREATE OR REPLACE FUNCTION public._loc_remove_fields(p_schema jsonb, p_names text[]) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_set(p_schema, '{sections}', (
    SELECT jsonb_agg(
      jsonb_set(sec, '{fields}', COALESCE((
        SELECT jsonb_agg(f) FROM jsonb_array_elements(sec->'fields') f
        WHERE NOT ((f->>'name') = ANY(p_names))
      ), '[]'::jsonb))
    )
    FROM jsonb_array_elements(p_schema->'sections') sec
  ));
$fn$;

CREATE OR REPLACE FUNCTION public._loc_add_location(p_schema jsonb, p_multi boolean) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_set(p_schema, '{sections,0,fields}',
    (p_schema->'sections'->0->'fields') || jsonb_build_object(
      'id', gen_random_uuid()::text,
      'name', 'location',
      'label_ar', 'الموقع',
      'label_en', 'Location',
      'type', 'location',
      'required', false,
      'order', 50,
      'section_id', (p_schema->'sections'->0->>'id'),
      'width', 'full',
      'show_in_table', true,
      'location_multi', p_multi,
      'location_levels', public._loc_levels()
    ));
$fn$;

CREATE OR REPLACE FUNCTION public._loc_patch_field(p_schema jsonb, p_field_id text, p_patch jsonb) RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT jsonb_set(p_schema, '{sections}', (
    SELECT jsonb_agg(
      jsonb_set(sec, '{fields}', (
        SELECT jsonb_agg(CASE WHEN (f->>'id') = p_field_id THEN f || p_patch ELSE f END)
        FROM jsonb_array_elements(sec->'fields') f
      ))
    )
    FROM jsonb_array_elements(p_schema->'sections') sec
  ));
$fn$;

-- Normalize an Arabic place name: trim, drop a leading "حي " / "مدينة " / "منطقة ".
CREATE OR REPLACE FUNCTION public._loc_norm(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT NULLIF(trim(regexp_replace(coalesce(p,''), '^\s*(حي|مدينة|منطقة)\s+', '')), '');
$fn$;

-- ── 2. all_projects (single) — copy own lookups, strip old keys ──────────────
UPDATE public.records r SET data =
  (r.data - 'region_lookup' - 'city_lookup' - 'district_lookup' - 'district_name'
          - 'district_match_status' - 'district_migration_notes' - 'preferred_city' - 'preferred_neighborhoods')
  || jsonb_build_object('location', jsonb_strip_nulls(jsonb_build_object(
       'region',   NULLIF(r.data->'region_lookup',   'null'::jsonb),
       'city',     NULLIF(r.data->'city_lookup',     'null'::jsonb),
       'district', NULLIF(r.data->'district_lookup', 'null'::jsonb)
     )))
WHERE r.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
  AND r.data ?| array['region_lookup','city_lookup','district_lookup','district_name','district_match_status','district_migration_notes','preferred_city','preferred_neighborhoods'];

UPDATE public.models SET schema = public._loc_add_location(
  public._loc_remove_fields(schema, ARRAY['region_lookup','city_lookup','district_lookup','district_name','district_match_status','district_migration_notes','preferred_city','preferred_neighborhoods','location']),
  false
) WHERE name = 'all_projects';

-- ── 3. clients (multi) — region/district from the arrays, city derived from ──
-- each chosen district's parent (frozen districts table), strip old keys.
UPDATE public.records r SET data =
  (r.data - 'preferred_regions' - 'preferred_districts' - 'preferred_city' - 'preferred_neighborhoods'
          - 'preferred_district_migration_status' - 'preferred_district_migration_notes')
  || jsonb_build_object('location', jsonb_strip_nulls(jsonb_build_object(
       'region',
         CASE WHEN jsonb_typeof(r.data->'preferred_regions') = 'array' AND jsonb_array_length(r.data->'preferred_regions') > 0
              THEN r.data->'preferred_regions' END,
       'district',
         CASE WHEN jsonb_typeof(r.data->'preferred_districts') = 'array' AND jsonb_array_length(r.data->'preferred_districts') > 0
              THEN r.data->'preferred_districts' END,
       'city',
         (SELECT CASE WHEN count(DISTINCT d.city_lookup) > 0 THEN jsonb_agg(DISTINCT d.city_lookup) END
          FROM jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(r.data->'preferred_districts') = 'array' THEN r.data->'preferred_districts' ELSE '[]'::jsonb END
               ) pd
          JOIN public.districts d ON d.id::text = pd
          WHERE NULLIF(d.city_lookup, '') IS NOT NULL)
     )))
WHERE r.model_id = '2e86f197-385f-4853-908f-b4cb7237f7d8'
  AND r.data ?| array['preferred_regions','preferred_districts','preferred_city','preferred_neighborhoods','preferred_district_migration_status','preferred_district_migration_notes'];

UPDATE public.models SET schema = public._loc_add_location(
  public._loc_remove_fields(schema, ARRAY['preferred_regions','preferred_districts','preferred_city','preferred_neighborhoods','preferred_district_migration_status','preferred_district_migration_notes','location']),
  true
) WHERE name = 'clients';

-- ── 4. market_listings (single, ~46k) — copy own lookups, strip old keys ─────
UPDATE public.records r SET data =
  (r.data - 'region_lookup' - 'city_lookup' - 'district_lookup' - 'city' - 'district' - 'region')
  || jsonb_build_object('location', jsonb_strip_nulls(jsonb_build_object(
       'region',   NULLIF(r.data->'region_lookup',   'null'::jsonb),
       'city',     NULLIF(r.data->'city_lookup',     'null'::jsonb),
       'district', NULLIF(r.data->'district_lookup', 'null'::jsonb)
     )))
WHERE r.model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede'
  AND r.data ?| array['region_lookup','city_lookup','district_lookup','city','district','region'];

UPDATE public.models SET schema = public._loc_add_location(
  public._loc_remove_fields(schema, ARRAY['region_lookup','city_lookup','district_lookup','city','district','region','location']),
  false
) WHERE name = 'market_listings';

-- Swap the AREA-pre-filter indexes onto the new `location` path (the old
-- district_lookup/city_lookup keys are stripped, so their indexes are dead).
DROP INDEX IF EXISTS public.idx_records_market_district_lookup;
DROP INDEX IF EXISTS public.idx_records_market_city_lookup;
CREATE INDEX IF NOT EXISTS idx_records_market_loc_district
  ON public.records (((data->'location'->>'district'))) WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';
CREATE INDEX IF NOT EXISTS idx_records_market_loc_city
  ON public.records (((data->'location'->>'city'))) WHERE model_id = '8f06bc39-4bee-42e9-9fab-77023fb89ede';

-- ── 5. real_estate_offices (single, free-text → best-effort frozen match) ────
-- Match the office's district by NORMALIZED name (drop "حي " prefix) AND city
-- (so the same district name in two cities resolves correctly). Rows that don't
-- resolve keep their raw text (NOT stripped) for a later fuzzy pass. Resolved
-- rows DO get their raw text stripped.
UPDATE public.records r SET data =
  (r.data - 'city' - 'district' - 'region') || jsonb_build_object('location', loc.location)
FROM LATERAL (
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'district', d.id::text,
    'city',     NULLIF(d.city_lookup,   ''),
    'region',   NULLIF(d.region_lookup, '')
  )) AS location
  FROM public.districts d
  WHERE public._loc_norm(d.name_ar) = public._loc_norm(r.data->>'district')
    AND public._loc_norm(d.city_name_ar) IS NOT DISTINCT FROM public._loc_norm(r.data->>'city')
  ORDER BY d.id
  LIMIT 1
) loc
WHERE r.model_id = '62256164-281b-4f1f-85a8-a3dac40b9ae9'
  AND r.data ? 'district'
  AND loc.location IS NOT NULL AND loc.location <> '{}'::jsonb;

UPDATE public.models SET schema = public._loc_add_location(
  public._loc_remove_fields(schema, ARRAY['city','district','region','location']),
  false
) WHERE name = 'real_estate_offices';

DO $$
DECLARE n_total int; n_loc int;
BEGIN
  SELECT count(*) INTO n_total FROM public.records WHERE model_id='62256164-281b-4f1f-85a8-a3dac40b9ae9';
  SELECT count(*) INTO n_loc   FROM public.records WHERE model_id='62256164-281b-4f1f-85a8-a3dac40b9ae9' AND (data->'location') IS NOT NULL;
  RAISE NOTICE 'real_estate_offices: % of % rows resolved to a location (rest keep raw text for a later fuzzy pass)', n_loc, n_total;
END $$;

-- ── 6. units (inherit from project — no cascade) ─────────────────────────────
-- Drop the unit's own city/district; repurpose the project_district_lookup
-- mirror into a single project_location mirror of the project's new `location`;
-- delete the redundant project_district_name mirror.
UPDATE public.models SET schema = public._loc_remove_fields(
  public._loc_patch_field(
    schema,
    'd15a0002-un00-4000-8000-000000000001',
    jsonb_build_object('name','project_location','label_ar','موقع المشروع','label_en','Project location','mirror_target_field_name','location')
  ),
  ARRAY['city','district','project_district_name']
) WHERE name = 'units';

-- ── 7. marketing_operations (repoint mirrors at the project's location) ──────
UPDATE public.models SET schema = public._loc_remove_fields(
  public._loc_patch_field(
    schema,
    'f1000000-0000-4000-9000-000000000005', -- mirror_city
    jsonb_build_object('name','mirror_location','label_ar','الموقع','label_en','Location','mirror_target_field_name','location')
  ),
  ARRAY['mirror_district']
) WHERE name = 'marketing_operations';

-- targeted_projects.dfghjkl mirrors project_location (the maps URL, untouched) — no change.

-- ── 8. Cleanup helpers ───────────────────────────────────────────────────────
DROP FUNCTION public._loc_add_location(jsonb, boolean);
DROP FUNCTION public._loc_remove_fields(jsonb, text[]);
DROP FUNCTION public._loc_patch_field(jsonb, text, jsonb);
DROP FUNCTION public._loc_levels();
DROP FUNCTION public._loc_norm(text);

COMMIT;
