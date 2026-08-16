-- ============================================================================
-- Rollback for Phase 3 · B2A — file authorization performance
--
-- Restores the pre-B2A authorization path exactly: the original plpgsql
-- wassell_can_access_file (verbatim from the production definition captured
-- 2026-08-16) and the original files_select policy, then drops the three
-- functions B2A introduced.
--
-- Safe at any time. B2A changed no reach, so rolling it back changes no reach
-- either — it only makes the predicate slow again.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_can_access_file(p_file_id uuid, p_kind text)
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

DROP POLICY IF EXISTS files_select ON public.files;
CREATE POLICY files_select ON public.files FOR SELECT TO authenticated
USING (
  (uploaded_by_user_id = wassell_app_user_id((SELECT auth.uid())))
  OR wassell_can_access_file(id, 'view'::text)
);

DROP FUNCTION IF EXISTS public.wassell_can_access_file_row(uuid,text,uuid,uuid,uuid,boolean,boolean,boolean,boolean);
DROP FUNCTION IF EXISTS public.wassell_user_has_file_grants(uuid);
DROP FUNCTION IF EXISTS public.wassell_user_has_folder_grants(uuid);

COMMIT;
