-- ============================================================================
-- 2026-09-14: Lead portals — register an interested customer into a
-- developer's / marketer's / officer's broker portal with a Browserbase session.
-- ----------------------------------------------------------------------------
-- Today, when a customer is interested in a project, the rep clicks "Notify
-- officer" and the project's officer gets a WhatsApp from the ops line. For SOME
-- developers / marketers / officers there is ALSO a web portal the lead must be
-- registered in (otherwise the broker doesn't get credited). Each portal signs
-- in differently (usually a phone number + an OTP code) and asks for different
-- customer fields.
--
-- This migration adds:
--   1. `lead_portals` — a CRM model (JSONB records, editable in the normal record
--      UI) = the portal registry. One record per portal: the login URL, which
--      developer / marketer / officers / projects it belongs to, the phone the
--      OTP is sent to, the fields the portal needs, and a declarative RECIPE
--      (JSON steps) the worker replays in a real browser. See
--      docs/lead-portal-recipes.md for the step language.
--   2. `portal_registration_jobs` — the queue + live state of one registration
--      run. The Fly worker claims a job, drives Browserbase, and when the portal
--      asks for an OTP it flips the job to `awaiting_input`; the SPA (subscribed
--      via Realtime, owner-only RLS) shows an input box; the rep types the code;
--      `/api/portal-registration` writes it onto the row; the worker (polling
--      its own row) picks it up and continues. No HTTP request is ever held open.
--   3. A private `portal-registrations` bucket for the step screenshots the
--      worker takes (proof of registration + failure diagnostics). Served to the
--      SPA as signed URLs by the API, never read directly.
--
-- Same enqueue → worker → Realtime posture as rega_lookup_jobs / deck_jobs.
-- ============================================================================

BEGIN;

-- ── 1. The lead_portals model (guarded — never re-created) ──────────────────
DO $$
DECLARE
  v_model uuid := '1ead0000-0000-4000-8000-000000000001';
  v_sec   uuid := gen_random_uuid();
  v_sec2  uuid := gen_random_uuid();
  f_name uuid := gen_random_uuid(); f_url uuid := gen_random_uuid();
  f_dev uuid := gen_random_uuid(); f_mkt uuid := gen_random_uuid();
  f_off uuid := gen_random_uuid(); f_proj uuid := gen_random_uuid();
  f_phone uuid := gen_random_uuid(); f_email uuid := gen_random_uuid();
  f_pass uuid := gen_random_uuid(); f_otp uuid := gen_random_uuid();
  f_fields uuid := gen_random_uuid(); f_recipe uuid := gen_random_uuid();
  f_active uuid := gen_random_uuid(); f_notes uuid := gen_random_uuid();
  v_schema jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.models WHERE name = 'lead_portals') THEN
    RETURN;
  END IF;

  v_schema := jsonb_build_object(
    'section_selector_field_id', NULL,
    'sections', jsonb_build_array(
      jsonb_build_object(
        'id', v_sec::text, 'label_ar','البوابة','label_en','Portal',
        'order',0,'is_base',true,'color','#B8734F',
        'fields', jsonb_build_array(
          jsonb_build_object('id',f_name::text,'name','name','type','text','label_ar','اسم البوابة','label_en','Portal name','required',true,'order',0,'section_id',v_sec::text,'width','half','show_in_table',true),
          jsonb_build_object('id',f_url::text,'name','login_url','type','url','label_ar','رابط تسجيل الدخول','label_en','Login URL','required',true,'order',1,'section_id',v_sec::text,'width','half','show_in_table',true),
          jsonb_build_object('id',f_dev::text,'name','developer','type','lookup','label_ar','المطور','label_en','Developer','required',false,'order',2,'section_id',v_sec::text,'width','half','show_in_table',true,
            'is_multi',false,'lookup_model_id','11bade2c-7da9-4d00-b045-eaab37153da2','lookup_display_field','name','lookup_max_records',500),
          jsonb_build_object('id',f_mkt::text,'name','marketer','type','lookup','label_ar','المسوّق','label_en','Marketer','required',false,'order',3,'section_id',v_sec::text,'width','half','show_in_table',true,
            'is_multi',false,'lookup_model_id','37f4905c-bc64-4993-a0c4-07e4f54463e2','lookup_display_field','name','lookup_max_records',500),
          jsonb_build_object('id',f_off::text,'name','officers','type','lookup','label_ar','المسؤولون (اختياري)','label_en','Officers (optional)','required',false,'order',4,'section_id',v_sec::text,'width','half','show_in_table',false,
            'is_multi',true,'lookup_model_id','026855a4-02cb-41de-b9b5-91c0eee331a9','lookup_display_field','name','lookup_max_records',500),
          jsonb_build_object('id',f_proj::text,'name','projects','type','lookup','label_ar','المشاريع (اختياري)','label_en','Projects (optional)','required',false,'order',5,'section_id',v_sec::text,'width','half','show_in_table',false,
            'is_multi',true,'lookup_model_id','220c49b9-de57-492d-9eca-c0d9f54fd40f','lookup_display_field','project_name','lookup_max_records',2000),
          jsonb_build_object('id',f_active::text,'name','is_active','type','checkbox','label_ar','نشطة','label_en','Active','required',false,'order',6,'section_id',v_sec::text,'width','half','show_in_table',true,'default_value',true),
          jsonb_build_object('id',f_notes::text,'name','notes','type','textarea','label_ar','ملاحظات','label_en','Notes','required',false,'order',7,'section_id',v_sec::text,'width','full','show_in_table',false)
        )
      ),
      jsonb_build_object(
        'id', v_sec2::text, 'label_ar','تسجيل الدخول والأتمتة','label_en','Sign-in & automation',
        'order',1,'is_base',true,'color','#8E4E3A',
        'fields', jsonb_build_array(
          jsonb_build_object('id',f_phone::text,'name','login_phone','type','phone','label_ar','رقم الدخول (يصله رمز التحقق)','label_en','Sign-in phone (receives the OTP)','required',false,'order',0,'section_id',v_sec2::text,'width','half','show_in_table',false),
          jsonb_build_object('id',f_email::text,'name','login_email','type','email','label_ar','بريد الدخول','label_en','Sign-in email','required',false,'order',1,'section_id',v_sec2::text,'width','half','show_in_table',false),
          jsonb_build_object('id',f_pass::text,'name','login_password','type','text','label_ar','كلمة المرور (إن وُجدت)','label_en','Password (if the portal uses one)','required',false,'order',2,'section_id',v_sec2::text,'width','half','show_in_table',false),
          jsonb_build_object('id',f_otp::text,'name','otp_channel','type','dropdown','label_ar','قناة رمز التحقق','label_en','OTP channel','required',false,'order',3,'section_id',v_sec2::text,'width','half','show_in_table',false,
            'options', jsonb_build_array(
              jsonb_build_object('id',gen_random_uuid()::text,'label_ar','رسالة نصية','label_en','SMS','value','sms','color','#B8734F'),
              jsonb_build_object('id',gen_random_uuid()::text,'label_ar','واتساب','label_en','WhatsApp','value','whatsapp','color','#25D366'),
              jsonb_build_object('id',gen_random_uuid()::text,'label_ar','بريد إلكتروني','label_en','Email','value','email','color','#C09B5F'),
              jsonb_build_object('id',gen_random_uuid()::text,'label_ar','بدون رمز','label_en','None','value','none','color','#4A4E54'))),
          jsonb_build_object('id',f_fields::text,'name','required_fields','type','textarea','label_ar','حقول العميل المطلوبة (JSON)','label_en','Customer fields the portal needs (JSON)','required',false,'order',4,'section_id',v_sec2::text,'width','full','show_in_table',false,
            'placeholder','[{"key":"name","label_ar":"اسم العميل","label_en":"Customer name","source":"client.client_name","required":true},{"key":"phone","label_ar":"رقم الجوال","label_en":"Mobile","source":"client.phone_number","type":"phone","required":true}]'),
          jsonb_build_object('id',f_recipe::text,'name','recipe','type','textarea','label_ar','خطوات الأتمتة (JSON)','label_en','Automation recipe (JSON steps)','required',false,'order',5,'section_id',v_sec2::text,'width','full','show_in_table',false,
            'placeholder','[{"do":"goto","url":"{{portal.login_url}}"},{"do":"fill","selector":"input[name=phone]","value":"{{portal.login_phone|local}}"},{"do":"click","text":"دخول"},{"do":"request_input","key":"otp","prompt_ar":"أدخل رمز التحقق الذي وصلك","prompt_en":"Enter the code you received"},{"do":"fill","selector":"input[name=otp]","value":"{{input.otp}}"},{"do":"click","text":"تأكيد"},{"do":"assert","text":"تم","error_ar":"لم يظهر تأكيد التسجيل"}]')
        )
      )
    )
  );

  INSERT INTO public.models (id,name,label_ar,label_en,icon,color,"order",group_id,is_system,is_hardcoded,table_name,card_config,schema)
  VALUES (v_model,'lead_portals','بوابات تسجيل العملاء','Lead portals','globe','#B8734F',52,NULL,false,false,NULL,
    jsonb_build_object('title_field_id',f_name::text,'subtitle_field_id',f_url::text,'badge_field_id',f_active::text,
      'shown_field_ids',jsonb_build_array(f_name::text,f_url::text,f_dev::text,f_mkt::text)),
    v_schema);
