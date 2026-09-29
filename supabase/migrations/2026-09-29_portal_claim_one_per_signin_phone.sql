-- One live portal run per SIGN-IN PHONE, not just per portal.
--
-- claim_next allowed one live run per portal, on the premise that "the
-- sign-in phone only ever has one code outstanding". That premise breaks as
-- soon as two portals sign in with the SAME phone — Al Ramz and Safa both text
-- their codes to +966554446109. At the daily 12:00 check both runs could be
-- awaiting a code at once: two SMS land, and portal_otp_relay_inbound hands
-- the reply to whichever run asked LAST — possibly the wrong portal's code.
--
-- Now a queued run is claimable only if no live run exists for the same portal
-- OR for any portal that texts its code to the same phone. Portals that send
-- no code (otp_channel 'none', e.g. Riva) keep the per-portal rule.
-- Backward compatible: same signature, it only claims less eagerly.

BEGIN;

CREATE OR REPLACE FUNCTION public.portal_signin_phone_digits(p_portal_record_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT NULLIF(regexp_replace(
           COALESCE(NULLIF(r.data->>'otp_relay_phone', ''), r.data->>'login_phone', ''),
           '\D', '', 'g'), '')
    FROM public.records r
   WHERE r.id = p_portal_record_id
     AND COALESCE(NULLIF(r.data->>'otp_channel', ''), 'none') <> 'none';
$fn$;
REVOKE ALL ON FUNCTION public.portal_signin_phone_digits(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_signin_phone_digits(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.portal_registration_job_claim_next(p_worker_id text)
RETURNS SETOF portal_registration_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN QUERY
  UPDATE public.portal_registration_jobs j
     SET status = 'running', attempts = j.attempts + 1, worker_id = p_worker_id,
         started_at = now(), heartbeat_at = now(), updated_at = now()
   WHERE j.id = (
     SELECT q.id FROM public.portal_registration_jobs q
      WHERE q.status = 'queued'
        AND q.parked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.portal_registration_jobs l
           WHERE l.status IN ('running','awaiting_input')
             AND (l.portal_record_id = q.portal_record_id
                  OR (public.portal_signin_phone_digits(q.portal_record_id) IS NOT NULL
                      AND public.portal_signin_phone_digits(l.portal_record_id)
                        = public.portal_signin_phone_digits(q.portal_record_id))))
      ORDER BY q.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
  RETURNING j.*;
END $function$;

COMMIT;
