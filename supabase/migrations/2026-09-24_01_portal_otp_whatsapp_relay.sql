-- ============================================================================
-- OTP portals auto-register via a WhatsApp code relay (2026-09-24)
--
-- Auto-registration (2026-09-23) skipped every portal that signs in with an SMS
-- code (Al Ramz / الرمز): nobody was there to type it. Now a portal with the new
-- `otp_whatsapp_relay` switch can run unattended. The code is relayed over the
-- OPERATIONS WhatsApp line:
--
--   1. The worker signs in → the portal texts a code to the sign-in phone →
--      the worker pauses (awaiting_input) and the ops number WhatsApps the
--      relay phone: "send me the code you just got for client X".
--   2. The phone owner replies with the code on WhatsApp → /api/webhook/waha →
--      portal_otp_relay_inbound() writes it onto the job → the worker (already
--      polling its row) types it and finishes the registration.
--   3. No reply within the recipe's wait (5 min — the code expires anyway) →
--      the job is PARKED, not failed: the browser closes, the job goes back to
--      `queued` with parked_at set, and the ops number says "the code expired;
--      message me whenever you're free and I'll request a new one".
--   4. A reply hours later → every parked job of that portal is un-parked →
--      the worker signs in again → a FRESH code is texted → back to step 1.
--
-- Invariants added here:
--   • At most ONE live run per portal (claim_next skips a portal that is
--     running / awaiting a code). The same sign-in phone gets one code at a
--     time, so an inbound code is never ambiguous.
--   • A parked job is never claimed, never swept by the 30-minute "nobody
--     claimed it" watchdog, and is only failed after PARK_MAX_DAYS (7).
--   • While a relay portal has a parked job, new auto jobs for it are parked on
--     arrival (the cron), so an absent phone owner gets ONE "code expired"
--     message, not one per lead.
--
-- Backward-compatible: parked_at is NULL on every existing row, so claim /
-- watchdog behaviour for manual runs and Riva is unchanged, except the new
-- one-live-run-per-portal rule.
-- ============================================================================

BEGIN;

-- ── 1. lead_portals: otp_whatsapp_relay + otp_relay_phone fields ────────────
DO $$
DECLARE
  v_sec_idx int;
  v_sec_id  text;
  v_n       int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.models WHERE name = 'lead_portals') THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.models m,
      jsonb_array_elements(m.schema->'sections') s,
      jsonb_array_elements(s->'fields') f
    WHERE m.name = 'lead_portals' AND f->>'name' = 'otp_whatsapp_relay'
  ) THEN
    RETURN;
  END IF;

  SELECT (o.ord - 1)::int, o.sec->>'id', jsonb_array_length(o.sec->'fields')
    INTO v_sec_idx, v_sec_id, v_n
  FROM public.models m,
       jsonb_array_elements(m.schema->'sections') WITH ORDINALITY AS o(sec, ord)
  WHERE m.name = 'lead_portals'
  ORDER BY (o.sec->>'label_en' = 'Sign-in & automation') DESC, o.ord DESC
  LIMIT 1;

  UPDATE public.models
     SET schema = jsonb_set(
       schema,
       ARRAY['sections', v_sec_idx::text, 'fields'],
       (schema->'sections'->v_sec_idx->'fields') || jsonb_build_array(
         jsonb_build_object(
           'id', gen_random_uuid()::text,
           'name', 'otp_whatsapp_relay',
           'type', 'checkbox',
           'label_ar', 'طلب رمز التحقق عبر واتساب العمليات',
           'label_en', 'Ask for the code on the ops WhatsApp',
           'required', false,
           'order', v_n,
           'section_id', v_sec_id,
           'width', 'half',
           'show_in_table', true,
           'default_value', false
         ),
         jsonb_build_object(
           'id', gen_random_uuid()::text,
           'name', 'otp_relay_phone',
           'type', 'phone',
           'label_ar', 'رقم واتساب مستلم الرمز (افتراضياً رقم الدخول)',
           'label_en', 'WhatsApp to ask for the code (default: sign-in phone)',
           'required', false,
           'order', v_n + 1,
           'section_id', v_sec_id,
           'width', 'half',
           'show_in_table', false
         )
       )
     )
   WHERE name = 'lead_portals';
