-- A unit is never created without its four essentials (operator rule,
-- 2026-10-05): area, price, bedrooms, unit type. The worker now skips such a
-- unit and TELLS the operator on WhatsApp which units lack what.
--
--   project_update_incomplete_notices  one row per project: the signature of
--       the last list of incomplete units the operator was told about. A weekly
--       run that finds the SAME list stays quiet; a changed list is sent again.
--   project_update_notify_incomplete(project, signature, body)
--       sends through scheduled_whatsapp_enqueue on the operations line to the
--       operator number already configured in ai_alert_settings (the number
--       lives only in the database, never in code). Returns the job id, or
--       NULL when the list is unchanged or no recipient is configured.

BEGIN;

CREATE TABLE IF NOT EXISTS public.project_update_incomplete_notices (
  project_id   uuid PRIMARY KEY,
  signature    text NOT NULL,
  notified_at  timestamptz NOT NULL DEFAULT now(),
  job_id       uuid
);
ALTER TABLE public.project_update_incomplete_notices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_update_incomplete_notices_admin_read ON public.project_update_incomplete_notices;
CREATE POLICY project_update_incomplete_notices_admin_read ON public.project_update_incomplete_notices
  FOR SELECT TO authenticated USING (public.wassell_is_admin(auth.uid()));
REVOKE ALL ON public.project_update_incomplete_notices FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.project_update_incomplete_notices FROM authenticated;
GRANT SELECT ON public.project_update_incomplete_notices TO authenticated;

CREATE OR REPLACE FUNCTION public.project_update_notify_incomplete(
  p_project_id uuid, p_signature text, p_body text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_cfg record; v_job uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.project_update_incomplete_notices
              WHERE project_id = p_project_id AND signature = p_signature) THEN
    RETURN NULL;                                  -- already told about this exact list
  END IF;
  SELECT whatsapp_to, whatsapp_device, enabled INTO v_cfg FROM public.ai_alert_settings LIMIT 1;
  IF v_cfg IS NULL OR NOT coalesce(v_cfg.enabled, false) OR coalesce(v_cfg.whatsapp_to, '') = '' THEN
    RAISE WARNING 'project_update_notify_incomplete: no operator WhatsApp configured (ai_alert_settings) — notice for % not sent', p_project_id;
    RETURN NULL;
  END IF;
  v_job := public.scheduled_whatsapp_enqueue(
    v_cfg.whatsapp_device, v_cfg.whatsapp_to || '@c.us', v_cfg.whatsapp_to, p_body,
    '[]'::jsonb, 'project-update-incomplete:' || p_project_id::text, now(), NULL);
  INSERT INTO public.project_update_incomplete_notices (project_id, signature, notified_at, job_id)
  VALUES (p_project_id, p_signature, now(), v_job)
  ON CONFLICT (project_id) DO UPDATE SET signature = EXCLUDED.signature, notified_at = now(), job_id = EXCLUDED.job_id;
  RETURN v_job;
END $$;

REVOKE ALL ON FUNCTION public.project_update_notify_incomplete(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_update_notify_incomplete(uuid, text, text) TO service_role;

COMMIT;
