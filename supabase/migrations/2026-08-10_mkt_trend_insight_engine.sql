-- ============================================================================
-- 2026-08-10 — Phase 5: deterministic trend insight engine.
--
-- EXTENDS the existing engine, does not replace it. The worker already emits
-- AD-LIFECYCLE insights during collection (new_creative, new_campaign,
-- campaign_ended, creative_reused, creative_burst, new_landing_page) — those are
-- event-shaped and fire the moment a thing appears. The seven rules here are
-- TREND-shaped: they need periodic evaluation across the whole corpus. New kinds
-- only, no collision. Both paths write through the SAME idempotent
-- mkt_insight_emit RPC.
--
-- NOISE CONTROL IS THE WHOLE DESIGN PROBLEM. A percentage change over 2 posts is
-- a rounding artifact, not intelligence. Every rule carries an explicit MINIMUM
-- VOLUME FLOOR, and the floor is recorded in the evidence so a reader can see the
-- basis of the claim rather than trusting the headline.
--
-- The FIRST live run proved this the hard way: 80 insights, 66 of them false —
-- 56 "new marketer" alerts that were really "we imported our data on one day",
-- and 10 "new offer" alerts that were feature taglines ("مساحات رحبة / Spacious
-- Areas"). Both rules were given the guards documented inline below, taking the
-- run to 14 genuine insights. Regression guard:
-- supabase/tests/mkt_trend_insights_test.sql.
--
-- Dedup keys embed the evaluation MONTH, so a rule re-fires next period when the
-- situation genuinely changes but cannot spam within one period.
--
-- ZERO AI. Every number is a SQL aggregate.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mkt_generate_trend_insights(
  p_window_days  int DEFAULT 30,
  p_min_prior    int DEFAULT 5,     -- volume floor for %-change claims
  p_change_pct   numeric DEFAULT 30 -- |change| needed to be worth saying
)
RETURNS TABLE(kind text, emitted int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_now      date := current_date;
  v_cur_from date := current_date - p_window_days;
  v_prv_from date := current_date - (p_window_days * 2);
  v_period   text := to_char(current_date, 'YYYY-MM');
  v_n        int;
BEGIN
  -- ── 1. Posting frequency changed (org) ────────────────────────────────────
  -- "Posting frequency increased 40%". Floor: the prior window must hold at
  -- least p_min_prior posts, else the ratio is meaningless.
  WITH windows AS (
    SELECT cp.organization_id,
           count(*) FILTER (WHERE cp.published_at >= v_cur_from) AS cur,
           count(*) FILTER (WHERE cp.published_at >= v_prv_from AND cp.published_at < v_cur_from) AS prv
    FROM mkt_content_posts cp
    WHERE cp.published_at >= v_prv_from AND cp.organization_id IS NOT NULL
    GROUP BY cp.organization_id
  ),
  scored AS (
    SELECT w.*, o.name_en, o.name_ar,
           round(100.0 * (w.cur - w.prv) / nullif(w.prv,0), 1) AS pct
    FROM windows w JOIN mkt_organizations o ON o.id = w.organization_id
    WHERE w.prv >= p_min_prior
      AND abs(round(100.0 * (w.cur - w.prv) / nullif(w.prv,0), 1)) >= p_change_pct
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'posting_frequency_change', 'pfc:' || organization_id::text || ':' || v_period,
      coalesce(name_ar, name_en) || ' — ' ||
        CASE WHEN pct > 0 THEN 'ارتفع النشر ' ELSE 'انخفض النشر ' END || abs(pct)::text || '%',
      NULL, CASE WHEN pct > 0 THEN 'opportunity' ELSE 'warning' END,
      organization_id, NULL, NULL,
      jsonb_build_object('rule','posting_frequency_change',
        'current_window_posts', cur, 'prior_window_posts', prv,
        'change_pct', pct, 'window_days', p_window_days,
        'window_current', jsonb_build_array(v_cur_from, v_now),
        'window_prior', jsonb_build_array(v_prv_from, v_cur_from),
        'threshold_pct', p_change_pct, 'min_prior_posts', p_min_prior))
    AS emitted_id FROM scored) z WHERE z.emitted_id IS NOT NULL;
  kind := 'posting_frequency_change'; emitted := v_n; RETURN NEXT;

  -- ── 2. Advertiser gone inactive ───────────────────────────────────────────
  -- "Competitor has gone inactive". Demonstrably active before, now silent
  -- across BOTH organic and paid.
  WITH prior_active AS (
    SELECT cp.organization_id, count(*) AS prv, max(cp.published_at) AS last_post
    FROM mkt_content_posts cp
    WHERE cp.published_at >= v_now - (p_window_days * 4) AND cp.published_at < v_cur_from
      AND cp.organization_id IS NOT NULL
    GROUP BY cp.organization_id HAVING count(*) >= p_min_prior
  ),
  silent AS (
    SELECT pa.*, o.name_en, o.name_ar FROM prior_active pa
    JOIN mkt_organizations o ON o.id = pa.organization_id
    WHERE NOT EXISTS (SELECT 1 FROM mkt_content_posts c2
                      WHERE c2.organization_id = pa.organization_id AND c2.published_at >= v_cur_from)
      AND NOT EXISTS (SELECT 1 FROM mkt_paid_ads a2
                      WHERE a2.organization_id = pa.organization_id
                        AND coalesce(a2.platform_started_at, a2.first_seen_at) >= v_cur_from)
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'advertiser_inactive', 'inact:' || organization_id::text || ':' || v_period,
      coalesce(name_ar, name_en) || ' — توقّف النشاط التسويقي',
      NULL, 'warning', organization_id, NULL, NULL,
      jsonb_build_object('rule','advertiser_inactive',
        'posts_in_prior_period', prv, 'last_post_at', last_post,
        'silent_since_days', p_window_days, 'checked_organic_and_paid', true,
        'min_prior_posts', p_min_prior))
    AS emitted_id FROM silent) z WHERE z.emitted_id IS NOT NULL;
  kind := 'advertiser_inactive'; emitted := v_n; RETURN NEXT;

  -- ── 3. Platform shift ─────────────────────────────────────────────────────
  -- "TikTok activity doubled". Per org+platform; ratio >= 2x or <= 0.5x.
  WITH pw AS (
    SELECT cp.organization_id, cp.platform,
           count(*) FILTER (WHERE cp.published_at >= v_cur_from) AS cur,
           count(*) FILTER (WHERE cp.published_at >= v_prv_from AND cp.published_at < v_cur_from) AS prv
    FROM mkt_content_posts cp
    WHERE cp.published_at >= v_prv_from AND cp.organization_id IS NOT NULL
    GROUP BY 1,2
  ),
  shifted AS (
    SELECT pw.*, o.name_en, o.name_ar,
           round((pw.cur::numeric) / nullif(pw.prv,0), 2) AS ratio
    FROM pw JOIN mkt_organizations o ON o.id = pw.organization_id
    WHERE pw.prv >= 3 AND (pw.cur >= pw.prv * 2 OR pw.cur * 2 <= pw.prv)
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'platform_shift',
      'pshift:' || organization_id::text || ':' || platform || ':' || v_period,
      coalesce(name_ar, name_en) || ' — ' || platform || ': ' ||
        CASE WHEN ratio >= 2 THEN 'تضاعف النشاط' ELSE 'تراجع النشاط للنصف' END,
      NULL, CASE WHEN ratio >= 2 THEN 'opportunity' ELSE 'info' END,
      organization_id, NULL, NULL,
      jsonb_build_object('rule','platform_shift', 'platform', platform,
        'current_window_posts', cur, 'prior_window_posts', prv, 'ratio', ratio,
        'window_days', p_window_days, 'min_prior_posts', 3))
    AS emitted_id FROM shifted) z WHERE z.emitted_id IS NOT NULL;
  kind := 'platform_shift'; emitted := v_n; RETURN NEXT;

  -- ── 4. Messaging shift ────────────────────────────────────────────────────
  -- "Installment messaging is increasing" / "drone content declined". Reads the
  -- fact layer, so it covers ANY fact family without new code.
  WITH fw AS (
    SELECT f.organization_id, f.fact_type,
           count(*) FILTER (WHERE f.observed_at >= v_cur_from) AS cur,
           count(*) FILTER (WHERE f.observed_at >= v_prv_from AND f.observed_at < v_cur_from) AS prv
    FROM mkt_observed_facts f
    WHERE f.observed_at >= v_prv_from AND f.organization_id IS NOT NULL
      AND f.fact_type IN ('payment_plan','financing','offer','content_type','price')
    GROUP BY 1,2
  ),
  shifted AS (
    SELECT fw.*, o.name_en, o.name_ar,
           round(100.0 * (fw.cur - fw.prv) / nullif(fw.prv,0), 1) AS pct
    FROM fw JOIN mkt_organizations o ON o.id = fw.organization_id
    WHERE fw.prv >= 3 AND abs(round(100.0 * (fw.cur - fw.prv) / nullif(fw.prv,0), 1)) >= 50
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'messaging_shift',
      'mshift:' || organization_id::text || ':' || fact_type || ':' || v_period,
      coalesce(name_ar, name_en) || ' — ' ||
        CASE WHEN pct > 0 THEN 'تزايد استخدام ' ELSE 'تراجع استخدام ' END || fact_type ||
        ' (' || abs(pct)::text || '%)',
      NULL, 'info', organization_id, NULL, NULL,
      jsonb_build_object('rule','messaging_shift', 'fact_type', fact_type,
        'current_window_observations', cur, 'prior_window_observations', prv,
        'change_pct', pct, 'window_days', p_window_days,
        'threshold_pct', 50, 'min_prior_observations', 3))
    AS emitted_id FROM shifted) z WHERE z.emitted_id IS NOT NULL;
  kind := 'messaging_shift'; emitted := v_n; RETURN NEXT;

  -- ── 5. New COMMERCIAL offer detected (noise-filtered) ─────────────────────
  -- The first live run emitted 10 of these, ALL feature taglines. The rule was
  -- faithfully reporting the fact layer; the fact layer's `offer` class includes
  -- slogans (same upstream precision issue as "Own The Luxury"). Two guards:
  --   (a) a bare `offer` must carry a COMMERCIAL SIGNAL — a number, currency,
  --       percent, or known commercial term. financing/payment_plan are
  --       inherently commercial and pass through.
  --   (b) the novelty key ignores punctuation, so "تحكم ذكي - Smart Control" and
  --       "تحكم ذكي / Smart Control" are ONE claim, not two.
  WITH first_seen AS (
    SELECT f.organization_id, f.fact_type,
           regexp_replace(lower(f.normalized_key), '[^[:alnum:][:space:]؀-ۿ]', '', 'g') AS novelty_key,
           min(f.observed_at) AS first_at,
           (array_agg(f.value_text ORDER BY f.observed_at))[1] AS sample_value,
           (array_agg(f.id ORDER BY f.observed_at))[1] AS sample_fact_id,
           (array_agg(f.content_post_id ORDER BY f.observed_at))[1] AS sample_post_id
    FROM mkt_observed_facts f
    WHERE f.fact_type IN ('offer','financing','payment_plan')
      AND f.organization_id IS NOT NULL
      AND (f.fact_type IN ('financing','payment_plan')
           OR f.value_text ~ '[0-9]'
           OR f.value_text ~* '(%|ريال|SAR|تقسيط|دفعة|خصم|تمويل|مجان|كاش|قسط|عرض خاص)')
    GROUP BY 1,2,3
  ),
  org_history AS (
    SELECT organization_id, min(observed_at) AS org_first_fact
    FROM mkt_observed_facts WHERE organization_id IS NOT NULL GROUP BY 1
  ),
  novel AS (
    -- the org must already have history, else every value is "new" the day we
    -- start collecting
    SELECT fs.*, o.name_en, o.name_ar FROM first_seen fs
    JOIN mkt_organizations o ON o.id = fs.organization_id
    JOIN org_history h ON h.organization_id = fs.organization_id
    WHERE fs.first_at >= v_cur_from AND h.org_first_fact < v_cur_from
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'new_offer_detected',
      'newoffer:' || organization_id::text || ':' || fact_type || ':' || left(novelty_key, 120),
      coalesce(name_ar, name_en) || ' — عرض جديد: ' || left(sample_value, 80),
      sample_value, 'opportunity', organization_id, NULL, NULL,
      jsonb_build_object('rule','new_offer_detected', 'fact_type', fact_type,
        'value', sample_value, 'novelty_key', novelty_key, 'first_observed_at', first_at,
        -- traceability: the exact fact row and the post it came from
        'source_fact_id', sample_fact_id, 'source_post_id', sample_post_id,
        'commercial_signal_required', fact_type = 'offer', 'window_days', p_window_days))
    AS emitted_id FROM novel) z WHERE z.emitted_id IS NOT NULL;
  kind := 'new_offer_detected'; emitted := v_n; RETURN NEXT;

  -- ── 6. New marketer on a project (import-safe) ────────────────────────────
  -- The first live run emitted 56 of these — every marketer link in the
  -- database, all created on 2026-07-22 by the bulk import. "We imported our
  -- data" is not "a new marketer entered this project". A FIRST observation
  -- cannot be called new; only an ADDITION to an already-known set can. Requires
  -- a prior marketer link on the same project, observed >= 1 day earlier.
  WITH entered AS (
    SELECT po.project_id, po.organization_id, po.relationship_type,
           po.first_observed_at, po.confidence, po.human_confirmed,
           o.name_en, o.name_ar, r.data->>'project_name' AS project_name,
           (SELECT min(p2.first_observed_at) FROM mkt_project_organizations p2
             WHERE p2.project_id = po.project_id
               AND p2.relationship_type IN ('authorized_marketer','observed_marketer')
               AND p2.organization_id <> po.organization_id) AS prior_marketer_at
    FROM mkt_project_organizations po
    JOIN mkt_organizations o ON o.id = po.organization_id
    LEFT JOIN unified_records r ON r.id = po.project_id
    WHERE po.relationship_type IN ('authorized_marketer','observed_marketer')
      AND po.first_observed_at >= v_cur_from
  ),
  additions AS (
    SELECT * FROM entered
    WHERE prior_marketer_at IS NOT NULL
      AND prior_marketer_at < first_observed_at - interval '1 day'
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'new_marketer',
      'newmkt:' || project_id::text || ':' || organization_id::text || ':' || relationship_type,
      'مسوّق جديد على ' || coalesce(project_name, 'مشروع') || ' — ' || coalesce(name_ar, name_en),
      NULL, 'opportunity', organization_id, project_id, NULL,
      jsonb_build_object('rule','new_marketer', 'relationship_type', relationship_type,
        'first_observed_at', first_observed_at,
        'prior_marketer_first_observed_at', prior_marketer_at,
        'link_confidence', confidence, 'human_confirmed', human_confirmed,
        'guard', 'requires an existing marketer on the project >= 1 day earlier, '
              || 'so a bulk import cannot be reported as arrivals',
        'window_days', p_window_days))
    AS emitted_id FROM additions) z WHERE z.emitted_id IS NOT NULL;
  kind := 'new_marketer'; emitted := v_n; RETURN NEXT;

  -- ── 7. Advertised price movement ──────────────────────────────────────────
  -- 3x window because price mentions are far rarer than posts; requires >= 2
  -- numeric observations on BOTH sides so one OCR read cannot move it.
  WITH pw AS (
    SELECT f.organization_id,
           avg(f.value_num) FILTER (WHERE f.observed_at >= v_now - (p_window_days*3)) AS cur_avg,
           count(*)         FILTER (WHERE f.observed_at >= v_now - (p_window_days*3)) AS cur_n,
           avg(f.value_num) FILTER (WHERE f.observed_at >= v_now - (p_window_days*6)
                                      AND f.observed_at <  v_now - (p_window_days*3)) AS prv_avg,
           count(*)         FILTER (WHERE f.observed_at >= v_now - (p_window_days*6)
                                      AND f.observed_at <  v_now - (p_window_days*3)) AS prv_n
    FROM mkt_observed_facts f
    WHERE f.fact_type = 'price' AND f.value_num IS NOT NULL
      AND f.organization_id IS NOT NULL AND f.observed_at >= v_now - (p_window_days*6)
    GROUP BY 1
  ),
  moved AS (
    SELECT pw.*, o.name_en, o.name_ar,
           round(100.0 * (pw.cur_avg - pw.prv_avg) / nullif(pw.prv_avg,0), 1) AS pct
    FROM pw JOIN mkt_organizations o ON o.id = pw.organization_id
    WHERE pw.cur_n >= 2 AND pw.prv_n >= 2
      AND abs(round(100.0 * (pw.cur_avg - pw.prv_avg) / nullif(pw.prv_avg,0), 1)) >= 10
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'price_movement', 'pmove:' || organization_id::text || ':' || v_period,
      coalesce(name_ar, name_en) || ' — ' ||
        CASE WHEN pct > 0 THEN 'ارتفاع الأسعار المعلنة ' ELSE 'انخفاض الأسعار المعلنة ' END
        || abs(pct)::text || '%',
      NULL, 'info', organization_id, NULL, NULL,
      jsonb_build_object('rule','price_movement',
        'current_avg', round(cur_avg), 'prior_avg', round(prv_avg),
        'current_observations', cur_n, 'prior_observations', prv_n,
        'change_pct', pct, 'currency', 'SAR', 'window_days', p_window_days * 3,
        'threshold_pct', 10, 'min_observations_each_side', 2))
    AS emitted_id FROM moved) z WHERE z.emitted_id IS NOT NULL;
  kind := 'price_movement'; emitted := v_n; RETURN NEXT;

  RETURN;
