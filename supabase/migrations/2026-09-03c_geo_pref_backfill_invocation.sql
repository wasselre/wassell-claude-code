-- ────────────────────────────────────────────────────────────────────────────
-- Geography Understanding Ability — BACKFILL INVOCATION RPCs (v7). ADDITIVE.
--
-- The queue TABLE (public.geo_pref_backfill_jobs) is created by
-- 2026-09-03a_geo_preference_review_and_ops.sql. This migration adds the
-- invocation path on top of it: enqueue / claim / complete / fail / watchdog /
-- progress — the RPCs the backfill endpoint + runner drive (api/geo-preference/
-- backfill.ts → api/_lib/geoPreference/backfillRunner.ts).
--
-- Runs AFTER 2026-09-03a (…a < …c), so the table already exists; this only ALTERs
-- in two attribution columns (idempotent) and defines the functions. It matches
-- the existing shape: run_id is TEXT and the status CHECK already allows
-- pending/running/done/failed/skipped.
--
-- SAFETY: a backfill run only READS a client's history and writes review-first
-- `pending` rows to geo_pref_proposals. It NEVER contacts a customer and NEVER
-- writes a client's active preferences (auto_write stays off). Same "ship dark"
-- posture as the parent migrations — NOT applied to prod until the subsystem is
-- verified end-to-end; apply all four 2026-09-03* migrations together.
-- ────────────────────────────────────────────────────────────────────────────

BEGIN;

-- Attribution + freshness columns the invocation RPCs use (the table shipped
-- without them). Idempotent.
ALTER TABLE public.geo_pref_backfill_jobs ADD COLUMN IF NOT EXISTS worker_id  text;
ALTER TABLE public.geo_pref_backfill_jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Claim + resumability indexes (the base migration only indexed (run_id,status)).
CREATE INDEX IF NOT EXISTS geo_pref_backfill_pending_idx
  ON public.geo_pref_backfill_jobs (run_id, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS geo_pref_backfill_running_idx
  ON public.geo_pref_backfill_jobs (started_at) WHERE status = 'running';

-- ── enqueue ─────────────────────────────────────────────────────────────────
-- One pending job per (run_id, client_id). NULL/empty p_client_ids ⇒ the DEV
-- split from geo_pref_gold_split. ON CONFLICT DO NOTHING makes re-enqueue of the
-- same run idempotent (already-queued clients are counted as `skipped`).
CREATE OR REPLACE FUNCTION public.geo_pref_backfill_enqueue(
  p_run_id text,
  p_client_ids uuid[] DEFAULT NULL
) RETURNS TABLE (inserted int, skipped int, total int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_ids uuid[];
  v_ins int;
  v_total int;
BEGIN
  IF p_client_ids IS NULL OR array_length(p_client_ids, 1) IS NULL THEN
    SELECT array_agg(client_id) INTO v_ids
      FROM public.geo_pref_gold_split WHERE split = 'dev';
  ELSE
    SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_client_ids) AS x;
  END IF;

  v_total := COALESCE(array_length(v_ids, 1), 0);
  IF v_total = 0 THEN
    RETURN QUERY SELECT 0, 0, 0; RETURN;
  END IF;

  WITH ins AS (
    INSERT INTO public.geo_pref_backfill_jobs (run_id, client_id)
    SELECT p_run_id, x FROM unnest(v_ids) AS x
    ON CONFLICT (run_id, client_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_ins FROM ins;

  RETURN QUERY SELECT v_ins, (v_total - v_ins), v_total;
END;
$fn$;

-- ── claim ───────────────────────────────────────────────────────────────────
-- Claim the next runnable job for a run: a pending job, or a failed job still
-- under the attempts cap (so a re-run resumes pending + retryable-failed, never
-- done). Pending before retryable-failed, oldest first, so fresh work drains
-- before retries. FOR UPDATE SKIP LOCKED ⇒ no two workers claim the same job.
CREATE OR REPLACE FUNCTION public.geo_pref_backfill_claim_next(
  p_worker_id text,
  p_run_id text,
  p_max_attempts int DEFAULT 3
) RETURNS TABLE (job_id uuid, run_id text, client_id uuid, attempts int)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  UPDATE public.geo_pref_backfill_jobs j
     SET status = 'running', worker_id = p_worker_id, started_at = now(),
         updated_at = now(), attempts = j.attempts + 1
   WHERE j.id = (
     SELECT s.id FROM public.geo_pref_backfill_jobs s
      WHERE s.run_id = p_run_id
        AND (s.status = 'pending' OR (s.status = 'failed' AND s.attempts < p_max_attempts))
      ORDER BY (s.status = 'failed'), s.created_at
      FOR UPDATE SKIP LOCKED LIMIT 1
   )
   RETURNING j.id, j.run_id, j.client_id, j.attempts;
$fn$;

-- ── complete / fail ─────────────────────────────────────────────────────────
-- Both only touch status='running' rows: a late finish after the watchdog swept
-- the job is a harmless no-op.
CREATE OR REPLACE FUNCTION public.geo_pref_backfill_complete(p_job_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH updated AS (
    UPDATE public.geo_pref_backfill_jobs
       SET status = 'done', finished_at = now(), updated_at = now(), last_error = NULL
     WHERE id = p_job_id AND status = 'running'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM updated);
$fn$;

CREATE OR REPLACE FUNCTION public.geo_pref_backfill_fail(p_job_id uuid, p_error text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH updated AS (
    UPDATE public.geo_pref_backfill_jobs
       SET status = 'failed', finished_at = now(), updated_at = now(), last_error = p_error
     WHERE id = p_job_id AND status = 'running'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM updated);
$fn$;

-- ── watchdog ────────────────────────────────────────────────────────────────
-- Sweep jobs stuck 'running' > 30 min (crash / lost worker) back to 'failed'
-- with attempts preserved, so claim can retry them while under the cap.
CREATE OR REPLACE FUNCTION public.geo_pref_backfill_watchdog(p_run_id text DEFAULT NULL)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_n int;
BEGIN
  UPDATE public.geo_pref_backfill_jobs
     SET status = 'failed', finished_at = now(), updated_at = now(),
         last_error = 'backfill worker did not finish within 30 minutes'
   WHERE status = 'running' AND started_at < now() - interval '30 minutes'
     AND (p_run_id IS NULL OR run_id = p_run_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$fn$;

-- ── progress ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.geo_pref_backfill_progress(p_run_id text)
RETURNS TABLE (status text, count bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT j.status, count(*)::bigint
    FROM public.geo_pref_backfill_jobs j
   WHERE j.run_id = p_run_id
   GROUP BY j.status;
$fn$;

-- ── grants: service-role only (the backfill runs server-side under service role) ─
REVOKE ALL ON FUNCTION public.geo_pref_backfill_enqueue(text, uuid[])        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.geo_pref_backfill_claim_next(text, text, int)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.geo_pref_backfill_complete(uuid)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.geo_pref_backfill_fail(uuid, text)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.geo_pref_backfill_watchdog(text)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.geo_pref_backfill_progress(text)              FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.geo_pref_backfill_enqueue(text, uuid[])       TO service_role;
GRANT EXECUTE ON FUNCTION public.geo_pref_backfill_claim_next(text, text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.geo_pref_backfill_complete(uuid)             TO service_role;
GRANT EXECUTE ON FUNCTION public.geo_pref_backfill_fail(uuid, text)           TO service_role;
GRANT EXECUTE ON FUNCTION public.geo_pref_backfill_watchdog(text)             TO service_role;
GRANT EXECUTE ON FUNCTION public.geo_pref_backfill_progress(text)             TO service_role;

COMMIT;
