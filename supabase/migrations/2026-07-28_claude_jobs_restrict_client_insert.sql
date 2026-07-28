-- WA-02 — stop any authenticated user from creating a whatsapp_reply job.
--
-- `claude_jobs_insert` was `WITH CHECK (true)`, and wa-agent/runner.mjs trusted
-- `payload.forced` to skip the AI safety gate. Together those were an
-- unauthorized-send path: anyone with a login could POST
--
--   {kind:'whatsapp_reply', payload:{chat_wid:'<any number>@c.us', forced:true}}
--
-- and have the agent send a WhatsApp message from the company number to an
-- arbitrary recipient, past the kill switch, working hours, the
-- don't-talk-over-a-human check and the reply cap.
--
-- The browser legitimately creates exactly ONE kind — client_study
-- (src/lib/claudeJobs/client.ts). Verified against history before narrowing:
-- of 276 jobs, the only kind ever carrying a requested_by_user_id is
-- client_study (10 of 10). whatsapp_reply, ping and every mkt_* kind are
-- created service-side.
--
-- service_role bypasses RLS, so the runner, the webhook enqueue and
-- /api/whatsapp/ai-handover are unaffected.
--
-- The second half of this fix is in wa-agent/runner.mjs: the gate is no longer
-- skippable from the payload at all. A genuine rep handover is honoured through
-- PERSISTED state (`records.data.ai_managed`, written by the RLS-authorized
-- /api/whatsapp/ai-handover), which whatsapp_ai_should_reply already recognises
-- as 'chat_ai_managed'.
--
-- Verified live from a real authenticated browser session after applying:
--   forged whatsapp_reply insert → 403 42501 (RLS violation)
--   forged ping insert           → 403 42501 (RLS violation)
--   legitimate client_study      → 201 Created
-- (the probe row was deleted immediately.)

DROP POLICY IF EXISTS claude_jobs_insert ON public.claude_jobs;

CREATE POLICY claude_jobs_insert ON public.claude_jobs
  FOR INSERT TO authenticated
  WITH CHECK (kind = 'client_study');

COMMENT ON POLICY claude_jobs_insert ON public.claude_jobs IS
  'WA-02: browser may only create client_study. Every other kind is service-side; a user-created whatsapp_reply job was an unauthorized-send path.';
