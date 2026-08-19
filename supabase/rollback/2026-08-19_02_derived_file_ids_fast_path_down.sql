-- ============================================================================
-- Rollback for supabase/migrations/2026-08-19_02_derived_file_ids_fast_path.sql
-- (Phase 3 · B2A.6)
--
-- Restores B4's original helper verbatim (LANGUAGE sql, single predicate, no
-- partition and no zero-permission guard). Reach-neutral in both directions:
-- B2A.6 changed only HOW the set is computed, never WHICH ids it contains, so
-- rolling back returns the same file-id set it replaced. The validator asserts
-- that rather than assuming it.
--
-- Restores the slow path: ~590-1,320 ms per statement for every read of `files`
-- or `file_links`. Roll back for correctness, not for comfort.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_my_record_derived_file_ids()
RETURNS TABLE (file_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT DISTINCT l.file_id
    FROM public.file_links l
    JOIN public.records r
      ON r.id = l.record_id AND r.model_id = l.model_id
   WHERE public.wassell_file_derived_access_enabled()
     AND public.wassell_app_user_id((SELECT auth.uid())) IS NOT NULL
     AND public.wassell_can_view_record((SELECT auth.uid()), r.*)
$fn$;

COMMENT ON FUNCTION public.wassell_my_record_derived_file_ids() IS NULL;

REVOKE ALL ON FUNCTION public.wassell_my_record_derived_file_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wassell_my_record_derived_file_ids() TO authenticated;

COMMIT;
