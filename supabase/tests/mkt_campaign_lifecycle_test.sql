-- ============================================================================
-- Campaign taxonomy, content counting, progress states and the status machine.
--
--   psql "$DATABASE_URL" -f supabase/tests/mkt_campaign_lifecycle_test.sql
--
-- Runs inside a transaction that ROLLS BACK, so it is safe against production.
-- Every assertion is a rejection that must happen or an arithmetic result; a
-- test that only checked "the row inserted" would pass against a schema with no
-- rules at all.
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_user uuid; v_sv uuid; v_plan uuid; v_goal uuid; v_other_plan uuid; v_other_goal uuid;
  v_org uuid; v_paid uuid; v_pc uuid; v_ag uuid;
  v_c1 uuid; v_c2 uuid; v_c3 uuid;
  v_counts jsonb; v_prog jsonb; v_next jsonb; n int; v_code1 text; v_code2 text;
BEGIN
  SELECT id INTO v_user FROM public.users LIMIT 1;
  IF v_user IS NULL THEN RAISE NOTICE 'SKIP: no users'; RETURN; END IF;

  -- ══ Fixtures ══════════════════════════════════════════════════════════════
  INSERT INTO public.mkt_strategy_versions
    (version_number, name_ar, status, approver_user_id, approved_at, effective_date)
  VALUES (9401, 'TEST استراتيجية الحملات', 'draft', v_user, now(), current_date)
  RETURNING id INTO v_sv;

  INSERT INTO public.mkt_plans (name_ar, plan_type, period_start, period_end, status,
                                owner_user_id, strategy_version_id)
  VALUES ('TEST خطة الحملات', 'annual', '2032-01-01', '2032-12-31', 'draft', v_user, v_sv)
  RETURNING id INTO v_plan;

  INSERT INTO public.mkt_goals (plan_id, goal_class, name_ar, metric, unit, target_value,
                                owner_user_id, measurement_frequency, source_of_truth,
                                aggregation_method, baseline_state, status)
  VALUES (v_plan, 'outcome', 'TEST هدف الحملات', 'عملاء محتملون', 'عميل', 100,
          v_user, 'monthly', 'crm_leads', 'sum', 'unknown', 'draft')
  RETURNING id INTO v_goal;

  -- A second plan, to prove cross-plan references are refused.
  INSERT INTO public.mkt_plans (name_ar, plan_type, period_start, period_end, status, owner_user_id)
  VALUES ('TEST خطة أخرى', 'annual', '2032-01-01', '2032-12-31', 'draft', v_user)
  RETURNING id INTO v_other_plan;
  INSERT INTO public.mkt_goals (plan_id, goal_class, name_ar, status)
  VALUES (v_other_plan, 'outcome', 'TEST هدف خطة أخرى', 'draft') RETURNING id INTO v_other_goal;

  -- ══ 1. Class is required, and is NOT the purpose ══════════════════════════
  BEGIN
    INSERT INTO public.mkt_internal_campaigns (name_ar, plan_id, primary_goal_id)
    VALUES ('TEST بلا نوع', v_plan, v_goal);
    RAISE EXCEPTION 'FAILED: created a campaign with no campaign_class';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a new campaign must say organic or paid';
  END;

  -- The old column accepted 'organic'/'paid' as a "type", which is what let the
  -- class go unset while the form still felt complete.
  BEGIN
    INSERT INTO public.mkt_internal_campaigns (name_ar, campaign_class, campaign_type, plan_id, primary_goal_id)
    VALUES ('TEST نوع قديم', 'organic', 'organic', v_plan, v_goal);
    RAISE EXCEPTION 'FAILED: campaign_type still accepts the class value ''organic''';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: organic/paid are no longer valid campaign purposes';
  END;

  -- ══ 2. Codes are issued by the database, unique, and never typed ══════════
  INSERT INTO public.mkt_internal_campaigns
    (name_ar, campaign_class, campaign_type, plan_id, primary_goal_id, owner_user_id,
     start_date, end_date, objective, deliverables)
  VALUES ('TEST حملة عضوية', 'organic', 'project_launch', v_plan, v_goal, v_user,
          '2032-02-01', '2032-03-31', 'جذب عملاء مؤهلين',
          '[{"label":"فيديو قصير","required":8,"completed":3}]'::jsonb)
  RETURNING id, code INTO v_org, v_code1;

  INSERT INTO public.mkt_internal_campaigns
    (name_ar, campaign_class, campaign_type, plan_id, primary_goal_id, owner_user_id,
     start_date, end_date, objective, deliverables, target_leads)
  VALUES ('TEST حملة مدفوعة', 'paid', 'lead_generation', v_plan, v_goal, v_user,
          '2032-02-01', '2032-03-31', 'حجوزات',
          '[{"label":"إبداع مدفوع","required":3,"completed":3}]'::jsonb, 100)
  RETURNING id, code INTO v_paid, v_code2;

  IF v_code1 IS NULL OR v_code2 IS NULL OR v_code1 = v_code2 THEN
    RAISE EXCEPTION 'FAILED: campaign codes were not issued distinctly (% / %)', v_code1, v_code2;
  END IF;
  IF v_code1 !~ '^CMP-[0-9]+$' OR v_code2 !~ '^CMP-[0-9]+$' THEN
    RAISE EXCEPTION 'FAILED: codes are not in the CMP-#### form (% / %)', v_code1, v_code2;
  END IF;
  RAISE NOTICE 'PASS: the database issued two distinct CMP codes with no input';

  -- ══ 3. channel_mix is derived, and 'both' is never created ════════════════
  IF (SELECT channel_mix FROM public.mkt_internal_campaigns WHERE id = v_org) <> 'organic'
     OR (SELECT channel_mix FROM public.mkt_internal_campaigns WHERE id = v_paid) <> 'paid' THEN
    RAISE EXCEPTION 'FAILED: channel_mix was not derived from campaign_class';
  END IF;
  -- Even if a caller insists on 'both', the class wins: organic and paid are
  -- sibling campaigns, not one campaign with a mixed channel.
  UPDATE public.mkt_internal_campaigns SET channel_mix = 'both' WHERE id = v_org;
  IF (SELECT channel_mix FROM public.mkt_internal_campaigns WHERE id = v_org) = 'both' THEN
    RAISE EXCEPTION 'FAILED: a new campaign was allowed to become channel_mix=both';
  END IF;
  RAISE NOTICE 'PASS: channel_mix follows the class and cannot be set to both';

  -- ══ 4. Cross-plan references are refused ══════════════════════════════════
  BEGIN
    UPDATE public.mkt_internal_campaigns SET primary_goal_id = v_other_goal WHERE id = v_org;
    RAISE EXCEPTION 'FAILED: accepted a goal from a different plan';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a goal from another plan is refused';
  END;

  BEGIN
    UPDATE public.mkt_internal_campaigns SET end_date = '2032-01-01' WHERE id = v_org;
    RAISE EXCEPTION 'FAILED: accepted an end date before the start date';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: an end date before the start date is refused';
  END;

  -- ══ 5. The status machine ═════════════════════════════════════════════════
  IF (SELECT status FROM public.mkt_internal_campaigns WHERE id = v_org) <> 'draft' THEN
    RAISE EXCEPTION 'FAILED: a new campaign did not start as a draft';
  END IF;

  -- draft → active is not a legal single step, whatever the campaign contains.
  BEGIN
    UPDATE public.mkt_internal_campaigns SET status = 'active' WHERE id = v_org;
    RAISE EXCEPTION 'FAILED: jumped draft -> active';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: draft cannot jump straight to active';
  END;

  UPDATE public.mkt_internal_campaigns SET status = 'planned' WHERE id = v_org;
  UPDATE public.mkt_internal_campaigns SET status = 'active'  WHERE id = v_org;
  RAISE NOTICE 'PASS: a complete organic campaign walks draft -> planned -> active';

  -- A paid campaign has nowhere to spend without a platform campaign.
  BEGIN
    UPDATE public.mkt_internal_campaigns SET status = 'planned' WHERE id = v_paid;
    RAISE EXCEPTION 'FAILED: a paid campaign was planned with no platform campaign';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a paid campaign needs a platform campaign before it advances';
  END;

  INSERT INTO public.mkt_platform_campaigns (campaign_id, platform, name, objective, status)
  VALUES (v_paid, 'meta', 'TEST حملة ميتا', 'leads', 'draft') RETURNING id INTO v_pc;
  UPDATE public.mkt_internal_campaigns SET status = 'planned' WHERE id = v_paid;
  UPDATE public.mkt_internal_campaigns SET status = 'active'  WHERE id = v_paid;
  RAISE NOTICE 'PASS: with a platform campaign the paid campaign advances';

  -- Terminal really is terminal.
  UPDATE public.mkt_internal_campaigns SET status = 'completed' WHERE id = v_org;
  UPDATE public.mkt_internal_campaigns SET status = 'archived'  WHERE id = v_org;
  BEGIN
    UPDATE public.mkt_internal_campaigns SET status = 'active' WHERE id = v_org;
    RAISE EXCEPTION 'FAILED: revived an archived campaign';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: archived is terminal';
  END;

  -- Every one of those moves is on the record, and the record cannot be edited.
  SELECT count(*) INTO n FROM public.mkt_campaign_status_history WHERE campaign_id = v_org;
  IF n < 4 THEN
    RAISE EXCEPTION 'FAILED: status history recorded only % of the transitions', n;
  END IF;
  IF (SELECT count(DISTINCT changed_at) FROM public.mkt_campaign_status_history
       WHERE campaign_id = v_org) <> n THEN
    RAISE EXCEPTION 'FAILED: history rows share a timestamp, so their order is undefined';
  END IF;
  RAISE NOTICE 'PASS: every transition is logged with a distinct, orderable timestamp';

  BEGIN
    UPDATE public.mkt_campaign_status_history SET to_status = 'active' WHERE campaign_id = v_org;
    RAISE EXCEPTION 'FAILED: rewrote campaign status history';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: status history cannot be edited';
  END;
  BEGIN
    DELETE FROM public.mkt_campaign_status_history WHERE campaign_id = v_org;
    RAISE EXCEPTION 'FAILED: deleted campaign status history';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: status history cannot be deleted';
  END;

  -- next_statuses must never offer a move the trigger would reject.
  v_next := public.mkt_campaign_next_statuses(v_org);
  IF jsonb_array_length(v_next) <> 0 THEN
    RAISE EXCEPTION 'FAILED: an archived campaign was offered transitions: %', v_next;
  END IF;
  RAISE NOTICE 'PASS: an archived campaign is offered no transitions';

  -- ══ 6. The four meanings of "campaign content", deduplicated ══════════════
  -- One item produced here; one produced elsewhere but reused here; one joined
  -- only by the legacy column; and the produced one ALSO used by a paid ad, to
  -- prove the union counts it once.
  INSERT INTO public.mkt_content_items (title, content_type, status, origin_campaign_id, campaign_id)
  VALUES ('TEST منتج هنا', 'reel', 'idea', v_org, v_org) RETURNING id INTO v_c1;
  INSERT INTO public.mkt_content_items (title, content_type, status)
  VALUES ('TEST معاد استخدامه', 'static_image', 'idea') RETURNING id INTO v_c2;
  INSERT INTO public.mkt_content_usage (content_item_id, usage_kind, campaign_id)
  VALUES (v_c2, 'campaign', v_org);
  -- A genuinely LEGACY row: campaign_id set, origin_campaign_id not. That shape
  -- can no longer be produced through the normal path, because
  -- mkt_ci_origin_sync keeps the two columns in lockstep on every write — which
  -- is precisely why "legacy" is a historical category. The trigger is disabled
  -- for this one insert to reconstruct a pre-trigger row; the whole transaction
  -- rolls back, and DISABLE TRIGGER is itself transactional.
  ALTER TABLE public.mkt_content_items DISABLE TRIGGER mkt_ci_origin_sync;
  INSERT INTO public.mkt_content_items (title, content_type, status, campaign_id, origin_campaign_id)
  VALUES ('TEST ارتباط قديم', 'carousel', 'idea', v_org, NULL) RETURNING id INTO v_c3;
  ALTER TABLE public.mkt_content_items ENABLE TRIGGER mkt_ci_origin_sync;

  INSERT INTO public.mkt_ad_groups (platform_campaign_id, name, status)
  VALUES (v_pc, 'TEST مجموعة', 'draft') RETURNING id INTO v_ag;
  INSERT INTO public.mkt_ads (ad_group_id, name, content_item_id, status)
  VALUES (v_ag, 'TEST إعلان', v_c1, 'draft');

  v_counts := public.mkt_campaign_content_counts(v_org);
  IF (v_counts->>'produced_content_count')::int <> 1 THEN
    RAISE EXCEPTION 'FAILED: produced count wrong: %', v_counts; END IF;
  IF (v_counts->>'reused_content_count')::int <> 1 THEN
    RAISE EXCEPTION 'FAILED: reused count wrong: %', v_counts; END IF;
  IF (v_counts->>'legacy_content_count')::int <> 1 THEN
    RAISE EXCEPTION 'FAILED: legacy count wrong: %', v_counts; END IF;
  -- v_c1 is reachable as produced AND (through the paid hierarchy) as a
  -- creative. Three relationships, three items — not four.
  IF (v_counts->>'unique_content_count')::int <> 3 THEN
    RAISE EXCEPTION 'FAILED: an item counted twice in the unique total: %', v_counts; END IF;
  RAISE NOTICE 'PASS: produced / reused / legacy are distinguished and deduplicated';

  v_counts := public.mkt_campaign_content_counts(v_paid);
  IF (v_counts->>'paid_creative_count')::int <> 1 THEN
    RAISE EXCEPTION 'FAILED: the ad creative was not counted for the paid campaign: %', v_counts; END IF;
  RAISE NOTICE 'PASS: creatives used by ads are reachable from the paid campaign';

  -- ══ 7. Three progress measures, three kinds of nothing ════════════════════
  v_prog := public.mkt_campaign_progress(v_org);
  IF v_prog->'deliverables'->>'state' <> 'measured'
     OR (v_prog->'deliverables'->>'done')::int <> 3
     OR (v_prog->'deliverables'->>'total')::int <> 8 THEN
    RAISE EXCEPTION 'FAILED: deliverable progress wrong: %', v_prog->'deliverables'; END IF;

  -- The organic campaign has no target_leads at all.
  IF v_prog->'outcome'->>'state' <> 'no_target' THEN
    RAISE EXCEPTION 'FAILED: a campaign with no target did not say so: %', v_prog->'outcome'; END IF;

  -- The paid one HAS a target and no measurement — which is not zero progress.
  v_prog := public.mkt_campaign_progress(v_paid);
  IF v_prog->'outcome'->>'state' <> 'awaiting_data' THEN
    RAISE EXCEPTION 'FAILED: a target with no reading was not reported as awaiting data: %',
      v_prog->'outcome'; END IF;
  RAISE NOTICE 'PASS: no-target, awaiting-data and measured are three different answers';

  -- And a genuine zero is reported as a zero, not as "no data".
  UPDATE public.mkt_internal_campaigns
     SET actual_results = '{"leads": 0}'::jsonb WHERE id = v_paid;
  v_prog := public.mkt_campaign_progress(v_paid);
  IF v_prog->'outcome'->>'state' <> 'measured' OR (v_prog->'outcome'->>'done')::numeric <> 0 THEN
    RAISE EXCEPTION 'FAILED: a measured zero was not reported as measured: %', v_prog->'outcome'; END IF;
  RAISE NOTICE 'PASS: a measured zero is a result, not a missing reading';

  RAISE NOTICE 'ALL CAMPAIGN LIFECYCLE TESTS PASSED';
END $$;

ROLLBACK;
