-- Ready or off-plan, as a client preference (operator, 2026-10-05: "he clearly
-- said that he wants something ready, not off-plan. We should have a field for
-- that … a multi-select, if the client wants ready or off-plan, or both").
-- Projects already carry construction_status; the client had nothing, so the
-- reader heard «جاهزه» and had nowhere to put it.
--
-- Multi-select `preferred_readiness` in the «Client Preferences» section, API
-- values `ready` / `off_plan` (the same words the sales agent's search uses,
-- api/_lib/salesAgent/catalog.ts Readiness). Both ticked = either is fine.
-- clients is UNFROZEN (records JSONB), so this is a schema-only change; the
-- models_view_sync trigger adds the v_clients column. Idempotent.

BEGIN;

UPDATE public.models m
SET schema = jsonb_set(
  m.schema,
  ARRAY['sections', sec.idx::text, 'fields'],
  (m.schema->'sections'->sec.idx->'fields') || jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid()::text,
    'name', 'preferred_readiness',
    'label_ar', 'جاهز أو على الخارطة',
    'label_en', 'Ready or off-plan',
    'type', 'multiselect',
    'required', false,
    'order', 13,
    'section_id', m.schema->'sections'->sec.idx->>'id',
    'width', 'half',
    'show_in_table', false,
    'options', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'ready',    'label_ar', 'جاهز',         'label_en', 'Ready',    'color', '#10B981'),
      jsonb_build_object('id', gen_random_uuid()::text, 'value', 'off_plan', 'label_ar', 'على الخارطة', 'label_en', 'Off-plan', 'color', '#F59E0B')
    )
  ))
)
FROM (
  SELECT (s.ord - 1)::int AS idx
  FROM public.models mm, jsonb_array_elements(mm.schema->'sections') WITH ORDINALITY s(sec, ord)
  WHERE mm.name = 'clients'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.sec->'fields') f WHERE f->>'name' = 'preferred_unit_type')
  LIMIT 1
) sec
WHERE m.name = 'clients'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(m.schema->'sections') s2, jsonb_array_elements(s2->'fields') f2
    WHERE f2->>'name' = 'preferred_readiness'
  );

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.models WHERE name = 'clients')
     AND NOT EXISTS (
       SELECT 1 FROM public.models m, jsonb_array_elements(m.schema->'sections') s, jsonb_array_elements(s->'fields') f
       WHERE m.name = 'clients' AND f->>'name' = 'preferred_readiness'
     ) THEN
    RAISE EXCEPTION 'preferred_readiness was not added to the clients schema';
  END IF;
END $assert$;

COMMIT;
