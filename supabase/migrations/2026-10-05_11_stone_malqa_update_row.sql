-- ستون الملقا on the update list (2026-10-05): updated from Al-Ramz's
-- WhatsApp (the officer's private chat + the broker group), with the unit type
-- the developer states for the project — Al-Ramz's broker portal lists it as
-- «شقق» (type flats), and all 20 existing CRM units are شقة. The officer's
-- availability sheets carry no type column, so without this every new unit
-- would be skipped by the four-essentials rule. Bedrooms come from his voice
-- note of 2026-10-05 (all remaining units are 2 bedrooms).
-- Guarded by name so the migration replays on a database without the project.

INSERT INTO public.records (model_id, data)
SELECT 'aa10c001-2026-4824-9000-000000000001', jsonb_build_object(
  'project', p.id::text,
  'source_type', 'whatsapp_group',
  'update_frequency', 'on_file',
  'is_active', true,
  'auto_scope', 'full',
  'stated_unit_type', 'شقة',
  'stated_unit_type_source', 'https://brokerportal.alramzre.com/user/projects/a25a0a85-afa4-4630-ac6b-b25e228f57e3',
  'migration_instructions', 'يُحدَّث تلقائياً من واتساب الرمز (محادثة المسؤول الخاصة + مجموعة الوسطاء). ملفات المتاح لا تذكر نوع الوحدة: النوع «شقة» حسب بوابة الرمز (شقق).',
  'migration_log', '2026-10-05 — أُضيف إلى قائمة التحديث (مصدر: واتساب الرمز).')
FROM public.records p
WHERE p.model_id = (SELECT id FROM public.models WHERE name = 'all_projects')
  AND p.data->>'project_name' = 'ستون الملقا'
  AND NOT EXISTS (
    SELECT 1 FROM public.records u
    WHERE u.model_id = 'aa10c001-2026-4824-9000-000000000001' AND u.data->>'project' = p.id::text);
