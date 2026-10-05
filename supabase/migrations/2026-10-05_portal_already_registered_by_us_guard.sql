-- Never register a client in a portal we have ALREADY registered them in.
--
-- Operator rule (2026-10-05): "Before registering in any portal, always check
-- if that client is already registered by us in that portal."
--
-- Until now only the high-interest path (api/_lib/portalInterest.ts) read
-- client_portal_registrations before queueing. The ad-lead sweep only looked
-- for an earlier JOB for the pair (a registration added by hand, or found in
-- the portal by the daily status check, has no job), and the chat button only
-- WARNED. This makes the database itself refuse, at two moments:
--
--   1. ENQUEUE — portal_registration_job_enqueue raises
--      'already_registered_by_us' (SQLSTATE WS412, never 40001 — see CLAUDE.md)
--      when the pair's row is 'registered' or 'already_registered'. Every
--      caller pre-checks and shows a proper message; the raise is the backstop.
--   2. CLAIM — a job can wait queued/parked for hours (the WhatsApp code relay)
--      while the status check finds the client in the portal or a rep records
--      a registration by hand. portal_registration_job_skip_if_registered is
--      called by the worker BEFORE it opens a browser and closes such a job as
--      'cancelled' with result.skip_reason='already_registered_by_us'.
--
-- "Registered" here is OUR record: runs that finished, registrations added by
-- hand, and clients the portal's own list showed at the last status check.
-- A wrong row is corrected in the client's «البوابات» tab (set our status to
-- «غير مسجّل» / «فشل»), after which a run is allowed again.

BEGIN;

