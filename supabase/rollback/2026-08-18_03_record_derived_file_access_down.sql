-- ============================================================================
-- Rollback for Phase 3 · B4 — record-derived view access
--
-- READ THIS FIRST: you almost certainly do not want this file.
--
-- B4's designed rollback is the TOGGLE, exactly as the spec specifies:
--
--     UPDATE public.file_access_settings SET derived_view_enabled = false;
--
-- One statement, instant, no data change, no DDL, no lock on files or
-- file_links. That is the rollback boundary B4 was accepted against.
--
-- This script is the heavier option: it removes the machinery entirely. Use it
-- only if the B4 objects themselves are causing a problem (a bad plan, a broken
-- trigger), not merely to withdraw the access grant.
--
-- It restores the B2A.4 predicate exactly and drops confidentiality from
-- file_links. It does NOT touch B2A.4's own two columns.
-- ============================================================================

BEGIN;

DO $policies$
DECLARE
  pred CONSTANT text := $pred$
  (SELECT public.wassell_app_user_id((SELECT auth.uid()))) IS NOT NULL
  AND (
       (SELECT public.wassell_is_admin((SELECT auth.uid())))
    OR uploaded_by_user_id = (SELECT public.wassell_app_user_id((SELECT auth.uid())))
    OR @FILE@ IN (SELECT g.file_id FROM public.wassell_my_granted_file_ids('view') g)
    OR ((SELECT public.wassell_mos_can('read'))
        AND @FILE@ IN (SELECT m.file_id FROM public.wassell_my_marketing_file_ids() m))
    OR (folder_id IS NOT NULL
        AND folder_id IN (SELECT c.folder_id FROM public.wassell_my_cascade_folder_ids('view') c))
  )$pred$;
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS files_select ON public.files';
  EXECUTE format(
    'CREATE POLICY files_select ON public.files FOR SELECT TO authenticated USING (%s)',
    replace(pred, '@FILE@', 'id'));

  EXECUTE 'DROP POLICY IF EXISTS file_links_select ON public.file_links';
  EXECUTE format(
    'CREATE POLICY file_links_select ON public.file_links FOR SELECT TO authenticated '
    'USING (%s AND EXISTS (SELECT 1 FROM public.unified_records ur '
    '  WHERE ur.id = file_links.record_id AND ur.model_id = file_links.model_id))',
    replace(pred, '@FILE@', 'file_id'));
END $policies$;

-- Restore the B2A.4 two-column trigger pair.
CREATE OR REPLACE FUNCTION public.tg_file_links_fill_authz()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' SET jit = 'off'
AS $fn$
BEGIN
  SELECT f.uploaded_by_user_id, f.folder_id
    INTO NEW.uploaded_by_user_id, NEW.folder_id
    FROM public.files f WHERE f.id = NEW.file_id;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.tg_files_push_authz()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' SET jit = 'off'
AS $fn$
BEGIN
  IF OLD.uploaded_by_user_id IS NOT DISTINCT FROM NEW.uploaded_by_user_id
     AND OLD.folder_id       IS NOT DISTINCT FROM NEW.folder_id THEN
    RETURN NULL;
  END IF;
  UPDATE public.file_links l
     SET uploaded_by_user_id = NEW.uploaded_by_user_id,
         folder_id           = NEW.folder_id
   WHERE l.file_id = NEW.id
     AND (l.uploaded_by_user_id IS DISTINCT FROM NEW.uploaded_by_user_id
       OR l.folder_id           IS DISTINCT FROM NEW.folder_id);
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS files_push_authz ON public.files;
CREATE TRIGGER files_push_authz
  AFTER UPDATE OF uploaded_by_user_id, folder_id ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.tg_files_push_authz();

DROP FUNCTION IF EXISTS public.wassell_my_record_derived_file_ids();
DROP FUNCTION IF EXISTS public.wassell_file_derived_access_enabled();

ALTER TABLE public.file_links DROP COLUMN IF EXISTS confidentiality;
DROP TABLE IF EXISTS public.file_access_settings;

COMMIT;
