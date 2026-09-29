-- A portal saying "this client is already registered by another broker" is an
-- ANSWER, not a failure. Until now it could only end a run as 'failed', so the
-- chat card showed a red «فشل», the ops WhatsApp sent «❌ تعذّر…», and a rep
-- would reasonably press retry — which can never succeed.
--
-- New terminal status 'already_registered' + the RPC the worker calls when a
-- recipe step ends with `{"do":"fail","outcome":"already_registered"}`.
-- Same race posture as complete/fail: it only touches a LIVE row, so a cancel
-- or the watchdog always wins.
--
-- Backward compatible: widening a CHECK never breaks the deployed code, and
-- nothing writes the new status until the worker that knows about it ships.

BEGIN;

ALTER TABLE public.portal_registration_jobs DROP CONSTRAINT portal_registration_jobs_status_check;
ALTER TABLE public.portal_registration_jobs ADD CONSTRAINT portal_registration_jobs_status_check
  CHECK (status = ANY (ARRAY['queued','running','awaiting_input','done','failed','cancelled','already_registered']));

CREATE OR REPLACE FUNCTION public.portal_registration_job_already_registered(
  p_job_id uuid, p_message text, p_result jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  UPDATE public.portal_registration_jobs
     SET status = 'already_registered',
         error_message = p_message,
         result = COALESCE(p_result, '{}'::jsonb) || jsonb_build_object('outcome', 'already_registered'),
         input_request = NULL, input_value = NULL,
         finished_at = now(), updated_at = now()
   WHERE id = p_job_id AND status IN ('running', 'awaiting_input');
  RETURN FOUND;
END $fn$;

REVOKE ALL ON FUNCTION public.portal_registration_job_already_registered(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_already_registered(uuid, text, jsonb) TO service_role;

COMMIT;
