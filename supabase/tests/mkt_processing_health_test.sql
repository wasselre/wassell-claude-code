-- ============================================================================
-- Regression guard for silent-success monitoring (2026-08-12).
--
--   psql "$DATABASE_URL" -f supabase/tests/mkt_processing_health_test.sql
--
-- Runs inside a transaction that ROLLS BACK — safe against production.
--
-- What these protect: before this shipped, `content_process` reported 684
-- succeeded / 0 failed while 67 of those successes carried a dead OCR step —
-- four days of exhausted Anthropic credits, invisible. The queue-backlog alert
-- was equally blind: it counted `status='pending'`, a value the table's CHECK
-- constraint does not permit, so it had never once fired.
--
-- The failure mode being guarded is therefore NOT "the alert is wrong" but
-- "the alert cannot fire at all". Assert firing, not just absence.
-- ============================================================================
BEGIN;

-- ── The backlog alert must count a status that can actually exist ───────────
DO $$
DECLARE v_def text; v_allowed text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'mkt_ops_evaluate';

  IF position('status=''pending''' IN v_def) > 0 THEN
    RAISE EXCEPTION 'FAILED: mkt_ops_evaluate counts status=''pending'', which the CHECK constraint forbids — the backlog alert can never fire';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_allowed FROM pg_constraint
   WHERE conrelid = 'public.mkt_collection_jobs'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%status%' LIMIT 1;
  IF v_allowed IS NOT NULL AND position('''queued''' IN v_allowed) = 0 THEN
    RAISE EXCEPTION 'FAILED: queue status vocabulary changed — re-check the backlog alert';
  END IF;
  RAISE NOTICE 'PASS: backlog alert counts a legal status';
END $$;

-- ── The check must be wired onto the existing ops cadence ───────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'mkt_ops_evaluate'
       AND pg_get_functiondef(p.oid) LIKE '%mkt_check_processing_health%')
  THEN
    RAISE EXCEPTION 'FAILED: mkt_check_processing_health is not called by mkt_ops_evaluate — it would never run';
  END IF;
  RAISE NOTICE 'PASS: processing health runs on the ops cadence';
END $$;

-- ── An infrastructure-class failure must fire CRITICAL, then auto-resolve ───
DO $$
DECLARE v_id uuid; v_h jsonb; v_n int; v_sev text;
BEGIN
  INSERT INTO public.mkt_collection_jobs(kind, provider, status, error_message, finished_at, params)
  VALUES ('content_process','internal','failed',
          'content_process test did not complete: vision(infrastructure): Your credit balance is too low to access the Anthropic API',
          now(), '{}'::jsonb)
  RETURNING id INTO v_id;

  v_h := public.mkt_check_processing_health();
  IF (v_h->>'infrastructure')::int < 1 THEN
    RAISE EXCEPTION 'FAILED: the credit-exhaustion marker was not detected (%)', v_h;
  END IF;

  SELECT count(*), max(severity) INTO v_n, v_sev FROM public.mkt_ops_alerts
   WHERE dedup_key = 'processing_infrastructure' AND resolved_at IS NULL;
  IF v_n < 1 THEN RAISE EXCEPTION 'FAILED: no alert row emitted'; END IF;
  IF v_sev <> 'critical' THEN
    RAISE EXCEPTION 'FAILED: infrastructure failure emitted severity % (must be critical — it affects every subsequent post)', v_sev;
  END IF;
  RAISE NOTICE 'PASS: infrastructure failure fires critical';

  DELETE FROM public.mkt_collection_jobs WHERE id = v_id;
  PERFORM public.mkt_check_processing_health();
  SELECT count(*) INTO v_n FROM public.mkt_ops_alerts
   WHERE dedup_key = 'processing_infrastructure' AND resolved_at IS NULL;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FAILED: alert did not auto-resolve once the cause cleared (% unresolved)', v_n;
  END IF;
  RAISE NOTICE 'PASS: alert auto-resolves when the cause clears';
END $$;

-- ── Degradation must NOT be reported as failure ─────────────────────────────
-- An expired TikTok URL or a datacenter-blocked YouTube download is degradation
-- that retrying cannot fix. Treating it as failure would produce a retry storm;
-- on the real corpus 276 of 684 jobs were in this class.
DO $$
DECLARE v_id uuid; v_h jsonb; v_before int;
BEGIN
  v_before := ((SELECT public.mkt_check_processing_health())->>'failed')::int;

  INSERT INTO public.mkt_collection_jobs(kind, provider, status, result, finished_at, params)
  VALUES ('content_process','internal','succeeded',
          jsonb_build_object('degraded', true,
                             'errors', jsonb_build_array('youtube: bot_check on datacenter IP')),
          now(), '{}'::jsonb)
  RETURNING id INTO v_id;

  v_h := public.mkt_check_processing_health();
  IF (v_h->>'failed')::int <> v_before THEN
    RAISE EXCEPTION 'FAILED: a degraded-but-succeeded job was counted as a failure';
  END IF;
  IF (v_h->>'degraded')::int < 1 THEN
    RAISE EXCEPTION 'FAILED: degradation was not counted at all — it would stay invisible';
  END IF;
  RAISE NOTICE 'PASS: degradation counted as degraded, not failed';
  RAISE NOTICE 'ALL PROCESSING-HEALTH TESTS PASSED';
END $$;

ROLLBACK;
