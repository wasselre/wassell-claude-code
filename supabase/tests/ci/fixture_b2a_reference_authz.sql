-- The PRE-B2A authorization function, pinned verbatim as a reference oracle.
--
-- Copied byte-for-byte (modulo the name) from the live production definition
-- captured with pg_get_functiondef on 2026-08-16, BEFORE B2A. B2A rewrites
-- wassell_can_access_file into a wrapper over wassell_can_access_file_row; this
-- file keeps the original around so the smoke can prove the two agree for every
-- (file, user, kind) rather than merely asserting that they do.
--
-- If B2A ever changes an answer, smoke_b2a_authz_perf.sql fails with the exact
-- file ids that diverged. Do NOT "fix" this file to match a new implementation
-- — that would delete the only independent witness.

CREATE OR REPLACE FUNCTION public.wassell_can_access_file__reference(p_file_id uuid, p_kind text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  app_uid uuid := wassell_app_user_id((SELECT auth.uid()));
  uploader uuid;
  fld uuid;
  direct_role text;
BEGIN
  IF wassell_is_admin((SELECT auth.uid())) THEN RETURN true; END IF;
  IF app_uid IS NULL OR p_file_id IS NULL THEN RETURN false; END IF;
  SELECT uploaded_by_user_id, folder_id INTO uploader, fld FROM public.files WHERE id = p_file_id;
  IF uploader IS NULL THEN RETURN false; END IF;
  IF uploader = app_uid THEN RETURN true; END IF;
  SELECT role INTO direct_role FROM public.file_permissions WHERE file_id = p_file_id AND user_id = app_uid;
  IF direct_role IS NOT NULL AND wassell_role_satisfies(direct_role, p_kind) THEN
    RETURN true;
  END IF;

  -- Marketing library reach (2026-08-09): view-only, index-probe first.
  IF p_kind = 'view'
     AND EXISTS (SELECT 1 FROM public.mos_assets WHERE file_id = p_file_id)
     AND public.wassell_mos_can('read')
  THEN
    RETURN true;
  END IF;

  IF fld IS NOT NULL THEN
    RETURN wassell_role_satisfies(wassell_folder_cascade_role(fld, app_uid), p_kind);
  END IF;
  RETURN false;
END $function$;

REVOKE ALL ON FUNCTION public.wassell_can_access_file__reference(uuid, text) FROM PUBLIC;
