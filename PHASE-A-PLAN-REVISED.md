# Phase A (revised) — WhatsApp follow-up as a reply-checkpoint, not a first-send task

> Supersedes §5 Option A of SALES-ARCHITECTURE-AUDIT.md. Reframed around the corrected
> business process: the first project is sent during/right after the first call; the
> WhatsApp follow-up is the controlled **continuation/checkpoint** on the client's reply.
> Analysis only — nothing implemented pending approval.

---

## 1. Corrected business process summary

1. New client logged → system creates the **first booking call** task.
2. Rep calls, gathers preferences, picks the first suitable project (Project Finder), and **sends the project to the client during/right after the call** (usually WhatsApp).
3. Client interested → rep completes the **call** task as `interested`.
4. System creates a **WhatsApp follow-up task due tomorrow (+24h)**. Its job is **not** "send the first project" — the project is already sent. Its job is:
   - Check whether the client replied to the project.
   - Replied → continue the conversation, then record the outcome on this task.
   - No reply → send a check-in ("وش رأيك بالمشروع؟"), then wait/continue.
   - More preferences → update preferences, re-run Project Finder, send another project, keep going.
   - Clear outcome reached → record it on **this same** WhatsApp task.
5. The chat is only the conversation surface. The follow-up task is the sales-process record. The workflow engine still owns every `client_stage`/`client_status` move.

**What this corrects vs. the audit's Option A:** the audit treated the task's send-phase as "send the project." It is really "check the reply; send a check-in only if silent." This changes copy, the meaning of the initial state, and makes the inbound-reply reconciler the *central* mechanism rather than a side fix. It does **not** add new subsystems.

---

## 2. Corrected WhatsApp follow-up state model

One `whatsapp_follow_up` record per checkpoint (still a historical task; never one permanent task per client). The lifecycle uses **existing fields only** — `followup_status` + `whatsapp_state` — no schema change:

| Phase | `followup_status` | `whatsapp_state` | `scheduled_datetime` | Meaning / rep sees |
|---|---|---|---|---|
| **Created (project already sent on the call)** | `open` | *(unset)* | +24h from call | "Project sent — awaiting the client's reply." Passive, due tomorrow. |
| **Client replied before due** | `open` | `replied` | unchanged | "Client replied — continue the conversation." **Surfaces now**, action-needed. Set by the inbound reconciler. |
| **Due, still no reply** | `open` | *(unset)* | now/past | "Check-in due — no reply yet, send a check-in." SLA = due/overdue. |
| **Rep sent a check-in** | `in_progress` | `message_sent_waiting_response` | escalation deadline (+24h / day-5) | "Check-in sent — waiting for reply." Escalation armed. **Only place waiting is entered.** |
| **Client replied to the check-in** | `in_progress` | `replied` | unchanged | "Client replied — continue." Escalation disarmed (state ≠ waiting). Reconciler flips it. |
| **Outcome recorded** | `completed` | *(cleared)* | — | Outcome on this task → WhatsApp Response Completed workflow moves the client. |
| **Silent past the check-in deadline** | `completed` | `no_response_expired` | — | Escalation closed it as `no_response` and created the next step. |

Key design decisions (grounded in the current architecture):

- **The task starts `open` due tomorrow, NOT waiting-response.** Reasons: (a) `whatsapp_state='message_sent_waiting_response'` is precisely the flag that *arms the on_due escalation* to auto-create an attempt-2/call — we do **not** want an automatic escalation before a human has looked; the corrected process demands a human checkpoint first. (b) The project-send event happened on the **call task**, not here, so "a message was just sent from this task, count down to escalate" is semantically false at creation. (c) The booking-call workflow **already** creates it exactly this way (`followup_status='open'`, no `whatsapp_state`, `+1d`) — so this needs **zero workflow change**.
- **`whatsapp_state='replied'` is the new active signal.** It exists in the schema and the "تم الرد/Replied" queue pill already exists — both were built and never wired. The reconciler sets it on inbound; it works on both an open checkpoint (client replied to the original project) and a waiting check-in (client replied to the check-in). Because `replied` ≠ `message_sent_waiting_response`, setting it **automatically disarms** the escalation with no extra logic.
- **`message_sent_waiting_response` now means only "the rep sent a check-in from this task."** That's the sole path that arms escalation — matching "if silent, escalate," not "the project was sent."

---

## 3. UI wording changes (display copy only — no lifecycle rename)

