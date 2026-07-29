-- WA-32 — stop a refused WhatsApp session from restarting forever, and stop it
-- from lying about having recovered.
--
-- Incident 2026-07-29. Both sessions were refused by WhatsApp with stream reason
-- 405 from 20:29 to 09:29 — 13 hours, straight through business hours, with no
-- inbound and no outbound reaching the CRM and nobody aware.
--
-- Two defects turned a recoverable refusal into that:
--
-- 1. NO ESCALATION. runWahaSessionWatchdog restarted any non-WORKING session
--    every 10 minutes forever — no cap, no backoff. Worse, each restart put the
--    session back into Baileys' internal reconnect loop, which retries a refused
--    login EVERY 2 SECONDS. Net: ~23,000 rejected logins per session against the
--    company's main WhatsApp number, which is exactly how a temporary refusal
--    becomes a permanent ban. It also wrote 70 MB of docker logs in ~2 hours,
--    rotating away the evidence of what originally broke.
--
-- 2. A DISHONEST SUCCESS. Every restart was logged status='success' because the
--    HTTP call succeeded — not because the session recovered. 78 consecutive
--    "successful" remediations of a session that never once reached WORKING.
--    That is the record that made a total outage look healthy.
--
-- The fix here is the shared state; the worker change is the other half:
-- restart -> verify -> STOP if it did not reach WORKING. A refused session then
-- costs ONE login attempt per backoff window instead of one every 2 seconds.

-- attempts already existed but was write-only: nothing ever reset it, so it
-- could not drive a backoff. These make it a real consecutive-failure counter.
ALTER TABLE public.waha_session_remediation
  ADD COLUMN IF NOT EXISTS last_outcome     text,
  ADD COLUMN IF NOT EXISTS last_recovered_at timestamptz,
  ADD COLUMN IF NOT EXISTS alerted_at        timestamptz;

-- Backoff is computed HERE, not passed in by the caller. Five worker machines
-- race this lock; if each supplied its own interval they would disagree about
-- when the next attempt is due and the shortest one would win every time.
CREATE OR REPLACE FUNCTION public.waha_try_remediation_lock(
  p_session text,
  p_min_interval_seconds integer DEFAULT 600
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
DECLARE
  v_key      bigint := hashtextextended(coalesce(p_session,''), 42);
  v_last     timestamptz;
  v_attempts integer := 0;
  v_wait     integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(v_key) THEN
    RETURN false;
  END IF;

  SELECT last_attempt_at, attempts INTO v_last, v_attempts
  FROM public.waha_session_remediation WHERE session = p_session;

  -- Exponential: 10m, 20m, 40m, 80m, 160m ... capped at 6h. A session WhatsApp
  -- is actively refusing must not be probed on a tight loop; the cap keeps a
  -- long outage cheap while still retrying unattended in case the block lifts.
  v_wait := least(
    greatest(p_min_interval_seconds, 60) * power(2, least(coalesce(v_attempts, 0), 6))::integer,
    21600
  );

  IF v_last IS NOT NULL AND v_last > now() - make_interval(secs => v_wait) THEN
    RETURN false;
  END IF;

  INSERT INTO public.waha_session_remediation (session, last_attempt_at, attempts)
  VALUES (p_session, now(), 1)
  ON CONFLICT (session) DO UPDATE
    SET last_attempt_at = now(),
        attempts = public.waha_session_remediation.attempts + 1;
  RETURN true;
END $$;

-- Called after the worker has VERIFIED the post-restart status. Recovery resets
-- the counter (so the next unrelated flap gets a fast first retry); failure
-- leaves it climbing so the backoff widens.
CREATE OR REPLACE FUNCTION public.waha_remediation_record_outcome(
  p_session   text,
  p_recovered boolean,
  p_outcome   text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
DECLARE
  v_attempts integer;
BEGIN
  INSERT INTO public.waha_session_remediation (session, last_attempt_at, attempts, last_outcome)
  VALUES (p_session, now(), 0, p_outcome)
  ON CONFLICT (session) DO UPDATE
    SET last_outcome      = p_outcome,
        attempts          = CASE WHEN p_recovered THEN 0 ELSE public.waha_session_remediation.attempts END,
        last_recovered_at = CASE WHEN p_recovered THEN now() ELSE public.waha_session_remediation.last_recovered_at END,
        -- clearing alerted_at on recovery re-arms the alarm for the next outage
        alerted_at        = CASE WHEN p_recovered THEN NULL ELSE public.waha_session_remediation.alerted_at END
  RETURNING attempts INTO v_attempts;
  RETURN coalesce(v_attempts, 0);
END $$;

-- Fires the "this is not recovering on its own" alert at most once per outage,
-- fleet-wide. Returns true only for the caller that should actually raise it.
CREATE OR REPLACE FUNCTION public.waha_should_alert_unrecoverable(
  p_session       text,
  p_min_attempts  integer DEFAULT 3
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $$
DECLARE
  v_attempts integer;
  v_alerted  timestamptz;
BEGIN
  SELECT attempts, alerted_at INTO v_attempts, v_alerted
  FROM public.waha_session_remediation WHERE session = p_session;

  IF coalesce(v_attempts, 0) < p_min_attempts OR v_alerted IS NOT NULL THEN
    RETURN false;
  END IF;

  UPDATE public.waha_session_remediation
    SET alerted_at = now() WHERE session = p_session AND alerted_at IS NULL;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.waha_remediation_record_outcome(text, boolean, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.waha_remediation_record_outcome(text, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public.waha_should_alert_unrecoverable(text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.waha_should_alert_unrecoverable(text, integer) TO service_role;
