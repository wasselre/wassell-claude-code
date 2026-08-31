-- Upgrade-only classification rule (operator decision):
-- When a "marketer project" (project_classification='riva_projects') has a
-- developer that has at least one active project officer, auto-set its
-- classification to 'our_projects'. FORWARD-ONLY:
--   * never reverts when the officer is later removed,
--   * never touches projects classified as anything other than 'riva_projects'
--     (so manual 'our_projects' / 'general_project' / 'aqar_platform' are safe).
--
-- Model ids: all_projects = 220c49b9-…, project_officers = 026855a4-…
-- Both are UNFROZEN (JSONB in records), so this operates on public.records.
-- SECURITY DEFINER so the cross-row writes/reads bypass the writer's RLS.

-- When a marketer project is written and its developer already has an officer,
-- flip it inline (BEFORE — no extra write).
CREATE OR REPLACE FUNCTION public.tg_project_upgrade_if_developer_has_officer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.data->>'developer' IS NOT NULL AND NEW.data->>'developer' <> '' AND EXISTS (
      SELECT 1 FROM public.records o
       WHERE o.model_id = '026855a4-02cb-41de-b9b5-91c0eee331a9'::uuid
         AND o.data->>'developer' = NEW.data->>'developer'
         AND COALESCE((o.data->>'is_active'), 'true') <> 'false'
  ) THEN
    NEW.data := jsonb_set(NEW.data, '{project_classification}', '"our_projects"');
  END IF;
  RETURN NEW;
END $fn$;

-- When an officer (with a developer) is created/updated, upgrade that
-- developer's marketer projects (AFTER — separate write; forward-only, so no
-- DELETE handling / no revert).
CREATE OR REPLACE FUNCTION public.tg_officer_upgrade_marketer_projects()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  UPDATE public.records p
     SET data = jsonb_set(p.data, '{project_classification}', '"our_projects"')
   WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'::uuid
     AND p.data->>'developer' = NEW.data->>'developer'
     AND p.data->>'project_classification' = 'riva_projects';
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS records_project_upgrade_classification ON public.records;
CREATE TRIGGER records_project_upgrade_classification
  BEFORE INSERT OR UPDATE ON public.records
  FOR EACH ROW
  WHEN (NEW.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'::uuid
        AND NEW.data->>'project_classification' = 'riva_projects')
  EXECUTE FUNCTION public.tg_project_upgrade_if_developer_has_officer();

DROP TRIGGER IF EXISTS records_officer_upgrade_projects ON public.records;
CREATE TRIGGER records_officer_upgrade_projects
  AFTER INSERT OR UPDATE ON public.records
  FOR EACH ROW
  WHEN (NEW.model_id = '026855a4-02cb-41de-b9b5-91c0eee331a9'::uuid
        AND NEW.data->>'developer' IS NOT NULL AND NEW.data->>'developer' <> '')
  EXECUTE FUNCTION public.tg_officer_upgrade_marketer_projects();

-- One-time backfill for existing data (no-op if nothing qualifies).
UPDATE public.records p
   SET data = jsonb_set(p.data, '{project_classification}', '"our_projects"')
 WHERE p.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'::uuid
   AND p.data->>'project_classification' = 'riva_projects'
   AND EXISTS (SELECT 1 FROM public.records o
                WHERE o.model_id = '026855a4-02cb-41de-b9b5-91c0eee331a9'::uuid
                  AND o.data->>'developer' = p.data->>'developer'
                  AND COALESCE((o.data->>'is_active'), 'true') <> 'false');
