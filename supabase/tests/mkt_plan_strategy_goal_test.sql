-- ============================================================================
-- Plan↔strategy binding and the three-class goal model.
--
--   psql "$DATABASE_URL" -f supabase/tests/mkt_plan_strategy_goal_test.sql
--
-- Runs inside a transaction that ROLLS BACK, so it is safe against production.
-- Covers the seven acceptance scenarios for these two rules:
--
--   1. A plan cannot be approved or activated without an APPROVED strategy version.
--   2. A plan stays on the version it was written against; nothing auto-migrates.
--   3. Rebasing is explicit, reasoned, attributed, and appended to a history
--      that is never rewritten.
--   4. The three goal classes are distinguishable and each has its own required
--      definition.
--   5. Metric and unit are separate, so a bare "900" cannot be a target.
--   6. A missing baseline stays missing; it is never turned into zero.
--   7. An actual value only moves when a measurement is appended, and periods
--      are only required to sum for an additive metric.
--
-- Every assertion is a rejection that must happen or an arithmetic result. A
-- test that only checked "the row inserted" would pass against a schema with
-- no rules at all.
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_user uuid;
  v_sv_draft uuid; v_sv_approved uuid; v_sv_next uuid;
  v_plan uuid; v_plan2 uuid;
  v_goal uuid; v_kpi uuid; v_out uuid;
  v_actual jsonb; v_alloc jsonb; v_dates jsonb;
  v_missing text[]; n int; v_txt text;
