-- ============================================================================
-- "Is this caller the service role?" — one answer, used by every definer read
-- the C-group adds. 2026-09-15.
--
-- WHY THIS EXISTS. The house pattern for a SECURITY DEFINER read in this schema
-- is `auth.uid() IS NULL OR wassell_mos_can(...)`, where the NULL branch means
-- "the Fly worker or a cron tick, running as service_role". That is only true
-- because every one of those functions has anon REVOKED at the grant level —
-- `auth.uid()` is ALSO null for an anonymous request.
--
-- Relying on a grant alone is one lock. This is the second: an explicit test of
-- who the caller is, so a future default-privilege surprise (Supabase grants
-- anon EXECUTE on every new function in `public`) cannot silently reopen data.
--
-- It fails CLOSED: a claims blob it cannot parse is not a trusted caller.
--
-- Found the hard way on 2026-09-15: `REVOKE ALL … FROM PUBLIC` does NOT remove
-- the grant anon holds in its own right, so `mos_month_exceptions` and
-- `mos_row_summary` shipped callable by anon with a gate that passed for anon.
-- Measured, fixed, and re-measured (anon now gets 42501 on both).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_caller_is_trusted_service()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_claims text;
BEGIN
  v_claims := NULLIF(current_setting('request.jwt.claims', true), '');
  -- No PostgREST request context at all → a direct connection: the Fly worker,
  -- a cron tick, or a migration. Those are trusted.
  IF v_claims IS NULL THEN RETURN true; END IF;
  RETURN (v_claims::jsonb ->> 'role') = 'service_role';
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN
  RAISE WARNING 'MOS:UNPARSEABLE_JWT_CLAIMS — treating caller as untrusted';
  RETURN false;
END $function$;

REVOKE ALL ON FUNCTION public.mos_caller_is_trusted_service() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_caller_is_trusted_service() TO authenticated, service_role;

COMMIT;
