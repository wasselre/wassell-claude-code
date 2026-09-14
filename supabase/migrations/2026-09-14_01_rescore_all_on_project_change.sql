-- A new/renamed project must be able to claim OLD posts from ANY company, not
-- only from the companies already attached to it. A brand-new project is
-- attached to nothing but its developer at creation, so a marketer's earlier
-- post about it (the «أكنان 23» case: ريفا posted, ديار أصيلة developed) was
-- never re-checked. Re-score everything instead: the worker's narrow pass
-- skips an unchanged post in milliseconds, so the whole corpus is ~10 minutes
-- of background time and reaches the AI only where a candidate actually
-- appeared.
BEGIN;

CREATE OR REPLACE FUNCTION public.mkt_rescore_project_organizations(p_project uuid)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- keep the developer relationship in sync first (the scope the matcher
  -- prefers), then re-score every post of every company
  PERFORM public.mkt_sync_developer_relationships(p_project, NULL);
  RETURN public.mkt_enqueue_attribution_rerun(NULL, 20000);
END $$;

COMMIT;