BEGIN
  SELECT id INTO v_user FROM public.users LIMIT 1;
  IF v_user IS NULL THEN RAISE NOTICE 'SKIP: no users'; RETURN; END IF;

  -- ══ Fixtures ══════════════════════════════════════════════════════════════
  -- 9101/9102/9103 are far outside the real version numbers, and the whole
  -- transaction rolls back, so this cannot collide with live strategy work.
  INSERT INTO public.mkt_strategy_versions (version_number, name_ar, status, positioning)
  VALUES (9101, 'TEST مسودة', 'draft', 'draft positioning') RETURNING id INTO v_sv_draft;

  INSERT INTO public.mkt_strategy_versions
    (version_number, name_ar, status, approver_user_id, approved_at, effective_date)
  VALUES (9102, 'TEST معتمدة', 'draft', v_user, now(), current_date) RETURNING id INTO v_sv_approved;
  -- Approve through the same path the app uses, so the supersede rule applies.
  UPDATE public.mkt_strategy_versions SET status = 'approved' WHERE id = v_sv_approved;

  -- ══ 1. A plan cannot be approved without an approved strategy version ═════
  INSERT INTO public.mkt_plans (name_ar, plan_type, period_start, period_end, status, owner_user_id)
  VALUES ('TEST خطة بلا استراتيجية', 'annual', '2031-01-01', '2031-12-31', 'draft', v_user)
  RETURNING id INTO v_plan;

  BEGIN
    UPDATE public.mkt_plans SET status = 'approved' WHERE id = v_plan;
    RAISE EXCEPTION 'FAILED: approved a plan with NO strategy version';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a plan with no strategy version cannot be approved';
  END;

  UPDATE public.mkt_plans SET strategy_version_id = v_sv_draft WHERE id = v_plan;
  BEGIN
    UPDATE public.mkt_plans SET status = 'active' WHERE id = v_plan;
    RAISE EXCEPTION 'FAILED: activated a plan bound to a DRAFT strategy version';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a draft strategy version cannot carry an active plan';
  END;

  -- The missing-requirements list must name the same blocker the trigger raises,
  -- or the screen and the database disagree about why a button is disabled.
  v_missing := public.mkt_plan_missing_requirements(v_plan);
  IF NOT ('approved_strategy_version' = ANY(v_missing)) THEN
    RAISE EXCEPTION 'FAILED: missing-requirements did not name the unapproved strategy: %', v_missing;
  END IF;
  RAISE NOTICE 'PASS: requirements list names the unapproved strategy version';

  -- ══ 2. Bound to an approved version, the plan can go active ═══════════════
  UPDATE public.mkt_plans SET strategy_version_id = v_sv_approved WHERE id = v_plan;
  UPDATE public.mkt_plans SET status = 'active' WHERE id = v_plan;
  RAISE NOTICE 'PASS: an approved strategy version lets the plan activate';

  -- ══ 3. A newer approved version does NOT migrate the plan ═════════════════
  INSERT INTO public.mkt_strategy_versions
    (version_number, name_ar, status, approver_user_id, approved_at, effective_date)
  VALUES (9103, 'TEST التالية', 'draft', v_user, now(), current_date) RETURNING id INTO v_sv_next;
  -- Supersede the incumbent first. Exactly one approved version may exist
  -- (mkt_sv_one_current), so this mirrors what strategy_approve does — and it
  -- means the plan below is now bound to a SUPERSEDED version, which is the
  -- realistic shape of "the strategy moved on and this plan did not".
  UPDATE public.mkt_strategy_versions SET status = 'superseded' WHERE id = v_sv_approved;
  UPDATE public.mkt_strategy_versions SET status = 'approved' WHERE id = v_sv_next;

  IF (SELECT strategy_version_id FROM public.mkt_plans WHERE id = v_plan) <> v_sv_approved THEN
    RAISE EXCEPTION 'FAILED: the plan followed a newer strategy version on its own';
  END IF;
  IF (SELECT status FROM public.mkt_plans WHERE id = v_plan) <> 'active' THEN
    RAISE EXCEPTION 'FAILED: superseding the strategy silently deactivated a live plan';
  END IF;
  RAISE NOTICE 'PASS: a newer approved version left the existing plan on its own version, still active';

  -- ══ 4. Rebase is explicit, reasoned, attributed and appended ══════════════
  SELECT count(*) INTO n FROM public.mkt_plan_strategy_links WHERE plan_id = v_plan;

  PERFORM public.mkt_plan_rebase_strategy(v_plan, v_sv_next, 'reviewed under v9103; still holds');

  IF (SELECT strategy_version_id FROM public.mkt_plans WHERE id = v_plan) <> v_sv_next THEN
    RAISE EXCEPTION 'FAILED: rebase did not move the plan';
  END IF;

  -- Addressed by TARGET VERSION, not by "the newest row". Ordering by changed_at
  -- was the first thing this test got wrong: several links are written in one
  -- transaction here, and until 2026-08-25_03 they all shared now().
  SELECT reason INTO v_txt FROM public.mkt_plan_strategy_links
   WHERE plan_id = v_plan AND to_strategy_version_id = v_sv_next;
  IF v_txt IS DISTINCT FROM 'reviewed under v9103; still holds' THEN
    RAISE EXCEPTION 'FAILED: the rebase reason was not recorded (got %)', v_txt;
  END IF;
  IF (SELECT count(*) FROM public.mkt_plan_strategy_links WHERE plan_id = v_plan) <= n THEN
    RAISE EXCEPTION 'FAILED: rebase appended no history row';
  END IF;
  -- auth.uid() is NULL under psql, and attribution is only claimable when there
  -- is a caller to attribute it to.
  IF (SELECT changed_by_user_id FROM public.mkt_plan_strategy_links
       WHERE plan_id = v_plan AND to_strategy_version_id = v_sv_next) IS NULL
     AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED: rebase did not record who did it';
  END IF;
  -- An audit trail whose rows cannot be ordered is not an audit trail.
  IF (SELECT count(DISTINCT changed_at) FROM public.mkt_plan_strategy_links WHERE plan_id = v_plan)
     <> (SELECT count(*) FROM public.mkt_plan_strategy_links WHERE plan_id = v_plan) THEN
    RAISE EXCEPTION 'FAILED: history rows share a timestamp, so their order is undefined';
  END IF;
  RAISE NOTICE 'PASS: rebase moved the plan and appended a distinctly-ordered, reasoned entry';

  -- History is evidence. If it can be edited, it proves nothing.
  BEGIN
    UPDATE public.mkt_plan_strategy_links SET reason = 'rewritten' WHERE plan_id = v_plan;
    RAISE EXCEPTION 'FAILED: rewrote a strategy-binding history row';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: binding history cannot be edited';
  END;
  BEGIN
    DELETE FROM public.mkt_plan_strategy_links WHERE plan_id = v_plan;
    RAISE EXCEPTION 'FAILED: deleted a strategy-binding history row';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: binding history cannot be deleted';
  END;

  -- An active plan may not be rebased onto something unapproved.
  BEGIN
    PERFORM public.mkt_plan_rebase_strategy(v_plan, v_sv_draft, 'should be refused');
    RAISE EXCEPTION 'FAILED: rebased an ACTIVE plan onto a DRAFT strategy version';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: an active plan cannot be rebased onto an unapproved version';
  END;

  -- ══ 5. The three classes, and their separate requirements ═════════════════
  INSERT INTO public.mkt_plans (name_ar, plan_type, period_start, period_end, status,
                                owner_user_id, strategy_version_id)
  VALUES ('TEST خطة الأهداف', 'annual', '2031-01-01', '2031-12-31', 'draft', v_user, v_sv_next)
  RETURNING id INTO v_plan2;

  BEGIN
    INSERT INTO public.mkt_goals (plan_id, goal_class, name_ar, status)
    VALUES (v_plan2, 'output', 'TEST تصنيف قديم', 'draft');
    RAISE EXCEPTION 'FAILED: accepted the retired goal class "output"';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: goal_class is restricted to outcome / kpi / output_commitment';
  END;

  -- A target with no unit is exactly the "900 of what?" problem. Creating the
  -- goal as a draft is allowed — you have to start somewhere — but activating
  -- it is not.
  INSERT INTO public.mkt_goals (plan_id, goal_class, name_ar, metric, target_value, status)
  VALUES (v_plan2, 'outcome', 'TEST 900', 'مهتمون', 900, 'draft') RETURNING id INTO v_goal;

  v_missing := public.mkt_goal_missing_requirements(v_goal);
  IF NOT ('unit' = ANY(v_missing)) THEN
    RAISE EXCEPTION 'FAILED: a target of 900 with no unit was not flagged: %', v_missing;
  END IF;
  RAISE NOTICE 'PASS: a bare numeric target with no unit is reported as incomplete';

  BEGIN
    UPDATE public.mkt_goals SET status = 'active' WHERE id = v_goal;
    RAISE EXCEPTION 'FAILED: activated a goal with no unit, owner, source or baseline decision';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: an incomplete goal cannot be activated';
  END;

  -- ══ 6. A missing baseline stays missing ═══════════════════════════════════
  BEGIN
    UPDATE public.mkt_goals SET baseline_state = 'known', baseline_value = NULL WHERE id = v_goal;
    RAISE EXCEPTION 'FAILED: a baseline declared KNOWN with no value was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a known baseline must carry a number';
  END;

  UPDATE public.mkt_goals
     SET unit = 'مهتم', owner_user_id = v_user, measurement_frequency = 'monthly',
         source_of_truth = 'crm_leads', aggregation_method = 'sum', baseline_state = 'unknown'
   WHERE id = v_goal;

  IF (SELECT baseline_value FROM public.mkt_goals WHERE id = v_goal) IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED: an unknown baseline was given a number';
  END IF;
  v_missing := public.mkt_goal_missing_requirements(v_goal);
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'FAILED: goal still incomplete after being fully defined: %', v_missing;
  END IF;
  UPDATE public.mkt_goals SET status = 'active' WHERE id = v_goal;
  RAISE NOTICE 'PASS: an unknown baseline stays unknown and does not block activation';

  -- Dates are inherited from the plan rather than demanded twice.
  v_dates := public.mkt_goal_effective_dates(v_goal);
  IF (v_dates->>'start')::date <> '2031-01-01' OR (v_dates->>'start_overridden')::boolean THEN
    RAISE EXCEPTION 'FAILED: goal did not inherit the plan period: %', v_dates;
  END IF;
  RAISE NOTICE 'PASS: a goal inherits its plan period unless it overrides it';

  -- ══ 7. Actuals come only from measurements ════════════════════════════════
  v_actual := public.mkt_goal_actual(v_goal);
  IF (v_actual->>'is_measured')::boolean OR v_actual->>'value' IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED: an unmeasured goal reported a value: %', v_actual;
  END IF;
  RAISE NOTICE 'PASS: with no measurements the actual is NULL and flagged unmeasured, not 0';

  INSERT INTO public.mkt_goal_measurements (goal_id, value, measured_at, period_start, period_end,
                                            source_key, evidence, entered_by_user_id)
  VALUES (v_goal, 300, '2031-01-31', '2031-01-01', '2031-01-31', 'crm_leads', 'CRM export', v_user);
  INSERT INTO public.mkt_goal_measurements (goal_id, value, measured_at, period_start, period_end,
                                            source_key, evidence, entered_by_user_id)
  VALUES (v_goal, 250, '2031-02-28', '2031-02-01', '2031-02-28', 'crm_leads', 'CRM export', v_user);

  v_actual := public.mkt_goal_actual(v_goal);
  IF (v_actual->>'value')::numeric <> 550 THEN
    RAISE EXCEPTION 'FAILED: a summed goal did not add its measurements: %', v_actual;
  END IF;
  -- The cached column must track the function, or the list and the detail
  -- screen would show two different numbers for the same goal.
  IF (SELECT actual_value FROM public.mkt_goals WHERE id = v_goal) <> 550 THEN
    RAISE EXCEPTION 'FAILED: the cached actual_value did not follow the measurement';
  END IF;
  RAISE NOTICE 'PASS: appending measurements is what moves the actual value';

  BEGIN
    UPDATE public.mkt_goal_measurements SET value = 9999 WHERE goal_id = v_goal;
    RAISE EXCEPTION 'FAILED: edited a measurement';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: measurements cannot be edited';
  END;
  BEGIN
    DELETE FROM public.mkt_goal_measurements WHERE goal_id = v_goal;
    RAISE EXCEPTION 'FAILED: deleted a measurement';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: measurements cannot be deleted';
  END;

  -- ══ 8. Allocation validation follows the metric, not the calendar ═════════
  INSERT INTO public.mkt_goal_target_periods (goal_id, label, period_start, period_end, target_value)
  VALUES (v_goal, 'Q1', '2031-01-01', '2031-03-31', 400),
         (v_goal, 'Q2', '2031-04-01', '2031-06-30', 400);

  v_alloc := public.mkt_goal_allocation_status(v_goal);
  IF NOT (v_alloc->>'is_additive')::boolean THEN
    RAISE EXCEPTION 'FAILED: a sum goal was not treated as additive';
  END IF;
  IF (v_alloc->>'difference')::numeric <> -100 OR (v_alloc->>'consistent')::boolean THEN
    RAISE EXCEPTION 'FAILED: additive allocation shortfall not reported: %', v_alloc;
  END IF;
  RAISE NOTICE 'PASS: an additive goal reports the gap between its periods and its target';

  -- A conversion RATE is the counter-example: 800 of allocation against a
  -- target of 900 is not a shortfall of 100, it is a meaningless subtraction.
  INSERT INTO public.mkt_goals (plan_id, goal_class, name_ar, metric, unit, target_value,
                                owner_user_id, measurement_frequency, source_of_truth,
                                aggregation_method, baseline_state, status)
  VALUES (v_plan2, 'kpi', 'TEST نسبة التحويل', 'نسبة التحويل', '%', 12,
          v_user, 'monthly', 'crm_leads', 'rate', 'unknown', 'active')
  RETURNING id INTO v_kpi;

  INSERT INTO public.mkt_goal_target_periods (goal_id, label, period_start, period_end, target_value)
  VALUES (v_kpi, 'Q1', '2031-01-01', '2031-03-31', 11),
         (v_kpi, 'Q2', '2031-04-01', '2031-06-30', 12);

  v_alloc := public.mkt_goal_allocation_status(v_kpi);
  IF (v_alloc->>'is_additive')::boolean THEN
    RAISE EXCEPTION 'FAILED: a rate goal was treated as additive';
  END IF;
  IF v_alloc->>'difference' IS NOT NULL OR v_alloc->>'consistent' IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED: a rate goal was given a sum check: %', v_alloc;
  END IF;
  RAISE NOTICE 'PASS: a rate goal is never required to have its periods sum to its target';

  -- A rate reads its latest value, it does not accumulate.
  INSERT INTO public.mkt_goal_measurements (goal_id, value, measured_at, source_key, entered_by_user_id)
  VALUES (v_kpi, 9, '2031-01-31', 'crm_leads', v_user);
  INSERT INTO public.mkt_goal_measurements (goal_id, value, measured_at, source_key, entered_by_user_id)
  VALUES (v_kpi, 11, '2031-02-28', 'crm_leads', v_user);
  v_actual := public.mkt_goal_actual(v_kpi);
  IF (v_actual->>'value')::numeric <> 11 THEN
    RAISE EXCEPTION 'FAILED: a rate goal accumulated instead of taking its latest reading: %', v_actual;
  END IF;
  RAISE NOTICE 'PASS: a rate goal reports its latest reading, not a sum';

  -- ══ 9. An output commitment is its own thing ══════════════════════════════
  INSERT INTO public.mkt_goals (plan_id, goal_class, name_ar, metric, unit, target_value,
                                owner_user_id, measurement_frequency, source_of_truth,
                                aggregation_method, baseline_state, status)
  VALUES (v_plan2, 'output_commitment', 'TEST 48 فيديو', 'فيديوهات منشورة', 'فيديو', 48,
          v_user, 'monthly', 'publication_snapshots', 'sum', 'not_applicable', 'active')
  RETURNING id INTO v_out;

  IF (SELECT goal_class FROM public.mkt_goals WHERE id = v_out) <> 'output_commitment' THEN
    RAISE EXCEPTION 'FAILED: output commitment did not keep its class';
  END IF;
  v_actual := public.mkt_goal_actual(v_out);
  IF (v_actual->>'is_measured')::boolean THEN
    RAISE EXCEPTION 'FAILED: a commitment with no deliveries reported progress';
  END IF;
  RAISE NOTICE 'PASS: an output commitment with nothing delivered is unmeasured, not at zero';

  -- A goal answers to at most one piece of execution; two links would make
  -- "which campaign delivered this" unanswerable.
  BEGIN
    UPDATE public.mkt_goals
       SET linked_initiative_id = gen_random_uuid(), linked_program_id = gen_random_uuid()
     WHERE id = v_out;
    RAISE EXCEPTION 'FAILED: a goal was linked to two execution objects at once';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    RAISE NOTICE 'PASS: a goal links to at most one execution object';
  END;

  RAISE NOTICE 'ALL PLAN-STRATEGY / GOAL-MODEL TESTS PASSED';
END $$;

ROLLBACK;
