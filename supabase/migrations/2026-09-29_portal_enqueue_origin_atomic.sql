-- An automatic registration must be born 'auto' — in the SAME insert.
--
-- The ad-lead sweep (api/cron/portal-auto-register.ts) created a run with
-- portal_registration_job_enqueue (origin defaults to 'manual', row committed
-- and claimable at once) and only THEN tagged it origin='auto' in a second
-- UPDATE. The worker polls every 3 s: when it claimed in that gap it treated
-- the run as manual — it never asked the sign-in phone's owner for the code on
-- the operations WhatsApp and waited for a rep to type it into the chat card,
-- so the run timed out and FAILED instead of parking. Hit live 2026-09-29 on
-- an Al Ramz ad lead (Reem): the SMS arrived, no WhatsApp ever did.
--
-- The enqueue RPC now takes origin / attribution / "born parked" and writes
-- them in the insert. New params default to the old behaviour, so the rep's
-- button (api/portal-registration.ts, 6 named args) is unaffected.

BEGIN;

DROP FUNCTION IF EXISTS public.portal_registration_job_enqueue(uuid, uuid, uuid, uuid, jsonb, text);

CREATE FUNCTION public.portal_registration_job_enqueue(
  p_portal_record_id uuid,
  p_client_record_id uuid,
  p_project_record_id uuid,
  p_user_id uuid,
  p_lead_data jsonb,
  p_login_phone text,
  p_origin text DEFAULT 'manual',
  p_attribution_id uuid DEFAULT NULL,
  p_parked boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF COALESCE(p_origin, 'manual') NOT IN ('manual', 'auto') THEN
    RAISE EXCEPTION 'portal_registration_job_enqueue: invalid origin %', p_origin;
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

REVOKE ALL ON FUNCTION public.portal_registration_job_enqueue(uuid, uuid, uuid, uuid, jsonb, text, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_registration_job_enqueue(uuid, uuid, uuid, uuid, jsonb, text, text, uuid, boolean) TO service_role;

COMMIT;
