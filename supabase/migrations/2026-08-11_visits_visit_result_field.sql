-- Add a `visit_result` dropdown to the visits model (unfrozen → JSONB schema edit).
-- The follow-up workspace's minimal "Record a visit" form captures the visit
-- outcome here instead of the numeric visit_rating. Idempotent: only adds the
-- field if it isn't already present. The models_view_sync trigger regenerates
-- v_visits with the new column automatically.
UPDATE public.models
SET schema = jsonb_set(
  schema,
  '{sections,0,fields}',
  (schema->'sections'->0->'fields') || jsonb_build_object(
    'id', gen_random_uuid()::text,
    'name', 'visit_result',
    'label_ar', 'نتيجة الزيارة',
    'label_en', 'Visit Result',
    'type', 'dropdown',
    'required', false,
    'order', 99,
    'section_id', (schema->'sections'->0->>'id'),
    'width', 'half',
    'show_in_table', true,
    'options', jsonb_build_array(
      jsonb_build_object('id', gen_random_uuid()::text, 'label_ar', 'مهتم',     'label_en', 'Interested',     'value', 'interested',     'color', '#10B981'),
      jsonb_build_object('id', gen_random_uuid()::text, 'label_ar', 'يفكّر',    'label_en', 'Considering',    'value', 'considering',    'color', '#C09B5F'),
      jsonb_build_object('id', gen_random_uuid()::text, 'label_ar', 'غير مهتم', 'label_en', 'Not interested', 'value', 'not_interested', 'color', '#8E4E3A'),
      jsonb_build_object('id', gen_random_uuid()::text, 'label_ar', 'حجز',      'label_en', 'Reserved',       'value', 'reserved',       'color', '#3B82F6')
    )
  )
)
WHERE name = 'visits'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(schema->'sections'->0->'fields') f
    WHERE f->>'name' = 'visit_result'
  );