END $fn$;

GRANT EXECUTE ON FUNCTION public.mkt_generate_trend_insights(int,int,numeric) TO service_role, authenticated;

-- ── Run it on the EXISTING ops cadence, not a new scheduler ─────────────────
-- mkt_ops_evaluate() is already invoked periodically by the worker and on demand
-- from the admin Operations page, so appending one call gives the insight engine
-- a schedule with zero new infrastructure.
--
-- The existing body is preserved EXACTLY: this reads the deployed definition and
-- injects the call before the final RETURN rather than re-typing 3 KB of SQL and
-- risking a transcription error. Wrapped so a failure in insight generation
-- cannot break ops health monitoring, which is the more critical of the two.
DO $mig$
DECLARE
  v_def text;
  v_inject text := E'  BEGIN\n'
                || E'    PERFORM public.mkt_generate_trend_insights();\n'
                || E'  EXCEPTION WHEN OTHERS THEN\n'
                || E'    RAISE WARNING ''mkt_generate_trend_insights failed during ops evaluate: % (%)'', SQLERRM, SQLSTATE;\n'
                || E'  END;\n\n  RETURN jsonb_build_object(''evaluated_at''';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'mkt_ops_evaluate';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'mkt_ops_evaluate not found — cannot wire the trend engine';
  END IF;
  IF position('mkt_generate_trend_insights' IN v_def) > 0 THEN
    RAISE NOTICE 'trend engine already wired into mkt_ops_evaluate — skipping';
    RETURN;
  END IF;
  IF position('RETURN jsonb_build_object(''evaluated_at''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'mkt_ops_evaluate shape changed — refusing to patch blindly';
  END IF;

  EXECUTE replace(v_def, '  RETURN jsonb_build_object(''evaluated_at''', v_inject);
  RAISE NOTICE 'trend engine wired into mkt_ops_evaluate';
END $mig$;
