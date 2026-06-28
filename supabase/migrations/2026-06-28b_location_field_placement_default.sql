-- ============================================================================
-- Location field — placement + الرياض default (2026-06-28b)
--
-- 1. Move the all_projects `location` field into the "المعلومات الجغرافية"
--    (Geographic Info) section, next to project_location / lat / lng.
-- 2. Seed `location_default` = { region: منطقة الرياض, city: الرياض } on the
--    location field of all_projects / clients / real_estate_offices /
--    market_listings, so an EMPTY field starts at الرياض/الرياض and the user
--    only picks a district (changeable). Display/seed only — nothing is written
--    until the user picks.
--
-- الرياض ids: region 9c0c7a82-738d-6456-2101-b7226cc84e20, city 44254a38-ce40-938f-17b7-55814a44e45c
-- ============================================================================
BEGIN;

-- 1. Relocate the all_projects location field into the geographic section + add default.
DO $$
DECLARE loc_field jsonb; new_schema jsonb;
DECLARE geo_section text := '9e8fc144-d3ae-4b62-bf1c-831b152c58ac';
BEGIN
  SELECT (f - 'order')
    || jsonb_build_object('section_id', geo_section, 'order', 99,
         'location_default', jsonb_build_object('region','9c0c7a82-738d-6456-2101-b7226cc84e20','city','44254a38-ce40-938f-17b7-55814a44e45c'))
    INTO loc_field
  FROM models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
  WHERE m.name='all_projects' AND f->>'name'='location';

  SELECT jsonb_set(m.schema, '{sections}', (
    SELECT jsonb_agg(
      jsonb_set(sec, '{fields}',
        COALESCE((SELECT jsonb_agg(ff) FROM jsonb_array_elements(sec->'fields') ff WHERE ff->>'name'<>'location'), '[]'::jsonb)
        || CASE WHEN sec->>'id' = geo_section THEN jsonb_build_array(loc_field) ELSE '[]'::jsonb END))
    FROM jsonb_array_elements(m.schema->'sections') sec))
  INTO new_schema FROM models m WHERE m.name='all_projects';

  UPDATE models SET schema = new_schema WHERE name='all_projects';
END $$;

-- 2. Add the الرياض default to the other location-field models (in place).
UPDATE public.models m SET schema = jsonb_set(m.schema, '{sections}', (
  SELECT jsonb_agg(jsonb_set(sec, '{fields}', (
    SELECT jsonb_agg(CASE WHEN f->>'name'='location'
      THEN f || jsonb_build_object('location_default', jsonb_build_object('region','9c0c7a82-738d-6456-2101-b7226cc84e20','city','44254a38-ce40-938f-17b7-55814a44e45c'))
      ELSE f END)
    FROM jsonb_array_elements(sec->'fields') f)))
  FROM jsonb_array_elements(m.schema->'sections') sec))
WHERE m.name IN ('clients','real_estate_offices','market_listings');

COMMIT;
