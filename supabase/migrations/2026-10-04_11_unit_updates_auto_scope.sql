-- unit_updates: how much the AUTOMATIC update may change (2026-10-04).
--
-- Found by the first dry run of the Riva portal reconcile: ستون الندى is an
-- Al-Ramz project MARKETED by Riva. Riva's portal still lists the old prices
-- (~5% lower), while Al-Ramz's own price file (posted in their WhatsApp group
-- on 2026-09-21, applied 2026-09-29) is newer. A portal run would have undone
-- that repricing and flipped a sold unit back to available.
--
-- `auto_scope` decides per project:
--   full         status + price + newly released units (default)
--   status_only  status only, and only FORWARD (available → reserved → sold);
--                never a price, never sold → available. For a project whose
--                portal is a secondary source.
--   off          the automatic update skips this project.
-- Plus a new source_type `whatsapp_group` for projects the WhatsApp reader
-- discovers.

BEGIN;

UPDATE public.models m
SET schema = jsonb_set(
  m.schema, '{sections,0,fields}',
  (m.schema->'sections'->0->'fields') || jsonb_build_array(jsonb_build_object(
    'id', 'aa10c001-2026-4824-9000-0000000000fa',
    'name', 'auto_scope',
    'label_ar', 'نطاق التحديث التلقائي',
    'label_en', 'Automatic update scope',
    'type', 'dropdown',
    'required', false,
    'order', 9,
    'width', 'half',
    'show_in_table', true,
    'section_id', 'aa10c001-2026-4824-9000-00000000s001',
    'options', jsonb_build_array(
      jsonb_build_object('id','aa10c001-2026-4824-9000-0000000000s1','value','full','label_ar','كامل (الحالة والسعر والوحدات الجديدة)','label_en','Full (status, price, new units)','color','#10B981'),
      jsonb_build_object('id','aa10c001-2026-4824-9000-0000000000s2','value','status_only','label_ar','الحالة فقط (للأمام)','label_en','Status only (forward)','color','#F59E0B'),
      jsonb_build_object('id','aa10c001-2026-4824-9000-0000000000s3','value','off','label_ar','متوقف','label_en','Off','color','#9CA3AF')
    )
  ))
)
WHERE m.id = 'aa10c001-2026-4824-9000-000000000001'
  AND NOT (m.schema::text LIKE '%"auto_scope"%');

UPDATE public.models m
SET schema = jsonb_set(
  m.schema,
  ARRAY['sections','0','fields', (
    SELECT (i - 1)::text FROM jsonb_array_elements(m.schema->'sections'->0->'fields') WITH ORDINALITY e(f, i)
    WHERE f->>'name' = 'source_type'
  ), 'options'],
  (SELECT f->'options' FROM jsonb_array_elements(m.schema->'sections'->0->'fields') f WHERE f->>'name' = 'source_type')
  || jsonb_build_array(jsonb_build_object(
       'id','aa10c001-2026-4824-9000-0000000000ob','value','whatsapp_group',
       'label_ar','مجموعة واتساب المطور','label_en','Developer WhatsApp group','color','#25D366'))
)
WHERE m.id = 'aa10c001-2026-4824-9000-000000000001'
  AND NOT (m.schema::text LIKE '%"whatsapp_group"%');

-- ستون الندى: the Riva portal is secondary; Al-Ramz's price files lead.
-- Guarded so the migration replays on a database without that project.
UPDATE public.records u
SET data = u.data || jsonb_build_object('auto_scope', 'status_only')
FROM public.records p
WHERE u.model_id = 'aa10c001-2026-4824-9000-000000000001'
  AND p.id::text = u.data->>'project'
  AND p.data->>'project_name' = 'ستون الندى'
  AND u.data->>'source_type' = 'riva_broker';

COMMIT;
