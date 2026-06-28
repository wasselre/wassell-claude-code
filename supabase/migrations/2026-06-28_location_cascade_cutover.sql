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

-- Coerce a legacy multiselect/text value to a jsonb array (string → 1-elem array).
CREATE OR REPLACE FUNCTION public._loc_arr(x jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE WHEN jsonb_typeof(x)='array' THEN x WHEN jsonb_typeof(x)='string' THEN jsonb_build_array(x #>> '{}') ELSE '[]'::jsonb END;
$fn$;

-- ── 2. all_projects (single) — relational lookups first, else name-match the
-- legacy preferred_city / preferred_neighborhoods dropdowns (string or first array
-- elem) to the frozen geography. city/region fall back to the matched district's
-- parents. Legacy text is KEPT (backup); the relational lookups are stripped.
-- Correlated subquery in SET (an UPDATE...FROM LATERAL can't reference the target r).
UPDATE public.records r SET data =
  (r.data - 'region_lookup' - 'city_lookup' - 'district_lookup' - 'district_name'
          - 'district_match_status' - 'district_migration_notes')
  || jsonb_build_object('location', (
    SELECT jsonb_strip_nulls(jsonb_build_object('region', c.rid, 'city', b.cid, 'district', a.did))
    FROM (SELECT COALESCE(NULLIF(r.data->>'district_lookup',''),
            -- Relational district_lookup is multi-city + authoritative (kept as-is). Only the
            -- legacy free-text fallback is scoped to الرياض (all legacy project text is الرياض).
            (SELECT d.id::text FROM public.districts d WHERE public._loc_norm(d.name_ar)=public._loc_norm(COALESCE(r.data->>'preferred_neighborhoods', r.data->'preferred_neighborhoods'->>0)) AND d.city_lookup='44254a38-ce40-938f-17b7-55814a44e45c' LIMIT 1)) AS did) a,
         LATERAL (SELECT COALESCE(NULLIF(r.data->>'city_lookup',''),
            (SELECT NULLIF(d.city_lookup,'') FROM public.districts d WHERE d.id::text=a.did LIMIT 1),
            (SELECT ci.id::text FROM public.cities ci WHERE public._loc_norm(ci.name_ar)=public._loc_norm(COALESCE(r.data->>'preferred_city', r.data->'preferred_city'->>0)) OR public._loc_norm(ci.display_name)=public._loc_norm(COALESCE(r.data->>'preferred_city', r.data->'preferred_city'->>0)) LIMIT 1)) AS cid) b,
         LATERAL (SELECT COALESCE(NULLIF(r.data->>'region_lookup',''),
            (SELECT NULLIF(d.region_lookup,'') FROM public.districts d WHERE d.id::text=a.did LIMIT 1),
            (SELECT NULLIF(ci.region_lookup,'') FROM public.cities ci WHERE ci.id::text=b.cid LIMIT 1)) AS rid) c
  ))
WHERE r.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
  AND r.data ?| array['region_lookup','city_lookup','district_lookup','district_name','district_match_status','district_migration_notes','preferred_city','preferred_neighborhoods'];

UPDATE public.models SET schema = public._loc_add_location(
  public._loc_remove_fields(schema, ARRAY['region_lookup','city_lookup','district_lookup','district_name','district_match_status','district_migration_notes','preferred_city','preferred_neighborhoods','location']),
  false
) WHERE name = 'all_projects';

-- ── 3. clients (multi) — region/city/district from BOTH the relational arrays AND
-- the legacy text multiselects (preferred_city / preferred_neighborhoods), the
-- latter name-matched (normalized, "حي " / "مدينة " prefix dropped) to the frozen
-- geography tables so no client loses its area. region/city are also derived from
-- each chosen district's parents. The legacy TEXT is KEPT (not stripped) as a
-- backup for any rare unmatched name; the fully-captured relational arrays are
-- stripped. Verified: all 34 geography-having clients resolve to a non-empty location.
UPDATE public.records r SET data =
  (r.data - 'preferred_regions' - 'preferred_districts'
          - 'preferred_district_migration_status' - 'preferred_district_migration_notes')
  || jsonb_build_object('location', (
    WITH dist AS (
      SELECT did FROM jsonb_array_elements_text(public._loc_arr(r.data->'preferred_districts')) did
      UNION SELECT d.id::text FROM jsonb_array_elements_text(public._loc_arr(r.data->'preferred_neighborhoods')) nb
        -- All legacy free-text client geography in this dataset is الرياض; scope the
        -- name-match to الرياض city so a common district name (الياسمين/النرجس/…) doesn't
        -- match the same-named district in every other city and explode the array.
        JOIN public.districts d ON public._loc_norm(d.name_ar) = public._loc_norm(nb) AND d.city_lookup = '44254a38-ce40-938f-17b7-55814a44e45c'
    ), cityids AS (
      SELECT d.city_lookup AS cid FROM dist JOIN public.districts d ON d.id::text = dist.did WHERE NULLIF(d.city_lookup, '') IS NOT NULL
      UNION SELECT ci.id::text FROM jsonb_array_elements_text(public._loc_arr(r.data->'preferred_city')) pc
        JOIN public.cities ci ON public._loc_norm(ci.name_ar) = public._loc_norm(pc) OR public._loc_norm(ci.display_name) = public._loc_norm(pc)
    ), regionids AS (
      SELECT rr FROM jsonb_array_elements_text(public._loc_arr(r.data->'preferred_regions')) rr
      UNION SELECT d.region_lookup FROM dist JOIN public.districts d ON d.id::text = dist.did WHERE NULLIF(d.region_lookup, '') IS NOT NULL
      UNION SELECT ci.region_lookup FROM cityids JOIN public.cities ci ON ci.id::text = cityids.cid WHERE NULLIF(ci.region_lookup, '') IS NOT NULL
    )
    SELECT jsonb_strip_nulls(jsonb_build_object(
      'region',   (SELECT CASE WHEN count(*) > 0 THEN jsonb_agg(DISTINCT rr)  END FROM regionids WHERE rr  IS NOT NULL),
      'city',     (SELECT CASE WHEN count(*) > 0 THEN jsonb_agg(DISTINCT cid) END FROM cityids   WHERE cid IS NOT NULL),
      'district', (SELECT CASE WHEN count(*) > 0 THEN jsonb_agg(DISTINCT did) END FROM dist      WHERE did IS NOT NULL)))
  ))
WHERE r.model_id = '2e86f197-385f-4853-908f-b4cb7237f7d8'
  AND (jsonb_typeof(r.data->'preferred_regions') = 'array' OR jsonb_typeof(r.data->'preferred_districts') = 'array'
    OR coalesce(r.data->>'preferred_city', '') <> '' OR jsonb_typeof(r.data->'preferred_city') = 'array'
    OR coalesce(r.data->>'preferred_neighborhoods', '') <> '' OR jsonb_typeof(r.data->'preferred_neighborhoods') = 'array');

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
  (r.data - 'city' - 'district' - 'region') || jsonb_build_object('location', (
    SELECT jsonb_strip_nulls(jsonb_build_object('district', d.id::text, 'city', NULLIF(d.city_lookup,''), 'region', NULLIF(d.region_lookup,'')))
    FROM public.districts d
    WHERE public._loc_norm(d.name_ar) = public._loc_norm(r.data->>'district')
      AND public._loc_norm(d.city_name_ar) IS NOT DISTINCT FROM public._loc_norm(r.data->>'city')
    ORDER BY d.id LIMIT 1
  ))
WHERE r.model_id = '62256164-281b-4f1f-85a8-a3dac40b9ae9' AND r.data ? 'district'
  AND EXISTS (SELECT 1 FROM public.districts d
    WHERE public._loc_norm(d.name_ar) = public._loc_norm(r.data->>'district')
      AND public._loc_norm(d.city_name_ar) IS NOT DISTINCT FROM public._loc_norm(r.data->>'city'));

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
DROP FUNCTION public._loc_arr(jsonb);

COMMIT;
