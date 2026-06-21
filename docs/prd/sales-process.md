# PRD: Sales Operating System

**Status:** Live
**Last updated:** 2026-06-21 (**Appointment no-show auto-close.** A new on_due workflow ("Auto-close appointment as No-Show after 24h", id `b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819203`) in the Sales Lifecycle group flips an appointment to `no_show` 24 h after `appointment_date` (Riyadh-local) when it's still open (scheduled/confirmed/unset). A human update first — completed/cancelled/rescheduled/no_show — is never overridden (status guard + `p_expected_version` self-update guard). Swept by `api/sweep-appointment-noshows.ts` every 30 min off the `appointments_due_for_noshow()` SQL function, with a going-forward `2026-06-21` cutoff so the existing backlog is left alone. Distinct from W5 (which fires on a *manual* no_show to create a recovery call); the auto-close does not spawn a recovery follow-up. See [workflow-automation.md](workflow-automation.md). **Also 2026-06-21 — Visit-experience rating + after-visit outcome expansion:** registering a visit now WhatsApps the client a public 1–5 rating link ~2h later (W6 arms a `rating_request` timer follow-up; a new on_due **"Send Visit Rating"** sends it), and W7 (After-Visit Completed) gained `requested_another_visit` (re-enter booking) / `visited_other_project` (at-risk → Sales-Manager review task, never auto-lost) / `recontact_later` / `invalid_number` branches plus a configurable no-answer **cap** that terminates as "Unreachable after visit". New `scheduled` followup_status (queue-invisible) + two new client_status options. See [visit-rating.md](visit-rating.md); migration `supabase/migrations/2026-06-21_visits_rating_and_after_visit.sql`. — Earlier 2026-06-17: **WhatsApp follow-ups are now a two-phase send → waiting → response flow, with auto-escalation.** Sending a WhatsApp is an *action* that puts the follow-up into a "waiting for response" state (`followup_status='in_progress'` + a new `whatsapp_state` field); the customer's reply is the real outcome. Three workflows added/extended: **WhatsApp Response Completed** (on_update) runs the response-outcome transitions, **WhatsApp No-Response Escalation** (on_due) closes a waiting follow-up whose baked-in deadline passes and creates the next attempt (WhatsApp #2 at 24h → booking call at day 5), and **W2 (Booking Call)** gained a leading leg so an unanswered escalation call loops back to WhatsApp. New `followups` fields via `supabase/migrations/2026-06-17_whatsapp_followup_fields.sql`. See [followups-workspace.md](followups-workspace.md) and [workflow-automation.md](workflow-automation.md). — Earlier 2026-06-17: **Per-type follow-up objectives are now manager-editable.** An admin can reword the "Goal" each rep sees in the Workspace mission, per follow-up type (AR + EN), from the Sales Manager page — persisted in the new `sales_process_overrides` table, loaded for all users via the `salesProcessOverrides` store slice, merged over the config by `applyOverridesToConfig()`. The rest of the recipe stays a code constant. — Earlier 2026-06-17: **Next-Action on the client is now DB-trigger-maintained, not workflow-written.** `clients.next_followup_id` / `next_action_type` / `next_action_due_at` are recomputed by a SECURITY DEFINER Postgres trigger pair from the client's earliest open follow-up (mirroring the all_projects rollup pattern), read-only, self-healing — NOT by workflow `update_record` actions. Migration: `supabase/migrations/2026-06-17_client_next_action.sql`. See [clients.md](clients.md).)
**Related PRDs:** [sales-studio.md](sales-studio.md), [followups-workspace.md](followups-workspace.md), [workflow-automation.md](workflow-automation.md), [visit-rating.md](visit-rating.md), [clients.md](clients.md), [calling.md](calling.md), [chats.md](chats.md), [record-management.md](record-management.md), [workflow-logs.md](workflow-logs.md)

> **2026-06-21 — Strategy layer split out into [Sales Studio 2.0](sales-studio.md).** The read-only `SalesProcessStudioPage` (now nav-labelled "Workflow Map" / "خريطة سير العمل", route `/sales/process`) still maps the lifecycle for inspection. The new **Sales Studio** (`/sales/studio`) is the business-facing strategy surface: a Process Library, versioned process configs, a journey map with safe workflow-card editing, client process assignment, A/B experiments, and real funnel analytics. It overlays this OS's workflows at run time (timing / message / assignment / branch-enabled) via `buildProcessOverlayResolver` injected into `executeWorkflows` — **the Workflow engine is still the only executor**; a client with no active assignment runs the legacy/default behavior documented here unchanged.

## What it is (in plain English)
The Sales Operating System is a guided, end-to-end sales lifecycle layered on top of the existing Clients, Follow-Ups, Appointments and Visits records. It turns "a pile of follow-up tasks" into a managed pipeline that walks every lead from first contact all the way to a closed deal — New → Booking Call → Appointment → Confirmation → Visit → After-Visit → Offer → Reservation → Financing → Ownership Transfer (الإفراغ) → Closed Won (مغلق ناجح), with two side-exits for leads that drop out: Lost (خاسر) and Unqualified (غير مؤهل).

A sales rep never has to think about "what stage is this client in and what do I move them to next." They open a task in the **Follow-up Workspace**, see the one mission for that call, dial or WhatsApp, pick an outcome from a short list, and save. Behind the scenes the existing workflow engine moves the client to the right stage, sets the right status, and schedules the next task automatically. Managers get a **Sales Queue** to triage the day's work, a read-only **Sales Process Studio** that maps the whole lifecycle and shows which automation implements each step, and a **Sales Manager** dashboard with the pipeline funnel and operating health metrics.

The hard architectural rule that holds the whole thing together: **the Workflow engine is the only thing that moves a client between stages.** The Workspace, Queue and Studio never hardcode a transition in React — they write the trigger record (the completed follow-up, the new appointment, the new offer) and let the bound workflow do every stage/status move. There is exactly one automation path.

## Why it exists
Wassell's reps were running the entire sales process from memory, juggling a generic follow-up form and manually editing client stages. The result was leads silently going cold ("nobody followed up"), inconsistent stage transitions, and no way for a manager to see where the pipeline was leaking. The Sales OS encodes the company's real sales playbook — every follow-up type, every allowed outcome, what each outcome requires, and what happens next — into a configuration the app reads, so the process is the same for every rep and the next action is never forgotten.

## The lifecycle and side-exits
The lifecycle stages (stored as Arabic strings on each client's `client_stage`, in order) are:

| # | Stage (AR) | Stage (EN) | Activities at this stage |
|---|---|---|---|
| 0 | جديد | New | Appointment Booking Call |
| 1 | الاتصال لحجز موعد | Appointment Booking | Booking Call, WhatsApp Follow-up |
| 2 | موعد زيارة | Appointment Scheduled | Confirmation Call, Same-Day Confirmation, No-Show Recovery |
| 3 | زيارة | Visit | After-Visit Follow-up |
| 4 | متابعة بعد الزيارة | After-Visit Follow-up | After-Visit Follow-up |
| 5 | عرض سعر | Offer | Offer Follow-up |
| 6 | حجز | Reservation | Reservation Payment Follow-up |
| 7 | تمويل | Financing | Financing Follow-up |
| 8 | الإفراغ | Ownership Transfer | Ownership Transfer Follow-up |
| 9 | مغلق ناجح | Closed Won | — (terminal success) |

Two **side-exit** stages a lead can drop into at almost any point:
- **غير مؤهل (Unqualified)** — a lead that was never a real prospect (wrong number, duplicate, not interested early on).
- **خاسر (Lost)** — a lead we worked but lost (rejected the offer, bought elsewhere, went cold).

A client in any of the three terminal/side-exit stages (Unqualified, Lost, Closed Won) is "done" — they don't count toward the "needs a next action" health metric.

## Key behaviors
- **Arabic values are canonical.** Every stage and status is stored as its Arabic label (the stored value equals `label_ar`). The build-time typed unions in `arabicEnums.generated.ts` and the runtime `assertSalesProcessEnums()` guard catch any drift between the config and the live `clients` model options, loudly.
- **The config is the recipe; the workflows are the executor.** The sales process is described once as a typed constant (`DEFAULT_SALES_PROCESS`). It lists the 10 follow-up types, the outcomes each type allows, the fields each outcome requires, and a *preview* of what the bound workflow will do (move the client, create the next task). The preview is shown to the rep before they save. The actual write is done by the workflow — never a second write path in React.
- **One part of the recipe is now manager-editable: the per-type objective text.** The "Goal" the rep reads at the top of the Workspace mission can be reworded (AR + EN) by an admin from the Sales Manager page without a code change. Those edits live in the `sales_process_overrides` table (one row per follow-up type), are loaded for every authenticated user via the `salesProcessOverrides` store slice (mirrors the scheduled-reports slice's load + upsert), and are merged over `DEFAULT_SALES_PROCESS` by `applyOverridesToConfig()` before the Workspace reads the config. A blank override field falls back to the default. Everything else in the recipe (outcomes, required fields, stage/status moves) stays a code constant in v1.
- **One automation path.** The Workspace/Queue/Studio write a trigger record via the store's `saveRecord`, which runs `executeWorkflows`. The Sales Lifecycle workflows (W1–W12) react to those writes and perform every client stage/status move + next-task creation. The Studio is read-only and runs nothing.
- **WhatsApp follow-ups are a two-phase flow: send (action) → waiting → reply (outcome).** Sending a WhatsApp is not an outcome — it's an action that puts the follow-up into a "waiting for response" state (`followup_status='in_progress'` + `whatsapp_state='message_sent_waiting_response'`; the `followup_status` enum is unchanged). The follow-up's `scheduled_datetime` is repurposed at send time as the **escalation deadline** (attempt 1 → +24h, attempt 2 → day 5 from the first send). The customer's reply is the real outcome; if no reply arrives by the deadline, the **No-Response Escalation** workflow marks the follow-up `no_response` + completed and creates the next attempt automatically (WhatsApp #2 → then a booking call). A WhatsApp follow-up self-stamps `source_followup_id = its own id` at send time so the `on_due` escalation can close the exact record it fired on. Full mechanics: [followups-workspace.md](followups-workspace.md) and [workflow-automation.md](workflow-automation.md).
- **No-Next-Action is the headline health metric.** An active client (not Unqualified / Lost / Closed Won) with no open follow-up is a leak. The Sales Queue surfaces these in a dedicated audit view, and the Sales Manager dashboard headlines the count — the target is always zero.
- **The "Next Action" on the client is delivered by a DB trigger, not a workflow (added 2026-06-17).** The brief's "Next-Action visible on the client" is implemented by a SECURITY DEFINER Postgres trigger pair (mirroring the all_projects rollup pattern) that recomputes `clients.next_followup_id` / `next_action_type` / `next_action_due_at` from the client's earliest open follow-up on every clients/followups write — read-only, self-healing on complete / reschedule / delete / move, covering every create path. This is **not** done by workflow `update_record` actions. See [clients.md](clients.md).
- **SLA is computed live, never stored.** Whether a task is on-time, due-now, overdue, or completed-late is derived at render time from `scheduled_datetime` vs now / `actual_datetime`. There is no stored `sla_status` field.
- **Studio ↔ Workflow binding via metadata.** Each Sales Lifecycle workflow carries `metadata = { managed_by: 'sales_process_studio', sales_stage, activity_type, compatibility }`. The Studio uses that metadata to show which workflow implements each activity and to flag drift (a Studio-generated workflow later hand-edited in the Builder).
- **Everything is bilingual + RTL.** All four surfaces render Arabic/English and mirror correctly under `dir="rtl"`.

## The 12 Sales Lifecycle workflows
All twelve live in the **"Sales Lifecycle" (دورة حياة المبيعات)** workflow group and are tagged with `metadata.managed_by = 'sales_process_studio'`. W1–W3 are the pre-existing sales workflows that were moved into the group and tagged; W4–W12 were generated by `scripts/build-sales-lifecycle-workflows.mjs` (each created **disabled** and enabled only after a dev-engine test passed). Branch-by-branch detail lives in the auto-generated workflow PRDs (`docs/prd/workflows/`); this table is the map.

| # | Workflow | Trigger | What it does |
|---|---|---|---|
| W1 | First Follow-up | create on `clients` | Creates the first booking-call follow-up for a brand-new lead. |
| W2 | Booking Call Completed | update on `followups` | Branches by outcome: no-answer / interested / wrong-time / not-interested. Gained a **leading leg (leg C)**: an escalation call (`escalation_reason = whatsapp_no_response_5d`) answered with `no_answer` creates a WhatsApp follow-up +1 day, re-entering the WhatsApp loop. First-match-wins keeps a *normal* booking-call no_answer unchanged. |
| W3 | Appointment Created | create on `appointments` | Moves the client to موعد زيارة and creates two confirmation follow-ups. **Owns the "appointment booked" client move** — the Workspace requires an appointment to be created, but does not move the client itself. |
| W4 | Confirmation Completed | update on `followups` | 7 branches: attendance_confirmed, no_answer (WhatsApp reminder **only** — never overwrites the client status with a generic value), rescheduled, cancelled→rebook, cancelled→lost, wrong_time, not_interested. |
| W5 | No-Show Recovery | update on `appointments` (status → no_show) | Sets client لم يحضر الموعد and creates a recovery call. |
| W6 | Visit → After-Visit | create on `visits` | Moves the client to زيارة and creates the after-visit call. |
| W7 | After-Visit Completed | update on `followups` | 7 branches: request_offer is **status-only** (client عرض سعر / تم طلب عرض سعر, no follow-up — W8 creates the offer follow-up); still_interested / needs_financing_info / family_discussion schedule retries; not_interested → خاسر; no_answer / wrong_time retries. |
| W8 | Offer Created → Offer Follow-up | create on `offer_prices` | Moves the client to عرض سعر / تم إرسال عرض السعر and creates the offer follow-up. |
| W9 | Offer Follow-up Completed | update on `followups` | 6 branches: offer_accepted → حجز / بانتظار دفعة الحجز + reservation-payment follow-up; offer_rejected → خاسر / تم رفض العرض + lost_reason (terminal); waiting_decision / needs_financing_info retry; no_answer / wrong_time. |
| W10 | Reservation Created → Financing Follow-up | create on `reservations` | Moves the client to تمويل / تم الحجز and creates the financing follow-up. |
| W11 | Financing Status Updated | update on `financing` | 3 branches by `financing_status`: bank_submitted → status البنك, valuation → status التقييم, completed → stage الإفراغ + ownership-transfer follow-up. |
| W12 | Ownership Transfer Completed → Closed Won | update on `ownership_transfer` (status → completed) | Moves the client to مغلق ناجح / تم الإفراغ — the deal is won. |

Two further Sales-Lifecycle workflows handle the **WhatsApp two-phase flow** (added 2026-06-17, live in prod):

| Workflow | Trigger | What it does |
|---|---|---|
| **WhatsApp Response Completed** (id `95bdbe0f-1247-4eb4-bc8f-f0db786c7e27`) | update on `followups` | Runs the response-outcome transitions when the rep records the customer's reply: **interested** → status مهتم + next WhatsApp +5d; **wrong_time** / **recontact_later** → next WhatsApp at the `reschedule_contact_date`; **not_interested** → غير مؤهل / غير مهتم (terminal, needs `lost_reason` + notes); **appointment_booked** (W3 owns the client move); **request_offer** → stage عرض سعر / status تم طلب عرض سعر. |
| **WhatsApp No-Response Escalation** (id `918b2540-1e07-42b9-8988-ddcfa02b9e8a`) | **on_due** on `followups` | When a waiting WhatsApp's baked-in `scheduled_datetime` (the escalation deadline) passes while still waiting: **attempt 1 (24h)** marks `call_result = no_response` + `whatsapp_state = no_response_expired` + completed, then creates **WhatsApp #2**; **attempt 2 (day 5)** marks no_response + creates a **booking call** (`appointment_booking_call`, `escalation_reason = whatsapp_no_response_5d`). It closes the trigger follow-up via an `update_record` filtered on `id = source_followup_id` (the record's self-stamp). Gated on `whatsapp_state` so a follow-up that already recorded a reply is skipped. Verified live end-to-end. |

One further Sales-Lifecycle workflow auto-closes stale appointments (added 2026-06-21, live in prod):

| Workflow | Trigger | What it does |
|---|---|---|
| **Auto-close appointment as No-Show after 24h** (id `b9f3a1c2-7d4e-4a8b-9c1d-5e6f70819203`) | **on_due** on `appointments` | 24 h after `appointment_date` (Riyadh-local), if the appointment is still **open** (`appointment_status` = scheduled / confirmed / unset) it (a) sets the status to `no_show`, then (b) **reproduces W5 exactly** — moves the client to `client_status` = لم يحضر الموعد and creates a `no_show_recovery_call` follow-up — so an automatic no-show is downstream-identical to a manual one. (W5 stays the *manual* path on appointment `update`; this on_due workflow copies its two actions because workflows can't share logic — **keep the two in sync**.) Any human update first — completed / cancelled / rescheduled / no_show — drops the row from the candidate set, so a manual update is **never overridden**; additionally the flip (a) is `p_expected_version`-guarded and runs first, and on `version_conflict` the engine aborts (b) too. Candidate rows come from `appointments_due_for_noshow()` swept by `api/sweep-appointment-noshows.ts` every 30 min; a **going-forward cutoff** (`2026-06-21`) excludes the pre-existing backlog. A visit registered *after* an auto-no-show still advances the client normally — W6 gates only on `client_id` and never reads the appointment status. |

One Sales-Lifecycle workflow handles the **visit-experience rating** (added 2026-06-21):

| Workflow | Trigger | What it does |
|---|---|---|
| **Send Visit Rating** (id `b9f2a1c4-7e3d-4a5b-9c8e-1d2f3a4b5c6d`) | **on_due** on `followups` | Fires when the `rating_request` timer follow-up that W6 created comes due (+2h after the visit). Sends the client a WhatsApp asking them to rate the visit 1–5, with a public link `https://app.wassel.re/rate/{rating_token}` (opened with no login — see [visit-rating.md](visit-rating.md)). Gated on `followup_type = rating_request`. **Created `is_active = false` as a go-live gate** so customers never receive a `/rate/<token>` link before the frontend route deploys — enabled after the deploy reaches READY. |

Most stage-completing workflows (W2, W4, W7, W9, W11, the WhatsApp Response Completed workflow) are **branched**: one trigger fans out into a branch per outcome, each branch self-contained with a global gate (the follow-up type + `actual_datetime` is set + the chosen `call_result`, matched on-change) and its own client move + next-task creation. The create/update steps create downstream follow-ups whose `scheduled_datetime` uses date-expression offsets (e.g. `+1d @10:00`) so the next task lands at a sensible time. For the WhatsApp flow the next follow-up's `scheduled_datetime` doubles as that attempt's escalation deadline.

## The four surfaces

### 1. Follow-up Workspace (the rep's daily driver)
Replaces the generic follow-up form. The rep opens a follow-up, sees the mission and only the context that matters for that task, calls or WhatsApps, picks an outcome (only the outcomes the config allows for that follow-up type appear), required fields validate live, and **Complete & Save** writes the outcome — the fired workflow then moves the client and creates the next task. The generic form stays reachable for power users via `?generic=1`. Full detail: [followups-workspace.md](followups-workspace.md).

### 2. Sales Queue (`/sales/tasks`)
The daily work surface. Follow-up tasks are bucketed into nine views — My Tasks, Due Now, Overdue, Today, Tomorrow, Waiting for Customer, High Priority, No Owner, Completed — plus the **No Next Action** audit (active clients with no open follow-up; headline target zero). SLA is computed live. Triage controls let the rep sort and filter the active view by rep, follow-up type, and client stage. Each row has a one-tap call or WhatsApp button (channel chosen by the follow-up type) and links into the Workspace. Available to all sales staff.

### 3. Sales Process Studio (`/sales/process`, admin-only)
A **read-only** visual map of the lifecycle. Each stage card shows its live count of active clients, overdue follow-ups, how many workflows are linked to it, and how many of its activities have no workflow. Clicking a stage expands its activities; each activity shows the outcomes the config defines (with their required fields and the stage/status they preview) and a badge for its bound workflow:
- **Linked** (green) — a Studio-managed workflow implements this activity and matches the generated shape.
- **Advanced** (gold) — a Studio-managed workflow implements it but has been hand-edited in the Builder (drift detected via the metadata shape hash).
- **Missing workflow** (red) — no workflow is bound to this activity yet.

"Open in Workflow Builder" and "View Workflow Runs" jump to the bound workflow's editor / logs. **No automation runs here** — the Studio only reads and maps; the Workflow Builder remains the only place a workflow is edited.

### 4. Sales Manager (`/sales/manager`, admin-only)
The operating-health dashboard. Headlines the **No Next Action** count (should be zero), overdue / open / completed-in-30-days counts, the pipeline funnel (clients by stage in lifecycle order), outcome and lost-reason breakdowns, a per-rep open/completed table, and two derived rates (booking-call no-answer rate, completed-on-time rate). All computed in-memory from the store; read-only.

It also carries one **editable** panel: a **"Follow-up Instructions"** accordion where the admin rewords the objective (the "Goal") each rep sees in the Follow-up Workspace mission, per follow-up type, in both Arabic and English. Each row expands to two text boxes (Goal AR / Goal EN) with Save and (once overridden) Reset-to-default. A saved override is persisted to the `sales_process_overrides` table and loaded for **every** authenticated user, so the reworded goal appears in the Workspace for all reps immediately. A blank field falls back to the hardcoded default, so a partial edit never blanks the instruction. This is the only place an admin can change what a follow-up's goal says without a code change — the rest of the recipe (outcomes, required fields, stage moves) is still a code constant.

## The config layer (`src/lib/salesProcess/`)
This is the single source of truth for the sales recipe, consumed by all four surfaces and the validators:
- **`outcomes.ts`** — `OUTCOME_CATALOG`: the follow-up outcome values, each with bilingual labels and a tone (positive / neutral / negative) that drives the outcome-button color in the Workspace. Append-only — these are stable API names stored on `followups.call_result`. The WhatsApp two-phase change added a **`no_response`** outcome (written only by the escalation workflow) and retired `message_sent` / `message_replied` from the *selectable* WhatsApp outcomes (they survive as legacy `call_result` values — `message_sent` is now reused as the `whatsapp_state` send marker).
- **`config.ts`** — `DEFAULT_SALES_PROCESS`: the 9 active lifecycle stages (+ the 3 terminal/side-exit ones), and all 10 follow-up types (appointment_booking_call, whatsapp_follow_up, appointment_confirmation_call, same_day_appointment_confirmation, no_show_recovery_call, follow_up_call_after_visit, offer_follow_up, reservation_payment_follow_up, financing_follow_up, ownership_transfer_follow_up). Each follow-up type declares its objective, primary channel, the context blocks the Workspace should show, a preference summary, an optional call script, and its allowed outcomes — each outcome mapping to required fields → client stage/status preview → next-action preview. The **`whatsapp_follow_up`** type's `allowed_outcomes` were reworked for the two-phase flow: `message_sent` / `message_replied` are no longer selectable, and the selectable set is now the customer-reply outcomes — `interested`, `wrong_time`, `recontact_later`, `not_interested`, `appointment_booked`, `request_offer`. `getSalesProcessConfig()` is the single accessor a future persisted/Studio-editable layer can slot into. **`applyOverridesToConfig(overrides, base?)`** is the first of those layers: it merges the manager-edited objective text from `sales_process_overrides` over the constant (keyed by follow-up type, blank-falls-back-to-default) and returns the effective config the Workspace reads. `getFollowUpTypeConfig(type, config?)` accepts that merged config so callers can pass the overridden version.
- **`types.ts`** — the typed shape of the config (follow-up types, outcomes, required fields, previews, the Studio↔workflow binding metadata).
- **`validators.ts`** — `validateFollowUpCompletion()` returns hard errors (block the save) and overridable warnings; `revealedFieldSlugs()` / `isOutcomeFieldVisible()` are the shared predicate the Workspace's outcome panel and the validator both use, so a revealed-and-required field that's empty blocks the save and a hidden field never does.
- **`workflowBindings.ts`** — `resolveBoundWorkflow()` / `findMissingWorkflowBindings()` resolve which workflow implements an activity via `workflow.metadata`; `isWorkflowDrifted()` flags a Studio-generated workflow that's been hand-edited (shape-hash mismatch).
- **`arabicEnums.generated.ts`** — generated typed unions of the live `clients` stage/status values, so config references are checked at build time.
- **`assertEnums.ts`** — the runtime guard that re-checks the config against the actually-loaded model.
- **`timeline.ts`, `contextResolvers.ts`** — helpers that build the Workspace's timeline and resolve per-block context.

## The downstream models (Phase 7)
Four new models (unfrozen JSONB in `records`, in the Sales group) carry the deal once it gets past the visit. Each was created via `supabase/migrations/2026-06-17_sales_os_downstream_models.sql` (generated by `scripts/build-downstream-models.mjs`) with fixed ids and live lookup targets:
- **offer_prices** (عروض الأسعار) — client, project, unit (via unit picker), offer_amount, offer_status (sent / signed / accepted / rejected / expired), offer_date, valid_until, sales_rep, notes.
- **reservations** (الحجوزات) — client, offer, project, unit, reservation_amount, payment_status (pending / cheque_received / paid), reservation_date, sales_rep, notes.
- **financing** (التمويل) — client, project, financing_status (documents_required → bank_submitted → valuation → approval → checks → contract → completed), bank, requested_amount, submitted/approval dates, sales_rep, notes.
- **ownership_transfer** / الإفراغ — client, project, unit, transfer_status (pending / form_issued / scheduled / completed), deed_number, transfer_date, sales_rep, notes.

Creating a record in these models is what fires the downstream workflows (W8 on offer_prices, W10 on reservations, W12 on ownership_transfer); updating their status fires W11/W12.

## User flows
1. **A rep works the day's queue (happy path):**
   1. Rep opens the Sales Queue → "My Tasks" (or "Due Now").
   2. Picks the top task → the Follow-up Workspace opens with the mission, context, and call/WhatsApp button.
   3. Rep dials, talks, picks the outcome (e.g. "Interested"). Required fields reveal and validate.
   4. Rep clicks **Complete & Save**. The follow-up is saved with the outcome; the bound workflow moves the client and schedules the next task.
   5. Rep returns to the queue — the completed task is gone and the new one has appeared.
2. **An appointment-booked outcome:**
   1. On a booking call the rep picks "Appointment Booked." The Workspace requires an Appointment record — it opens the appointment form prefilled.
   2. Rep saves the appointment. W3 (Appointment Created) moves the client to موعد زيارة and creates two confirmation follow-ups. The booking follow-up's own save records the outcome but does not move the client (W3 owns that).
3. **A manager audits the pipeline:**
   1. Admin opens Sales Manager → reads the No-Next-Action headline (should be zero) and the funnel.
   2. Sees a leak (e.g. several active clients with no next action) → clicks the headline → lands in the Sales Queue's No-Next-Action view → opens each client to schedule a task.
   3. Switches to the Sales Process Studio to confirm every activity has a Linked (not Missing) workflow.
4. **Empty / edge states:**
   - No-Next-Action audit empty → "Every active client has a next action ✓".
   - A follow-up whose type isn't in the config → the Workspace shows "No guided outcomes for this type — use Advanced Fields."
   - A Studio activity with no bound workflow → red "Missing workflow" badge + a prompt to create one in the Builder.

## Data touched
- **Reads:** `models` (clients / followups / appointments / visits + the 4 downstream models, for ids and schema); `records` (clients, follow-ups, appointments, visits, offers, reservations, financing, ownership transfers); `workflows` (to resolve Studio bindings + drift); `sales_process_overrides` (the manager-edited objective text, loaded for every user and merged into the config).
- **Writes:** `records.data` for the operating surfaces — every record write goes through `saveRecord` (which runs the workflow engine). The Workspace writes the completed follow-up; "Book Appointment" writes an appointment; outcome-driven client moves and next-task creation are written by the workflows, not the surfaces. Separately, the Sales Manager page writes `sales_process_overrides` rows (admin-only) when an admin edits a follow-up type's objective.
- **New fields on existing models (Phase 1 migration):**
  - **followups:** `followup_status` (open / in_progress / completed / cancelled / skipped — unchanged by the WhatsApp work), `priority`, `outcome_notes`, `lost_reason`, `completed_by_call_id`, `completed_by_chat_id`, `completed_by_user`, `new_appointment_datetime`, `source_stage_snapshot`, `source_status_snapshot`. `call_result` was relabeled "Outcome" and extended to the catalog (now including `no_response`). The **WhatsApp two-phase flow** (migration `2026-06-17_whatsapp_followup_fields.sql`) added `whatsapp_state`, `sent_at`, `first_whatsapp_sent_at`, `whatsapp_attempt_number`, `escalation_reason`, `previous_followup_id`, `source_followup_id`, `sent_by_user`, `whatsapp_template_id`. (Also `phone_calls.linked_followup_id` and `appointments.source_followup_id`.)
  - **clients:** `client_owner`, `next_followup_id`, `next_action_type`, `next_action_due_at`, `last_activity_at`, `lost_reason`, `lost_at`, `lifecycle_health`; new Arabic `client_stage` options (خاسر, مغلق ناجح) and `client_status` options (رقم خاطئ, مكرر, تم رفض العرض, يحتاج معلومات تمويل, نقاش عائلي, بانتظار القرار, تم إرسال واتساب, إعادة تواصل لاحقًا, بارد, بانتظار دفعة الحجز). The **next-action trio** (`next_followup_id` / `next_action_type` / `next_action_due_at`) is now read-only and DB-trigger-maintained (Phase 2 migration `2026-06-17_client_next_action.sql`), not a workflow write. See [clients.md](clients.md).
- **New table `sales_process_overrides`** (one row per follow-up type: `id` = the type key, `objective_ar`, `objective_en`, `updated_at`). Admin-write, all-authenticated-read RLS. Holds only the manager-edited objective text; it does not change which outcomes/fields/moves a type has. Migration: `supabase/migrations/2026-06-17_sales_process_overrides.sql`.
- **No stored `sla_status`** — SLA is computed live in the Queue / Manager.

## Key files
| File | What it does |
|---|---|
| `src/lib/salesProcess/config.ts` | `DEFAULT_SALES_PROCESS` — stages + 10 follow-up types + per-outcome required fields and previews. The recipe. Plus `applyOverridesToConfig()`, which merges manager `sales_process_overrides` over the constant. |
| `src/lib/salesProcess/outcomes.ts` | `OUTCOME_CATALOG` — the 25 outcome values + bilingual labels + tone |
| `src/lib/salesProcess/types.ts` | Typed shape of the config + the Studio↔workflow binding metadata |
| `src/lib/salesProcess/validators.ts` | `validateFollowUpCompletion` (hard errors + warnings), `revealedFieldSlugs` / `isOutcomeFieldVisible` |
| `src/lib/salesProcess/workflowBindings.ts` | `resolveBoundWorkflow`, `findMissingWorkflowBindings`, `isWorkflowDrifted` (shape-hash drift) |
| `src/lib/salesProcess/arabicEnums.generated.ts` | Generated typed unions of live `clients` stage/status values |
| `src/lib/salesProcess/assertEnums.ts` | Runtime guard: config enums vs the loaded model |
| `src/lib/salesProcess/timeline.ts`, `contextResolvers.ts` | Workspace timeline + per-block context resolution |
| `src/pages/Followups/FollowUpWorkspacePage.tsx` | The guided Follow-up Workspace (replaces the generic followups form) |
| `src/pages/Sales/SalesTasksPage.tsx` | Sales Queue — 9 views + the No-Next-Action audit |
| `src/pages/Sales/lib/queueViews.ts` | Pure queue logic: bucketize, computeNoNextAction, live SLA |
| `src/pages/SalesProcess/SalesProcessStudioPage.tsx` | Read-only lifecycle map + workflow-binding badges (admin-only) |
| `src/pages/Sales/SalesManagerPage.tsx` | Manager dashboard — funnel, breakdowns, per-rep, rates, and the editable "Follow-up Instructions" accordion (objective AR/EN per type) (admin-only) |
| `src/pages/Sales/lib/salesMetrics.ts` | Pure manager metrics (`computeManagerMetrics`) |
| `src/stores/appStore.ts` (`salesProcessOverrides`) | Store slice that loads `sales_process_overrides` for all users and `saveSalesProcessOverride` upserts an admin's edit (mirrors the scheduled-reports slice) |
| `src/App.tsx` | Routes `/sales/tasks`, `/sales/process` (admin), `/sales/manager` (admin); swaps the followups form for the Workspace |
| `src/components/layout/Sidebar.tsx` | Sales Tasks (all staff) + Sales Process + Sales Manager (admin-only) sidebar links |
| `scripts/build-sales-lifecycle-workflows.mjs` | Reviewable builders for W4–W12 → migration SQL + dev-engine test JSON |
| `scripts/build-downstream-models.mjs` | Builds the 4 downstream models → migration SQL |
| `supabase/migrations/2026-06-16_sales_os_phase1.sql` | New fields on followups / clients / phone_calls / appointments + the outcome / stage / status options |
| `supabase/migrations/2026-06-17_sales_process_overrides.sql` | The `sales_process_overrides` table + RLS (admin-write, authenticated-read) for the manager-editable objective text |
| `supabase/migrations/2026-06-17_client_next_action.sql` | SECURITY DEFINER trigger pair maintaining the client next-action trio from the earliest open follow-up; flags the three fields `read_only` |
| `supabase/migrations/2026-06-16_sales_os_phase5_workflows.sql` | Sales Lifecycle group + metadata-tagging W1–W3 + the W3 confirmation fix |
| `supabase/migrations/2026-06-17_sales_os_downstream_models.sql` | offer_prices / reservations / financing / ownership_transfer models |
| `supabase/migrations/2026-06-17_sales_os_w{4..12}.sql` | The W4–W12 workflow inserts (created disabled) |
| `supabase/migrations/2026-06-17_whatsapp_followup_fields.sql` | The WhatsApp two-phase fields on `followups` (`whatsapp_state`, `sent_at`, `first_whatsapp_sent_at`, `whatsapp_attempt_number`, `escalation_reason`, `previous_followup_id`, `source_followup_id`, `sent_by_user`, `whatsapp_template_id`) + the `no_response` `call_result` option |

## Open questions / known limitations
- **Most of the config is still a hardcoded constant.** Only the per-type objective text is admin-editable so far (via `sales_process_overrides` + `applyOverridesToConfig`). The rest of `DEFAULT_SALES_PROCESS` — outcomes, required fields, stage/status moves, scripts — is not yet persisted or editable from the Studio; changing those means a code change + a workflow edit. `getSalesProcessConfig()` / `applyOverridesToConfig()` are the seams a fuller persisted/Studio-editable layer plugs into.
- **The Studio maps; it doesn't generate.** It detects drift and missing bindings but can't (re)generate or repair a workflow from the UI — that's still done by the build scripts + the Workflow Builder.
- **Stage moves only happen through the workflow engine.** Because client-side workflows fire on the SPA save path, a direct DB write to a trigger record (e.g. via SQL or an importer) does **not** advance the lifecycle. This is by design (single executor) but worth knowing when bulk-loading data.
- **Next-action trio is now DB-denormalized (resolved 2026-06-17).** `clients.next_followup_id` / `next_action_type` / `next_action_due_at` are populated automatically by a SECURITY DEFINER Postgres trigger pair that recomputes them from the client's earliest open follow-up on every clients/followups write (mirrors the all_projects rollup pattern) — NOT by workflow `update_record` actions. The three fields are read-only. The Queue/Manager still compute the live "needs a next action" picture from the open follow-up set for their headline metric, but the denormalized columns are now reliably populated for any other reader (dashboards, BI, the client form). `lifecycle_health` remains a workflow-driven flag, not part of the trigger. Migration: `supabase/migrations/2026-06-17_client_next_action.sql`. See [clients.md](clients.md).
- **The on_due scheduled-follow-up sweeper is currently inert in production** because `CRON_SECRET` is unset in Vercel — time-based follow-up automation (and its workflow-run logging) activates the moment the secret is set. See [workflow-automation.md](workflow-automation.md).
- **Multi-value `client_id` is read defensively** (first element) across the queue/context code — the sales process assumes one client per follow-up.
