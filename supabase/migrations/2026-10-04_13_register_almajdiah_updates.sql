-- Register the Almajdiah projects in the update list (unit_updates) so the
-- automated weekly run (project_update_runs, source_type developer_api) picks
-- them up. They carried an update_source_url to the developer's public units
-- API since 2026-08-24 but had no unit_updates row, so nothing ever ran.
--
-- One row per all_projects record with update_source = 'developer_api' and an
-- etmaam API url, skipping any project that already has a row. next_due =
-- today, so the first scheduled run takes them as soon as 'developer_api' is
-- added to project_update_settings.scheduled_sources. Idempotent; replays as a
-- no-op on a database without these projects.

BEGIN;

INSERT INTO public.records (id, model_id, data, created_by_user_id)
SELECT gen_random_uuid(),
       'aa10c001-2026-4824-9000-000000000001',
       jsonb_build_object(
         'project', p.id::text,
         'update_frequency', 'weekly',
         'source_type', 'developer_api',
         'source_url', p.data->>'update_source_url',
         'is_active', true,
         'auto_scope', 'full',
         'next_due', (now() AT TIME ZONE 'Asia/Riyadh')::date::text,
         'migration_instructions',
           'تحديث آلي أسبوعي من API الماجدية العام (بدون تسجيل دخول): ' ||
           'https://etmaam.almajdiah.com/api/client/v1/projects/<id>?page=N — 30 وحدة لكل صفحة. ' ||
           'المصدر كامل: يذكر كل وحدة بحالتها الحقيقية (available / booked / sold)، فحالته تُعتمد في الاتجاهين، ' ||
           'والسعر = price_before_tax (نفس قاعدة الترحيل الأول). مفتاح الربط = معرّف الوحدة في API ' ||
           '(developer_unit_code = MAJD-<id>) أو رمز الوحدة الكامل (TY01-H-0-1) ثم المبنى + الرقم. ' ||
           'الوحدات الموجودة في النظام وغير الموجودة في API لا تُلمس (تُذكر في السجل). ' ||
           'الوحدات الجديدة تُضاف. أي مشروع لا يشترك مع API في أي وحدة يُوقف (رابط خاطئ أو ترقيم مختلف).',
         'migration_log', to_char((now() AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD') ||
           ' — سُجّل للتحديث الآلي الأسبوعي (API الماجدية).'
       ),
       'a3374d65-9cee-4daa-8880-5e8ff23e7db0'
FROM public.records p
WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
  AND p.data->>'update_source' = 'developer_api'
  AND p.data->>'update_source_url' ~ 'etmaam\.almajdiah\.com/api/client/v1/projects/\d+'
  AND EXISTS (SELECT 1 FROM public.users WHERE id = 'a3374d65-9cee-4daa-8880-5e8ff23e7db0')
  AND NOT EXISTS (
    SELECT 1 FROM public.records u
     WHERE u.model_id = 'aa10c001-2026-4824-9000-000000000001'
       AND u.data->>'project' = p.id::text);

COMMIT;
