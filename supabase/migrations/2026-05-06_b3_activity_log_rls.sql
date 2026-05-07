-- ============================================================
-- Phase B.3 — Tighten activity_log RLS
-- ============================================================
-- The current policy on activity_log is "Authenticated full access"
-- with USING(true) WITH CHECK(true) FOR ALL — flagged by advisor
-- as rls_policy_always_true. This means any authenticated user can
-- read every other user's actions AND can rewrite history via UPDATE.
-- For an audit log, both are wrong: the whole point of an audit log
-- is to be tamper-evident.
--
-- New posture (split into per-command policies):
--   SELECT: admin sees all; non-admin sees only their own events.
--   INSERT: admin can insert anything; non-admin must stamp their
--           own actor_user_id.
--           (System / service_role inserts bypass RLS — they go
--           through the service role key in webhooks and Vercel
--           API routes.)
--   UPDATE: NO POLICY — audit logs are immutable.
--   DELETE: admin only — for retention pruning.
--
-- Edge cases:
--   * actor_user_id IS NULL — system events. With this policy,
--     non-admin INSERTs with NULL fail. Frontend must always stamp
--     actor_user_id (currentUserId) — verified in
--     src/lib/activityLogger.ts. Service-role inserts bypass RLS.
--   * wassell_app_user_id((SELECT auth.uid())) returns NULL if the
--     authenticated user lacks a public.users row. The check
--     "actor_user_id = NULL" evaluates to NULL (not false), so the
--     row is rejected for those users. Correct.
--
-- Verification:
--   * Advisor: rls_policy_always_true count drops by 1 (activity_log).
--   * Non-admin SELECT * FROM activity_log returns only their own rows.
--   * Non-admin INSERT with foreign actor_user_id → 42501.
--   * Any UPDATE → 42501.
--
-- Rollback: re-create the original "Authenticated full access" policy
-- via 2026-05-06_b3_rollback.sql (kept alongside).
-- ============================================================

-- Drop the always-true permissive policy.
DROP POLICY IF EXISTS "Authenticated full access" ON public.activity_log;

-- SELECT: admin sees all, users see their own.
CREATE POLICY activity_log_select ON public.activity_log FOR SELECT TO authenticated
  USING (
    public.wassell_is_admin((SELECT auth.uid()))
    OR actor_user_id = public.wassell_app_user_id((SELECT auth.uid()))
  );

-- INSERT: admin or self-stamped. Non-admin must set actor_user_id
-- to their own app_user_id; rejecting NULL prevents anonymous logging.
CREATE POLICY activity_log_insert ON public.activity_log FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_is_admin((SELECT auth.uid()))
    OR (
      actor_user_id IS NOT NULL
      AND actor_user_id = public.wassell_app_user_id((SELECT auth.uid()))
    )
  );

-- DELETE: admin only — for retention pruning.
CREATE POLICY activity_log_delete ON public.activity_log FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- (No UPDATE policy — audit logs are immutable. Any UPDATE attempt
-- returns 42501 because no policy authorizes it.)
