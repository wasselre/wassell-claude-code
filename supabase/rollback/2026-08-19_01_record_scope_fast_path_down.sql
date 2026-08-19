-- ============================================================================
-- Rollback for supabase/migrations/2026-08-19_01_record_scope_fast_path.sql
-- (Phase 3 · B2A.5)
--
-- Restores records_view to the pre-B2A.5 predicate: the bare per-row call, with
-- no fast path. Because the migration was `FASTPATH OR ORIGINAL`, rolling back
-- can only ever REMOVE the fast path term — it cannot change any caller's row
-- set, provided the fast path was sound. run_b2a5_record_scope_test.sh asserts
-- exactly that: fingerprints after rollback must equal fingerprints before the
-- migration AND after it.
--
-- The helper function is dropped too. Leaving an unreferenced SECURITY DEFINER
-- set-returning function installed is the pattern 2026-08-17_01 was written to
-- end; if the rollback is only temporary, re-applying the migration recreates
-- it.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS records_view ON public.records;
CREATE POLICY records_view ON public.records
  FOR SELECT TO authenticated
  USING (public.wassell_can_view_record((SELECT auth.uid()), records.*));

DROP FUNCTION IF EXISTS public.wassell_my_view_scope_all_models();

COMMIT;