-- 1. Enqueue refuses a pair we already registered. Body otherwise verbatim
--    from the live definition (2026-09-29_portal_enqueue_origin_atomic.sql).
CREATE OR REPLACE FUNCTION public.portal_registration_job_enqueue(
  p_portal_record_id uuid, p_client_record_id uuid, p_project_record_id uuid, p_user_id uuid,
  p_lead_data jsonb, p_login_phone text, p_origin text DEFAULT 'manual'::text,
  p_attribution_id uuid DEFAULT NULL::uuid, p_parked boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id uuid;
        v_our text;
BEGIN
  IF COALESCE(p_origin, 'manual') NOT IN ('manual', 'auto') THEN
    RAISE EXCEPTION 'portal_registration_job_enqueue: invalid origin %', p_origin;
  END IF;

  SELECT our_status INTO v_our FROM public.client_portal_registrations
   WHERE client_record_id = p_client_record_id AND portal_record_id = p_portal_record_id;
  IF v_our IN ('registered', 'already_registered') THEN
    RAISE EXCEPTION 'already_registered_by_us: client % portal % is %', p_client_record_id, p_portal_record_id, v_our
      USING ERRCODE = 'WS412';
  END IF;

  INSERT INTO public.portal_registration_jobs
    (portal_record_id, client_record_id, project_record_id, user_id, lead_data, login_phone,
     origin, attribution_id, parked_at, phase, phase_ar, phase_en)
  VALUES
    (p_portal_record_id, p_client_record_id, p_project_record_id, p_user_id,
     COALESCE(p_lead_data, '{}'::jsonb), NULLIF(p_login_phone, ''),
     COALESCE(p_origin, 'manual'), p_attribution_id,
     CASE WHEN p_parked THEN now() END,
     CASE WHEN p_parked THEN 'parked' END,
     CASE WHEN p_parked THEN 'بانتظار الرد على واتساب العمليات لطلب رمز جديد' END,
     CASE WHEN p_parked THEN 'Waiting for a reply on the ops WhatsApp to request a new code' END)
  ON CONFLICT (client_record_id, portal_record_id)
    WHERE status IN ('queued','running','awaiting_input') DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.portal_registration_jobs
     WHERE client_record_id = p_client_record_id
       AND portal_record_id = p_portal_record_id
       AND status IN ('queued','running','awaiting_input')
     ORDER BY created_at DESC LIMIT 1;
    UPDATE public.portal_registration_jobs
       SET parked_at = NULL, updated_at = now()
     WHERE id = v_id AND parked_at IS NOT NULL;
  END IF;
  RETURN v_id;
END $function$;

-- 2. The worker's last look before it pays for a browser.
CREATE OR REPLACE FUNCTION public.portal_registration_job_skip_if_registered(p_job_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
  UPDATE public.portal_registration_jobs j
     SET status        = 'cancelled',
         finished_at   = now(),
         updated_at    = now(),
         parked_at     = NULL,
         phase         = 'skipped',
         phase_ar      = 'تُخطّي — العميل مسجّل لدينا في هذه البوابة',
         phase_en      = 'Skipped — already registered by us in this portal',
         error_message = 'لم يُسجَّل مرة أخرى — العميل مسجّل لدينا في هذه البوابة مسبقاً' || E'\n'
                      || 'Not registered again — this client is already registered by us in this portal',
         result        = COALESCE(j.result, '{}'::jsonb)
                      || jsonb_build_object('skip_reason', 'already_registered_by_us', 'our_status', r.our_status)
    FROM public.client_portal_registrations r
   WHERE j.id = p_job_id
     AND j.kind = 'register'
     AND j.status IN ('queued', 'running', 'awaiting_input')
     AND r.client_record_id = j.client_record_id
     AND r.portal_record_id = j.portal_record_id
     AND r.our_status IN ('registered', 'already_registered');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $function$;

REVOKE ALL ON FUNCTION public.portal_registration_job_skip_if_registered(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_skip_if_registered(uuid) TO service_role;

-- 3. The registration history names the skip instead of a generic «أُلغيت».
--    Verbatim from the live definition except the 'cancelled' branch.
CREATE OR REPLACE FUNCTION public.tg_portal_jobs_sync_registration()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_reg      public.client_portal_registrations;
  v_new      text;
  v_proj     text := NULLIF(NEW.lead_data->>'project_name', '');
  v_as       text := NULLIF(NEW.lead_data->>'project', '');
  v_via      text := CASE WHEN NEW.origin = 'auto' THEN 'auto' ELSE 'manual_run' END;
  v_ar       text;
  v_en       text;
  v_err      text := split_part(COALESCE(NEW.error_message, ''), E'\n', 1);
BEGIN
  IF NEW.kind <> 'register' OR NEW.client_record_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  INSERT INTO public.client_portal_registrations (client_record_id, portal_record_id)
  VALUES (NEW.client_record_id, NEW.portal_record_id)
  ON CONFLICT (client_record_id, portal_record_id) DO NOTHING;
  SELECT * INTO v_reg FROM public.client_portal_registrations
   WHERE client_record_id = NEW.client_record_id AND portal_record_id = NEW.portal_record_id
   FOR UPDATE;

  v_new := v_reg.our_status;
  IF NEW.status IN ('queued','running','awaiting_input') THEN
    IF v_reg.our_status NOT IN ('registered','already_registered') THEN v_new := 'registering'; END IF;
  ELSIF NEW.status = 'done' THEN
    v_new := 'registered';
    v_ar := 'سُجّل العميل في البوابة' || COALESCE(' — ' || v_proj, '');
    v_en := 'Registered in the portal' || COALESCE(' — ' || v_proj, '');
  ELSIF NEW.status = 'already_registered' THEN
    IF v_reg.our_status <> 'registered' THEN v_new := 'already_registered'; END IF;
    v_ar := 'البوابة أفادت أن العميل مسجّل لدى وسيط آخر';
    v_en := 'The portal says the client is already another broker''s';
  ELSIF NEW.status = 'failed' THEN
    IF v_reg.our_status NOT IN ('registered','already_registered') THEN
      v_new := CASE WHEN NEW.result->>'skip_reason' = 'no_owner' THEN 'not_registered' ELSE 'failed' END;
    END IF;
    v_ar := 'فشلت محاولة التسجيل' || CASE WHEN v_err <> '' THEN ': ' || v_err ELSE '' END;
    v_en := 'Registration attempt failed' || CASE WHEN split_part(COALESCE(NEW.error_message,''), E'\n', 2) <> ''
                                                 THEN ': ' || split_part(NEW.error_message, E'\n', 2) ELSE '' END;
  ELSIF NEW.status = 'cancelled' THEN
    IF v_reg.our_status = 'registering' THEN
      v_new := CASE WHEN v_reg.registered_at IS NOT NULL THEN 'registered' ELSE 'not_registered' END;
    END IF;
    IF NEW.result->>'skip_reason' = 'already_registered_by_us' THEN
      v_ar := 'تُخطّيت محاولة التسجيل — العميل مسجّل لدينا في هذه البوابة مسبقاً';
      v_en := 'Registration attempt skipped — the client is already registered by us in this portal';
    ELSE
      v_ar := 'أُلغيت محاولة التسجيل';
      v_en := 'Registration attempt cancelled';
    END IF;
  END IF;

  UPDATE public.client_portal_registrations r
     SET our_status            = v_new,
         project_names         = CASE WHEN v_proj IS NOT NULL AND NOT (v_proj = ANY(r.project_names))
                                      THEN r.project_names || v_proj ELSE r.project_names END,
         registered_as         = CASE WHEN NEW.status = 'done' AND v_as IS NOT NULL AND NOT (v_as = ANY(r.registered_as))
                                      THEN r.registered_as || v_as ELSE r.registered_as END,
         registered_at         = CASE WHEN NEW.status = 'done' THEN COALESCE(r.registered_at, NEW.finished_at, now()) ELSE r.registered_at END,
         registered_via        = CASE WHEN NEW.status = 'done' AND r.registered_via IS NULL THEN v_via ELSE r.registered_via END,
         registered_by_user_id = CASE WHEN NEW.status = 'done' AND r.registered_by_user_id IS NULL THEN NEW.user_id ELSE r.registered_by_user_id END,
         last_job_id           = NEW.id,
         updated_at            = now()
   WHERE r.id = v_reg.id;

  IF v_ar IS NOT NULL THEN
    INSERT INTO public.client_portal_registration_events
      (registration_id, kind, our_status, summary_ar, summary_en, job_id, actor_user_id)
    VALUES (v_reg.id, 'run', v_new, v_ar, v_en, NEW.id, NEW.user_id);
  END IF;
  RETURN NEW;
END $function$;

COMMIT;
