-- ============================================================================
-- Regression guard for the deterministic trend insight engine (2026-08-10).
--
--   psql "$DATABASE_URL" -f supabase/tests/mkt_trend_insights_test.sql
--
-- Every test runs inside a transaction that ROLLS BACK, so it is safe against
-- production and leaves no insights behind.
--
-- These guard the NOISE FLOORS specifically. The first live run of this engine
-- emitted 80 insights of which 66 were false positives — 56 "new marketer"
-- alerts that were really "we imported our data on one day", and 10 "new offer"
-- alerts that were feature taglines. An alert stream that cries wolf is worse
-- than no alert stream, so the floors are the thing most worth protecting.
-- ============================================================================
BEGIN;

-- ── A bulk import must NOT be reported as marketers arriving ────────────────
DO $$
DECLARE v_proj uuid; v_o1 uuid; v_o2 uuid; v_fired int;
BEGIN
  v_proj := gen_random_uuid();
  SELECT id INTO v_o1 FROM mkt_organizations ORDER BY id LIMIT 1;
  SELECT id INTO v_o2 FROM mkt_organizations ORDER BY id DESC LIMIT 1;
  IF v_o1 IS NULL OR v_o1 = v_o2 THEN RAISE NOTICE 'SKIP: need 2 orgs'; RETURN; END IF;

  -- two marketer links created in the SAME import batch
  INSERT INTO mkt_project_organizations
    (project_id, organization_id, relationship_type, first_observed_at, last_observed_at, confidence, is_active)
  VALUES (v_proj, v_o1, 'authorized_marketer', now(), now(), 1, true),
         (v_proj, v_o2, 'observed_marketer',   now(), now(), 1, true);

  PERFORM mkt_generate_trend_insights();
  SELECT count(*) INTO v_fired FROM mkt_insights
   WHERE kind = 'new_marketer' AND project_id = v_proj;

  IF v_fired > 0 THEN
    RAISE EXCEPTION 'FAILED: bulk import produced % new_marketer alerts (must be 0)', v_fired;
  END IF;
  RAISE NOTICE 'PASS: same-batch marketer links produce no arrival alerts';

  -- now a GENUINE arrival: an additional marketer, well after the first
  INSERT INTO mkt_project_organizations
    (project_id, organization_id, relationship_type, first_observed_at, last_observed_at, confidence, is_active)
  SELECT v_proj, o.id, 'observed_marketer', now(), now(), 0.9, true
  FROM mkt_organizations o
  WHERE o.id NOT IN (v_o1, v_o2) ORDER BY o.id LIMIT 1;

  UPDATE mkt_project_organizations
     SET first_observed_at = now() - interval '20 days'
   WHERE project_id = v_proj AND organization_id IN (v_o1, v_o2);

  PERFORM mkt_generate_trend_insights();
  SELECT count(*) INTO v_fired FROM mkt_insights
   WHERE kind = 'new_marketer' AND project_id = v_proj;

  IF v_fired < 1 THEN
    RAISE EXCEPTION 'FAILED: a genuine additional marketer did not fire (got %)', v_fired;
  END IF;
  RAISE NOTICE 'PASS: a genuine additional marketer fires (%)', v_fired;
END $$;

-- ── An `offer` without a commercial signal is a tagline, not an offer ───────
DO $$
DECLARE v_org uuid; v_post uuid; v_tag int; v_real int;
BEGIN
  -- MUST be an org that already has fact history: rule 5 deliberately ignores
  -- orgs with none, otherwise every value looks "new" the day collection starts.
  SELECT organization_id INTO v_org FROM mkt_observed_facts
   WHERE organization_id IS NOT NULL
   GROUP BY organization_id ORDER BY count(*) DESC LIMIT 1;
  SELECT id INTO v_post FROM mkt_content_posts
   WHERE organization_id = v_org ORDER BY id LIMIT 1;
  IF v_org IS NULL THEN RAISE NOTICE 'SKIP: no org with fact history'; RETURN; END IF;

  INSERT INTO mkt_observed_facts
    (fact_type, value_text, normalized_key, organization_id, content_post_id,
     source_type, source_id, extractor, confidence, observed_at)
  VALUES
    -- a slogan: no number, no currency, no commercial term
    ('offer', 'مساحات رحبة / Spacious Areas', '__test_tagline__', v_org, v_post,
     'visual_text', gen_random_uuid(), 'ocr', 0.7, now() - interval '2 days'),
    -- a real commercial offer
    ('offer', 'تقسيط حتى 60 شهر بدون فوائد', '__test_real_offer__', v_org, v_post,
     'visual_text', gen_random_uuid(), 'ocr', 0.7, now() - interval '2 days');

  PERFORM mkt_generate_trend_insights();

  SELECT count(*) INTO v_tag FROM mkt_insights
   WHERE kind = 'new_offer_detected' AND evidence->>'value' LIKE '%Spacious Areas%';
  SELECT count(*) INTO v_real FROM mkt_insights
   WHERE kind = 'new_offer_detected' AND evidence->>'value' LIKE '%تقسيط%';

  IF v_tag > 0 THEN
    RAISE EXCEPTION 'FAILED: a tagline was reported as a new offer';
  END IF;
  IF v_real < 1 THEN
    RAISE EXCEPTION 'FAILED: a real commercial offer (تقسيط حتى 60 شهر) did not fire';
  END IF;
  RAISE NOTICE 'PASS: taglines filtered, commercial offers kept';
END $$;

-- ── Every emitted insight must carry its evidence and its thresholds ────────
DO $$
DECLARE v_bad int;
BEGIN
  PERFORM mkt_generate_trend_insights();

  SELECT count(*) INTO v_bad FROM mkt_insights
   WHERE kind IN ('posting_frequency_change','advertiser_inactive','platform_shift',
                  'messaging_shift','new_offer_detected','new_marketer','price_movement')
     AND (evidence IS NULL OR evidence->>'rule' IS NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'FAILED: % trend insights lack evidence.rule (untraceable)', v_bad;
  END IF;
  RAISE NOTICE 'PASS: every trend insight carries evidence.rule';
END $$;

-- ── Idempotent within a period ──────────────────────────────────────────────
DO $$
DECLARE v_before bigint; v_after bigint;
BEGIN
  PERFORM mkt_generate_trend_insights();
  SELECT count(*) INTO v_before FROM mkt_insights;
  PERFORM mkt_generate_trend_insights();
  SELECT count(*) INTO v_after FROM mkt_insights;
  IF v_after <> v_before THEN
    RAISE EXCEPTION 'FAILED: re-running emitted % extra insights', v_after - v_before;
  END IF;
  RAISE NOTICE 'PASS: idempotent within the evaluation period';
  RAISE NOTICE 'ALL TREND-INSIGHT TESTS PASSED';
END $$;

ROLLBACK;
