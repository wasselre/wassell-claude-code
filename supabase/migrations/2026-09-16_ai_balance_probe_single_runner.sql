-- ============================================================================
-- Balance-probe single-runner claim (2026-09-16)
--
-- WHY THIS EXISTS. The Fly app `wassel-deck-worker` runs FIVE general `app`
-- machines, and the hourly browser balance-probe tick
-- (`balanceProbeLoop` in worker/src/index.ts) is a TIMED loop, not a queue
-- poller. Every other loop on that worker claims rows with
-- FOR UPDATE SKIP LOCKED, so five machines racing is safe; a timed tick has
-- no such protection, so as written all five machines would fire the tick
-- every hour — ~5 Browserbase sessions per provider instead of 1 (real money,
-- plus Browserbase concurrency limits) and ~5 duplicate
-- `ai_provider_balance_probes` rows per provider, which makes the probe
-- history useless for seeing drift over time.
--
-- A read-then-act check ("was the last probe recent?") does not fix it: all
-- five machines boot together and therefore wake together, so several would
-- read "no recent probe" in the same instant and all proceed. The claim must
-- be ATOMIC IN POSTGRES.
--
-- An advisory lock is deliberately NOT the tool here: the worker reaches the
-- database through PostgREST, which does not hold connections, so a lock
-- cannot be held across calls. Instead the PRIMARY KEY on the hour bucket is
-- the lock — the database itself permits exactly one winner per hour.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_balance_probe_runs (
  hour_bucket timestamptz PRIMARY KEY,
  claimed_by  text,
  claimed_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ai_balance_probe_runs IS
  'One row per hour = one machine won the right to run the hourly balance-probe tick. The PRIMARY KEY is the mutex: the second claimant of an hour loses the ON CONFLICT race.';

ALTER TABLE public.ai_balance_probe_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_balance_probe_runs_admin_read ON public.ai_balance_probe_runs;
CREATE POLICY ai_balance_probe_runs_admin_read ON public.ai_balance_probe_runs
  FOR SELECT TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

REVOKE ALL ON public.ai_balance_probe_runs FROM anon;

/**
 * Try to claim the current UTC hour for this worker. Returns true only if
 * THIS call inserted the row — i.e. exactly one caller per hour wins, no
 * matter how many machines call in the same instant. The losers return false
 * and skip the tick; they retry next hour.
 *
 * Retention: the table grows one row per hour (~8.8k rows/year), which is
 * negligible, so no cleanup job is added on purpose.
 */
CREATE OR REPLACE FUNCTION public.ai_balance_probe_try_claim(p_worker text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_bucket timestamptz;
  v_rows   integer;
BEGIN
  IF NOT (auth.uid() IS NULL OR public.wassell_is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'ai_balance_probe_try_claim: admin only' USING ERRCODE = 'WS403';
  END IF;

  -- Explicit UTC on both sides of the AT TIME ZONE pair: derive the wall
  -- clock in UTC, then re-interpret it AS UTC. Never depend on the session
  -- TimeZone — two machines in different zones must agree on the bucket.
  v_bucket := date_trunc('hour', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc';

  INSERT INTO public.ai_balance_probe_runs (hour_bucket, claimed_by)
  VALUES (v_bucket, p_worker)
  ON CONFLICT (hour_bucket) DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$fn$;
