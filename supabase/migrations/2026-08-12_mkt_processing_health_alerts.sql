-- ============================================================================
-- Silent-success monitoring (2026-08-12).
--
-- Two defects of the same family — a green signal produced by not looking:
--
--   1. `content_process` jobs reported `succeeded` even when their OCR step died.
--      Measured on production before this migration: 684 succeeded, 0 failed,
--      and 67 of the successes carried a `vision:` error — the four days of
--      exhausted Anthropic credits, invisible because the queue never went red.
--      The worker fix (fatal vs degraded) makes those jobs fail. This migration
--      adds the alert so a human is TOLD rather than having to query.
--
--   2. The existing `queue_backlog` alert counts `status='pending'`, which the
--      table's CHECK constraint does not permit — the vocabulary is
--      (queued|running|succeeded|failed|cancelled). It has therefore never been
--      able to fire. A 167-job backlog was live and silent while this shipped.
--
-- Additive and reversible: one new function plus a surgical patch of the
-- deployed `mkt_ops_evaluate` body. No table, no column, no data touched.
-- ============================================================================

-- ── 1. Processing health: is the pipeline succeeding, or just reporting so? ──
CREATE OR REPLACE FUNCTION public.mkt_check_processing_health()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_window    numeric := mkt_setting_num('ops_processing_window_hours', 24);
  v_min_n     numeric := mkt_setting_num('ops_processing_min_sample', 10);
  v_deg_ratio numeric := mkt_setting_num('ops_processing_degraded_ratio', 0.5);
  v_fail_n    numeric := mkt_setting_num('ops_processing_failure_alert', 3);
  v_since     timestamptz;
  v_total int; v_failed int; v_degraded int; v_infra int;
  v_ratio numeric;
BEGIN
  v_since := now() - (v_window * interval '1 hour');

  SELECT
    count(*) FILTER (WHERE status IN ('succeeded','failed')),
    count(*) FILTER (WHERE status = 'failed'),
    -- Degraded: finished, but not cleanly. `degraded` is written by the worker;
    -- the errors-array test also catches rows written before it existed.
    count(*) FILTER (WHERE status = 'succeeded'
                       AND (result->>'degraded' = 'true'
                            OR jsonb_array_length(COALESCE(result->'errors','[]'::jsonb)) > 0)),
    -- Infrastructure class: our account or the transport, not this post's pixels.
    -- ONE of these is enough to alert — it will hit every subsequent post
    -- identically, which is exactly how the credit exhaustion spread unseen.
    count(*) FILTER (WHERE COALESCE(error_message,'') ILIKE '%vision(infrastructure)%'
                        OR COALESCE(result::text,'') ILIKE '%vision(infrastructure)%')
  INTO v_total, v_failed, v_degraded, v_infra
  FROM public.mkt_collection_jobs
  WHERE kind = 'content_process' AND finished_at >= v_since;

  v_ratio := CASE WHEN v_total > 0 THEN round(v_degraded::numeric / v_total, 3) ELSE 0 END;

  -- (a) infrastructure — critical, no sample threshold
  IF v_infra > 0 THEN
    PERFORM mkt_alert_emit(
      'processing_infrastructure', 'processing_infrastructure',
      'تعطّل في معالجة المحتوى — سبب خارجي', 'critical', 'system', 'content_process',
      v_infra || ' مهمة تعذّر فيها استخراج النص من الصور (رصيد/مصادقة/حد استخدام)',
      jsonb_build_object('window_hours', v_window, 'affected_jobs', v_infra,
                         'hint', 'check Anthropic credit balance and API key'));
  ELSE
    PERFORM mkt_alert_resolve('processing_infrastructure', 'content_process');
  END IF;

  -- (b) hard failures
  IF v_failed >= v_fail_n THEN
    PERFORM mkt_alert_emit(
      'processing_failures', 'processing_failures',
      'إخفاق في معالجة المحتوى', 'critical', 'system', 'content_process',
      v_failed || ' من ' || v_total || ' مهمة أخفقت',
      jsonb_build_object('window_hours', v_window, 'failed', v_failed, 'total', v_total,
                         'threshold', v_fail_n));
  ELSE
    PERFORM mkt_alert_resolve('processing_failures', 'content_process');
  END IF;

  -- (c) degraded rate — warning, and only on a real sample. Degradation is often
  -- legitimate and unfixable by retry (an expired TikTok URL, a datacenter-blocked
  -- YouTube download), so this is a "the pipeline is thinner than it looks"
  -- signal, NOT an error. Warning severity on purpose.
  IF v_total >= v_min_n AND v_ratio >= v_deg_ratio THEN
    PERFORM mkt_alert_emit(
      'processing_degraded', 'processing_degraded',
      'معالجة المحتوى ناقصة', 'warning', 'system', 'content_process',
      round(v_ratio * 100) || '% من المهام اكتملت بشكل جزئي',
      jsonb_build_object('window_hours', v_window, 'degraded', v_degraded,
                         'total', v_total, 'ratio', v_ratio, 'threshold', v_deg_ratio));
  ELSE
    PERFORM mkt_alert_resolve('processing_degraded', 'content_process');
  END IF;

  RETURN jsonb_build_object('window_hours', v_window, 'total', v_total, 'failed', v_failed,
                            'degraded', v_degraded, 'degraded_ratio', v_ratio,
                            'infrastructure', v_infra);
