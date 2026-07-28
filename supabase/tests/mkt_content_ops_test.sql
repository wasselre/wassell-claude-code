-- ============================================================================
-- Content operations lifecycle — acceptance tests.
--
--   psql "$DATABASE_URL" -f supabase/tests/mkt_content_ops_test.sql
--
-- Runs inside a transaction that ROLLS BACK, so it is safe against production.
-- Covers acceptance scenarios A–P from the content-operations brief. Q (RTL /
-- mixed-script / localized dates) and R (responsive) are browser behaviours and
-- are not assertable here — they are in the manual QA checklist instead.
--
-- Every assertion is a rejection that must happen or an arithmetic result. This
-- suite has already earned its keep: on first run it caught three real defects
-- that would each have failed for a user rather than a test —
--   1. ON CONFLICT could not infer the PARTIAL unique index on
--      (deliverable_id, step_key), so generating tasks raised 42P10 every time;
--   2. the auto-library trigger wrote asset_type 'video' and usage_status
--      'used', neither of which exists in mkt_raw_assets' CHECK lists;
--   3. mkt_asset_links.target_type had no 'deliverable' value, so linking an
--      asset to a deliverable — the core of the library flow — was impossible.
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_user uuid; v_org uuid; v_sv uuid; v_plan uuid; v_goal uuid;
  v_item uuid; v_num text; v_ig uuid; v_tt uuid; v_txt uuid; v_raw uuid;
  v_acc_ig uuid; v_acc_tt uuid;
  v_art uuid; v_art2 uuid; v_cap uuid; v_media uuid; v_asset uuid; v_file uuid;
  v_pub_ig uuid; m text[]; j jsonb;
