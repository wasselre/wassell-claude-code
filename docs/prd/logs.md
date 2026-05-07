# PRD: Activity Log

**Status:** Live
**Last updated:** 2026-05-07 (**RLS hardening + immutability — Phase B.3, deployed 2026-05-07.** The previous `Authenticated full access` USING(true) WITH CHECK(true) FOR ALL policy on `activity_log` let any user read every other user's actions and rewrite history via UPDATE — both wrong for an audit log. The policy is now split into per-command policies: `activity_log_select` (admin sees all events; non-admin sees only events where `actor_user_id = wassell_app_user_id((SELECT auth.uid()))`), `activity_log_insert` (admin can stamp any actor; non-admin must self-stamp — NULL `actor_user_id` is rejected to prevent anonymous logging), `activity_log_delete` (admin only — for retention pruning). **No UPDATE policy** — audit logs are formally immutable. Any UPDATE attempt now returns `42501`. Service-role inserts (the Vercel API routes / webhooks paths) bypass RLS as before. The frontend logger in `src/lib/activityLogger.ts` already stamps `actor_user_id = currentUserId` so non-admin INSERTs continue to work; system events that would have written `actor_user_id = NULL` from a signed-in non-admin session would now be rejected — those paths run via the service-role helper in `api/_lib/activityLogger.ts`.)
**Related PRDs:** [workflow-logs.md](workflow-logs.md), [ai-agent.md](ai-agent.md), [access-control.md](access-control.md), [data-storage.md](data-storage.md)

## What it is (in plain English)
A single page at `/logs` that shows everything happening in the app, in one continuous timeline: who signed in and when, every record that was created / updated / deleted / opened, every workflow that fired, every turn of the AI sales agent (with the full tool calls it made and what they returned), every API request the front-end made, and every webhook that arrived from Haberchat or Hatif. The admin can filter by category, status, user, model, and free-text search, then click any entry to see its full payload in the right pane.

## Why it exists
Before this page, debugging "what happened" required jumping between Supabase Studio, Vercel function logs, the WhatsApp Haberchat dashboard, the Hatif call dashboard, and grepping through console output. Owners want a single place to ask "what did the AI agent search for at 3pm yesterday?", "who deleted record X?", "which webhook calls failed last hour?" — without leaving the app. It's also a forensic trail for compliance: every destructive action and every external integration touch is now persisted with the actor's identity.

## Key behaviors
- **Admin-only.** The route is gated by `RequireAdmin`. Non-admins don't see the sidebar entry and get a 403-equivalent if they hit the URL directly.
- **One unified timeline.** Categories: `auth`, `record`, `workflow`, `ai_agent`, `api`, `webhook`, `system`. Each row carries a localizable summary, an actor, an optional target (model + record id), a status, a duration, and a `details` JSONB payload.
- **Workflow rows deep-link to the existing detail page.** The summary row in `activity_log` carries a `workflow_run_id`; the detail panel shows an "Open workflow run detail" button that navigates to `/workflow/logs/:runId` where the full conditions/actions trace lives.
- **AI agent gets full depth.** Every turn writes one row with: iteration number, stop reason, message count, and the complete `tool_calls` array — name, full input args, full result string, duration, error if any. The /logs UI renders each tool call as its own card with input + result side by side. (The earlier `ai-agent.md` rule "tool-use blocks are not persisted" is superseded; tool calls are persisted in `activity_log.details`.)
- **API requests log on every hit.** The `withAuth` wrapper records method, path, query string, status code, duration, and the actor. Streaming responses (SSE) are logged at handler-return time with status 200 even though the stream may continue.
- **Webhooks log on receipt.** Both `/api/webhook/haberchat` and `/api/webhook/hatif-call` write a row with the source, event type, and the raw payload (truncated to 16KB if larger).
- **Record updates log only the diff, not the full snapshot.** A no-op save (e.g. auto_id-only writes that produce no field-level diff) does not produce a row.
- **Record deletes capture the last snapshot** in `details.last_snapshot` for forensics.
- **Record opens log every visit.** The `RecordFormPage` mount fires one event per record-mount. Navigating between records via prev/next remounts the page (key change) and produces one event per record visited.
- **Sign-in logs only on identity transition.** A page reload that restores a cached session does NOT produce a sign_in event — only a real auth-state change from null → email does.
- **Two-tier storage cap.** In-memory + localStorage holds the most recent 200 entries. Supabase keeps everything; the LogsPage loads the most recent 500 on mount via `loadActivityLog(500)`. There is no automatic purge — admins can run a SQL delete from Supabase Studio when they want a cleanup, or use the "Clear all" button which deletes the rows currently visible.
- **Logging is fire-and-forget.** Any error writing to the log is swallowed (logged to console only) so logging never breaks the action that triggered it.
- **RLS-enforced visibility (Phase B.3, 2026-05-07).** Non-admin users see only their own events when querying the table directly (`actor_user_id = wassell_app_user_id((SELECT auth.uid()))`). Admins see everything. INSERTs require self-stamping; DELETEs are admin-only; UPDATEs are blocked entirely (no policy authorizes them). Service-role inserts (Vercel API routes + webhooks) bypass RLS so server-side `logServerActivity` / `logApiRequest` / `logWebhookReceipt` continue to work unchanged.

## User flows
1. **Admin investigates a deletion:** opens `/logs`, filters category=`record`, types a record name in search → finds the row → clicks → right pane shows the deleting user, the timestamp, and `details.last_snapshot` with the full record data at delete time.
2. **Admin debugs the AI agent:** filters category=`ai_agent` → picks the most recent turn → right pane shows iteration, stop reason, and one card per tool call with the exact JSON input and the exact text result the model received.
3. **Admin tracks a webhook delivery:** filters category=`webhook` → searches for the wid or callId → finds the row → details panel shows the raw event payload Haberchat/Hatif sent.
4. **Admin audits API hits:** filters category=`api` and status=`error` → sees every 4xx/5xx response with method, path, and the duration up to error.
5. **Empty state:** brand-new install shows "No activity yet — entries will appear automatically."

## Data touched
- Reads/writes: `public.activity_log` (new — JSONB `details` column).
- Read-only cross-link: `public.workflow_runs` via `activity_log.workflow_run_id`.
- localStorage: `wassell_activity_log` (capped at 200 entries, newest first).

## Key files
| File | What it does |
|---|---|
| `src/pages/Logs/LogsPage.tsx` | Main page — list + detail two-pane, filters, category cards, refresh + clear-all. |
| `src/lib/activityLogger.ts` | Client-side helpers — `signIn`, `signOut`, `recordCreated/Updated/Deleted`, `recordOpened`, `workflowRunSummary`. Funnels through `appendActivityLog`. |
| `api/_lib/activityLogger.ts` | Server-side helpers — `logServerActivity`, `logApiRequest`, `logWebhookReceipt`, `logAiAgentTurn`. Uses the service-role Supabase client. |
| `src/stores/appStore.ts` | `appendActivityLog`, `loadActivityLog`, `deleteActivityLog`, `clearActivityLog` actions. Instruments `bindAuth`, `signOutAndClear`, `saveRecord`, `deleteRecord`, and `appendWorkflowRun`. |
| `api/agent.ts` | AI agent endpoint — logs one row per Claude turn with full `tool_calls` array. |
| `api/_lib/auth.ts` | `withAuth` middleware — logs every API hit (method, path, status, duration, actor). |
| `api/webhook/haberchat.ts`, `api/webhook/hatif-call.ts` | Both write a webhook-receipt row on every payload. |
| `supabase/schema.sql` | `activity_log` table definition (idempotent). |
| `src/components/layout/Sidebar.tsx` | "Activity Log" link under the System section, admin-only. |
| `src/types/index.ts` | `ActivityLogEntry`, `ActivityLogCategory`, `ActivityLogStatus` types. |

## Open questions / known limitations
- **No retention/auto-purge.** The table grows unboundedly until admin clears it. Acceptable for v1 staff-only launch; revisit when external clients onboard.
- **No real-time stream — but `activity_log` is NOT yet on the realtime publication.** The 2026-05-07 refactor added 11 tables to `supabase_realtime` (records, models, workflows, etc.) but `activity_log` was intentionally left off — busy installations would generate noisy events that aren't useful in the chrome. The page reloads on mount and on the manual Refresh button; events that land while the page is open don't appear until refresh. Future: opt in if it proves needed.
- **Bulk operations log per-row.** A bulk import of 500 records produces 500 `record.create` rows. Acceptable; if it ever becomes noisy we can add a `bulk_id` column to group them.
- **Page-view tracking is record-only.** We log when a user opens a specific record, but not when they navigate to a list, dashboard, or settings page. Adds noise without much forensic value; revisit if needed.
- **Clear-all only purges visible rows.** Older Supabase rows beyond the 500 most-recent stay in the database. Use Supabase Studio for a full purge — admins use the new `slow_query_log()` admin function to identify pruning candidates.
- **Non-admin users can't see system events.** The B.3 policy split rejects INSERTs with NULL `actor_user_id` from authenticated users (only service-role bypasses), so any system event that doesn't carry an actor must go through the server-side logger. Admin SELECTs see everything regardless.
