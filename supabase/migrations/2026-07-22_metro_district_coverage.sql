-- 2026-07-22 — Metro district coverage for the Riyadh district picker
-- ---------------------------------------------------------------------------
-- Problem: clients come from areas that are FUNCTIONALLY part of metro Riyadh
-- but GOVERNMENTALLY separate cities in the SPL dataset — الدرعية (17 districts
-- with boundaries, never shown), الجبيلة (= SPL's حي عقرباء/حي سلام under city
-- العيينة), and العمارية (absent from SPL entirely). The DistrictMapPicker is
-- city-scoped via wassell_city_district_shapes(p_city_id), so picking الرياض
-- could never offer those districts.
--
-- Fix, three parts:
--   1. city_metro_groups — reference table mapping a parent city to member
--      cities whose districts should ALSO appear when the parent is selected.
--      Seeded: الرياض → {الدرعية، العيينة}. Adding more later is one INSERT.
--   2. العمارية — custom district row under city الدرعية + a rough boundary
--      polygon (~5.6×4.9 km box around the town at 24.803N 46.4225E; source
--      'custom' marks it as hand-added, refine anytime by updating the geom).
--   3. الجبيلة aliases — 'الجبيلة' resolves to حي عقرباء (primary) and حي سلام
--      so lookup-first text matching recognizes the common town name.
-- wassell_city_district_shapes is updated to expand membership and to suffix
-- non-parent-city district names with their city (e.g. «الشهداء — الدرعية»)
-- so same-named districts stay distinguishable in the picker.
-- Idempotent: ON CONFLICT / IF NOT EXISTS / WHERE NOT EXISTS guards throughout.

BEGIN;

-- ─── 1. Metro membership ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.city_metro_groups (
  parent_city_id uuid NOT NULL,
  member_city_id uuid NOT NULL,
  note text,
  PRIMARY KEY (parent_city_id, member_city_id)
);
-- Reference data read only via SECURITY DEFINER functions — RLS on, no
-- client-facing policies needed.
ALTER TABLE public.city_metro_groups ENABLE ROW LEVEL SECURITY;

INSERT INTO public.city_metro_groups (parent_city_id, member_city_id, note) VALUES
  ('44254a38-ce40-938f-17b7-55814a44e45c', '7b602cdd-85ca-5979-9996-4a9a7a7348df',
   'الدرعية — داخل النطاق العمراني العملي للرياض'),
  ('44254a38-ce40-938f-17b7-55814a44e45c', '6d7bebc6-cd61-bb92-212e-2c9b106ef770',
   'العيينة — تشمل منطقة الجبيلة (SPL: حي عقرباء / حي سلام)')
ON CONFLICT DO NOTHING;

-- ─── 2. العمارية custom district + boundary ─────────────────────────────────
-- Parented to city الدرعية (its governorate). SPL has no row for it; source
-- 'custom' + migration_notes record provenance.
INSERT INTO public.districts (
  id, name_ar, name_en, display_name, spl_district_id,
  city_lookup, city_id, city_name_ar, city_name_en,
  region_lookup, region_id, region_name_ar, region_name_en,
  centroid_lat, centroid_lng, source, is_active, migration_notes
)
SELECT
  '7f3d1c2e-9a41-4b8f-8f2e-1a2b3c4d5e6f', 'العمارية', 'Al Ammariyah', 'العمارية', 'CUSTOM-AMMARIYAH-001',
  '7b602cdd-85ca-5979-9996-4a9a7a7348df', '828', 'الدرعية', 'Ad Dir''iyah',
  '9c0c7a82-738d-6456-2101-b7226cc84e20', '1', 'منطقة الرياض', 'Riyadh',
  24.8031, 46.4225, 'custom', true,
  'أُضيفت يدوياً 2026-07-22 — بلدة العمارية غير موجودة في بيانات SPL؛ الحدود تقريبية (مربع ~5.6×4.9كم حول البلدة)'
WHERE NOT EXISTS (SELECT 1 FROM public.districts WHERE id = '7f3d1c2e-9a41-4b8f-8f2e-1a2b3c4d5e6f');

INSERT INTO public.district_boundaries (
  id, district_record_id, spl_district_id, city_id, region_id,
  geom, geometry_type, boundary_source, boundary_updated_at, is_active
)
SELECT
  gen_random_uuid(), '7f3d1c2e-9a41-4b8f-8f2e-1a2b3c4d5e6f', 'CUSTOM-AMMARIYAH-001', '828', '1',
  ST_SetSRID(ST_GeomFromText(
    'POLYGON((46.3945 24.7811, 46.4505 24.7811, 46.4505 24.8251, 46.3945 24.8251, 46.3945 24.7811))'
  ), 4326),
  'Polygon', 'custom', now(), true
WHERE NOT EXISTS (
  SELECT 1 FROM public.district_boundaries
  WHERE district_record_id = '7f3d1c2e-9a41-4b8f-8f2e-1a2b3c4d5e6f'
);

-- ─── 3. الجبيلة aliases ─────────────────────────────────────────────────────
INSERT INTO public.district_aliases (id, district_record_id, spl_district_id, alias_ar, alias_type, source, confidence_score, is_active)
SELECT gen_random_uuid(), '194e6b02-7921-2921-84c2-78e4071c3aa9', '10100830005', 'الجبيلة', 'common_name', 'manual', 0.9, true
WHERE NOT EXISTS (SELECT 1 FROM public.district_aliases
  WHERE district_record_id = '194e6b02-7921-2921-84c2-78e4071c3aa9' AND alias_ar = 'الجبيلة');

INSERT INTO public.district_aliases (id, district_record_id, spl_district_id, alias_ar, alias_type, source, confidence_score, is_active)
SELECT gen_random_uuid(), '8fff275c-e372-75b6-7724-6bc4df0b541d', '10100830002', 'الجبيلة', 'common_name', 'manual', 0.6, true
WHERE NOT EXISTS (SELECT 1 FROM public.district_aliases
  WHERE district_record_id = '8fff275c-e372-75b6-7724-6bc4df0b541d' AND alias_ar = 'الجبيلة');

-- ─── 4. Picker RPC: expand to metro members + disambiguate names ────────────
CREATE OR REPLACE FUNCTION public.wassell_city_district_shapes(p_city_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '15s'
AS $function$
  with member_cities as (
    select p_city_id::text as cid
    union
    select member_city_id::text from public.city_metro_groups where parent_city_id = p_city_id
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'district_id', b.district_record_id,
      'name',
        coalesce(d.data->>'display_name', d.data->>'name_ar', d.data->>'name_en')
        || case when d.data->>'city_lookup' <> p_city_id::text
                then ' — ' || coalesce(d.data->>'city_name_ar', d.data->>'city_name_en', '')
                else '' end,
      'geojson', ST_AsGeoJSON(ST_SimplifyPreserveTopology(b.geom, 0.0002), 5)::jsonb
    )
    order by coalesce(d.data->>'display_name', d.data->>'name_ar')
  ), '[]'::jsonb)
  from public.district_boundaries b
  join public.unified_records d on d.id = b.district_record_id
  where b.is_active
    and d.data->>'city_lookup' in (select cid from member_cities)
$function$;

COMMIT;