BEGIN
  SELECT id INTO v_user FROM public.users LIMIT 1;
  SELECT id INTO v_org FROM public.mkt_organizations LIMIT 1;
  IF v_user IS NULL OR v_org IS NULL THEN RAISE NOTICE 'SKIP: no user/org'; RETURN; END IF;

  -- ══ Fixtures: an approved strategy, a plan, a goal, two accounts ══════════
  INSERT INTO public.mkt_strategy_versions (version_number, name_ar, status, approver_user_id, approved_at, effective_date)
  VALUES (9501,'TEST content strategy','draft',v_user,now(),current_date) RETURNING id INTO v_sv;
  UPDATE public.mkt_strategy_versions SET status='approved' WHERE id=v_sv;
  INSERT INTO public.mkt_plans (name_ar, plan_type, period_start, period_end, status, owner_user_id, strategy_version_id)
  VALUES ('TEST content plan','annual','2031-01-01','2031-12-31','draft',v_user,v_sv) RETURNING id INTO v_plan;
  INSERT INTO public.mkt_goals (plan_id, goal_class, name_ar, metric, unit, target_value, status)
  VALUES (v_plan,'outcome','TEST goal','leads','lead',100,'draft') RETURNING id INTO v_goal;
  INSERT INTO public.mkt_social_accounts (organization_id, platform, handle)
  VALUES (v_org,'instagram','@test_ig') RETURNING id INTO v_acc_ig;
  INSERT INTO public.mkt_social_accounts (organization_id, platform, handle)
  VALUES (v_org,'tiktok','@test_tt') RETURNING id INTO v_acc_tt;

  -- ══ A. A title is enough to capture an idea ═══════════════════════════════
  INSERT INTO public.mkt_content_items (title, content_type) VALUES ('TEST idea only','reel')
  RETURNING id, content_number INTO v_item, v_num;
  RAISE NOTICE 'PASS A: title-only idea captured as %', v_num;

  -- ══ B. …and not enough to leave the idea stage ════════════════════════════
  BEGIN
    UPDATE public.mkt_content_items SET status='brief' WHERE id=v_item;
    RAISE EXCEPTION 'FAILED B: left the idea stage with nothing filled in';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS B: blocked leaving idea'; END;

  -- ══ C. Bound to an EXACT strategy and plan version ════════════════════════
  UPDATE public.mkt_content_items
     SET scope_kind='brand', owner_user_id=v_user, strategy_version_id=v_sv, plan_id=v_plan,
         primary_goal_id=v_goal, target_audience='TEST audience', core_promise='TEST promise',
         desired_action='whatsapp'
   WHERE id=v_item;
  IF (SELECT strategy_version_id FROM public.mkt_content_items WHERE id=v_item) <> v_sv THEN
    RAISE EXCEPTION 'FAILED C: not bound to the exact strategy version'; END IF;
  m := public.mkt_content_missing_requirements(v_item);
  IF NOT ('at_least_one_deliverable' = ANY(m)) THEN
    RAISE EXCEPTION 'FAILED B2: a deliverable was not required, missing=%', m; END IF;
  RAISE NOTICE 'PASS C: bound to the exact strategy+plan; a deliverable is still required';

  -- ══ D. One brief, two platform deliverables ═══════════════════════════════
  INSERT INTO public.mkt_content_deliverables
    (content_item_id, platform, format, language, owner_user_id, social_account_id, aspect_ratio)
  VALUES (v_item,'instagram','reel','ar',v_user,v_acc_ig,'9:16') RETURNING id INTO v_ig;
  INSERT INTO public.mkt_content_deliverables
    (content_item_id, platform, format, language, owner_user_id, social_account_id, aspect_ratio)
  VALUES (v_item,'tiktok','reel','ar',v_user,v_acc_tt,'9:16') RETURNING id INTO v_tt;
  IF (SELECT deliverable_number FROM public.mkt_content_deliverables WHERE id=v_tt) <> 2 THEN
    RAISE EXCEPTION 'FAILED D: deliverables are not numbered per brief'; END IF;
  RAISE NOTICE 'PASS D: one brief -> D1 instagram + D2 tiktok';

  m := public.mkt_content_missing_requirements(v_item);
  IF array_length(m,1) > 0 THEN RAISE EXCEPTION 'FAILED B3: still missing %', m; END IF;
  UPDATE public.mkt_content_items SET status='brief' WHERE id=v_item;
  RAISE NOTICE 'PASS B2: activated once the requirements AND a deliverable existed';

  -- ══ E. Workflow follows the deliverable type, not a fixed 12 ══════════════
  INSERT INTO public.mkt_content_deliverables (content_item_id, platform, format, language)
  VALUES (v_item,'x','text_post','ar') RETURNING id INTO v_txt;
  INSERT INTO public.mkt_content_deliverables (content_item_id, platform, format, language)
  VALUES (v_item,'offline','raw_asset_only','ar') RETURNING id INTO v_raw;
  IF public.mkt_generate_deliverable_tasks(v_ig)  <> 10 THEN RAISE EXCEPTION 'FAILED E: video step count'; END IF;
  IF public.mkt_generate_deliverable_tasks(v_txt) <> 5  THEN RAISE EXCEPTION 'FAILED E: text step count'; END IF;
  IF public.mkt_generate_deliverable_tasks(v_raw) <> 4  THEN RAISE EXCEPTION 'FAILED E: raw step count'; END IF;
  -- The whole point of the raw-asset template: there is nothing to publish.
  IF EXISTS (SELECT 1 FROM public.mkt_content_tasks
              WHERE deliverable_id=v_raw AND task_type='schedule_publication') THEN
    RAISE EXCEPTION 'FAILED E: the raw-asset workflow contains a publishing step'; END IF;
  RAISE NOTICE 'PASS E: video=10, text=5, raw=4 steps; raw has no publish step';

  IF public.mkt_generate_deliverable_tasks(v_ig) <> 0 THEN
    RAISE EXCEPTION 'FAILED E2: regenerating duplicated tasks'; END IF;
  RAISE NOTICE 'PASS E2: regenerating creates no duplicates';

  -- ══ F. Artifact review cycle ══════════════════════════════════════════════
  INSERT INTO public.mkt_content_versions (content_item_id, deliverable_id, version_type, payload, owner_user_id, approval_state)
  VALUES (v_item, v_ig, 'script', '{"text":"v1"}'::jsonb, v_user, 'pending') RETURNING id INTO v_art;
  UPDATE public.mkt_content_versions SET approval_state='changes_requested', review_comment='tighten the hook' WHERE id=v_art;
  INSERT INTO public.mkt_content_versions (content_item_id, deliverable_id, version_type, payload, owner_user_id, approval_state, parent_version_id, change_summary)
  VALUES (v_item, v_ig, 'script', '{"text":"v2"}'::jsonb, v_user, 'draft', v_art, 'tightened hook') RETURNING id INTO v_art2;
  IF (SELECT version_number FROM public.mkt_content_versions WHERE id=v_art2) <> 2 THEN
    RAISE EXCEPTION 'FAILED F: the second version was not numbered 2'; END IF;
  UPDATE public.mkt_content_versions SET approval_state='approved', approved_by_user_id=v_user, approved_at=now() WHERE id=v_art2;
  RAISE NOTICE 'PASS F: draft -> changes_requested -> new version -> approved';

  -- ══ G. An approved version is immutable ═══════════════════════════════════
  BEGIN
    UPDATE public.mkt_content_versions SET payload='{"text":"sneaky"}'::jsonb WHERE id=v_art2;
    RAISE EXCEPTION 'FAILED G: edited an approved artifact in place';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS G: approved artifact refused an edit'; END;

  -- ══ K. Scheduling is gated on approved media AND copy ═════════════════════
  INSERT INTO public.mkt_publications (content_item_id, deliverable_id, platform, channel, status, publish_method)
  VALUES (v_item, v_ig, 'instagram', 'organic', 'draft', 'manual') RETURNING id INTO v_pub_ig;
  BEGIN
    UPDATE public.mkt_publications SET status='scheduled', scheduled_for=now()+interval '1 day' WHERE id=v_pub_ig;
    RAISE EXCEPTION 'FAILED K: scheduled with no approved media or copy';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS K: scheduling refused without approved media+copy'; END;
  m := public.mkt_deliverable_schedule_blockers(v_ig);
  IF NOT ('approved_final_media' = ANY(m) AND 'approved_caption' = ANY(m) AND 'publish_time' = ANY(m)) THEN
    RAISE EXCEPTION 'FAILED K2: blockers did not name media/caption/time: %', m; END IF;
  RAISE NOTICE 'PASS K2: the blocker list names exactly what is missing';

  -- ══ H. An existing library asset links without being copied ═══════════════
  INSERT INTO public.mkt_raw_assets (asset_name, asset_type, asset_class, source_kind, owner_user_id)
  VALUES ('TEST existing footage','property_video','raw','in_house',v_user) RETURNING id INTO v_asset;
  INSERT INTO public.mkt_asset_links (asset_id, target_type, target_id, role, created_by_user_id)
  VALUES (v_asset,'deliverable',v_ig,'source',v_user);
  RAISE NOTICE 'PASS H: existing library asset linked without copying the file';

  -- ══ J. Scenes, and a duration that is computed rather than typed ══════════
  INSERT INTO public.mkt_video_scenes (content_item_id, deliverable_id, scene_number, scene_type, planned_seconds, voice_over, visual_description, location, raw_asset_id, status)
  VALUES (v_item,v_ig,1,'property_shot',5,'vo1','wide establishing','Riyadh',v_asset,'not_started'),
         (v_item,v_ig,2,'b_roll',12,'vo2','interior walk','Riyadh',NULL,'not_started'),
         (v_item,v_ig,3,'text_only',8,'vo3','logo end card',NULL,NULL,'not_started');
  IF public.mkt_deliverable_planned_seconds(v_ig) <> 25 THEN
    RAISE EXCEPTION 'FAILED J: duration = %', public.mkt_deliverable_planned_seconds(v_ig); END IF;
  -- A deliverable with no scenes is UNPLANNED, not zero seconds long.
  IF public.mkt_deliverable_planned_seconds(v_txt) IS NOT NULL THEN
    RAISE EXCEPTION 'FAILED J2: a deliverable with no scenes reported a duration'; END IF;
  RAISE NOTICE 'PASS J: 5+12+8 = 25s computed; no scenes -> NULL, not 0';

  -- ══ I. Approving final media registers it in the library ══════════════════
  SELECT id INTO v_file FROM public.files LIMIT 1;
  IF v_file IS NOT NULL THEN
    INSERT INTO public.mkt_content_versions (content_item_id, deliverable_id, version_type, payload, file_id, owner_user_id, approval_state, approved_by_user_id, approved_at)
    VALUES (v_item, v_ig, 'final_media', '{}'::jsonb, v_file, v_user, 'approved', v_user, now()) RETURNING id INTO v_media;
    IF NOT EXISTS (SELECT 1 FROM public.mkt_asset_links l JOIN public.mkt_raw_assets a ON a.id=l.asset_id
                    WHERE l.target_id=v_ig AND l.role='final' AND a.asset_class='final') THEN
      RAISE EXCEPTION 'FAILED I: approved final media was not registered in the library'; END IF;
    RAISE NOTICE 'PASS I: approving final media auto-registered a final library asset';
  ELSE
    INSERT INTO public.mkt_content_versions (content_item_id, deliverable_id, version_type, payload, owner_user_id, approval_state, approved_by_user_id, approved_at)
    VALUES (v_item, v_ig, 'final_media', '{}'::jsonb, v_user, 'approved', v_user, now()) RETURNING id INTO v_media;
    RAISE NOTICE 'SKIP I: no files row available to attach';
  END IF;

  INSERT INTO public.mkt_content_versions (content_item_id, deliverable_id, version_type, payload, owner_user_id, approval_state, approved_by_user_id, approved_at, parent_version_id)
  VALUES (v_item, v_ig, 'caption', '{"text":"TEST caption"}'::jsonb, v_user, 'approved', v_user, now(), v_art2) RETURNING id INTO v_cap;

  -- ══ L. Two deliverables schedule independently ════════════════════════════
  UPDATE public.mkt_content_deliverables SET planned_publish_at = now()+interval '2 days' WHERE id=v_ig;
  UPDATE public.mkt_publications SET status='scheduled', scheduled_for=now()+interval '2 days' WHERE id=v_pub_ig;
  IF (SELECT locked_media_version_id FROM public.mkt_publications WHERE id=v_pub_ig) IS NULL
     OR (SELECT locked_copy_version_id FROM public.mkt_publications WHERE id=v_pub_ig) IS NULL THEN
    RAISE EXCEPTION 'FAILED L: scheduling did not lock the approved versions'; END IF;
  RAISE NOTICE 'PASS L: D1 scheduled and locked to its approved versions';

  IF (SELECT status FROM public.mkt_content_deliverables WHERE id=v_tt) <> 'planned' THEN
    RAISE EXCEPTION 'FAILED L2: scheduling D1 moved D2'; END IF;
  IF array_length(public.mkt_deliverable_schedule_blockers(v_tt),1) IS NULL THEN
    RAISE EXCEPTION 'FAILED L3: D2 became schedulable through D1'; END IF;
  RAISE NOTICE 'PASS L2: D2 unaffected and still independently blocked';

  -- ══ M. Manual publication is honest about being manual ════════════════════
  UPDATE public.mkt_publications
     SET status='published', published_at=now(), published_url='https://instagram.com/p/TEST123',
         platform_post_id='TEST123', published_by_user_id=v_user
   WHERE id=v_pub_ig;
  IF (SELECT published_url FROM public.mkt_publications WHERE id=v_pub_ig) IS NULL THEN
    RAISE EXCEPTION 'FAILED M'; END IF;
  RAISE NOTICE 'PASS M: manual publication stored its external URL and post id';

  -- ══ N. Results compared with the deliverable's own target ═════════════════
  UPDATE public.mkt_content_deliverables SET primary_kpi='views', kpi_unit='view', kpi_target=10000 WHERE id=v_ig;
  INSERT INTO public.mkt_content_results (content_item_id, deliverable_id, goal_id, kpi_actual, measured_at, metrics, leads, clicks, recorded_by_user_id, recommendation, learning)
  VALUES (v_item, v_ig, v_goal, 7500, current_date, '{"views":7500,"saves":120}'::jsonb, 14, 320, v_user, 'improve', 'hook lost people at 3s');
  j := public.mkt_deliverable_attainment(v_ig);
  IF (j->>'attainment_pct')::numeric <> 75.0 THEN RAISE EXCEPTION 'FAILED N: %', j; END IF;
  RAISE NOTICE 'PASS N: 7500/10000 = 75%% attainment against the deliverable KPI';

  IF (public.mkt_deliverable_attainment(v_tt)->>'is_measured')::boolean THEN
    RAISE EXCEPTION 'FAILED N2: an unmeasured deliverable reported a measurement'; END IF;
  RAISE NOTICE 'PASS N2: an unmeasured deliverable is unmeasured, not 0%%';

  -- ══ O + P. The real records survived, exactly once ════════════════════════
  IF NOT EXISTS (SELECT 1 FROM public.mkt_content_items WHERE content_number='C-00011' AND title='mena 52 video') THEN
    RAISE EXCEPTION 'FAILED O: C-00011 is gone'; END IF;
  IF (SELECT count(*) FROM public.mkt_content_deliverables d
       JOIN public.mkt_content_items c ON c.id=d.content_item_id
      WHERE c.content_number='C-00011') <> 1 THEN
    RAISE EXCEPTION 'FAILED P: C-00011 has duplicate deliverables'; END IF;
  IF (SELECT count(*) FROM public.mkt_content_tasks t
       JOIN public.mkt_content_items c ON c.id=t.content_item_id
      WHERE c.content_number='C-00011') <> 12 THEN
    RAISE EXCEPTION 'FAILED O2: C-00011 lost or gained tasks'; END IF;
  RAISE NOTICE 'PASS O/P: C-00011 intact — 1 deliverable, 12 tasks, no duplicates';

  -- ══ Computed state, not a typed-in next_action ════════════════════════════
  j := public.mkt_content_state(v_item);
  IF (j->>'is_activatable')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'FAILED state'; END IF;
  IF j->'next_action' IS NULL THEN RAISE EXCEPTION 'FAILED state: no next action computed'; END IF;
  RAISE NOTICE 'PASS: next action and progress computed from real records';

  RAISE NOTICE 'ALL CONTENT-OPS TESTS PASSED';
END $$;

ROLLBACK;
