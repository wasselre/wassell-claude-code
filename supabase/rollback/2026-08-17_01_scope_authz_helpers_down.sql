-- ============================================================================
-- Rollback for the caller-scoping security correction
--
-- WARNING. This restores the FORGEABLE helpers and the direct-RPC bypass they
-- carry: any authenticated caller regains the ability to enumerate any other
-- user's grant sets, and identity-less / deactivated callers regain the whole
-- marketing file-id list. Only run it if the corrective migration itself is
-- causing a worse problem.
--
-- Reach through files_select is identical either way; only direct RPC differs.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_granted_file_ids(p_app_uid uuid, p_kind text)
RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT fp.file_id
    FROM public.file_permissions fp
   WHERE p_app_uid IS NOT NULL
     AND fp.user_id = p_app_uid
     AND public.wassell_role_satisfies(fp.role, p_kind)
$$;

CREATE OR REPLACE FUNCTION public.wassell_cascade_folder_ids(p_app_uid uuid, p_kind text)
RETURNS TABLE (folder_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  WITH RECURSIVE seed AS (
    SELECT fp.folder_id AS id
      FROM public.folder_permissions fp
     WHERE p_app_uid IS NOT NULL
       AND fp.user_id = p_app_uid
       AND public.wassell_role_satisfies(fp.role, p_kind)
  ), tree AS (
    SELECT id FROM seed
    UNION
    SELECT f.id FROM public.folders f JOIN tree t ON f.parent_folder_id = t.id
  )
  SELECT id FROM tree
$$;

CREATE OR REPLACE FUNCTION public.wassell_marketing_file_ids()
RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT ma.file_id FROM public.mos_assets ma WHERE ma.file_id IS NOT NULL
$$;

DROP POLICY IF EXISTS files_select ON public.files;
CREATE POLICY files_select ON public.files FOR SELECT TO authenticated
USING (
  (SELECT public.wassell_app_user_id((SELECT auth.uid()))) IS NOT NULL
  AND (
       (SELECT public.wassell_is_admin((SELECT auth.uid())))
    OR uploaded_by_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid())))
    OR id IN (SELECT g.file_id FROM public.wassell_granted_file_ids(
                (SELECT public.wassell_app_user_id((SELECT auth.uid()))), 'view') g)
    OR ((SELECT public.wassell_mos_can('read'))
        AND id IN (SELECT m.file_id FROM public.wassell_marketing_file_ids() m))
    OR (folder_id IS NOT NULL
        AND folder_id IN (SELECT c.folder_id FROM public.wassell_cascade_folder_ids(
                (SELECT public.wassell_app_user_id((SELECT auth.uid()))), 'view') c))
  )
);

DROP FUNCTION IF EXISTS public.wassell_my_granted_file_ids(text);
DROP FUNCTION IF EXISTS public.wassell_my_cascade_folder_ids(text);
DROP FUNCTION IF EXISTS public.wassell_my_marketing_file_ids();

DO $g$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.wassell_granted_file_ids(uuid,text)',
    'public.wassell_cascade_folder_ids(uuid,text)',
    'public.wassell_marketing_file_ids()',
    'public.wassell_can_access_file_row(uuid,text,uuid,uuid,uuid,boolean,boolean,boolean,boolean)',
    'public.wassell_user_has_file_grants(uuid)',
    'public.wassell_user_has_folder_grants(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END IF;
  END LOOP;
END $g$;

COMMIT;