| Surface | File | From | To (EN / AR) |
|---|---|---|---|
| Type objective | `src/lib/salesProcess/config.ts:123-124` (`whatsapp_follow_up`) | "Keep engagement and move toward an appointment or offer" / "الحفاظ على التفاعل…" | **"Follow up on the client's response to the project"** / **"متابعة رد العميل على المشروع"** |
| Type guidance (new `script`) | `config.ts` same block | *(none today)* | AR bullets: «المشروع أُرسل للعميل بعد المكالمة — تأكّد إن ردّ.» / «إن ردّ: أكمل المحادثة وسجّل النتيجة.» / «إن لم يردّ: أرسل رسالة تفقّد — مثال: السلام عليكم، وش رأيك بالمشروع؟» / «إن أعطى تفضيلات جديدة: حدّث التفضيلات، استخدم الباحث، وأرسل خياراً آخر.» + EN equivalents |
| Mission header | `MissionHeader` (reads objective) | inherits | inherits new objective automatically |
| Outcome panel — checkpoint entry, no reply | `OutcomePanel.tsx:131-157` (sendPhase) | "What happened on WhatsApp? / Send WhatsApp message" | **"No reply yet — send a check-in"**, primary button **"Send check-in message" / "إرسال رسالة تفقّد"**, secondary **"Record the outcome" / "تسجيل النتيجة"** |
| Outcome panel — reply present (new branch) | `OutcomePanel.tsx` | *(falls into sendPhase today)* | Banner **"Client replied — continue the conversation" / "ردّ العميل — أكمل المحادثة"** + **"Open chat" / "فتح المحادثة"** + the outcome buttons directly |
| Outcome panel — waiting banner | `OutcomePanel.tsx:165` | "Message sent — awaiting the customer reply" | keep; applies to the check-in now |
| Chat Done popup title | new component | (audit said "Complete WhatsApp Follow-Up") | **"Complete WhatsApp Follow-Up" / "إنهاء متابعة واتساب"**, prompt **"What was the outcome of this conversation? / ما نتيجة هذه المحادثة؟"** — never "Chat result" |
| Queue pills | `FollowupTaskCard.tsx:22-26` | `replied` label exists | reuse: no-reply-not-due → "Awaiting reply / بانتظار رد العميل"; due → "Check-in due / متابعة مطلوبة"; replied → existing "Replied / ردّ العميل"; waiting → existing "Waiting for reply / بانتظار الرد" |

The `sales_process_overrides` row for `whatsapp_follow_up`, if one exists, **shadows** the config default in the Sales Manager editor. Plan: update the code default AND clear/refresh any stored override for this type so the new objective/script actually shows (see §6).

---

## 4. Exact files to change

1. **`src/pages/Followups/FollowUpWorkspacePage.tsx`**
   - `handleComplete` (~:184): add `whatsapp_state: null` to `finalData` (bug fix — clears the waiting flag on completion).
   - `handleWhatsAppSent` (~:260): add `fired_at: null` to the patch (bug fix — re-arms the sweep for the new deadline).
2. **`src/pages/Followups/components/OutcomePanel.tsx`**
   - Add a `repliedPhase` branch (`waState === 'replied'`) → banner + "Open chat" + outcome buttons.
   - Relabel `sendPhase` copy to the check-in framing; keep "Record the outcome" secondary.
3. **`src/lib/salesProcess/config.ts`**
   - `whatsapp_follow_up`: new `objective_ar/en`; add `script.ar/en` guidance bullets. (Outcomes unchanged.)
4. **`api/webhook/haberchat.ts`**
   - In `bumpConversationRecord` (inbound, `flow='in'`, chat has `client_link`): find that client's active `whatsapp_follow_up` (status `open`/`in_progress`, not completed/cancelled) and set `whatsapp_state='replied'` via service-role `record_save` (version-unaware single patch). Idempotent; re-flips waiting→replied on every inbound. This is the mechanism for Scenarios 2 & 4.
5. **`src/pages/Sales/lib/queueViews.ts`** (+ `myWork.ts` for the rep pages)
   - New rule: a follow-up with `whatsapp_state='replied'` is **surfaced now** (Due Now / action-needed) even if `scheduled_datetime` is in the future; ranked above plain due tasks.
   - Render the already-computed `openCount` badge when a client has >1 open follow-up.
