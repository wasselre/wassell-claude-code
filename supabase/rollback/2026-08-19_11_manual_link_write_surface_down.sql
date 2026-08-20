-- ============================================================================
-- Rollback for supabase/migrations/2026-08-19_11_manual_link_write_surface.sql
--
-- B6's stated rollback boundary is "hide the panel; links already written stay
-- valid and keep syncing" — a CLIENT action that does not need this file. This
-- exists for the separate case of reverting the database change.
--
-- READ THIS BEFORE RUNNING IT. This rollback is deliberately NOT symmetric,
-- and running it in full RE-OPENS a hole:
--
--   §2 and §3 (the UPDATE policy and the role-only trigger) are reverted below.
--   §1 (the grant hardening) is NOT, because restoring TRUNCATE to anon and
--   authenticated would put back a privilege that row-level security does not
--   mediate, in order to undo a change nothing depends on. A rollback exists to
--   recover from a regression, not to reinstate a vulnerability.
--
-- If you genuinely need the original grants back — the only real case is a
-- service that authenticates as `authenticated` and issues UPDATE outside the
-- policy — the statement is commented out at the bottom. Uncomment it
-- knowingly.
--
-- Idempotent.
-- ============================================================================

BEGIN;

-- §3 — the role-only guard.
DROP TRIGGER  IF EXISTS document_links_role_only_update ON public.document_links;
DROP FUNCTION IF EXISTS public.tg_document_links_role_only_update();

-- §2 — the UPDATE policy. With this gone, the UPDATE grant is inert again
-- (no policy = deny), which is the pre-B6 behaviour.
DROP POLICY IF EXISTS document_links_update ON public.document_links;

-- §1 — NOT reverted. See the header. The line below is the un-revert, left
-- commented deliberately:
--
--   GRANT ALL ON public.document_links TO anon, authenticated;

COMMIT;