END $$;

-- ── 2. portal_registration_jobs — queue + live run state ────────────────────
CREATE TABLE IF NOT EXISTS public.portal_registration_jobs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The lead_portals record (public.records id) whose recipe is replayed.
  portal_record_id   uuid        NOT NULL REFERENCES public.records(id) ON DELETE CASCADE,
  -- The client being registered + the project they are interested in.
  client_record_id   uuid        NOT NULL REFERENCES public.records(id) ON DELETE CASCADE,
  project_record_id  uuid        REFERENCES public.records(id) ON DELETE SET NULL,
  -- auth.users id of the rep who clicked the button (owner: RLS + OTP entry).
  user_id            uuid        NOT NULL,
  status             text        NOT NULL DEFAULT 'queued'
                                 CHECK (status IN ('queued','running','awaiting_input','done','failed','cancelled')),
  -- What the worker is doing right now (bilingual, shown in the modal).
  phase              text,
  phase_ar           text,
  phase_en           text,
  -- The customer fields collected in the modal (already validated against the
  -- portal's required_fields) — the worker's `{{lead.*}}` template source.
  lead_data          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- The phone used to sign in (portal default, overridable per run).
  login_phone        text,
  -- The pause/resume handshake for OTP codes and any other mid-run question.
  input_request      jsonb,      -- { key, kind, prompt_ar, prompt_en, length? }
  input_value        text,       -- what the rep typed (cleared when consumed)
  input_requested_at timestamptz,
  input_submitted_at timestamptz,
  -- Browserbase session (live view URL lets the rep WATCH the run in an iframe).
  browserbase_session_id text,
  live_view_url      text,
  -- Screenshots: [{ path, label, at }] in the portal-registrations bucket.
  screenshots        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  result             jsonb,
  error_message      text,
  attempts           int         NOT NULL DEFAULT 0,
  worker_id          text,
  heartbeat_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz
);

