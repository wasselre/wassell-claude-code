-- ============================================================================
-- Marketing Portfolio — integrity, identity and completion tests.
--
--   psql "$DATABASE_URL" -f supabase/tests/mkt_portfolio_test.sql
--
-- Runs inside a transaction that ROLLS BACK, so it is safe against production.
--
-- Every block proves ONE rule, and each is written so that it FAILS against the
-- schema as it was before 2026-08-26_01. A test that merely asserted "the row
-- inserted" would have passed against the bug this migration fixes.
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_user uuid;
  v_sv uuid; v_plan uuid; v_other_plan uuid;
  v_goal uuid; v_other_goal uuid;
  v_init uuid; v_prog uuid;
  v_c1 uuid; v_c2 uuid; v_legacy uuid;
  a text; b text; c text;
  v_missing text[]; v_res jsonb; n int;
BEGIN
  SELECT id INTO v_user FROM public.users LIMIT 1;
  IF v_user IS NULL THEN RAISE NOTICE 'SKIP: no users'; RETURN; END IF;

  -- Fixtures: two plans under one approved strategy, one goal in each.
  INSERT INTO public.mkt_strategy_versions
    (version_number, name_ar, status, approver_user_id, approved_at)
  VALUES (9101, 'TEST portfolio strategy', 'draft', v_user, now()) RETURNING id INTO v_sv;
  UPDATE public.mkt_strategy_versions SET status = 'superseded' WHERE status = 'approved' AND id <> v_sv;
  UPDATE public.mkt_strategy_versions SET status = 'approved' WHERE id = v_sv;

  INSERT INTO public.mkt_plans (plan_type, strategy_version_id, name_ar, status, period_start, period_end, owner_user_id)
  VALUES ('annual', v_sv, 'TEST plan A', 'draft', '2027-01-01', '2027-12-31', v_user) RETURNING id INTO v_plan;
  INSERT INTO public.mkt_plans (plan_type, strategy_version_id, name_ar, status, period_start, period_end, owner_user_id)
  VALUES ('annual', v_sv, 'TEST plan B', 'draft', '2028-01-01', '2028-12-31', v_user) RETURNING id INTO v_other_plan;

  INSERT INTO public.mkt_goals (plan_id, goal_class, name_ar, metric, unit, target_value, owner_user_id,
                                measurement_frequency, source_of_truth, aggregation_method, baseline_state, status)
  VALUES (v_plan, 'outcome', 'TEST goal A', 'leads', 'lead', 100, v_user,
          'monthly', 'crm_leads', 'sum', 'unknown', 'draft') RETURNING id INTO v_goal;
  INSERT INTO public.mkt_goals (plan_id, goal_class, name_ar, metric, unit, target_value, owner_user_id,
                                measurement_frequency, source_of_truth, aggregation_method, baseline_state, status)
  VALUES (v_other_plan, 'outcome', 'TEST goal B', 'leads', 'lead', 50, v_user,
          'monthly', 'crm_leads', 'sum', 'unknown', 'draft') RETURNING id INTO v_other_goal;

  -- ══ 1. A campaign code is issued by the database ═════════════════════════
  -- Test 2 + 3 of the acceptance list: creating an organic and a paid campaign
  -- without supplying a code at all.
  INSERT INTO public.mkt_internal_campaigns
    (name_ar, campaign_type, campaign_class, channel_mix, status, plan_id, primary_goal_id, owner_user_id)
  VALUES ('TEST organic', 'organic', 'organic', 'organic', 'planned', v_plan, v_goal, v_user)
  RETURNING id, code INTO v_c1, a;
  IF a !~ '^CMP-[0-9]{4,}$' THEN
    RAISE EXCEPTION 'FAILED: organic campaign got code "%" instead of a generated CMP-nnnn', a;
  END IF;
  RAISE NOTICE 'PASS: organic campaign created with no code supplied -> %', a;

  INSERT INTO public.mkt_internal_campaigns
    (name_ar, campaign_type, campaign_class, channel_mix, status, plan_id, primary_goal_id, owner_user_id)
  VALUES ('TEST paid', 'paid', 'paid', 'paid', 'planned', v_plan, v_goal, v_user)
  RETURNING id, code INTO v_c2, b;
  IF b !~ '^CMP-[0-9]{4,}$' THEN
    RAISE EXCEPTION 'FAILED: paid campaign got code "%" instead of a generated CMP-nnnn', b;
  END IF;
  IF a = b THEN
    RAISE EXCEPTION 'FAILED: two campaigns share the code %', a;
  END IF;
  RAISE NOTICE 'PASS: paid campaign created with no code supplied -> %', b;

  -- An explicit NULL must be refilled too. PostgREST sends nulls for empty
  -- fields, so relying on the column DEFAULT alone would not have covered it.
  INSERT INTO public.mkt_internal_campaigns
    (code, name_ar, campaign_type, campaign_class, channel_mix, status)
  VALUES (NULL, 'TEST null code', 'organic', 'organic', 'organic', 'draft') RETURNING code INTO c;
  IF c IS NULL OR c !~ '^CMP-' THEN
    RAISE EXCEPTION 'FAILED: an explicit NULL code was not refilled (got %)', c;
  END IF;
  RAISE NOTICE 'PASS: an explicitly null code is refilled -> %', c;

  -- ══ 2. Two concurrent creates cannot collide ═════════════════════════════
  -- The discriminator against MAX+1: asking twice with NO insert in between.
  -- MAX+1 returns the same string twice; a sequence cannot.
  a := public.mkt_next_campaign_code();
  b := public.mkt_next_campaign_code();
  IF a = b THEN
    RAISE EXCEPTION 'FAILED: code generation is not concurrency-safe — two calls returned %', a;
  END IF;
  RAISE NOTICE 'PASS: two code requests with no intervening insert differ (% vs %)', a, b;

  -- ══ 3. A new campaign must be organic or paid ════════════════════════════
  BEGIN
    INSERT INTO public.mkt_internal_campaigns (name_ar, campaign_type, channel_mix, status)
    VALUES ('TEST unclassified', 'organic', 'organic', 'draft');
    RAISE EXCEPTION 'FAILED: created a campaign with a null class';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: a new campaign must declare organic or paid';
  END;

  -- ══ 4. Cross-plan relationships are rejected ═════════════════════════════
  -- Acceptance test 9. Initiatives and programs already enforced this; the
  -- campaign path is the one that was missing.
  BEGIN
    INSERT INTO public.mkt_internal_campaigns
      (name_ar, campaign_type, campaign_class, channel_mix, status, plan_id, primary_goal_id)
    VALUES ('TEST cross plan', 'organic', 'organic', 'organic', 'draft', v_plan, v_other_goal);
    RAISE EXCEPTION 'FAILED: a campaign took a goal from another plan';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: a campaign goal must belong to the campaign plan';
  END;

  INSERT INTO public.mkt_initiatives (plan_id, name_ar, status, owner_user_id)
  VALUES (v_other_plan, 'TEST init other plan', 'proposed', v_user) RETURNING id INTO v_init;
  BEGIN
    INSERT INTO public.mkt_internal_campaigns
      (name_ar, campaign_type, campaign_class, channel_mix, status, plan_id, initiative_id)
    VALUES ('TEST cross init', 'organic', 'organic', 'organic', 'draft', v_plan, v_init);
    RAISE EXCEPTION 'FAILED: a campaign took an initiative from another plan';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: a campaign initiative must belong to the campaign plan';
  END;

  -- ══ 5. End before start is rejected ══════════════════════════════════════
  BEGIN
    INSERT INTO public.mkt_internal_campaigns
      (name_ar, campaign_type, campaign_class, channel_mix, status, start_date, end_date)
    VALUES ('TEST backwards', 'organic', 'organic', 'organic', 'draft', '2027-06-01', '2027-05-01');
    RAISE EXCEPTION 'FAILED: end date before start date was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: end date cannot precede start date';
  END;

  -- ══ 6. Outside the plan period needs a recorded override ═════════════════
  BEGIN
    INSERT INTO public.mkt_internal_campaigns
      (name_ar, campaign_type, campaign_class, channel_mix, status, plan_id, start_date, end_date)
    VALUES ('TEST outside', 'organic', 'organic', 'organic', 'draft', v_plan, '2026-12-01', '2027-02-01');
    RAISE EXCEPTION 'FAILED: dates outside the plan period were accepted with no override';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: dates outside the plan need an override';
  END;

  INSERT INTO public.mkt_internal_campaigns
    (name_ar, campaign_type, campaign_class, channel_mix, status, plan_id, start_date, end_date,
     period_override_reason)
  VALUES ('TEST outside ok', 'organic', 'organic', 'organic', 'draft', v_plan, '2026-12-01', '2027-02-01',
          'launch teaser runs before the plan opens')
  RETURNING id INTO v_legacy;
  IF (SELECT period_override_at FROM public.mkt_internal_campaigns WHERE id = v_legacy) IS NULL THEN
    RAISE EXCEPTION 'FAILED: an override was accepted without being stamped';
  END IF;
  RAISE NOTICE 'PASS: a recorded override allows the dates and is stamped';

  -- ══ 7. Activation is gated on completeness ═══════════════════════════════
  BEGIN
    UPDATE public.mkt_internal_campaigns SET status = 'active' WHERE id = v_legacy;
    RAISE EXCEPTION 'FAILED: activated a campaign with no goal and no owner';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: activation requires the completion checklist';
  END;

  UPDATE public.mkt_internal_campaigns
     SET status = 'active', start_date = '2027-02-01', end_date = '2027-03-01'
   WHERE id = v_c1;
  RAISE NOTICE 'PASS: a complete campaign activates';

  -- ══ 8. Type-missing and context-missing are DIFFERENT states ═════════════
  -- Acceptance test 7: an explicitly organic campaign with no goal is
  -- "strategic context incomplete", never "type unknown".
  INSERT INTO public.mkt_internal_campaigns
    (name_ar, campaign_type, campaign_class, channel_mix, status)
  VALUES ('TEST organic no goal', 'organic', 'organic', 'organic', 'draft') RETURNING id INTO v_legacy;
  IF (SELECT campaign_class FROM public.mkt_internal_campaigns WHERE id = v_legacy) IS DISTINCT FROM 'organic' THEN
    RAISE EXCEPTION 'FAILED: an explicitly organic campaign lost its class';
  END IF;
  IF NOT (SELECT needs_classification FROM public.mkt_internal_campaigns WHERE id = v_legacy) THEN
    RAISE EXCEPTION 'FAILED: a campaign with no plan or goal is not flagged as context-incomplete';
  END IF;
  RAISE NOTICE 'PASS: organic + no goal = context incomplete, class still organic';

  -- Attaching a plan and goal clears the flag by itself — nothing hand-sets it.
  UPDATE public.mkt_internal_campaigns SET plan_id = v_plan, primary_goal_id = v_goal WHERE id = v_legacy;
  IF (SELECT needs_classification FROM public.mkt_internal_campaigns WHERE id = v_legacy) THEN
    RAISE EXCEPTION 'FAILED: needs_classification stayed true after plan and goal were attached';
  END IF;
  RAISE NOTICE 'PASS: needs_classification is derived, not a stale backfill flag';

  -- ══ 9. Classifying a legacy campaign ═════════════════════════════════════
  -- Acceptance test 6. The legacy shape is a row with a NULL class, which no
  -- INSERT can now produce — so it is created the only way it exists in
  -- production: by predating the rule.
  INSERT INTO public.mkt_internal_campaigns
    (name_ar, campaign_type, campaign_class, channel_mix, status)
  VALUES ('TEST legacy', 'organic', 'organic', 'organic', 'draft') RETURNING id INTO v_legacy;
  UPDATE public.mkt_internal_campaigns SET campaign_class = NULL WHERE id = v_legacy;

  v_res := public.mkt_campaign_classify(v_legacy, 'paid', v_plan, v_goal);
  IF v_res->>'class_before' IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED: classify reported a prior class that did not exist';
  END IF;
  IF v_res->>'class_after' <> 'paid' THEN
    RAISE EXCEPTION 'FAILED: classify did not set the class (got %)', v_res->>'class_after';
  END IF;
  IF (SELECT channel_mix FROM public.mkt_internal_campaigns WHERE id = v_legacy) <> 'paid' THEN
    RAISE EXCEPTION 'FAILED: classify left channel_mix disagreeing with campaign_class';
  END IF;
  IF (v_res->>'needs_classification')::boolean THEN
    RAISE EXCEPTION 'FAILED: classify supplied plan and goal but left the record context-incomplete';
  END IF;
  RAISE NOTICE 'PASS: a legacy campaign is classified through the dedicated action';

  BEGIN
    PERFORM public.mkt_campaign_classify(v_legacy, 'sponsored');
    RAISE EXCEPTION 'FAILED: classify accepted a class outside organic/paid';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: classify refuses anything but organic or paid';
  END;

  -- ══ 10. Programs: a commitment is data, and there is no end date ═════════
  INSERT INTO public.mkt_programs
    (plan_id, primary_goal_id, name_ar, purpose, status, owner_user_id,
     commitment_count, commitment_unit, every_n_periods, output_type)
  VALUES (v_plan, v_goal, 'TEST weekly analytics', 'watch the numbers', 'draft', v_user,
          1, 'week', 1, 'analytics report') RETURNING id INTO v_prog;
  v_missing := public.mkt_program_missing_requirements(v_prog);
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED: a complete program still reports missing %', v_missing;
  END IF;
  RAISE NOTICE 'PASS: 1 analytics report every 1 week is a complete program';

  BEGIN
    UPDATE public.mkt_programs SET commitment_count = 0 WHERE id = v_prog;
    RAISE EXCEPTION 'FAILED: a program committed to producing zero outputs';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: a recurring output count must be positive';
  END;
  BEGIN
    UPDATE public.mkt_programs SET every_n_periods = 0 WHERE id = v_prog;
    RAISE EXCEPTION 'FAILED: a program repeated every zero periods';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: the repeat interval must be positive';
  END;

  -- ══ 11. Missing-requirement checklists agree with the constraints ════════
  v_missing := public.mkt_campaign_missing_requirements(v_c2);
  IF NOT ('objective' = ANY(v_missing)) OR NOT ('deliverables' = ANY(v_missing)) THEN
    RAISE EXCEPTION 'FAILED: campaign checklist missed objective/deliverables (got %)', v_missing;
  END IF;
  IF 'plan' = ANY(v_missing) OR 'primary_goal' = ANY(v_missing) THEN
    RAISE EXCEPTION 'FAILED: campaign checklist reported a plan or goal that IS set (%)', v_missing;
  END IF;
  RAISE NOTICE 'PASS: campaign checklist reports exactly what is absent';

  INSERT INTO public.mkt_initiatives (plan_id, primary_goal_id, name_ar, status, owner_user_id)
  VALUES (v_plan, v_goal, 'TEST empty initiative', 'proposed', v_user) RETURNING id INTO v_init;
  v_missing := public.mkt_initiative_missing_requirements(v_init);
  IF NOT ('execution' = ANY(v_missing)) THEN
    RAISE EXCEPTION 'FAILED: an initiative with no programs or campaigns was not flagged (%)', v_missing;
  END IF;
  RAISE NOTICE 'PASS: an initiative with no execution is flagged';

  -- ══ 12. Deleting something that carries evidence is refused ══════════════
  INSERT INTO public.mkt_platform_campaigns (campaign_id, platform, name, status)
  VALUES (v_c2, 'meta', 'TEST pc', 'draft');
  BEGIN
    DELETE FROM public.mkt_internal_campaigns WHERE id = v_c2;
    RAISE EXCEPTION 'FAILED: deleted a campaign that still carries an ad structure';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: a campaign with dependents cannot be deleted';
  END;

  -- A record with nothing hanging off it is still deletable, so the guard is a
  -- guard and not a blanket ban.
  DELETE FROM public.mkt_initiatives WHERE id = v_init;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAILED: could not delete an initiative with no dependents'; END IF;
  RAISE NOTICE 'PASS: a record with no dependents is still deletable';

  RAISE NOTICE 'ALL MARKETING PORTFOLIO TESTS PASSED';
END $$;

ROLLBACK;
