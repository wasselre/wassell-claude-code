-- 2026-10-08: collected competitor / reference content stays OUT of Files and
-- the app (operator: "make sure content extracted does not end up in files and
-- the actual app").
--
-- 1. The raw capture library (mkt_media_raw_capture) is a back-room dataset for
--    building agents later. Nothing in src/ or api/ reads it, but the table was
--    created with an authenticated SELECT policy — and Supabase's default
--    privileges had granted authenticated full DML (RLS was the only thing
--    blocking writes). Make it service-role only: no policy, no grants.
--
-- 2. The Social-media → Files bridge (2026-09-13_04, social_file_settings)
--    copies every collected post that matches a project into the Files system
--    (origin 'social_intake') — project Files tabs, the Business Library and the
--    WhatsApp file picker. It ran during the 2026-10-04..07 collection catch-up
--    at ~1,400 files/day. Switch it OFF (the same kill switch it shipped with).
--    Files it already registered are NOT touched here — that is a separate,
--    confirmed step.
BEGIN;

DROP POLICY IF EXISTS mkt_media_raw_capture_read ON public.mkt_media_raw_capture;
REVOKE ALL ON public.mkt_media_raw_capture FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mkt_media_raw_capture TO service_role;

UPDATE public.social_file_settings SET is_enabled = false, updated_at = now() WHERE is_enabled;

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
              WHERE table_schema = 'public' AND table_name = 'mkt_media_raw_capture'
                AND grantee IN ('anon', 'authenticated', 'PUBLIC')) THEN
    RAISE EXCEPTION 'RAW_CAPTURE_STILL_EXPOSED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.social_file_settings WHERE is_enabled) THEN
    RAISE EXCEPTION 'SOCIAL_FILE_BRIDGE_STILL_ON';
  END IF;
END $assert$;

COMMIT;
