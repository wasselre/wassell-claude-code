-- Portal runs survive worker restarts (2026-10-05).
--
-- A registration that waits for a code can take minutes. Today the worker was
-- deployed / scaled 6 times in 90 minutes and two machines were OOM-killed;
-- each time the run on that machine died, the watchdog FAILED it 5 minutes
-- later, and nothing retried it. Measured on Safa: the phone owner's code
-- arrived at 08:13:09, the worker took it at 08:13:13, and a deploy killed the
-- machine at 08:13:20 — a lead lost to our own deploy, not to the portal.
--
-- Two paths back into the queue, both refusing once the run is SUBMITTING
-- (phase = 'committing', set by the worker when it enters a registration's
-- last phase). Past that point the portal may already hold the client, and a
-- second run could register them twice — that case still fails loudly for a
-- person to check.
--
--   1. portal_registration_job_handback — the worker, on SIGTERM, closes the
--      browser and calls this: the job goes straight back to 'queued' and the
--      next free machine starts it again (a new sign-in, so a new code).
--   2. portal_registration_jobs_watchdog — a job with no heartbeat for 5 min
--      (machine killed outright) is requeued the same way, up to 3 attempts.
--
-- A handed-back job is NOT parked: parked jobs wait for a WhatsApp reply,
-- these must be picked up immediately.

BEGIN;

CREATE OR REPLACE FUNCTION public.portal_registration_job_handback(p_job_id uuid, p_max_attempts int DEFAULT 5)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_attempts int; v_phase text;
BEGIN
  SELECT attempts, phase INTO v_attempts, v_phase FROM public.portal_registration_jobs
   WHERE id = p_job_id AND status IN ('running','awaiting_input')
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'gone'; END IF;
  IF v_phase = 'committing' THEN RETURN 'committing'; END IF;

  IF v_attempts >= p_max_attempts THEN
    UPDATE public.portal_registration_jobs
       SET status = 'failed', finished_at = now(), updated_at = now(),
           input_request = NULL, input_value = NULL,
           error_message = 'أُعيد تشغيل الخادم عدة مرات أثناء التسجيل — أُوقفت المحاولات. أعد المحاولة من زر «التسجيل في البوابة».' || E'\n' ||
                           'The worker restarted several times during this registration — stopped retrying. Retry from the Register in portal button.'
     WHERE id = p_job_id;
    RETURN 'failed';
  END IF;

  UPDATE public.portal_registration_jobs
     SET status = 'queued', updated_at = now(),
         input_request = NULL, input_value = NULL, input_requested_at = NULL, input_submitted_at = NULL,
         worker_id = NULL, browserbase_session_id = NULL, live_view_url = NULL, heartbeat_at = NULL,
         phase = 'handed_back',
         phase_ar = 'أُعيد تشغيل الخادم — يُستأنف التسجيل على جهاز آخر',
         phase_en = 'The worker restarted — resuming on another machine'
   WHERE id = p_job_id;
  RETURN 'requeued';
END $function$;

REVOKE ALL ON FUNCTION public.portal_registration_job_handback(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_handback(uuid, int) TO service_role;

-- Watchdog: verbatim from the live definition except the first sweep, which
-- now requeues a dead run that had not reached the submit step.
CREATE OR REPLACE FUNCTION public.portal_registration_jobs_watchdog()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int := 0; v_r int := 0; v_m int := 0; v_p int := 0;
BEGIN
  -- A dead machine before the submit step → back in the queue (≤ 3 attempts).
  UPDATE public.portal_registration_jobs
     SET status = 'queued', updated_at = now(),
         input_request = NULL, input_value = NULL, input_requested_at = NULL, input_submitted_at = NULL,
         worker_id = NULL, browserbase_session_id = NULL, live_view_url = NULL, heartbeat_at = NULL,
         phase = 'handed_back',
         phase_ar = 'توقف الخادم أثناء التسجيل — يُعاد على جهاز آخر',
         phase_en = 'The worker stopped during this run — retrying on another machine'
   WHERE status IN ('running','awaiting_input')
     AND COALESCE(heartbeat_at, started_at, created_at) < now() - interval '5 minutes'
     AND phase IS DISTINCT FROM 'committing'
     AND attempts < 3;
  GET DIAGNOSTICS v_r = ROW_COUNT;

  UPDATE public.portal_registration_jobs
     SET status = 'failed', finished_at = now(), updated_at = now(),
         error_message = CASE WHEN phase = 'committing'
           THEN 'توقف الخادم أثناء إرسال العميل إلى البوابة — تحقّق من البوابة قبل إعادة المحاولة، فقد يكون التسجيل قد تم.' || E'\n' ||
                'The worker stopped while submitting to the portal — check the portal before retrying; the registration may have gone through.'
           ELSE 'watchdog: the worker stopped responding (no heartbeat for 5 minutes)' END
   WHERE status IN ('running','awaiting_input')
     AND COALESCE(heartbeat_at, started_at, created_at) < now() - interval '5 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.portal_registration_jobs
     SET status = 'failed', finished_at = now(), updated_at = now(),
         error_message = 'watchdog: no worker claimed this job within 30 minutes (is the portal lane enabled on the worker?)'
   WHERE status = 'queued' AND parked_at IS NULL
     AND GREATEST(created_at, updated_at) < now() - interval '30 minutes';
  GET DIAGNOSTICS v_m = ROW_COUNT;

  UPDATE public.portal_registration_jobs
     SET status = 'failed', finished_at = now(), updated_at = now(), parked_at = NULL,
         error_message = 'لم يصل ردّ على واتساب العمليات خلال 7 أيام — أُلغي التسجيل التلقائي.' || E'\n' ||
                         'No reply on the ops WhatsApp within 7 days — automatic registration abandoned.'
   WHERE status = 'queued' AND parked_at < now() - interval '7 days';
  GET DIAGNOSTICS v_p = ROW_COUNT;
  RETURN v_r + v_n + v_m + v_p;
END $function$;

COMMIT;
