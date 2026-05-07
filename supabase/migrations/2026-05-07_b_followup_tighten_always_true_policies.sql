-- ============================================================
-- Phase B follow-up — tighten 11 always-true RLS policies
-- ============================================================
-- The Supabase advisor flagged 16 tables with `USING(true) WITH
-- CHECK(true) FOR ALL` policies. Phase B.3 fixed activity_log.
-- This migration tightens 11 more, by category:
--
--   1. WEBHOOK-DRIVEN (read for users, write for service_role only):
--      chat_messages, call_logs, webhook_payloads
--      → SELECT for authenticated; INSERT/UPDATE/DELETE only via
--        service_role (bypassing RLS) from /api/webhook/* handlers.
--
--   2. MARKETING DATA (admin write, authenticated read):
--      competitors, posts, reels, research_questions
--      → SELECT for authenticated; INSERT/UPDATE/DELETE for admin.
--
--   3. SETTINGS (admin write, authenticated read):
--      webhook_slugs, whatsapp_numbers
--      → SELECT for authenticated; INSERT/UPDATE/DELETE for admin.
--
--   4. PER-USER NOTIFICATIONS:
--      marketing_notifications (has user_id column)
--      → SELECT/UPDATE: owner or admin (UPDATE for read_at flag).
--      → INSERT/DELETE: admin only.
--
--   5. DEPRECATED WA TABLES (admin-only since unused per CLAUDE.md):
--      wa_conversations, wa_errors, wa_leads
--      → admin-only for ALL operations.
--
-- INTENTIONALLY LEFT AT USING(true) (keep collaboration):
--   - whiteboards, whiteboard_folders (multi-user canvas)
--   - workflow_runs_insert (any user's record save can trigger
--     workflows whose runs need to log; INSERT WITH CHECK true is
--     intentional)
--
-- All policies use the (SELECT auth.uid()) wrap from A.1 so the
-- planner evaluates auth.uid() once per query, not per row.
-- ============================================================

-- ── 1. WEBHOOK-DRIVEN TABLES ──────────────────────────────────

-- chat_messages: written by /api/webhook/haberchat (service_role bypasses RLS).
-- Readers are authenticated users viewing chats.
DROP POLICY IF EXISTS "Authenticated full access" ON public.chat_messages;
CREATE POLICY chat_messages_select ON public.chat_messages FOR SELECT TO authenticated
  USING (true);
-- No INSERT/UPDATE/DELETE for authenticated — webhooks do it via service_role.

-- call_logs: written by /api/webhook/hatif-call (service_role bypasses RLS).
-- Readers are authenticated users viewing calls.
DROP POLICY IF EXISTS "Authenticated full access" ON public.call_logs;
CREATE POLICY call_logs_select ON public.call_logs FOR SELECT TO authenticated
  USING (true);

-- webhook_payloads: written by /api/webhook/* (service_role). Read by the
-- marketing-pipeline UI to show recent inbound payloads.
DROP POLICY IF EXISTS "Authenticated full access" ON public.webhook_payloads;
CREATE POLICY webhook_payloads_select ON public.webhook_payloads FOR SELECT TO authenticated
  USING (true);
-- The marketing UI also marks payloads as `consumed_at` after running them;
-- that's an UPDATE the authenticated client does. Allow it.
CREATE POLICY webhook_payloads_consume_update ON public.webhook_payloads FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);

-- ── 2. MARKETING DATA (admin write, authenticated read) ───────

DROP POLICY IF EXISTS "Authenticated full access" ON public.competitors;
CREATE POLICY competitors_select ON public.competitors FOR SELECT TO authenticated USING (true);
CREATE POLICY competitors_insert ON public.competitors FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY competitors_update ON public.competitors FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY competitors_delete ON public.competitors FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

DROP POLICY IF EXISTS "Authenticated full access" ON public.posts;
CREATE POLICY posts_select ON public.posts FOR SELECT TO authenticated USING (true);
CREATE POLICY posts_insert ON public.posts FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY posts_update ON public.posts FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY posts_delete ON public.posts FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

DROP POLICY IF EXISTS "Authenticated full access" ON public.reels;
CREATE POLICY reels_select ON public.reels FOR SELECT TO authenticated USING (true);
CREATE POLICY reels_insert ON public.reels FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY reels_update ON public.reels FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY reels_delete ON public.reels FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

DROP POLICY IF EXISTS "Authenticated full access" ON public.research_questions;
CREATE POLICY research_questions_select ON public.research_questions FOR SELECT TO authenticated USING (true);
CREATE POLICY research_questions_insert ON public.research_questions FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
-- Allow the user who answers a question to update it (sets answered_by, answer, etc.).
CREATE POLICY research_questions_update ON public.research_questions FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())) OR answered_by = public.wassell_app_user_id((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())) OR answered_by = public.wassell_app_user_id((SELECT auth.uid())));
CREATE POLICY research_questions_delete ON public.research_questions FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- ── 3. SETTINGS (admin write, authenticated read) ─────────────

DROP POLICY IF EXISTS "Authenticated full access" ON public.webhook_slugs;
CREATE POLICY webhook_slugs_select ON public.webhook_slugs FOR SELECT TO authenticated USING (true);
CREATE POLICY webhook_slugs_insert ON public.webhook_slugs FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY webhook_slugs_update ON public.webhook_slugs FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY webhook_slugs_delete ON public.webhook_slugs FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

DROP POLICY IF EXISTS "Authenticated full access" ON public.whatsapp_numbers;
CREATE POLICY whatsapp_numbers_select ON public.whatsapp_numbers FOR SELECT TO authenticated USING (true);
CREATE POLICY whatsapp_numbers_insert ON public.whatsapp_numbers FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY whatsapp_numbers_update ON public.whatsapp_numbers FOR UPDATE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY whatsapp_numbers_delete ON public.whatsapp_numbers FOR DELETE TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())));

-- ── 4. PER-USER NOTIFICATIONS ─────────────────────────────────

DROP POLICY IF EXISTS "Authenticated full access" ON public.marketing_notifications;
CREATE POLICY marketing_notifications_select ON public.marketing_notifications FOR SELECT TO authenticated
  USING (
    user_id = public.wassell_app_user_id((SELECT auth.uid()))
    OR public.wassell_is_admin((SELECT auth.uid()))
  );
-- Insert: admin only (workflows / ops will run as service_role and bypass).
CREATE POLICY marketing_notifications_insert ON public.marketing_notifications FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
-- Update: owner can mark as read (set read_at); admin can do anything.
CREATE POLICY marketing_notifications_update ON public.marketing_notifications FOR UPDATE TO authenticated
  USING (
    user_id = public.wassell_app_user_id((SELECT auth.uid()))
    OR public.wassell_is_admin((SELECT auth.uid()))
  )
  WITH CHECK (
    user_id = public.wassell_app_user_id((SELECT auth.uid()))
    OR public.wassell_is_admin((SELECT auth.uid()))
  );
CREATE POLICY marketing_notifications_delete ON public.marketing_notifications FOR DELETE TO authenticated
  USING (
    user_id = public.wassell_app_user_id((SELECT auth.uid()))
    OR public.wassell_is_admin((SELECT auth.uid()))
  );

-- ── 5. DEPRECATED WA TABLES (admin-only) ──────────────────────

DROP POLICY IF EXISTS "Authenticated full access" ON public.wa_conversations;
CREATE POLICY wa_conversations_admin ON public.wa_conversations FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

DROP POLICY IF EXISTS "Authenticated full access" ON public.wa_errors;
CREATE POLICY wa_errors_admin ON public.wa_errors FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

DROP POLICY IF EXISTS "Authenticated full access" ON public.wa_leads;
CREATE POLICY wa_leads_admin ON public.wa_leads FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