6. **`src/pages/Chats/components/ChatDetail.tsx`** (Done button) + **new small popup component** (e.g. `CompleteWhatsAppFollowupModal.tsx`)
   - On Done, if the linked client has an active `whatsapp_follow_up`, open the popup; completing it runs the **normal follow-up completion path** (`saveRecord` on the follow-up → WhatsApp Response Completed workflow), then resolve the chat. No chat-result object.
7. **`FollowupTaskCard.tsx`** — pill copy per §3 (mostly reuse).

**No schema migration.** All fields already exist.

---

## 5. Exact workflow edits needed

- **WhatsApp No-Response Escalation (918b2540)** — add condition `followup_status ∈ {open, in_progress}` to both branches (Builder edit, no code). This stops escalation on completed/cancelled rows. (Bug fix; independent of the process correction.)
- **Booking Call Completed (d997425a), interested branch** — **NO CHANGE.** It already creates `whatsapp_follow_up` as `open`, no `whatsapp_state`, `+1d` — exactly the corrected "start open, due tomorrow." Confirmed in `config.ts:104` preview and the live workflow.
- **WhatsApp Response Completed (95bdbe0f)** — **NO CHANGE.** The Done popup and the workspace both complete the task through the same path; this workflow then moves the client. Its name stays (admin-facing).
- **No workflow renames.** Only display copy (§3) changes; internal workflow labels are fine.
- Optional (belongs with the bug-fix batch, not strictly a "process" edit): add `followup_status != 'completed'` guard to the sweep query in `api/sweep-due-followups.ts` as defense-in-depth behind the workflow condition.

---

## 6. Data cleanup plan (one migration, sandbox-verified first)

Same set as the audit, all still valid under the corrected model:

1. **4 completed-but-waiting rows** (`whatsapp_state='message_sent_waiting_response'` + `followup_status='completed'`) → clear `whatsapp_state`. These are the R1 ghost-escalation seeds.
2. **3 ghost attempt-2 chains** (clients `a8b9a5cc…`, `625fa8cc…`, `3ad4566c…` — each has 2 open WhatsApp tasks from the R1 bug) → keep the genuinely latest task per client, cancel the ghost (`followup_status='cancelled'`, `cancel_reason='ghost_escalation_cleanup'`). Preserves history.
3. **Duplicated `follow_up_call_after_visit`** (client `5ada52e7…`, two identical 10:00 tasks) → cancel one.
4. **3 zombie `rating_request` rows** (`followup_status='scheduled'` — in neither open nor done set) → convert `'scheduled'`→`'open'` OR complete them; decide with the visit-rating owner. Either way, remove the limbo value.
5. **Workflow "1" (34af4560, inactive, broken refs)** → delete.
6. **126 NULL-status booking calls** → leave as-is (open-by-convention), but start stamping `followup_status='open'` in future workflow field-mappings.
7. Not a data change but bundled: rotate the disabled legacy service key and re-run `npm run sync:prds` so `docs/prd/workflows/` regains the missing "Create Unresponded Requests" workflow.

Backup the affected `records` rows to a `_backup_phaseA_followups_20260704` table before mutating (standard posture).

---

## 7. Tests to add/update

Run on prod with the 🧪 Sandbox client + a real test phone; verify record state (SQL) **and** surface (queue/workspace/chat) at each step.

1. **Baseline (regression targets):** completed+waiting=4, double-open-WA clients=3, open-task/closed-chat=5, overdue=213 → after cleanup all → ~0.
2. **Scenario 1 (create):** sandbox client → complete booking call `interested` → assert WA task `open`, `+24h`, `whatsapp_state` unset, `fired_at` null; MissionHeader reads "متابعة رد العميل على المشروع"; workspace shows "project already sent — check reply." **No "send the first project" copy anywhere.**
3. **Scenario 2 (reply before due):** inbound from the test phone → reconciler sets `whatsapp_state='replied'`; task jumps to Due Now / action-needed with the "Replied" pill; force `scheduled_datetime` past + run sweep → escalation does **not** fire (check `workflow_runs`), `fired_at` stamped harmlessly. Rep records outcome → single result, client moved by the workflow, no duplicate.
4. **Scenario 3 (no reply, due):** let due pass with no inbound → task "check-in due"; rep opens, sends check-in from the task → `whatsapp_state='message_sent_waiting_response'`, `in_progress`, `fired_at` null, deadline armed; no reply by deadline → escalation fires, source closed `no_response`, next step created (also re-verifies R2 and the version-conflict side-finding on the source close).
5. **Scenario 4 (more preferences):** during the waiting/replied phase, edit preferences + re-run Finder + send another project from the chat → conversation continues on the **same** task; record final outcome there.
6. **Scenario 5 (Done popup):** open the sandbox chat with an active WA task → Done → popup titled "إنهاء متابعة واتساب" asks the outcome → pick `interested` → the **existing** task completes via `saveRecord` (WhatsApp Response Completed run in `/workflow/logs`), chat resolves, no chat-result object created, `client_stage/status` moved only by the workflow. Then inbound → chat auto-reopens.
7. **Completion clears state (R1):** complete a waiting task → `whatsapp_state` cleared → push deadline into the past → sweep → **no ghost task**.
8. **Edge cases (Q6):** Done with (a) no active WA task → plain resolve, no fabricated task; (b) two active WA tasks → popup targets the chat-linked one (`completed_by_chat_id`), else newest, and names which; (c) already-completed task → treated as none-active, plain resolve, no reopen.
9. **No-regression:** appointment no-show sweep, Send Visit Rating, Haberchat status sync unaffected.
10. **48h watch:** zero new `no_response` rows on clients that had inbound messages.

