-- unit_updates: the unit type the DEVELOPER states for a whole project (2026-10-05).
--
-- A unit is never created without its type (the four-essentials rule). Some
-- sources never state it per unit — Safa's broker cards («299-C5-4-41») and
-- Riva's portal unit data for أكنان 24 — so every weekly run skipped those
-- units. The developer does state it at project level: Sakani lists every
-- model of صفا 101 and صفا 102 as «شقة», and Riva's project page lists
-- أكنان 24 as apartments only (researched 2026-10-05, operator: "set them as
-- apartments and add the units").
--
--   stated_unit_type          a units.unit_type value
--   stated_unit_type_source   the link where the developer states it
--
-- The reconciler uses it ONLY when a unit's own data has no type, and only
-- when BOTH fields are filled (a type without a source is ignored). Each unit
-- created this way carries the source in its notes.

BEGIN;

UPDATE public.models m
SET schema = jsonb_set(
  m.schema, '{sections,0,fields}',
  (m.schema->'sections'->0->'fields') || jsonb_build_array(
    jsonb_build_object(
      'id', 'aa10c001-2026-4824-9000-0000000000fb',
      'name', 'stated_unit_type',
      'label_ar', 'نوع الوحدات حسب المطوّر',
      'label_en', 'Unit type stated by the developer',
      'type', 'dropdown',
      'required', false,
      'order', 10,
      'width', 'half',
      'show_in_table', false,
      'section_id', 'aa10c001-2026-4824-9000-00000000s001',
      'options', jsonb_build_array(
        jsonb_build_object('id','aa10c001-2026-4824-9000-0000000000t1','value','شقة','label_ar','شقة','label_en','Apartment','color','#3B82F6'),
        jsonb_build_object('id','aa10c001-2026-4824-9000-0000000000t2','value','دور','label_ar','دور','label_en','Floor','color','#8B5CF6'),
        jsonb_build_object('id','aa10c001-2026-4824-9000-0000000000t3','value','فيلا','label_ar','فيلا','label_en','Villa','color','#10B981'),
        jsonb_build_object('id','aa10c001-2026-4824-9000-0000000000t4','value','تاون هاوس','label_ar','تاون هاوس','label_en','Townhouse','color','#F59E0B'),
        jsonb_build_object('id','aa10c001-2026-4824-9000-0000000000t5','value','دبلكس','label_ar','دبلكس','label_en','Duplex','color','#EC4899'),
        jsonb_build_object('id','aa10c001-2026-4824-9000-0000000000t6','value','بنتهاوس','label_ar','بنتهاوس','label_en','Penthouse','color','#C09B5F')
      )
    ),
    jsonb_build_object(
      'id', 'aa10c001-2026-4824-9000-0000000000fc',
      'name', 'stated_unit_type_source',
      'label_ar', 'مصدر نوع الوحدات',
      'label_en', 'Source of the stated unit type',
      'type', 'url',
      'required', false,
      'order', 11,
      'width', 'half',
      'show_in_table', false,
      'section_id', 'aa10c001-2026-4824-9000-00000000s001'
    )
  )
)
WHERE m.id = 'aa10c001-2026-4824-9000-000000000001'
  AND NOT (m.schema::text LIKE '%"stated_unit_type"%');

-- The three projects researched 2026-10-05. Guarded by name so the migration
-- replays on a database without them.
UPDATE public.records u
SET data = u.data || jsonb_build_object(
  'stated_unit_type', 'شقة',
  'stated_unit_type_source', CASE p.data->>'project_name'
    WHEN 'صفا 101' THEN 'https://sakani.sa/app/offplan-projects/1445'
    WHEN 'صفا 102' THEN 'https://sakani.sa/app/offplan-projects/1646'
    WHEN 'أكنان 24' THEN 'https://riva.sa/project/aknan-24'
  END)
FROM public.records p
WHERE u.model_id = 'aa10c001-2026-4824-9000-000000000001'
  AND p.id::text = u.data->>'project'
  AND p.data->>'project_name' IN ('صفا 101', 'صفا 102', 'أكنان 24');

COMMIT;
