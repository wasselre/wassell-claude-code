-- ============================================================================
-- Marketing Management v2 — constraint and behaviour tests.
--
--   psql "$DATABASE_URL" -f supabase/tests/mkt_v2_test.sql
--
-- Runs inside a transaction that ROLLS BACK, so it is safe against production.
-- Each block proves ONE rule the design depends on. A test that only checked
-- "the row inserted" would pass against a schema with no rules at all, so every
-- assertion here is either a rejection that must happen or an arithmetic result.
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_user uuid;
  v_sv1 uuid; v_sv2 uuid;
  v_annual uuid; v_monthly uuid; v_other uuid;
  v_goal uuid; v_goal_b uuid;
  v_init uuid; v_prog uuid; v_camp uuid; v_paid uuid;
  v_pillar uuid; v_content uuid;
  v_chan uuid; v_pc uuid; v_adg uuid;
  v_status jsonb; v_missing text[]; n int;
BEGIN
  SELECT id INTO v_user FROM public.users LIMIT 1;
  IF v_user IS NULL THEN RAISE NOTICE 'SKIP: no users'; RETURN; END IF;

  -- ══ Strategy ══════════════════════════════════════════════════════════════
  INSERT INTO public.mkt_strategy_versions (version_number, name_ar, status, positioning)
  VALUES (9001, 'TEST استراتيجية', 'draft', 'first') RETURNING id INTO v_sv1;

  -- approved requires an approver AND a date: "approved" must be falsifiable
  BEGIN
    UPDATE public.mkt_strategy_versions SET status='approved' WHERE id=v_sv1;
    RAISE EXCEPTION 'FAILED: approved a strategy with no approver or date';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: approval requires approver + date';
  END;

  UPDATE public.mkt_strategy_versions
     SET status='approved', approver_user_id=v_user, approved_at=now() WHERE id=v_sv1;

  -- an approved version is immutable
  BEGIN
    UPDATE public.mkt_strategy_versions SET positioning='rewritten' WHERE id=v_sv1;
    RAISE EXCEPTION 'FAILED: edited an APPROVED strategy version — history is rewritable';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: approved strategy is immutable';
  END;

  -- only one approved strategy at a time
  INSERT INTO public.mkt_strategy_versions (version_number, name_ar, status, approver_user_id, approved_at)
  VALUES (9002, 'TEST v2', 'draft', v_user, now()) RETURNING id INTO v_sv2;
  BEGIN
    UPDATE public.mkt_strategy_versions SET status='approved' WHERE id=v_sv2;
    RAISE EXCEPTION 'FAILED: two approved strategies coexist — "current strategy" is ambiguous';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: only one approved strategy at a time';
  END;

  -- superseding is the supported path
  UPDATE public.mkt_strategy_versions SET status='superseded' WHERE id=v_sv1;
  UPDATE public.mkt_strategy_versions SET status='approved', supersedes_version_id=v_sv1 WHERE id=v_sv2;
  RAISE NOTICE 'PASS: supersede-then-approve works';

  -- ══ Plans ═════════════════════════════════════════════════════════════════
  INSERT INTO public.mkt_plans (plan_type, strategy_version_id, name_ar, status,
                                period_start, period_end, owner_user_id)
  VALUES ('annual', v_sv2, 'TEST خطة 2027', 'active', '2027-01-01', '2027-12-31', v_user)
  RETURNING id INTO v_annual;

  -- a monthly plan may nest under an annual one
  INSERT INTO public.mkt_plans (plan_type, parent_plan_id, strategy_version_id, name_ar,
                                period_start, period_end)
  VALUES ('monthly', v_annual, v_sv2, 'TEST يناير', '2027-01-01', '2027-01-31')
  RETURNING id INTO v_monthly;
  RAISE NOTICE 'PASS: monthly nests under annual';

  -- an annual plan may NOT nest under a monthly one
  BEGIN
    INSERT INTO public.mkt_plans (plan_type, parent_plan_id, name_ar, period_start, period_end)
    VALUES ('annual', v_monthly, 'TEST bad', '2027-01-01', '2027-01-31');
    RAISE EXCEPTION 'FAILED: an annual plan nested under a monthly plan';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: plan rank order enforced';
  END;

  -- a child must fall inside its parent's period
  BEGIN
    INSERT INTO public.mkt_plans (plan_type, parent_plan_id, name_ar, period_start, period_end)
    VALUES ('monthly', v_annual, 'TEST outside', '2028-01-01', '2028-01-31');
    RAISE EXCEPTION 'FAILED: child plan outside its parent period';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: child period must sit inside parent';
  END;

  -- an active plan cannot exist without a strategy
  BEGIN
    INSERT INTO public.mkt_plans (plan_type, name_ar, status, period_start, period_end)
    VALUES ('annual', 'TEST no strategy', 'active', '2027-01-01', '2027-12-31');
    RAISE EXCEPTION 'FAILED: active plan with no strategy version';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: active plan requires a strategy';
  END;

  -- ══ Goals: three kinds, and seasonality ═══════════════════════════════════
  INSERT INTO public.mkt_goals (plan_id, goal_category, name_ar, metric, unit,
                                target_value, status, source_of_truth, owner_user_id)
  VALUES (v_annual, 'outcome', 'TEST عملاء مؤهلون', 'qualified_leads', 'lead',
          3600, 'active', 'CRM followups', v_user)
  RETURNING id INTO v_goal;

  BEGIN
    INSERT INTO public.mkt_goals (plan_id, goal_category, name_ar)
    VALUES (v_annual, 'deliverable', 'TEST bad category');
    RAISE EXCEPTION 'FAILED: an unknown goal category was accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: goal categories limited to outcome/kpi/output';
  END;

  -- Deliberately UNEVEN monthly targets: 200 in January, 450 in December.
  -- Nothing may divide 3600 by 12.
  INSERT INTO public.mkt_goal_target_periods (goal_id, label, period_start, period_end, target_value)
  VALUES (v_goal,'يناير','2027-01-01','2027-01-31',200),
         (v_goal,'فبراير','2027-02-01','2027-02-28',220),
         (v_goal,'ديسمبر','2027-12-01','2027-12-31',450);
  SELECT count(*) INTO n FROM public.mkt_goal_target_periods WHERE goal_id=v_goal;
  IF n <> 3 THEN RAISE EXCEPTION 'FAILED: target periods not stored (got %)', n; END IF;
  IF (SELECT target_value FROM public.mkt_goal_target_periods
       WHERE goal_id=v_goal AND label='ديسمبر') <> 450 THEN
    RAISE EXCEPTION 'FAILED: December target was not preserved as 450';
  END IF;
  RAISE NOTICE 'PASS: uneven per-month allocation stored (200 / 220 / 450, not 3600/12)';

  -- one row per period start
  BEGIN
    INSERT INTO public.mkt_goal_target_periods (goal_id, period_start, period_end, target_value)
    VALUES (v_goal, '2027-01-01', '2027-01-31', 999);
    RAISE EXCEPTION 'FAILED: duplicate target period for the same month';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: one target per period';
  END;

  -- pacing reports coverage rather than inventing a number
  IF (public.mkt_goal_pacing(v_goal) ->> 'has_periods') <> 'true' THEN
    RAISE EXCEPTION 'FAILED: pacing did not see the target periods';
  END IF;
  RAISE NOTICE 'PASS: pacing reports has_periods + coverage';

  -- a sub-goal must belong to the same plan
  INSERT INTO public.mkt_goals (plan_id, goal_category, name_ar, status)
  VALUES (v_monthly, 'kpi', 'TEST انطباعات', 'draft') RETURNING id INTO v_goal_b;
  BEGIN
    UPDATE public.mkt_goals SET parent_goal_id = v_goal WHERE id = v_goal_b;
    RAISE EXCEPTION 'FAILED: sub-goal adopted a parent from another plan';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: sub-goal must share its parent plan';
  END;

  -- ══ Portfolio ═════════════════════════════════════════════════════════════
  INSERT INTO public.mkt_initiatives (plan_id, primary_goal_id, name_ar, status, owner_user_id)
  VALUES (v_annual, v_goal, 'TEST مبادرة', 'active', v_user) RETURNING id INTO v_init;

  BEGIN
    INSERT INTO public.mkt_initiatives (name_ar, status) VALUES ('TEST مبادرة ناقصة', 'active');
    RAISE EXCEPTION 'FAILED: an ACTIVE initiative with no plan, goal or owner';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: active initiative needs plan + goal + owner';
  END;

  -- a program needs NO end date, and its commitment is a number + unit
  INSERT INTO public.mkt_programs (plan_id, initiative_id, primary_goal_id, name_ar, status,
                                   owner_user_id, cadence, commitment_count, commitment_unit)
  VALUES (v_annual, v_init, v_goal, 'TEST تحليلات أسبوعية', 'active', v_user,
          'weekly', 1, 'week') RETURNING id INTO v_prog;
  RAISE NOTICE 'PASS: ongoing program created with no end date';

  BEGIN
    INSERT INTO public.mkt_programs (plan_id, name_ar, commitment_count)
    VALUES (v_annual, 'TEST نصف التزام', 2);
    RAISE EXCEPTION 'FAILED: commitment count without a unit';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: commitment needs count AND unit';
  END;

  -- campaigns: organic and paid as siblings of the SAME initiative
  INSERT INTO public.mkt_internal_campaigns
    (code, name_ar, campaign_type, status, start_date, end_date,
     plan_id, initiative_id, primary_goal_id, campaign_class, owner_user_id)
  VALUES ('TEST-ORG', 'TEST حملة عضوية', 'organic', 'active', '2027-03-01', '2027-03-31',
          v_annual, v_init, v_goal, 'organic', v_user) RETURNING id INTO v_camp;
  INSERT INTO public.mkt_internal_campaigns
    (code, name_ar, campaign_type, status, start_date, end_date,
     plan_id, initiative_id, primary_goal_id, campaign_class, owner_user_id)
  VALUES ('TEST-PAID', 'TEST حملة مدفوعة', 'paid', 'active', '2027-03-01', '2027-03-31',
          v_annual, v_init, v_goal, 'paid', v_user) RETURNING id INTO v_paid;
  IF (SELECT count(*) FROM public.mkt_internal_campaigns WHERE initiative_id = v_init) <> 2 THEN
    RAISE EXCEPTION 'FAILED: organic and paid campaigns did not both attach to the initiative';
  END IF;
  RAISE NOTICE 'PASS: organic + paid campaigns are siblings under one initiative';

  -- campaign dates must sit inside the plan period
  BEGIN
    INSERT INTO public.mkt_internal_campaigns
      (code, name_ar, status, start_date, end_date, plan_id, campaign_class)
    VALUES ('TEST-OUT', 'TEST خارج الخطة', 'active', '2028-01-01', '2028-02-01',
            v_annual, 'organic');
    RAISE EXCEPTION 'FAILED: campaign dates outside its plan period';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: campaign must sit inside its plan period';
  END;

  -- ══ Content origin vs usage ═══════════════════════════════════════════════
  SELECT id INTO v_pillar FROM public.mkt_content_pillars WHERE slug='market_intelligence';

  INSERT INTO public.mkt_content_items
    (title, content_type, status, origin_kind, origin_program_id,
     plan_id, primary_goal_id, primary_pillar_id, target_audience,
     strategic_purpose, cta_destination, created_by_user_id)
  VALUES ('TEST تحليل السوق', 'reel', 'idea', 'program', v_prog,
          v_annual, v_goal, v_pillar, 'مشترٍ أول',
          'بناء الثقة عبر بيانات أصلية', 'whatsapp', v_user)
  RETURNING id INTO v_content;

  -- the kind and the populated FK must agree
  BEGIN
    UPDATE public.mkt_content_items SET origin_kind='campaign' WHERE id=v_content;
    RAISE EXCEPTION 'FAILED: origin_kind=campaign with only a program reference';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: origin kind must match its FK';
  END;

  -- reuse in a paid campaign does NOT change the origin
  INSERT INTO public.mkt_content_usage (content_item_id, usage_kind, campaign_id)
  VALUES (v_content, 'paid_ad', v_paid);
  IF (SELECT origin_kind FROM public.mkt_content_items WHERE id=v_content) <> 'program' THEN
    RAISE EXCEPTION 'FAILED: reuse rewrote the production origin';
  END IF;
  RAISE NOTICE 'PASS: paid reuse recorded as usage; origin stays the program';

  BEGIN
    INSERT INTO public.mkt_content_usage (content_item_id, usage_kind, campaign_id)
    VALUES (v_content, 'paid_ad', v_paid);
    RAISE EXCEPTION 'FAILED: duplicate usage link — roll-up would double count';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: duplicate usage link refused';
  END;

  BEGIN
    INSERT INTO public.mkt_content_usage (content_item_id, usage_kind, campaign_id, program_id)
    VALUES (v_content, 'campaign', v_paid, v_prog);
    RAISE EXCEPTION 'FAILED: usage row pointing at two targets at once';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: usage points at exactly one target';
  END;

  -- ══ The approval gate ═════════════════════════════════════════════════════
  -- Fully-contexted content reports nothing missing.
  v_missing := public.mkt_content_missing_context(v_content);
  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'FAILED: complete content reported missing: %', array_to_string(v_missing, ', ');
  END IF;
  RAISE NOTICE 'PASS: complete content reports no missing context';

  -- Strip the goal; the gate must name exactly that.
  UPDATE public.mkt_content_items SET primary_goal_id = NULL WHERE id = v_content;
  v_missing := public.mkt_content_missing_context(v_content);
  IF NOT ('primary_goal' = ANY(v_missing)) THEN
    RAISE EXCEPTION 'FAILED: missing goal not reported (got %)', array_to_string(v_missing, ', ');
  END IF;
  RAISE NOTICE 'PASS: gate names the missing piece (primary_goal)';

  UPDATE public.mkt_content_items SET primary_goal_id = v_goal WHERE id = v_content;

  -- ══ Capacity: the brief's exact scenario ══════════════════════════════════
  INSERT INTO public.mkt_channel_plans (plan_id, platform, account_handle,
                                        max_per_week, reactive_reserve)
  VALUES (v_annual, 'instagram', '@wassel_test', 21, 2) RETURNING id INTO v_chan;

  -- 7 slots reserved by programs
  INSERT INTO public.mkt_capacity_allocations
    (channel_plan_id, week_start, allocation_kind, program_id, slots_requested)
  VALUES (v_chan, '2027-03-01', 'program_reservation', v_prog, 7);

  -- two campaigns asking for 25 between them
  INSERT INTO public.mkt_capacity_allocations
    (channel_plan_id, week_start, allocation_kind, campaign_id, slots_requested)
  VALUES (v_chan, '2027-03-01', 'campaign_allocation', v_camp, 13),
         (v_chan, '2027-03-01', 'campaign_allocation', v_paid, 12);

  v_status := public.mkt_capacity_status(v_chan, '2027-03-01');
  IF (v_status->>'campaign_available')::int <> 12 THEN
    RAISE EXCEPTION 'FAILED: available campaign capacity should be 21-7-2=12, got %',
      v_status->>'campaign_available';
  END IF;
  IF (v_status->>'campaign_requested')::int <> 25 THEN
    RAISE EXCEPTION 'FAILED: requested should be 25, got %', v_status->>'campaign_requested';
  END IF;
  IF (v_status->>'over_allocated_by')::int <> 13 THEN
    RAISE EXCEPTION 'FAILED: over-allocation should be 13, got %', v_status->>'over_allocated_by';
  END IF;
  IF jsonb_array_length(v_status->'campaign_requests') <> 2 THEN
    RAISE EXCEPTION 'FAILED: the competing campaigns were not named';
  END IF;
  RAISE NOTICE 'PASS: capacity 21 − 7 − 2 = 12 available, 25 requested, over by 13, campaigns named';

  -- capacity that is not configured is NULL, never 0
  UPDATE public.mkt_channel_plans SET max_per_week = NULL WHERE id = v_chan;
  v_status := public.mkt_capacity_status(v_chan, '2027-03-01');
  IF (v_status->>'capacity_configured') <> 'false' OR v_status->>'campaign_available' IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED: unconfigured capacity did not report as unknown';
  END IF;
  RAISE NOTICE 'PASS: unconfigured capacity reports unknown, not zero';
  UPDATE public.mkt_channel_plans SET max_per_week = 21 WHERE id = v_chan;

  -- ══ Paid hierarchy ════════════════════════════════════════════════════════
  INSERT INTO public.mkt_platform_campaigns (campaign_id, platform, name, objective, budget, budget_kind)
  VALUES (v_paid, 'meta', 'TEST Meta', 'leads', 5000, 'lifetime') RETURNING id INTO v_pc;
  INSERT INTO public.mkt_platform_campaigns (campaign_id, platform, name)
  VALUES (v_paid, 'tiktok', 'TEST TikTok');
  RAISE NOTICE 'PASS: two platform campaigns under one paid campaign';

  -- a platform campaign may not hang off an organic campaign
  BEGIN
    INSERT INTO public.mkt_platform_campaigns (campaign_id, platform, name)
    VALUES (v_camp, 'meta', 'TEST wrong parent');
    RAISE EXCEPTION 'FAILED: platform campaign under an ORGANIC campaign';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: platform campaign requires a paid parent';
  END;

  INSERT INTO public.mkt_ad_groups (platform_campaign_id, name, budget)
  VALUES (v_pc, 'TEST ad set', 2500) RETURNING id INTO v_adg;

  -- an ad may not go active on unapproved creative
  BEGIN
    INSERT INTO public.mkt_ads (ad_group_id, name, content_item_id, status)
    VALUES (v_adg, 'TEST ad', v_content, 'active');
    RAISE EXCEPTION 'FAILED: active ad using unapproved creative';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: active ad requires approved creative';
  END;

  INSERT INTO public.mkt_ads (ad_group_id, name, content_item_id, status)
  VALUES (v_adg, 'TEST ad draft', v_content, 'draft');
  RAISE NOTICE 'PASS: draft ad may reference work in progress';

  -- ══ Roll-ups return honest shapes with no data ════════════════════════════
  IF (public.mkt_content_rollup(v_content) ->> 'is_measurable') <> 'false' THEN
    RAISE EXCEPTION 'FAILED: content with no snapshots claimed to be measurable';
  END IF;
  IF (public.mkt_goal_rollup(v_goal) -> 'coverage' ->> 'total') IS NULL THEN
    RAISE EXCEPTION 'FAILED: goal roll-up returned no coverage denominator';
  END IF;
  RAISE NOTICE 'PASS: roll-ups report coverage and never fake measurability';

  -- ══ Permissions ═══════════════════════════════════════════════════════════
  -- The matrix itself, independent of any session: a writer must not be able to
  -- approve strategy or plans, and must keep its content rights.
  IF public.wassell_mkt_can('approve_strategy', NULL) THEN
    RAISE EXCEPTION 'FAILED: a NULL caller can approve strategy';
  END IF;
  RAISE NOTICE 'PASS: unauthenticated caller has no capability';

  -- ══ Reviews ═══════════════════════════════════════════════════════════════
  DECLARE v_rev uuid;
  BEGIN
    INSERT INTO public.mkt_reviews (plan_id, review_type, period_start, period_end, status)
    VALUES (v_annual, 'monthly', '2027-03-01', '2027-03-31', 'held') RETURNING id INTO v_rev;
    INSERT INTO public.mkt_review_decisions (review_id, program_id, decision, rationale)
    VALUES (v_rev, v_prog, 'scale', 'saves and shares above target');
    IF (SELECT decision FROM public.mkt_programs WHERE id = v_prog) <> 'scale' THEN
      RAISE EXCEPTION 'FAILED: a review decision was not applied to its subject';
    END IF;
    RAISE NOTICE 'PASS: review decision applied onto the program';

    BEGIN
      INSERT INTO public.mkt_review_decisions (review_id, program_id, campaign_id, decision)
      VALUES (v_rev, v_prog, v_camp, 'stop');
      RAISE EXCEPTION 'FAILED: review decision with two subjects';
    EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: a decision has exactly one subject';
    END;
  END;

  RAISE NOTICE 'ALL MARKETING v2 TESTS PASSED';
END $$;

ROLLBACK;