CREATE INDEX IF NOT EXISTS portal_registration_jobs_queued_idx
  ON public.portal_registration_jobs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS portal_registration_jobs_active_idx
  ON public.portal_registration_jobs (heartbeat_at) WHERE status IN ('running','awaiting_input');
-- One active run per (client, portal): a double-click collapses into one job.
CREATE UNIQUE INDEX IF NOT EXISTS portal_registration_jobs_one_active_idx
  ON public.portal_registration_jobs (client_record_id, portal_record_id)
  WHERE status IN ('queued','running','awaiting_input');
CREATE INDEX IF NOT EXISTS portal_registration_jobs_client_idx
  ON public.portal_registration_jobs (client_record_id, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_registration_jobs_user_idx
  ON public.portal_registration_jobs (user_id, created_at DESC);

ALTER TABLE public.portal_registration_jobs ENABLE ROW LEVEL SECURITY;

-- Owner may SELECT (drives the Realtime subscription in the modal). All writes
-- go through service-role RPCs from the API + worker.
DROP POLICY IF EXISTS portal_registration_jobs_owner_select ON public.portal_registration_jobs;
CREATE POLICY portal_registration_jobs_owner_select
  ON public.portal_registration_jobs FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Realtime: the modal subscribes to its own job row (filter id=eq.<job>);
-- postgres_changes honours the SELECT policy above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'portal_registration_jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.portal_registration_jobs;
  END IF;
END $$;

-- ── 3. Private screenshots bucket ───────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('portal-registrations', 'portal-registrations', false)
ON CONFLICT (id) DO NOTHING;

-- ── 4. RPCs (service-role only) ─────────────────────────────────────────────

-- enqueue — idempotent one-active-per-(client, portal). Returns the job id.
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
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.portal_registration_job_enqueue(uuid,uuid,uuid,uuid,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_enqueue(uuid,uuid,uuid,uuid,jsonb,text) TO service_role;

-- claim_next — FOR UPDATE SKIP LOCKED single-row claim.
CREATE OR REPLACE FUNCTION public.portal_registration_job_claim_next(p_worker_id text)
RETURNS SETOF public.portal_registration_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  UPDATE public.portal_registration_jobs j
     SET status = 'running', attempts = j.attempts + 1, worker_id = p_worker_id,
         started_at = now(), heartbeat_at = now(), updated_at = now()
   WHERE j.id = (
     SELECT id FROM public.portal_registration_jobs
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
  RETURNING j.*;
END $$;
REVOKE ALL ON FUNCTION public.portal_registration_job_claim_next(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_claim_next(text) TO service_role;

-- progress — phase label + optional screenshot append + heartbeat. Only while
-- the run is live (a late progress write after cancel/watchdog is a no-op).
CREATE OR REPLACE FUNCTION public.portal_registration_job_progress(
  p_job_id uuid, p_phase text, p_phase_ar text, p_phase_en text, p_screenshot jsonb DEFAULT NULL
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE public.portal_registration_jobs
       SET phase = COALESCE(p_phase, phase),
           phase_ar = COALESCE(p_phase_ar, phase_ar),
           phase_en = COALESCE(p_phase_en, phase_en),
           screenshots = CASE WHEN p_screenshot IS NULL THEN screenshots ELSE screenshots || jsonb_build_array(p_screenshot) END,
           heartbeat_at = now(), updated_at = now()
     WHERE id = p_job_id AND status IN ('running','awaiting_input')
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION public.portal_registration_job_progress(uuid,text,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_progress(uuid,text,text,text,jsonb) TO service_role;

-- session — record the Browserbase session + live view URL.
CREATE OR REPLACE FUNCTION public.portal_registration_job_session(
  p_job_id uuid, p_session_id text, p_live_view_url text
) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE public.portal_registration_jobs
       SET browserbase_session_id = p_session_id, live_view_url = p_live_view_url,
           heartbeat_at = now(), updated_at = now()
     WHERE id = p_job_id AND status IN ('running','awaiting_input')
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION public.portal_registration_job_session(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_session(uuid,text,text) TO service_role;

-- heartbeat — the worker ticks this while waiting (OTP wait / long steps) so
-- the watchdog can tell "alive and waiting" from "worker died".
CREATE OR REPLACE FUNCTION public.portal_registration_job_heartbeat(p_job_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE public.portal_registration_jobs SET heartbeat_at = now()
     WHERE id = p_job_id AND status IN ('running','awaiting_input')
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION public.portal_registration_job_heartbeat(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_heartbeat(uuid) TO service_role;

-- request_input — worker: the portal asked for something (an OTP) → pause.
CREATE OR REPLACE FUNCTION public.portal_registration_job_request_input(p_job_id uuid, p_request jsonb)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE public.portal_registration_jobs
       SET status = 'awaiting_input', input_request = p_request, input_value = NULL,
           input_requested_at = now(), input_submitted_at = NULL,
           heartbeat_at = now(), updated_at = now()
     WHERE id = p_job_id AND status = 'running'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION public.portal_registration_job_request_input(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_request_input(uuid,jsonb) TO service_role;

-- submit_input — API on behalf of the OWNER: the rep typed the code.
CREATE OR REPLACE FUNCTION public.portal_registration_job_submit_input(p_job_id uuid, p_user_id uuid, p_value text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE public.portal_registration_jobs
       SET input_value = p_value, input_submitted_at = now(), updated_at = now()
     WHERE id = p_job_id AND user_id = p_user_id AND status = 'awaiting_input'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION public.portal_registration_job_submit_input(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_submit_input(uuid,uuid,text) TO service_role;

-- resume — worker consumed the input → back to running (clears the request).
CREATE OR REPLACE FUNCTION public.portal_registration_job_resume(p_job_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE public.portal_registration_jobs
       SET status = 'running', input_request = NULL, input_value = NULL,
           heartbeat_at = now(), updated_at = now()
     WHERE id = p_job_id AND status = 'awaiting_input'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION public.portal_registration_job_resume(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_resume(uuid) TO service_role;

-- cancel — API on behalf of the OWNER. The worker notices between steps / in
-- its OTP wait loop and closes the browser.
CREATE OR REPLACE FUNCTION public.portal_registration_job_cancel(p_job_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE public.portal_registration_jobs
       SET status = 'cancelled', finished_at = now(), updated_at = now(),
           error_message = COALESCE(error_message, 'cancelled by user')
     WHERE id = p_job_id AND user_id = p_user_id
       AND status IN ('queued','running','awaiting_input')
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION public.portal_registration_job_cancel(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_cancel(uuid,uuid) TO service_role;

-- complete / fail — only touch a LIVE row (worker vs watchdog/cancel race).
CREATE OR REPLACE FUNCTION public.portal_registration_job_complete(p_job_id uuid, p_result jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE public.portal_registration_jobs
       SET status = 'done', result = p_result, error_message = NULL,
           input_request = NULL, input_value = NULL,
           finished_at = now(), updated_at = now()
     WHERE id = p_job_id AND status IN ('running','awaiting_input')
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION public.portal_registration_job_complete(uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_complete(uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.portal_registration_job_fail(p_job_id uuid, p_error text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE public.portal_registration_jobs
       SET status = 'failed', error_message = p_error,
           input_request = NULL, input_value = NULL,
           finished_at = now(), updated_at = now()
     WHERE id = p_job_id AND status IN ('running','awaiting_input')
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
REVOKE ALL ON FUNCTION public.portal_registration_job_fail(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_fail(uuid,text) TO service_role;

-- watchdog — a LIVE job whose worker stopped heart-beating for 5 min is dead
-- (worker crash / machine stop). A healthy worker beats every few seconds even
-- while it waits for the OTP, so a rep who takes 4 minutes to type the code is
-- never swept. Also fails queued jobs nobody claimed within 30 min (the
-- Browserbase lane is disabled on the worker → say so instead of spinning).
CREATE OR REPLACE FUNCTION public.portal_registration_jobs_watchdog()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_n int := 0; v_m int := 0;
BEGIN
  UPDATE public.portal_registration_jobs
     SET status = 'failed', finished_at = now(), updated_at = now(),
         error_message = 'watchdog: the worker stopped responding (no heartbeat for 5 minutes)'
   WHERE status IN ('running','awaiting_input')
     AND COALESCE(heartbeat_at, started_at, created_at) < now() - interval '5 minutes';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.portal_registration_jobs
     SET status = 'failed', finished_at = now(), updated_at = now(),
         error_message = 'watchdog: no worker claimed this job within 30 minutes (is the portal lane enabled on the worker?)'
   WHERE status = 'queued' AND created_at < now() - interval '30 minutes';
  GET DIAGNOSTICS v_m = ROW_COUNT;
  RETURN v_n + v_m;
END $$;
REVOKE ALL ON FUNCTION public.portal_registration_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_jobs_watchdog() TO service_role;

COMMIT;