END $fn$;

GRANT EXECUTE ON FUNCTION public.mkt_check_processing_health() TO service_role, authenticated;

-- ── 2. Repair the backlog alert's impossible status value ───────────────────
-- Patches the DEPLOYED body rather than re-typing it, for the same reason the
-- trend engine was injected this way: transcribing 3 KB of live SQL to change
-- one word is how you lose the other 2,999 bytes.
DO $mig$
DECLARE v_def text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'mkt_ops_evaluate';
  IF v_def IS NULL THEN RAISE EXCEPTION 'mkt_ops_evaluate not found'; END IF;

  IF position('WHERE status=''pending''' IN v_def) = 0 THEN
    RAISE NOTICE 'backlog status already correct (or shape changed) — skipping';
  ELSE
    v_new := replace(v_def, 'WHERE status=''pending''', 'WHERE status=''queued''');
    EXECUTE v_new;
    RAISE NOTICE 'queue_backlog now counts queued jobs (was counting an impossible status)';
  END IF;
END $mig$;

-- ── 3. Wire the check onto the EXISTING ops cadence ─────────────────────────
-- Same injection posture as the trend engine: append before the final RETURN,
-- wrapped so a failure here cannot break ops health monitoring itself.
DO $mig$
DECLARE
  v_def text;
  v_inject text := E'  BEGIN\n'
                || E'    PERFORM public.mkt_check_processing_health();\n'
                || E'  EXCEPTION WHEN OTHERS THEN\n'
                || E'    RAISE WARNING ''mkt_check_processing_health failed during ops evaluate: % (%)'', SQLERRM, SQLSTATE;\n'
                || E'  END;\n\n  RETURN jsonb_build_object(''evaluated_at''';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'mkt_ops_evaluate';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'mkt_ops_evaluate not found — cannot wire the processing health check';
  END IF;
  IF position('mkt_check_processing_health' IN v_def) > 0 THEN
    RAISE NOTICE 'processing health already wired into mkt_ops_evaluate — skipping';
    RETURN;
  END IF;
  IF position('RETURN jsonb_build_object(''evaluated_at''' IN v_def) = 0 THEN
    RAISE EXCEPTION 'mkt_ops_evaluate shape changed — refusing to patch blindly';
  END IF;

  EXECUTE replace(v_def, '  RETURN jsonb_build_object(''evaluated_at''', v_inject);
  RAISE NOTICE 'processing health check wired into mkt_ops_evaluate';
END $mig$;
