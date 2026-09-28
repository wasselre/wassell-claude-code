-- units.office_unit_location (added by 2026-09-28_office_outreach.sql) was
-- created without location_levels, so the form rendered «لم يتم إعداد حقل
-- الموقع» instead of the country → region → city → district picker. Copy the
-- level config (and the Riyadh default) from all_projects.location so a
-- standalone office unit is located on exactly the same geography as projects.

BEGIN;

WITH src AS (
  SELECT f AS field
    FROM public.models m,
         jsonb_array_elements(m.schema->'sections') s,
         jsonb_array_elements(s->'fields') f
   WHERE m.name = 'all_projects' AND f->>'name' = 'location'
   LIMIT 1
), u AS (
  SELECT m.id,
         jsonb_set(m.schema, '{sections}', (
           SELECT jsonb_agg(
                    jsonb_set(s, '{fields}', (
                      SELECT COALESCE(jsonb_agg(
                               CASE WHEN f->>'name' = 'office_unit_location'
                                    THEN f || jsonb_build_object(
                                           'location_levels',  (SELECT field->'location_levels'  FROM src),
                                           'location_default', (SELECT field->'location_default' FROM src),
                                           'location_multi',   false)
                                    ELSE f END
                               ORDER BY fo), '[]'::jsonb)
                        FROM jsonb_array_elements(s->'fields') WITH ORDINALITY AS x(f, fo))
                  ) ORDER BY so)
             FROM jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS y(s, so))
         ) AS new_schema
    FROM public.models m
   WHERE m.name = 'units'
)
UPDATE public.models m SET schema = u.new_schema, updated_at = now()
  FROM u WHERE m.id = u.id AND EXISTS (SELECT 1 FROM src WHERE field ? 'location_levels');

COMMIT;