---

## 8. Answers to your 10 questions (condensed)

1. **Label/description:** "Follow up on the client's response to the project" / "متابعة رد العميل على المشروع", with guidance stating the project was already sent, check the reply, send a check-in only if silent. Not "send project info."
2. **Open due-tomorrow, NOT waiting-response.** Waiting arms auto-escalation and semantically means "a message was just sent from this task" — both wrong for a human checkpoint. And the create workflow already does open+`+1d`, so it's a zero-change match.
3. **Inbound before due:** webhook reconciler sets `whatsapp_state='replied'` on the client's active WA task → surfaces it now, disarms escalation (state ≠ waiting), no duplicate.
4. **Queue display:** not-due+no-reply → scheduled, "Awaiting reply" (passive); due+no-reply → Due Now/Overdue, "Check-in due"; replied → surfaced now (action-needed), "Client replied"; sent check-in+waiting → "Waiting for reply" until deadline/next reply.
5. **Done popup:** find the chat's client's active `whatsapp_follow_up` (prefer `completed_by_chat_id==this chat`, else newest open) → complete via the normal follow-up path → WhatsApp Response Completed runs → resolve chat.
6. **Edge cases:** none active → just resolve (no fabricated task); multiple → target chat-linked, else newest, name it in the popup; already completed → treat as none, plain resolve.
7. **Overrides:** yes — update the `config.ts` default AND clear/refresh any `sales_process_overrides` row for `whatsapp_follow_up` so the new objective/script isn't shadowed.
8. **Workflow names:** no renames; display copy only.
9. **Bugs still required (all five):** clear waiting-state on completion; reset `fired_at` on deadline rewrite; wire inbound→followup (now central); connect Done→followup; exclude completed/cancelled from escalation. None removed by the correction.
10. **Scope change:** roughly same size as audit Option A, re-weighted — the inbound reconciler moves from side-fix to core; add one queue rule (surface `replied` now) and the check-in/reply copy reframe; **remove** any "send first project from the task" framing; confirm (no change) that creation already starts open-due-tomorrow. Still Phase A, one phase, no schema migration, no new subsystem.

---

## 9. Risks & assumptions

- **Assumption:** a chat maps to ≤1 active checkpoint task in the normal case; multiple is the handled edge (§6/Q6).
- **Assumption:** the webhook may write the followup via service-role `record_save` without tripling the chats echo-dedup — safe because the webhook is not the browser store; the followup touch-trigger then recomputes client next-action.
- **Risk:** a `replied` task nobody works stays action-needed forever (no auto-escalation from `replied` by design). Mitigation: it's loud in the queue; Phase B's manager contradictions block covers systemic neglect.
- **Risk:** surfacing `replied` ahead of scheduled order changes queue ranking — intended, but verify it doesn't bury genuinely-overdue call tasks (sort: replied WA and overdue calls both in the urgent band; tie-break by due time).
- **Risk:** clearing `whatsapp_state` on completion vs. setting `'replied'` could race if a reply lands in the same second as completion — last-write-wins on a single JSONB patch; acceptable (completion is terminal; a late `replied` on a completed row is ignored once the escalation carries the status condition).
- **Out of scope (Phase B, needs your approval):** supersede-on-stage-event cancellation, `cancel_reason` as a first-class field, next-action unification onto the DB trigger, manager contradictions block, read-only stage/status flags.