END $$;

-- ── 2. parked_at on the job row ─────────────────────────────────────────────
ALTER TABLE public.portal_registration_jobs
  ADD COLUMN IF NOT EXISTS parked_at timestamptz;

COMMENT ON COLUMN public.portal_registration_jobs.parked_at IS
  'Set while an auto run of a WhatsApp-relay portal waits for the phone owner to come back (the code wait timed out). status stays queued; claim_next skips it; portal_otp_relay_inbound clears it when the owner replies.';

CREATE INDEX IF NOT EXISTS portal_registration_jobs_parked_idx
  ON public.portal_registration_jobs (portal_record_id) WHERE parked_at IS NOT NULL;

-- ── 3. helpers ──────────────────────────────────────────────────────────────

-- Digits-only phone of the WhatsApp that answers for a portal's codes.
CREATE OR REPLACE FUNCTION public.portal_otp_relay_digits(p_portal_record_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT NULLIF(regexp_replace(
           COALESCE(NULLIF(r.data->>'otp_relay_phone', ''), r.data->>'login_phone', ''),
           '\D', '', 'g'), '')
    FROM public.records r
   WHERE r.id = p_portal_record_id
     AND r.data->>'otp_whatsapp_relay' = 'true';
$$;
REVOKE ALL ON FUNCTION public.portal_otp_relay_digits(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_otp_relay_digits(uuid) TO service_role;

-- Queue a WhatsApp from the OPERATIONS line to the portal's relay phone, sent
-- within seconds by the worker's scheduled-send loop. Returns false (and sends
-- nothing) when there is no active ops line or no relay phone — never falls
-- back to the sales number.
CREATE OR REPLACE FUNCTION public.portal_otp_relay_notify(p_job_id uuid, p_body text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_job    public.portal_registration_jobs;
  v_device text;
  v_digits text;
BEGIN
  SELECT * INTO v_job FROM public.portal_registration_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN RETURN false; END IF;
  v_digits := public.portal_otp_relay_digits(v_job.portal_record_id);
  SELECT device_id INTO v_device FROM public.whatsapp_numbers
   WHERE is_active AND is_operations LIMIT 1;
  IF v_digits IS NULL OR v_device IS NULL OR COALESCE(p_body, '') = '' THEN
    RETURN false;
  END IF;
  INSERT INTO public.scheduled_whatsapp_jobs
    (device_id, chat_wid, phone, body, deliver_at, created_by_user_id)
  VALUES
    (v_device, v_digits || '@c.us', '+' || v_digits, p_body, now(), v_job.user_id);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.portal_otp_relay_notify(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_otp_relay_notify(uuid, text) TO service_role;

-- ── 4. park — worker: the code never came → close up and wait for a reply ──
-- Returns 'parked', or 'failed' once the job has been retried too often (a
-- portal that keeps asking for codes nobody can satisfy should surface, not loop).
CREATE OR REPLACE FUNCTION public.portal_registration_job_park(p_job_id uuid, p_max_attempts int DEFAULT 8)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_attempts int;
BEGIN
  SELECT attempts INTO v_attempts FROM public.portal_registration_jobs
   WHERE id = p_job_id AND status IN ('running','awaiting_input')
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 'gone'; END IF;

  IF v_attempts >= p_max_attempts THEN
    UPDATE public.portal_registration_jobs
       SET status = 'failed', finished_at = now(), updated_at = now(),
           input_request = NULL, input_value = NULL,
           error_message = 'لم يصل رمز التحقق بعد عدة محاولات — أُوقف التسجيل التلقائي لهذا العميل.' || E'\n' ||
                           'No verification code arrived after several attempts — automatic registration stopped for this client.'
     WHERE id = p_job_id;
    RETURN 'failed';
  END IF;

  UPDATE public.portal_registration_jobs
     SET status = 'queued', parked_at = now(), updated_at = now(),
         input_request = NULL, input_value = NULL, input_requested_at = NULL, input_submitted_at = NULL,
         worker_id = NULL, browserbase_session_id = NULL, live_view_url = NULL,
         phase = 'parked',
         phase_ar = 'بانتظار الرد على واتساب العمليات لطلب رمز جديد',
         phase_en = 'Waiting for a reply on the ops WhatsApp to request a new code'
   WHERE id = p_job_id;
  RETURN 'parked';
END $$;
REVOKE ALL ON FUNCTION public.portal_registration_job_park(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_park(uuid, int) TO service_role;

-- ── 5. inbound — webhook: a message from a relay phone to the ops line ─────
-- Returns { action, job_id?, count? }:
--   code_accepted — a live run was waiting for a code; the code is on its row.
--   restarted     — parked runs were waiting for the owner; they are queued
--                   again (the worker will sign in and trigger a NEW code).
--   busy          — a run is already signing in / about to ask; nothing to do.
--   none          — this phone relays no portal with pending work.
-- It also queues the ops-line acknowledgement for `restarted`.
CREATE OR REPLACE FUNCTION public.portal_otp_relay_inbound(p_phone text, p_body text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_digits  text := regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g');
  v_body    text := translate(COALESCE(p_body, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
  v_job     public.portal_registration_jobs;
  v_len     int;
  v_code    text;
  v_n       int;
  v_first   uuid;
  v_portal  text;
BEGIN
  IF v_digits = '' THEN RETURN jsonb_build_object('action', 'none'); END IF;

  -- (a) A run waiting for a code right now (at most one per portal).
  SELECT j.* INTO v_job
    FROM public.portal_registration_jobs j
   WHERE j.status = 'awaiting_input' AND j.origin = 'auto'
     AND public.portal_otp_relay_digits(j.portal_record_id) = v_digits
   ORDER BY j.input_requested_at DESC NULLS LAST
   LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    v_len := NULLIF(v_job.input_request->>'length', '')::int;
    IF v_len IS NOT NULL THEN
      v_code := substring(v_body FROM '(?<!\d)(\d{' || v_len || '})(?!\d)');
    END IF;
    v_code := COALESCE(v_code, substring(v_body FROM '(?<!\d)(\d{4,8})(?!\d)'));
    IF v_code IS NULL THEN
      RETURN jsonb_build_object('action', 'no_code', 'job_id', v_job.id);
    END IF;
    UPDATE public.portal_registration_jobs
       SET input_value = v_code, input_submitted_at = now(), updated_at = now()
     WHERE id = v_job.id;
    RETURN jsonb_build_object('action', 'code_accepted', 'job_id', v_job.id);
  END IF;

  -- (b) Parked runs → the owner is back: queue them again.
  WITH u AS (
    UPDATE public.portal_registration_jobs j
       SET parked_at = NULL, updated_at = now(),
           phase = 'queued',
           phase_ar = 'سيُطلب رمز تحقق جديد الآن',
           phase_en = 'A new code will be requested now'
     WHERE j.parked_at IS NOT NULL AND j.status = 'queued'
       AND public.portal_otp_relay_digits(j.portal_record_id) = v_digits
    RETURNING j.id, j.created_at)
  SELECT count(*), (array_agg(id ORDER BY created_at))[1]
    INTO v_n, v_first
    FROM u;
  IF v_n > 0 THEN
    SELECT r.data->>'name' INTO v_portal
      FROM public.portal_registration_jobs j JOIN public.records r ON r.id = j.portal_record_id
     WHERE j.id = v_first;
    PERFORM public.portal_otp_relay_notify(v_first,
      'تمام 👍 طلبت الآن رمز تحقق جديداً من «' || COALESCE(v_portal, 'البوابة') || '»' ||
      CASE WHEN v_n > 1 THEN ' (لتسجيل ' || v_n || ' عملاء)' ELSE '' END ||
      '. سيصلك SMS خلال لحظات — أرسل لي الرمز هنا.');
    RETURN jsonb_build_object('action', 'restarted', 'count', v_n, 'job_id', v_first);
  END IF;

  -- (c) A run of this phone's portal is queued / signing in already.
  IF EXISTS (
    SELECT 1 FROM public.portal_registration_jobs j
     WHERE j.status IN ('queued','running') AND j.origin = 'auto' AND j.parked_at IS NULL
       AND public.portal_otp_relay_digits(j.portal_record_id) = v_digits
  ) THEN
    RETURN jsonb_build_object('action', 'busy');
  END IF;

  RETURN jsonb_build_object('action', 'none');
END $$;
REVOKE ALL ON FUNCTION public.portal_otp_relay_inbound(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_otp_relay_inbound(text, text) TO service_role;

-- ── 6. claim_next — skip parked jobs + one live run per portal ─────────────
CREATE OR REPLACE FUNCTION public.portal_registration_job_claim_next(p_worker_id text)
RETURNS SETOF public.portal_registration_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  UPDATE public.portal_registration_jobs j
     SET status = 'running', attempts = j.attempts + 1, worker_id = p_worker_id,
         started_at = now(), heartbeat_at = now(), updated_at = now()
   WHERE j.id = (
     SELECT q.id FROM public.portal_registration_jobs q
      WHERE q.status = 'queued'
        AND q.parked_at IS NULL
        -- One live run per portal: its sign-in phone gets one code at a time.
        AND NOT EXISTS (
          SELECT 1 FROM public.portal_registration_jobs l
           WHERE l.portal_record_id = q.portal_record_id
             AND l.status IN ('running','awaiting_input'))
      ORDER BY q.created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
  RETURNING j.*;
END $$;

-- ── 7. enqueue — a rep pressing the button un-parks a waiting auto run ─────
CREATE OR REPLACE FUNCTION public.portal_registration_job_enqueue(
  p_portal_record_id  uuid,
  p_client_record_id  uuid,
  p_project_record_id uuid,
  p_user_id           uuid,
  p_lead_data         jsonb,
  p_login_phone       text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.portal_registration_jobs
    (portal_record_id, client_record_id, project_record_id, user_id, lead_data, login_phone)
  VALUES
    (p_portal_record_id, p_client_record_id, p_project_record_id, p_user_id,
     COALESCE(p_lead_data, '{}'::jsonb), NULLIF(p_login_phone, ''))
  ON CONFLICT (client_record_id, portal_record_id)
    WHERE status IN ('queued','running','awaiting_input') DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.portal_registration_jobs
     WHERE client_record_id = p_client_record_id
       AND portal_record_id = p_portal_record_id
       AND status IN ('queued','running','awaiting_input')
     ORDER BY created_at DESC LIMIT 1;
    -- Someone asked for this run explicitly: it no longer waits for a reply.
    UPDATE public.portal_registration_jobs
       SET parked_at = NULL, updated_at = now()
     WHERE id = v_id AND parked_at IS NOT NULL;
  END IF;
  RETURN v_id;
END $$;

-- ── 8. watchdog — parked jobs are waiting on purpose; expire after 7 days ──
CREATE OR REPLACE FUNCTION public.portal_registration_jobs_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int := 0; v_m int := 0; v_p int := 0;
BEGIN
  UPDATE public.portal_registration_jobs
     SET status = 'failed', finished_at = now(), updated_at = now(),
         error_message = 'watchdog: the worker stopped responding (no heartbeat for 5 minutes)'
   WHERE status IN ('running','awaiting_input')
     AND COALESCE(heartbeat_at, started_at, created_at) < now() - interval '5 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- "Nobody claimed it" only counts time the job was actually claimable: a
  -- parked job, or one that just came out of parking, waited on purpose.
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
  RETURN v_n + v_m + v_p;
END $$;

-- ── 9. Al Ramz: relay codes over WhatsApp + auto-register ───────────────────
UPDATE public.records
   SET data = data || jsonb_build_object('otp_whatsapp_relay', true, 'auto_register', true)
 WHERE model_id = '1ead0000-0000-4000-8000-000000000001'
   AND data->>'login_url' = 'https://brokerportal.alramzre.com/user/login'
   AND data->>'otp_channel' = 'sms';

COMMIT;
