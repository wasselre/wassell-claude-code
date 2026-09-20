-- ============================================================================
-- September–October runs its ads at the NORMAL daily pace. 2026-09-20.
--
-- Operator: "budget should be 66 per day so total budget is 8000
-- approximately."
--
-- The template's 2,000 a project is sized for `campaign_length_days` = 30, so
-- it IS 66.67 a day for an ordinary month. This month's campaign runs
-- 22 Sep → 31 Oct — FORTY days — so the same 2,000 spends only 50 a day.
--
--   66.67 x 40 = 2,667 a project  ->  8,001 across the three
--
-- It goes in `month_starts`, beside the month's other one-off decisions, and
-- NOT in `budget_per_project`. Raising the template would make every ordinary
-- 30-day month spend 89 a day. The pace belongs to the month, so the number
-- does too — `budgetPerProjectFor` resolves it for the page, the commit, the
-- report and the Meta build alike.
--
-- The three live executions and all six Meta ad sets were already moved to
-- 66.68/day (33.34 each, budget on the ad set and halved per variant), and
-- verified through the Graph API at 200.04 SAR/day across the three campaigns.
-- This records the same decision where the app reads it.
-- ============================================================================

BEGIN;

UPDATE public.mos_month_template
   SET month_starts = jsonb_set(
         month_starts, '{2026-09,budget_per_project}', to_jsonb(2667), true),
       updated_at = now()
 WHERE month_starts ? '2026-09';

DO $$
DECLARE v jsonb; v_exec int; v_tpl numeric;
BEGIN
  SELECT month_starts -> '2026-09', budget_per_project INTO v, v_tpl
    FROM public.mos_month_template LIMIT 1;
  IF v IS NULL OR (v ->> 'budget_per_project')::numeric <> 2667 THEN
    RAISE EXCEPTION 'MOS:SEPT_BUDGET_NOT_SET got %', v;
  END IF;
  -- The TEMPLATE must be untouched: an ordinary month still spends 2,000.
  IF v_tpl <> 2000 THEN
    RAISE EXCEPTION 'MOS:TEMPLATE_BUDGET_CHANGED got % — an ordinary month would now overspend', v_tpl;
  END IF;
  -- And the live executions must already agree with it.
  SELECT count(*) INTO v_exec FROM public.mos_campaign_executions e
    JOIN public.mos_campaigns c ON c.id = e.campaign_id
   WHERE c.ref LIKE '2026-09:paid%' AND e.budget = 2667;
  IF v_exec <> 3 THEN
    RAISE EXCEPTION 'MOS:SEPT_EXECUTIONS_NOT_REPACED only % of 3 at 2667', v_exec;
  END IF;
END $$;

COMMIT;
