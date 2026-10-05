-- Live operator proof: requires the configured Binghatti email portal and migration14.
-- Creates only synthetic jobs/claims inside BEGIN/ROLLBACK; reads the saved mailbox
-- solely to compute its hash. No email address, OTP or credential is emitted.
BEGIN;
DO $verify$
DECLARE
  v_job uuid := gen_random_uuid();
  v_second_job uuid := gen_random_uuid();
  v_portal uuid := '0f828ff1-c3b9-482c-8b1d-215bef4b4d43';
  v_fingerprint text;
  v_schema text;
  v_request jsonb := jsonb_build_object('key','otp','kind','otp','email_otp_nonce','00000000-0000-4000-8000-000000000001');
  v_ok boolean;
BEGIN
  SELECT n.nspname INTO v_schema FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto';
  EXECUTE format('SELECT encode(%I.digest(lower(btrim(data->>''login_id'')),''sha256''),''hex'') FROM public.records WHERE id=$1',v_schema)
    INTO v_fingerprint USING v_portal;
  IF v_fingerprint IS NULL THEN RAISE EXCEPTION 'mailbox fingerprint missing'; END IF;
  IF EXISTS(SELECT 1 FROM public.portal_registration_jobs WHERE portal_record_id=v_portal AND kind='status_check' AND status IN ('queued','running','awaiting_input')) THEN
    RAISE EXCEPTION 'existing active capture; do not interfere';
  END IF;
  INSERT INTO public.portal_registration_jobs(id,portal_record_id,kind,status,input_request,heartbeat_at)
    VALUES(v_job,v_portal,'status_check','awaiting_input',v_request,now());
  v_ok := public.portal_email_otp_claim(v_job,'otp',repeat('0',64),'a123456789abcdef','00000000-0000-4000-8000-000000000001');
  IF v_ok THEN RAISE EXCEPTION 'incorrect mailbox accepted'; END IF;
  v_ok := public.portal_email_otp_claim(v_job,'other',v_fingerprint,'a123456789abcdef','00000000-0000-4000-8000-000000000001');
  IF v_ok THEN RAISE EXCEPTION 'incorrect key accepted'; END IF;
  v_ok := public.portal_email_otp_claim(v_job,'otp',v_fingerprint,'a123456789abcdef','00000000-0000-4000-8000-000000000002');
  IF v_ok THEN RAISE EXCEPTION 'incorrect nonce accepted'; END IF;
  UPDATE public.portal_registration_jobs SET input_value='manual-answer' WHERE id=v_job;
  v_ok := public.portal_email_otp_claim(v_job,'otp',v_fingerprint,'a123456789abcdef','00000000-0000-4000-8000-000000000001');
  IF v_ok THEN RAISE EXCEPTION 'manual answer lost race'; END IF;
  IF EXISTS(SELECT 1 FROM public.portal_email_otp_claims WHERE job_id=v_job) THEN RAISE EXCEPTION 'rejected request claimed message'; END IF;
  UPDATE public.portal_registration_jobs SET input_value=NULL WHERE id=v_job;
  v_ok := public.portal_email_otp_claim(v_job,'otp',v_fingerprint,'a123456789abcdef','00000000-0000-4000-8000-000000000001');
  IF NOT v_ok THEN RAISE EXCEPTION 'valid claim rejected'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.portal_registration_jobs WHERE id=v_job AND status='running' AND input_value IS NULL AND input_request IS NULL) THEN
    RAISE EXCEPTION 'claim failed atomic resume';
  END IF;
  IF (SELECT count(*) FROM public.portal_email_otp_claims WHERE job_id=v_job) <> 1 THEN RAISE EXCEPTION 'claim row missing'; END IF;
  DELETE FROM public.portal_registration_jobs WHERE id=v_job;
  IF NOT EXISTS(SELECT 1 FROM public.portal_email_otp_claims WHERE mailbox_fingerprint=v_fingerprint AND message_id='a123456789abcdef' AND job_id IS NULL) THEN RAISE EXCEPTION 'job cleanup erased replay marker'; END IF;
  INSERT INTO public.portal_registration_jobs(id,portal_record_id,kind,status,input_request,heartbeat_at)
    VALUES(v_second_job,v_portal,'status_check','awaiting_input',v_request,now());
  v_ok := public.portal_email_otp_claim(v_second_job,'otp',v_fingerprint,'a123456789abcdef','00000000-0000-4000-8000-000000000001');
  IF v_ok THEN RAISE EXCEPTION 'message reused across jobs'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.portal_registration_jobs WHERE id=v_second_job AND status='awaiting_input') THEN RAISE EXCEPTION 'reuse attempt resumed job'; END IF;
  UPDATE public.portal_registration_jobs SET status='cancelled' WHERE id=v_second_job;
  v_ok := public.portal_email_otp_claim(v_second_job,'otp',v_fingerprint,'b123456789abcdef','00000000-0000-4000-8000-000000000001');
  IF v_ok THEN RAISE EXCEPTION 'cancelled job resumed'; END IF;
  IF EXISTS(SELECT 1 FROM public.portal_email_otp_claims WHERE job_id=v_second_job) THEN RAISE EXCEPTION 'rejected second job claimed message'; END IF;
END $verify$;
ROLLBACK;
SELECT 'atomic claim, manual precedence, mailbox/key/nonce, replay and cancellation guards passed; synthetic rows rolled back' AS verification;
