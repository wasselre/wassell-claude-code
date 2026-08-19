-- ============================================================================
-- Rollback for supabase/migrations/2026-08-19_10_file_views.sql (Phase 3 · B5)
--
-- B5's rollback boundary in the spec is "flag returns the folder-first page",
-- which is a CLIENT action and does not need this file. This exists for the
-- separate case of removing the database objects entirely.
--
-- WHAT THIS DESTROYS: every saved view every user has written. There is no
-- other copy. A saved view is cheap to recreate but nobody will remember which
-- ones existed, so prefer turning the feature flag off (instant, lossless) and
-- leaving these objects in place.
--
-- WHAT THIS RESTORES: file_document_types goes back to deny-all-with-no-policy,
-- exactly as B1 shipped it. Nothing else on the Files surface is touched --
-- this migration never modified `files`, `file_links` or any authorization
-- helper, so there is nothing else to put back.
--
-- Idempotent.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.file_views_save(text, jsonb, text, text, text, text, text, boolean);

DROP TRIGGER  IF EXISTS file_views_touch ON public.file_views;
DROP TABLE    IF EXISTS public.file_views;          -- policies + indexes go with it
DROP FUNCTION IF EXISTS public.tg_file_views_touch();

-- Back to B1's posture: RLS on, no policy, no grant to anon/authenticated.
-- The BEFORE trigger that reads this table is SECURITY DEFINER and keeps
-- working; only the Library UI loses its labels, which is the intent.
DROP POLICY IF EXISTS file_document_types_select ON public.file_document_types;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.file_document_types FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON public.file_document_types FROM service_role;
  END IF;
END $g$;

COMMIT;
