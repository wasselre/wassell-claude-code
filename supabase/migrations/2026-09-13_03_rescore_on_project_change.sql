-- A project added (or renamed, or re-assigned to a developer) LATER must catch
-- up the posts that already mentioned it. Until now the relationship sync
-- (2026-09-13_01) made the new project a candidate for FUTURE scoring only —
-- the 16 «أوتوجراف 22» posts would have stayed «no project» until someone
-- pressed re-score by hand.
--
-- This trigger enqueues an attribution-only re-score for every organization
-- linked to the project whenever an all_projects row is inserted or its
-- project_name / project_name_en / developer actually change. It deliberately
-- does NOT fire on other data writes: the unit-rollup triggers touch project
-- rows on every unit save (`UPDATE records SET data = data`), and re-scoring a
-- 500-post company on each of those would be a self-inflicted storm.
--
-- Cost: one narrow_only content_process job per post of the company. The
-- worker's narrow pass skips a post in milliseconds when its candidate set is
-- unchanged, so only posts that now match the new name reach the AI runner.
BEGIN;

CREATE OR REPLACE FUNCTION public.mkt_rescore_project_organizations(p_project uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_total int := 0; r record; n int;
BEGIN
  -- make sure the developer relationship exists before we look it up
  PERFORM public.mkt_sync_developer_relationships(p_project, NULL);
  FOR r IN
    SELECT DISTINCT po.organization_id
      FROM public.mkt_project_organizations po
     WHERE po.project_id = p_project AND po.is_active
  LOOP
    n := public.mkt_enqueue_attribution_rerun(r.organization_id, 10000);
    v_total := v_total + COALESCE(n, 0);
  END LOOP;
  RETURN v_total;
END $$;
REVOKE ALL ON FUNCTION public.mkt_rescore_project_organizations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_rescore_project_organizations(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.mkt_tg_records_rescore_on_project_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public.mkt_rescore_project_organizations(NEW.id);
  RETURN NEW;
END $$;

-- TG_OP is not available inside a WHEN clause, so INSERT and UPDATE get one
-- trigger each.
DROP TRIGGER IF EXISTS records_rescore_on_project_change ON public.records;
DROP TRIGGER IF EXISTS records_rescore_on_project_insert ON public.records;
DROP TRIGGER IF EXISTS records_rescore_on_project_update ON public.records;
CREATE TRIGGER records_rescore_on_project_insert
  AFTER INSERT ON public.records
  FOR EACH ROW
  WHEN (NEW.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'::uuid)
  EXECUTE FUNCTION public.mkt_tg_records_rescore_on_project_change();
CREATE TRIGGER records_rescore_on_project_update
  AFTER UPDATE OF data ON public.records
  FOR EACH ROW
  WHEN (
    NEW.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'::uuid
    AND (
         OLD.data->>'project_name'    IS DISTINCT FROM NEW.data->>'project_name'
      OR OLD.data->>'project_name_en' IS DISTINCT FROM NEW.data->>'project_name_en'
      OR OLD.data->>'developer'       IS DISTINCT FROM NEW.data->>'developer'
    )
  )
  EXECUTE FUNCTION public.mkt_tg_records_rescore_on_project_change();

-- A developer newly linked to a tracked organization: catch up its posts too.
CREATE OR REPLACE FUNCTION public.mkt_tg_org_rescore_on_developer_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.developer_record_id IS NOT NULL THEN
    PERFORM public.mkt_sync_developer_relationships(NULL, NEW.id);
    PERFORM public.mkt_enqueue_attribution_rerun(NEW.id, 10000);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mkt_organizations_rescore_on_developer_change ON public.mkt_organizations;
CREATE TRIGGER mkt_organizations_rescore_on_developer_change
  AFTER UPDATE OF developer_record_id ON public.mkt_organizations
  FOR EACH ROW
  WHEN (OLD.developer_record_id IS DISTINCT FROM NEW.developer_record_id)
  EXECUTE FUNCTION public.mkt_tg_org_rescore_on_developer_change();

COMMIT;
