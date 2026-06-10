-- ============================================================================
-- Files System — batch "effective role" RPCs (Files upgrade Phase 1, item #3)
--
-- Why: the SPA grid approximated "can I edit/delete this?" as
--   uploaded_by_user_id === currentUserId
-- which HID Rename/Move/Share/Delete from anyone who was granted editor/owner
-- via a folder cascade or a direct file grant. RLS already allowed those
-- actions server-side; the UI just didn't reflect the grant. These two
-- functions return the caller's STRONGEST effective role per file/folder so the
-- UI can show the right affordances. RLS stays the authoritative gate; this is
-- purely to drive button visibility.
--
-- Additive + idempotent. Mirrors wassell_can_access_file / _folder logic from
-- 2026-05-23_files_system.sql but RETURNS the role instead of a boolean.
-- ============================================================================

BEGIN;

-- Numeric rank for a role string so we can take GREATEST(direct, cascade).
CREATE OR REPLACE FUNCTION public.wassell_role_rank(p_role text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_role
    WHEN 'owner'  THEN 3
    WHEN 'editor' THEN 2
    WHEN 'viewer' THEN 1
    ELSE 0
  END
$$;

-- Effective role per file. Returns one row per input id the caller can see at
-- all (omits files with no access and not-found ids). Strongest of:
--   admin/uploader → owner
--   else GREATEST(direct file grant, folder cascade)
CREATE OR REPLACE FUNCTION public.wassell_effective_file_roles(p_file_ids uuid[])
RETURNS TABLE(file_id uuid, role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  app_uid  uuid    := wassell_app_user_id((SELECT auth.uid()));
  is_admin boolean := wassell_is_admin((SELECT auth.uid()));
  fid uuid;
  uploader uuid;
  fld uuid;
  direct_role text;
  cascade_role text;
  r int;
BEGIN
  IF app_uid IS NULL OR p_file_ids IS NULL THEN RETURN; END IF;
  FOREACH fid IN ARRAY p_file_ids LOOP
    SELECT uploaded_by_user_id, folder_id INTO uploader, fld FROM public.files WHERE id = fid;
    IF uploader IS NULL THEN CONTINUE; END IF;  -- not found
    IF is_admin OR uploader = app_uid THEN
      file_id := fid; role := 'owner'; RETURN NEXT; CONTINUE;
    END IF;
    SELECT fp.role INTO direct_role
      FROM public.file_permissions fp
     WHERE fp.file_id = fid AND fp.user_id = app_uid;
    cascade_role := CASE WHEN fld IS NOT NULL
                        THEN wassell_folder_cascade_role(fld, app_uid)
                        ELSE NULL END;
    r := GREATEST(wassell_role_rank(direct_role), wassell_role_rank(cascade_role));
    IF r > 0 THEN
      file_id := fid;
      role := CASE r WHEN 3 THEN 'owner' WHEN 2 THEN 'editor' ELSE 'viewer' END;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

-- Effective role per folder. admin/creator → owner, else the folder cascade
-- (which already includes the folder itself).
CREATE OR REPLACE FUNCTION public.wassell_effective_folder_roles(p_folder_ids uuid[])
RETURNS TABLE(folder_id uuid, role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  app_uid  uuid    := wassell_app_user_id((SELECT auth.uid()));
  is_admin boolean := wassell_is_admin((SELECT auth.uid()));
  fid uuid;
  creator uuid;
  cascade_role text;
BEGIN
  IF app_uid IS NULL OR p_folder_ids IS NULL THEN RETURN; END IF;
  FOREACH fid IN ARRAY p_folder_ids LOOP
    SELECT created_by_user_id INTO creator FROM public.folders WHERE id = fid;
    IF creator IS NULL THEN CONTINUE; END IF;  -- not found
    IF is_admin OR creator = app_uid THEN
      folder_id := fid; role := 'owner'; RETURN NEXT; CONTINUE;
    END IF;
    cascade_role := wassell_folder_cascade_role(fid, app_uid);
    IF cascade_role IS NOT NULL THEN
      folder_id := fid; role := cascade_role; RETURN NEXT;
    END IF;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.wassell_role_rank(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.wassell_effective_file_roles(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_effective_folder_roles(uuid[]) TO authenticated;

COMMIT;
