-- The append-only guards on calculation runs / results / matches / cash flows /
-- audit events were blocking CASCADED deletes, not just direct ones. That made
-- it impossible to ever remove a scenario and everything under it — which is a
-- compliance problem, not a safety feature: PDPL erasure requests are real, and
-- a system that physically cannot delete a customer's financial data fails them.
--
-- The immutability that actually matters is "nobody can rewrite what a customer
-- was shown". That is UPDATE. A DELETE that removes the WHOLE scenario is a
-- different, legitimate act.
--
-- The distinction is detectable precisely: with ON DELETE CASCADE, Postgres
-- removes the parent row FIRST and then fires the children's BEFORE DELETE
-- triggers. So if the parent scenario no longer exists, we are inside a cascade
-- and the delete is allowed; if it still exists, someone is trying to snip a
-- single result row out of a live scenario's history, and that stays refused.
CREATE OR REPLACE FUNCTION public.fin_tg_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_scenario_id uuid;
  v_parent_exists boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% is append-only (attempted UPDATE) — create a new row instead of rewriting history', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  -- DELETE path. fin_cash_flows reaches its scenario through the run.
  IF TG_TABLE_NAME = 'fin_cash_flows' THEN
    SELECT r.scenario_id INTO v_scenario_id
    FROM public.fin_calculation_runs r WHERE r.id = OLD.run_id;
    -- The run is already gone => the cascade is underway.
    IF v_scenario_id IS NULL THEN RETURN OLD; END IF;
  ELSE
    v_scenario_id := OLD.scenario_id;
  END IF;

  IF v_scenario_id IS NULL THEN RETURN OLD; END IF;

  SELECT EXISTS (SELECT 1 FROM public.fin_scenarios s WHERE s.id = v_scenario_id)
    INTO v_parent_exists;

  IF v_parent_exists THEN
    RAISE EXCEPTION '% is append-only — a single row cannot be deleted from a live scenario''s history (delete the whole scenario instead)', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END $$;
