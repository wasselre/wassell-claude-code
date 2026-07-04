# Wassell CRM — Sales Process Architecture Audit
### Follow-ups × WhatsApp × Workflows: current behavior, contradictions, and the path to reconciliation

> Prepared 2026-07-04. Analysis only — nothing implemented. Sources: production source code
> (file:line references throughout), the live workflows table in wassell-prod, and live record
> data queried on 2026-07-04. Companion doc: SALES-SYSTEM-BRIEFING.md.

---

## 1. Current architecture map

### Data models & fields

| Thing | Where | Key facts |
|---|---|---|
| **followups model** | `src/data/seedModels.ts:954–1372` + `supabase/migrations/2026-06-16_sales_os_phase1.sql` (status/priority/outcome/evidence fields) + `2026-06-17_whatsapp_followup_fields.sql` (WhatsApp fields) | `followup_type` (section-selector, stored as an ARRAY e.g. `["whatsapp_follow_up"]`), `followup_status` (open/in_progress/completed/cancelled/skipped — **workflow-created rows often have NULL**, treated as open), `scheduled_datetime` (required; **repurposed as the escalation deadline after a WhatsApp send**), `call_result` (27 outcomes in `src/lib/salesProcess/outcomes.ts`), `whatsapp_state` (`message_sent_waiting_response` / `no_response_expired` / **`replied` — defined but never written by anything**), `sent_at`, `first_whatsapp_sent_at`, `whatsapp_attempt_number`, `escalation_reason`, `source_followup_id` (self-stamp for escalation), `previous_followup_id`, `completed_by_call_id` / `completed_by_chat_id` (evidence), `fired_at` (on_due claim stamp) |
| **chats model** | `seedModels.ts:2658–2874` | `wid`, `phone`, `status` (active/resolved/archived — **live data also contains `pending` from Haberchat sync, 92 rows**), `client_link`, `unread_count`, `last_message_at`, `last_message_flow` (in/out), `device_id`, `labels`, `owner` |
| **chat_messages table** | `supabase/schema.sql:957–1039` | One row per WhatsApp message; written ONLY by the webhook (service role) + optimistic placeholders; Realtime-enabled; RLS = any authenticated user |
| **clients derived fields** | `supabase/migrations/2026-06-17_client_next_action.sql` + `2026-06-17_client_derived_fields.sql` | `next_followup_id` / `next_action_type` / `next_action_due_at` = **earliest open follow-up by scheduled_datetime** (`COALESCE(followup_status,'open') IN ('open','in_progress')`, `ORDER BY scheduled ASC NULLS LAST, created_at`); maintained by a BEFORE trigger on clients + AFTER touch triggers on followups/phone_calls/chats |

### Code paths

