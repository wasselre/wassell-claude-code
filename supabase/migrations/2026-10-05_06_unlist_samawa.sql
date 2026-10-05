-- Unlist شقق سماوة from Our Projects (operator 2026-10-05: "unlist the projects
-- which Riva unlisted, unless we have a developer source").
--
-- Checked the same day: Riva's public list (riva.sa/projects, 18 projects) and
-- its broker portal (22) no longer include شقق سماوة; its developer (آبه) has
-- no source of its own. Every other Riva-marketed project in Our Projects is
-- still listed by Riva, except أدوار جديل الرمال, which stays: its developer
-- Al-Ramz has its own source (their WhatsApp group).
--
-- "Unlist" = stays in All Projects with its units; only the Our Projects row
-- goes. The website flag (is_public) follows automatically
-- (records_enforce_our_projects_public). The removed row was just
-- {"project": "95c0edd3-1d85-4149-b050-72edf35ee302"} — re-adding the project
-- to Our Projects restores it.

BEGIN;

DELETE FROM public.records o
WHERE o.model_id = (SELECT id FROM public.models WHERE name = 'our_projects')
  AND o.id = 'b962756a-877d-4718-8c57-7307add0fcbd'
  AND o.data->>'project' = '95c0edd3-1d85-4149-b050-72edf35ee302';

UPDATE public.records p
SET data = p.data || jsonb_build_object('source_notes',
  coalesce(p.data->>'source_notes', '') ||
  E'\n2026-10-05: أُخرج من «مشاريعنا» — ريفا أزالته من قائمتها (riva.sa/projects وبوابة الوسطاء) ولا مصدر للمطوّر. باقٍ في كل المشاريع بوحداته (أرشيف).')
WHERE p.id = '95c0edd3-1d85-4149-b050-72edf35ee302'
  AND p.model_id = (SELECT id FROM public.models WHERE name = 'all_projects');

COMMIT;
