-- WA-08 + WA-19 — fleet-wide session remediation, and an honest state for a
-- send whose outcome we do not know.
--
-- WA-08. The restart debounce was a process-local Map, and wassel-deck-worker
-- runs FIVE machines — so one session flap could produce five concurrent
-- restarts, and a burst of 5xx sends five more. A restart drops whatever the
-- other machines have in flight on that session, and repeatedly restarting an
-- active session risks the pairing itself, which is the failure the Doha move
-- was meant to end.
--
-- pg_try_advisory_xact_lock is fleet-wide and self-releasing: the lock dies
-- with the transaction, so a machine crashing mid-restart cannot wedge it.
-- Verified: call 1 acquires, call 2 within the interval is refused, call 3
-- after it acquires again.
--
-- WA-19. The watchdog marked any job running >15 min as FAILED without checking
-- whether WhatsApp had accepted it. A delivered message recorded as failed
-- invites a resend — which is how a customer receives the same message twice.
-- 'unknown' says what we actually know, and nothing auto-retries it.

CREATE TABLE IF NOT EXISTS public.waha_session_remediation (
  session          text PRIMARY KEY,
  last_attempt_at  timestamptz NOT NULL DEFAULT now(),
  attempts         integer     NOT NULL DEFAULT 0
);
ALTER TABLE public.waha_session_remediation ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.waha_try_remediation_lock(
  p_session text,
  p_min_interval_seconds integer DEFAULT 600
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
DECLARE
  v_key bigint := hashtextextended(coalesce(p_session,''), 42);
  v_last timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(v_key) THEN
    RETURN false;
  END IF;

  SELECT last_attempt_at INTO v_last
  FROM public.waha_session_remediation WHERE session = p_session;

  IF v_last IS NOT NULL AND v_last > now() - make_interval(secs => p_min_interval_seconds) THEN
    RETURN false;
  END IF;

  INSERT INTO public.waha_session_remediation (session, last_attempt_at, attempts)
  VALUES (p_session, now(), 1)
  ON CONFLICT (session) DO UPDATE
    SET last_attempt_at = now(),
        attempts = public.waha_session_remediation.attempts + 1;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.waha_try_remediation_lock(text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.waha_try_remediation_lock(text, integer) TO service_role;

ALTER TABLE public.scheduled_whatsapp_jobs DROP CONSTRAINT IF EXISTS scheduled_whatsapp_jobs_status_check;
ALTER TABLE public.scheduled_whatsapp_jobs ADD CONSTRAINT scheduled_whatsapp_jobs_status_check
  CHECK (status = ANY (ARRAY['queued','running','sent','failed','cancelled','unknown']));

CREATE OR REPLACE FUNCTION public.scheduled_whatsapp_watchdog()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
DECLARE v_count int := 0;
BEGIN
  WITH swept AS (
    UPDATE public.scheduled_whatsapp_jobs
       SET status = 'unknown', finished_at = now(),
           error_message = 'Send worker did not finish within 15 minutes. The message MAY have been delivered — reconcile against the gateway before resending.'
     WHERE status = 'running' AND started_at < now() - interval '15 minutes'
     RETURNING 1)
  SELECT COUNT(*) INTO v_count FROM swept;
  RETURN v_count;
END $$;
