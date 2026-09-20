-- Careers settings — editable WhatsApp message for the experience link (2026-09-20)
-- ============================================================================
-- A tiny singleton so the team can view + EDIT the message that goes out with the
-- per-candidate experience link. `{name}` and `{link}` are substituted at send
-- time by api/careers/send-experience (service role reads this row). Admins
-- read/edit via their JWT + `wassell_is_admin` (same posture as job_applications).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.careers_settings (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  experience_message text NOT NULL DEFAULT '',
  updated_at         timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.careers_settings (id, experience_message)
VALUES (1, $msg$أهلًا {name} 👋
يسعدنا اهتمامك بالانضمام إلى فريق وصل العقارية.
جهّزنا لك تجربة قصيرة تعرّفك على طريقة العمل والدخل قبل المقابلة — تأخذ دقائق من جوالك:
{link}

هذا الرابط خاص بك.$msg$)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.careers_settings_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_catalog AS $fn$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$fn$;
DROP TRIGGER IF EXISTS careers_settings_touch ON public.careers_settings;
CREATE TRIGGER careers_settings_touch BEFORE UPDATE ON public.careers_settings
FOR EACH ROW EXECUTE FUNCTION public.careers_settings_touch();

ALTER TABLE public.careers_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS careers_settings_admin_select ON public.careers_settings;
CREATE POLICY careers_settings_admin_select ON public.careers_settings
  FOR SELECT TO authenticated USING (public.wassell_is_admin(auth.uid()));
DROP POLICY IF EXISTS careers_settings_admin_update ON public.careers_settings;
CREATE POLICY careers_settings_admin_update ON public.careers_settings
  FOR UPDATE TO authenticated USING (public.wassell_is_admin(auth.uid())) WITH CHECK (public.wassell_is_admin(auth.uid()));
-- No INSERT policy: the singleton row is seeded here; service role bypasses RLS to read.