| Behavior | Where | Key facts |
|---|---|---|
| Workspace completion | `src/pages/Followups/FollowUpWorkspacePage.tsx:183` `handleComplete()` | Stamps `call_result`, `actual_datetime`, `followup_status='completed'`, `completed_by_user`, stage/status snapshots; saves via `saveRecord` (optimistic version) → client-side workflows fire. **Does NOT clear `whatsapp_state`** (the comment at :247 claims it does — it doesn't; confirmed in code and in 4 live rows). |
| WhatsApp send (two-phase) | same file `:249–290` `handleWhatsAppSent()` | Sets `whatsapp_state='message_sent_waiting_response'`, `followup_status='in_progress'`, attempt#, `completed_by_chat_id`, self-stamps `source_followup_id`, **rewrites `scheduled_datetime` to the escalation deadline** (attempt 1 → +24h; attempt ≥2 → day-5 from first send). **Does NOT reset `fired_at`** — if the task ever came due before the send, the new deadline is dead (sweep filters `fired_at IS NULL`). |
| Outcome panel / phases | `src/pages/Followups/components/OutcomePanel.tsx:104–110` | `sendPhase` vs `waitingPhase` keyed off `whatsapp_state`; "Record customer response" mode completes without ever arming escalation. |
| Type/outcome config | `src/lib/salesProcess/config.ts` (10 types), `outcomes.ts` (27 outcomes) | Per-type allowed outcomes, required fields, previews. |
| Inbound WhatsApp webhook | `api/webhook/haberchat.ts` — `handleNewMessage()` :154–206, `bumpConversationRecord()` :276–335 | Writes `chat_messages`, bumps the chat record (`last_message_*`, `unread_count`, **auto-reopen** resolved/archived → active on inbound, synced back to Haberchat). **Zero references to followups/whatsapp_state — grep-verified.** No client-matching sweep here; no workflow invocation. |
| Outbound send | `appStore.ts:4946–5095` `startNewChat()` + `api/haberchat/messages.ts` | Creates/reuses chat record (client link by explicit id or phone match), optimistic message, server proxy send. **Never touches followups.** |
| Chat "Done" / status | `ChatDetail.tsx:244–349` `DoneButton` → `appStore.ts:5168–5242` `patchChat()` | Writes `status`/`labels` via **direct `supabaseUpsert` — bypasses `saveRecord`, so NO workflow can ever fire on chat status change.** No outcome capture, no follow-up completion. |
| Client-side workflow engine | `src/lib/workflowEngine.ts` (`executeWorkflows` :212; conditions :313 incl. only_on_change; actions :400–1275) | Fires after `saveRecord`; MAX_DEPTH=3; `create_record` dedup = optional single-field `skip_if_exists` (**not used by any lifecycle workflow**); `update_record` matches **one** record (`.find()` — cannot bulk-cancel). |
| on_due sweeper | `api/_lib/workflowSweeper.ts` + `api/sweep-due-followups.ts` (5 min) + `api/sweep-appointment-noshows.ts` | Claims due followups where `scheduled_datetime <= now AND fired_at IS NULL` (**no status filter**), stamps `fired_at` once, runs on_due workflows. Supports update/create/send-WhatsApp only. Version guard on self-updates. |
| Sales Queue | `SalesTasksPage.tsx` + `src/pages/Sales/lib/queueViews.ts` | `OPEN_STATES={open,in_progress}` (NULL→open fallback); 9 views; SLA computed live; **"Waiting for Customer" is keyed off CLIENT status values, not `whatsapp_state`**; No-Next-Action audit :147–170. No per-client grouping — every open follow-up is its own card. |
| My Tasks / My Clients | `MyTasksPage.tsx`, `MyClientsPage.tsx`, `myWork.ts`, `salesClients.ts` | today/late by calendar day; calls-vs-conversations split; **"Waiting for reply" / "Replied" pills already exist** (`FollowupTaskCard.tsx:22–26` — `replied` label built, never triggered); `openCount` per client computed (`myWork.ts:162`) but **never rendered**; My Clients computes "next" itself (earliest open) instead of reading `clients.next_followup_id`; Client 360 KPI reads `next_action_due_at` from the client record — three parallel implementations of "next action". |
| Dedup / cancellation of obsolete tasks | — | **Does not exist**, with one exception: the WhatsApp escalation closes its own source task via `source_followup_id`. No workflow or code cancels open follow-ups when an appointment/visit/offer/reservation is created or a chat message arrives. |

### Live workflows (queried from wassell-prod, 2026-07-04)

21 workflows, 19 active. The sales-relevant set: First Follow-up (create clients), Booking Call Completed, WhatsApp Response Completed, **WhatsApp No-Response Escalation (on_due — ACTIVE)**, Appointment Booked (create appointments), Confirmation Completed, Auto-close No-Show (on_due), No-Show Recovery, Visit → After-Visit, After-Visit Completed, Offer Created/Completed, Reservation → Financing, Financing Updated, Transfer → Closed Won, Send Visit Rating (**now on create visits**), Apology on missed call, **Create Unresponded Requests (28dae81e — creates an `unanswered_requests` record when `call_result='unanswered_request'`; NOT in the generated PRD docs — `docs/prd/workflows/` is stale because `sync:prds` has been skipping on the disabled legacy service key)**.

None of the stage-event workflows (appointment/visit/offer/reservation created) touches any pre-existing follow-up.

---

## 2. Current real behavior, by scenario

### Scenario A — booking call completed "interested", rep sends project info by WhatsApp

1. Rep completes the booking call in the Workspace → `handleComplete('interested')` → Booking Call workflow branch 3 fires:
   - Client: stage stays **الاتصال لحجز موعد**, status → **مهتم**.
   - Creates a `whatsapp_follow_up`: `followup_status='open'`, `scheduled_datetime = +1 day`, `whatsapp_attempt_number=1`, `previous_followup_id` back-link. This is a **"message to send" task** — no waiting state, no escalation armed yet.
2. `clients.next_followup_id` trio updates via the DB trigger → the WA task is the client's next action, due tomorrow. It appears in Sales Queue (Tomorrow → Today), My Tasks (Conversations column, pill "Message to send").
3. **The fork that matters:** if the rep sends the project info *through the task tomorrow* (Workspace → Send WhatsApp), `handleWhatsAppSent` arms the two-phase state and the 24h escalation deadline. But if the rep sends it **right now from the Chats page** (very common — the chat is already open from the call), *nothing records the send on the task*: no `sent_at`, no waiting state, no deadline. Tomorrow the task still says "Message to send" → double-send risk, and the escalation never arms at all.
4. Ownership of the next step: **WhatsApp Response Completed** (rep records the reply outcome) or **WhatsApp No-Response Escalation** (silence past deadline) — but only along the Workspace path.

Live-data reality check: of 253 open follow-ups, **0 are `in_progress`** and only a handful ever carried a waiting state → **reps are largely not using the two-phase send**; they work the chat directly and the tasks sit open. 213 of 253 open follow-ups are overdue.

### Scenario B — client replies 6h after the message (before the 24h deadline)

- **Does the system detect the reply?** Only at the chat layer. The webhook writes `chat_messages`, bumps `unread_count`/`last_message_*`, auto-reopens the chat if closed. It **never touches the followups model** (grep-verified) and fires no workflow.
- **Does the follow-up change?** No. It stays `in_progress` + `message_sent_waiting_response`, deadline still armed. The `replied` state value and the "تم الرد / Replied" queue pill exist in code but nothing ever sets them.
- **Is the 24h escalation cancelled?** No. If the rep records the outcome before the deadline, the escalation *conditions* won't match at fire time (waiting state gone — but see the bug below). If the rep replies in the chat and doesn't record an outcome, at the deadline the escalation **fires anyway**: marks the task `no_response` (a false negative in the history) and creates an attempt-2 WhatsApp task — for a customer who answered.
- **Is a "reply to client" task created?** No. The only signal is the unread badge on the Chats page — invisible in Sales Queue / My Tasks, which have no `chat_messages` subscription.
- **Duplicate/stale tasks?** Yes — and it's worse than the design intends, because of a confirmed bug: **`handleComplete` never clears `whatsapp_state`** (comment at `FollowUpWorkspacePage.tsx:246-247` claims it does; the `finalData` at :184–192 has no `whatsapp_state` key). A rep who completes the waiting task with "interested" leaves `whatsapp_state='message_sent_waiting_response'` on a completed row; the sweep has **no status filter**, so at the old deadline the escalation matches and creates a **ghost attempt-2 task**. Proven in production — see §3, Risk 1.

### Scenario C — rep replies, then clicks Done / Resolve

- `DoneButton` → `patchChat` → chat `status='resolved'` written by **direct `supabaseUpsert`** + a Haberchat PATCH. That is the entire behavior.
- No outcome is recorded anywhere. No popup asks what happened. The linked follow-up is untouched — if it was waiting, it keeps waiting and the escalation timer keeps ticking. No workflow can fire (the write bypasses `saveRecord`, and no workflow triggers on chats anyway). There is **no connection between closing a chat and the sales lifecycle** — zero.
- Live data: **5 open WhatsApp follow-ups whose linked chat is already resolved/archived** right now.
- Only partial mitigation: if the customer writes again, the webhook auto-reopens the chat.

### Scenario D — appointment booked while a WhatsApp follow-up is open

- The Appointment Booked workflow updates the client (موعد زيارة / تم حجز موعد), sends the confirmation WhatsApp, creates two confirmation-call tasks. It **cancels nothing**.
- If the appointment was booked *through* the open WA task (outcome `appointment_booked`), that task completes correctly. If it was booked any other way (a different call task, directly on the appointments model, by another rep), the old WA task stays open.
- The rep workspace then shows both the confirmation tasks and the stale WA task. **The "true next action" is whichever has the earliest `scheduled_datetime`** — for an overdue WA task, that's the stale one: `clients.next_followup_id`, the My Clients card, and the Client 360 tile will all present the obsolete WhatsApp chase as the client's next action while the client is in the appointment stage.
- Live data: currently **0** open booking-calls with a later appointment (appointment volume is still small), so this is a structural risk rather than an accumulated one — today.

### Scenario E — multiple events close together

- **Can multiple active follow-ups coexist?** Yes, freely. Nothing dedups by type/client/stage (the engine's `skip_if_exists` exists but no lifecycle workflow uses it), and nothing cancels obsolete tasks.
- **Live proof (queried 2026-07-04):** 4 clients have >1 open follow-up. One client has **5** open: two identical `follow_up_call_after_visit` (same client, same 10:00 slot — double-fired creation) plus **three** `rating_request` rows. Three clients each have **two open WhatsApp tasks** — and the record trail shows exactly how (see Risk 1's reconstructed chain).
- **Single next-action source of truth?** No — three implementations: the DB trigger (`next_followup_id`, earliest open), `myWork.ts` (recomputed earliest open, used by My Clients/My Tasks), and the raw queue (all open tasks side by side). They mostly agree because all mean "earliest open", but "earliest" ≠ "correct" — a stale stage-1 task beats a fresh stage-5 task by definition.
- `clients.next_followup_id` behavior: recalculated on every followup/call/chat touch; picks the earliest open regardless of whether it still makes sense; also note `rating_request` rows use `followup_status='scheduled'`, which is in **neither** the open set nor the done set — invisible to the queue, ignored by the trigger, permanently zombie.

---

## 3. Contradictions and risks (ranked)

**R1 — Completed WhatsApp tasks keep the waiting state → ghost escalations and duplicate tasks. CONFIRMED BUG, happening in production.**
`handleComplete` (`FollowUpWorkspacePage.tsx:184–192`) doesn't clear `whatsapp_state`; the sweep (`api/sweep-due-followups.ts`) claims due rows with no status filter; the escalation workflow's conditions check type + `whatsapp_state` but **not** `followup_status`. Reconstructed live chain (client `a8b9a5cc…`): rep sent WA (deadline 06-30 11:06) → completed it "interested" on 06-29 → Response workflow correctly created the next WA (+5d, due 07-04) → on 06-30 11:10 the sweep claimed the *completed* task, escalation matched (state still `waiting`), created a ghost attempt-2 task → rep completed the ghost "interested" too → another +5d task (due 07-05). **End state: two open WhatsApp tasks for one client**, four extra records, and (if unattended) a duplicate message to a customer who already answered. Same pattern on two more clients. Severity: **high** — customer-facing duplicates + polluted history + rep confusion. Currently: completely unhandled. (Side finding: on those ghost rows the escalation's close-the-source update did NOT apply — the source kept `call_result='interested'` — while its create action did; likely the sweep's own `fired_at` stamp bumps the row version and the self-update then hits the version guard. Verify when fixing.)

**R2 — `fired_at` is one-shot but `scheduled_datetime` is rewritten → escalations die silently. CONFIRMED BUG.**
`handleWhatsAppSent` rewrites `scheduled_datetime` to the escalation deadline but doesn't reset `fired_at` (:260–273 — no `fired_at` key). Any WA task that came due *before* the rep sent (very common: workflow creates it due tomorrow; rep sends the day after) already has `fired_at` stamped → the sweep (`fired_at IS NULL`) never claims it again → **no 24h reminder, no day-5 call escalation, ever**. Two live rows show exactly this (fired 06-22, deadline 06-23, never re-claimed). Also: escalation-created tasks are scheduled "now" (+0d) → instantly due → `fired_at` stamped on the next 5-min sweep *before the rep sends* → **the whole attempt-2 → day-5 → call chain is effectively dead in practice**. Evidence: only 2 `no_response_expired` rows ever. Severity: **high** — the safety net the design relies on mostly doesn't run.

**R3 — Inbound replies are invisible to the task layer.** The webhook never touches followups; workflows can't trigger on chats (no such trigger; chat writes bypass `saveRecord` anyway); the queue has no `chat_messages` subscription. A client can reply and the rep's queue shows nothing — the task still says "waiting", the escalation still ticks, and if the rep answers from the Chats page the sales outcome is never captured. This is the root architectural gap behind Scenarios B and C. Severity: **high**. Currently: 0% handled (the `replied` state + UI pill were built for this and never wired).

**R4 — Chat close records no outcome and can't fire workflows.** `patchChat` bypasses the store's save path entirely. "Done" is purely cosmetic to the sales process. 5 live open-task/closed-chat contradictions. Severity: **high** (it's the rep's natural end-of-conversation gesture, and it's a dead end). Currently: unhandled.

**R5 — No supersede/cancellation on stage events.** Appointment/visit/offer/reservation creation cancels nothing; `update_record` can only match ONE record (`.find()` — `workflowEngine.ts:720–756`), so bulk-cancel isn't even expressible as a workflow action today. Obsolete tasks linger as the client's computed "next action" (D/E). Severity: **medium-high** (structural; low accumulation so far only because volumes are small). Currently: missing entirely, except the escalation's own self-close.

**R6 — Reps bypass the two-phase send.** 0 `in_progress` tasks and 213/253 open tasks overdue says the send-from-workspace discipline isn't holding; sends from the Chats UI don't stamp anything. Severity: **medium-high** — process adoption, amplified by R3 (nothing reconciles what actually happened in the chat). Partial mitigation exists (Workspace opens the chat inline), but nothing enforces or backfills.

**R7 — Three "next action" implementations + `'scheduled'` status limbo.** DB trigger vs `myWork.ts` vs queue; `rating_request` rows (`followup_status='scheduled'`) are neither open nor done — 3 zombie rows, plus duplicated after-visit calls on one client (double-fired creation — no dedup key on any lifecycle create action). Severity: **medium**. Partially handled (the implementations agree by accident).

**R8 — client_stage/client_status are only socially read-only.** No `read_only` flag, no validation — a rep CAN hand-edit them; a concurrent workflow write is last-write-wins. Severity: **medium** (discipline holds today). Cheap fix exists (schema `read_only: true` blocks the form while workflows keep writing).

**R9 — Client-side workflows don't fire on non-UI writes.** Imports, direct DB writes, and any server-side record creation skip the entire lifecycle (the server runner exists but is unenrolled). The 126 NULL-status booking calls (all of W1's output) also show workflow-created rows don't stamp `followup_status` — handled by NULL→open fallbacks, but it's fragile convention. Severity: **medium**, pre-existing and known.

**R10 — Stale generated workflow docs + enum drift.** `docs/prd/workflows/` is missing the live "Create Unresponded Requests" workflow (sync:prds skipping on the disabled legacy key — rotate to `sb_secret_`); chats carry a `pending` status outside the app enum (Haberchat vocabulary, treated as open — harmless but confirms chat.status is not a sales state). Severity: **low**, but it misleads audits like this one.

---

## 4. Recommended architecture

**Verdict on the proposed direction: it fits, with three amendments.** The codebase was visibly built *toward* this design — `whatsapp_state='replied'` exists, the "Replied" pill exists, `completed_by_chat_id` exists, the escalation checks `whatsapp_state` (so a reconciled state disarms it automatically) — the wiring between the chat layer and the task layer was simply never built.

Keep, exactly as proposed:
- **Follow-ups stay historical task/action records.** One row per attempt, completed/cancelled but never deleted, chained by `previous_followup_id`. This is already the design and it's right. No permanent per-client WhatsApp task.
- **Conversation state ≠ task state.** Chat records describe the conversation; follow-ups describe the sales action. Never merge them.
- **Outcome-on-close popup.** Right idea, and the outcome list should be the existing `whatsapp_follow_up` outcome set from `salesProcess/config.ts` (interested / appointment booked / request offer / wrong time / recontact later / not interested / no clear answer / wrong number) — not a new vocabulary. The popup's save must go through `saveRecord` on the *follow-up*, so the existing WhatsApp Response Completed workflow does the lifecycle move. That keeps the covenant: the workflow engine remains the only thing that moves clients.

Amend:
1. **Don't add manual chat states "Waiting for us / Waiting for client" — derive them.** `last_message_flow` is already maintained on every chat by the webhook: `in` = waiting for us, `out` = waiting for client. A manual five-state machine would rot the way `status='pending'` already drifted. Chat `status` stays exactly active/resolved/archived; the two "waiting" facets are computed display state (list badges, queue chips).
2. **The reconciliation layer should be three small, deterministic pieces, not a new engine:**
   - **Inbound reconciler (webhook):** on an inbound message for a chat with `client_link`, patch that client's open waiting WhatsApp follow-ups to `whatsapp_state='replied'` (service-role `record_save`). Effects cascade for free: the escalation condition (`= message_sent_waiting_response`) stops matching → no ghost escalation; the existing "Replied" pill lights up in My Tasks; the touch-trigger recomputes client derived fields. This one write closes most of Scenario B.
   - **Supersede rules (DB function + AFTER triggers):** on create of appointment/visit/offer/reservation (and client → lost), cancel obsolete open follow-ups for that client (`followup_status='cancelled'` + a `cancel_reason` like `superseded_by_appointment`). A DB trigger, not a workflow, because (a) `update_record` can only hit one record, (b) triggers cover every write path including imports and server writes (R9), and (c) the codebase already uses exactly this pattern for client derived fields (SECURITY DEFINER touch triggers). Cancelled ≠ deleted: audit history intact.
   - **Escalation correctness (bug fixes):** clear `whatsapp_state` on completion; reset `fired_at` whenever `scheduled_datetime` is rewritten; add a `followup_status ∈ {open,in_progress}` condition to the escalation workflow and a done-status exclusion to the sweep.
3. **Make the DB trigger the single next-action authority.** `clients.next_followup_id` is already the canonical, trigger-maintained answer; point My Clients/My Tasks at it (or at minimum align the open-state predicate and kill the `'scheduled'` limbo). With supersede + reply reconciliation feeding it, "earliest open" becomes trustworthy, because obsolete tasks stop being open.

The reconciliation questions the user listed map cleanly: *current stage* = `clients.client_stage` (workflow-owned, unchanged); *chat state* = `status` + derived waiting facet; *open follow-ups* = the existing open predicate (post-cleanup); *obsolete follow-ups* = supersede matrix by stage-event; *which next action* = `next_followup_id` after reconciliation; *should stage change* = workflows only, unchanged; *what appears in the queue* = open tasks + a "replied — act now" boost.

---

## 5. Implementation options

### Option A — Minimal safe patch (bug fixes + reply wiring + close-chat outcome)

**Changes**
1. `handleComplete`: add `whatsapp_state: null` (or `'replied'`-preserving) to `finalData` — 1 line.
2. `handleWhatsAppSent`: add `fired_at: null` to the patch — 1 line.
3. Escalation workflow (Workflow Builder edit, no code): add condition `followup_status in {open, in_progress}` to both branches. Optionally also add the status filter to the sweep query (code, `api/sweep-due-followups.ts`).
4. Webhook inbound reconciler: in `bumpConversationRecord`, when `flow='in'` and the chat has `client_link`, patch open waiting WA follow-ups for that client to `whatsapp_state='replied'` (service-role `record_save`, version-unaware single-field patch).
5. Chat Done button: if the linked client has an open `whatsapp_follow_up`, show the outcome popup (reuse the type's outcome buttons); completing saves the follow-up via `saveRecord` (workflows fire), then resolves the chat. "No clear answer" = resolve chat, leave/reschedule the task explicitly.
6. Queue polish: sort `replied` tasks into Due Now with the existing pill; render the already-computed `openCount` badge when >1.
7. **Data cleanup migration:** fix the 4 completed-but-waiting rows; cancel the ghost attempt-2 chains (3 clients with double WA tasks — keep the later "real" one); dedupe the doubled after-visit calls and triple `rating_request` rows; map `'scheduled'` status into the open set or convert those rows; delete workflow "1"; document the 126 NULL-status rows as open-by-convention (or backfill `'open'`).

**Files/tables:** `FollowUpWorkspacePage.tsx`, `api/webhook/haberchat.ts`, `ChatDetail.tsx` (+ small popup component), `queueViews.ts`/`FollowupTaskCard.tsx`, one workflow edit, one cleanup migration. **No schema migration** (all fields exist). **Risk: low** — every change is additive or a bug fix; the escalation self-stamp, two-phase send, derived-field triggers stay untouched. **One phase: yes.**
**Pros:** kills the two confirmed bugs, wires reply detection, gives Done a meaning — the three loudest contradictions — in days. **Cons:** no supersede (stale tasks on stage events remain), next-action still triple-implemented.

### Option B — Proper reconciliation layer (A + supersede + single source of truth)

**Changes (on top of A)**
1. `reconcile_superseded_followups(client_id, event)` SECURITY DEFINER SQL function + AFTER-INSERT triggers on records for appointments/visits/offer_prices/reservations (+ client-stage → lost): cancels open follow-ups of superseded types per a small matrix (e.g. appointment created ⇒ cancel open `appointment_booking_call` + `whatsapp_follow_up`; visit ⇒ also cancel confirmation types; offer ⇒ cancel after-visit chase; lost ⇒ cancel all open). Stamps `cancel_reason` (new dropdown field on followups — JSONB, so just a schema + seed update).
2. Unify next-action: My Clients/My Tasks read the `next_followup_id` trio; keep `myWork.ts` only for per-client openCount/late flags; single open-state predicate shared with the DB definition.
3. Manager visibility: a small "contradictions" block on Sales Manager (open task + closed chat; >1 open per client; replied-but-waiting) — the audit queries from §3 productized.
4. Rotate the service key and re-enable `sync:prds` so the workflow docs stop lying.

**Migration needs:** one SQL migration (function + triggers + `cancel_reason` field), plus A's cleanup. **UI:** popup (from A), badges, manager block. **Risk: medium-low** — triggers on the records table must exclude recursion (they only write followups, which touch clients via existing triggers — same pattern already in production for rollups/derived fields). **Testing:** trigger matrix per event type. **One phase:** yes if shipped as A-then-B; cramming both into one push is possible but not worth the review surface.
**Pros:** removes the structural cause (stale tasks can't survive stage events), makes `next_followup_id` genuinely trustworthy, keeps everything auditable. **Cons:** supersede rules are policy — need sign-off on the matrix; DB triggers are less visible than workflows in the Studio (mitigate: document them in the Studio's stage-automations block).

### Option C — Larger sales-process cleanup (not recommended now)

Server-enroll followups/clients in the server-authoritative workflow runner (closes R9 fully); technical read-only on `client_stage`/`client_status`; a real conversation-state machine on chats incl. Haberchat `pending` normalization; merge the three task-surface implementations into one queue library; per-action dedup keys on all lifecycle creates.
**Why not now:** the runner enrollment is a platform-wide change with its own risk budget (double-fire guards, echo-dedup) and the contradictions the user cares about are fully addressed by A+B; the state machine adds a second source of truth for what `last_message_flow` already encodes. **Cherry-pick two cheap pieces into B instead:** `read_only: true` on `client_stage`/`client_status` (UI-only flag; workflows write via `record_save` regardless), and dedup keys on the escalation/response create actions.

---

## 6. Final recommendation

**Ship A now, B next. Skip C except the two cherry-picks.**

- **Change now (A):** the two one-line bug fixes (`whatsapp_state` clear, `fired_at` reset) + escalation status condition; the webhook replied-reconciler; the Done-button outcome popup; queue pills/badges; the data-cleanup migration. This is the highest damage-per-line fix available: it stops false `no_response` history, ghost tasks, dead escalations, and silent chat closes.
- **Then (B):** the supersede function + triggers with an agreed matrix; next-action unification; the manager contradictions block; key rotation + `sync:prds`.
- **Do not touch:** the two-phase send design, the escalation `source_followup_id` self-stamp, the client derived-field triggers, chat auto-reopen, the workflow-owns-lifecycle covenant, the follow-up history model.
- **Delete/deprecate:** workflow "1" (broken, inactive); the 3 zombie `rating_request` rows + the `'scheduled'` status value (fold into open or done); the misleading comment at `FollowUpWorkspacePage.tsx:246-247` once the code matches it.
- **Keep as-is:** chats status enum (active/resolved/archived) with `pending` tolerated as open; the NULL-status→open convention (but start stamping `followup_status='open'` in workflow field-mappings going forward).
- **Add:** `cancel_reason` field (B); `read_only: true` on client stage/status (B); dedup keys on escalation/response create actions (B).

**Order:** cleanup migration → the two bug fixes + escalation condition → webhook reconciler → Done popup → queue polish → (B) supersede migration → next-action unification → manager block.

---

## 7. Test plan (end-to-end, on production via the sandbox client)

Use the "🧪 Sandbox (Claude)" client (established live-ops posture). Every step verifies both the record state (SQL) and the surface (queue/workspace).

1. **Baseline assertions (before):** re-run the audit queries — completed+waiting count (currently 4), double-open-WA clients (3), open-task/closed-chat (5), overdue count. These become the regression numbers that must go to ~0 after cleanup.
2. **Two-phase happy path:** create sandbox client → W1 task → complete "interested" → verify WA task created (status open, +1d) → Send WhatsApp from the Workspace → verify `whatsapp_state=waiting`, `followup_status=in_progress`, deadline = +24h, `fired_at` **null**.
3. **Reply reconciliation:** reply from a test phone (real webhook) → verify the task flips to `replied`, the pill shows in My Tasks, and — after forcing `scheduled_datetime` to now-1min — the next sweep does **not** escalate (check `workflow_runs`: conditions unmatched) and stamps `fired_at` harmlessly.
4. **Completion clears state:** complete the task "interested" → SQL: `whatsapp_state` cleared; set the deadline into the past → sweep → **no ghost task created** (this is the R1 regression test).
5. **fired_at reset:** create a WA task, let its original schedule pass (sweep stamps `fired_at`), then Send → verify `fired_at` is null again and the escalation fires at the new deadline when nobody replies (R2 regression: verify the attempt-2 task is created AND the source task is closed as `no_response` — also confirms/refutes the version-conflict side finding).
6. **Done popup:** open the sandbox chat with a waiting task → Done → popup appears → pick "interested" → verify the follow-up completed via `saveRecord` (WhatsApp Response Completed run appears in `/workflow/logs`), the next task exists, and the chat is resolved. Then send an inbound message → chat auto-reopens.
7. **Supersede (B):** with an open WA task, create an appointment for the sandbox client from the appointments model directly (not through the task) → verify the WA task flips to `cancelled/superseded_by_appointment`, the confirmation tasks exist, and `next_followup_id` points at the earliest confirmation call. Repeat for visit/offer/lost.
8. **No-regression sweeps:** confirm the appointment no-show sweep and Send Visit Rating still behave (create sandbox visit; check the rating timer path); confirm `chats` Done still syncs status to Haberchat.
9. **After:** re-run step 1's assertions; deploy per the standard flow (rebase → push → verify Vercel SHA → smoke-test app.wassel.re) and watch `workflow_runs` + the sweep logs for 48h for any new `no_response` rows on clients with inbound messages (should be zero).
