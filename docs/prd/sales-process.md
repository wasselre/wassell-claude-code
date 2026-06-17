# PRD: Sales Operating System

**Status:** Live
**Last updated:** 2026-06-17
**Related PRDs:** [followups-workspace.md](followups-workspace.md), [workflow-automation.md](workflow-automation.md), [clients.md](clients.md), [calling.md](calling.md), [chats.md](chats.md), [record-management.md](record-management.md), [workflow-logs.md](workflow-logs.md)

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
- **One automation path.** The Workspace/Queue/Studio write a trigger record via the store's `saveRecord`, which runs `executeWorkflows`. The Sales Lifecycle workflows (W1–W12) react to those writes and perform every client stage/status move + next-task creation. The Studio is read-only and runs nothing.
- **No-Next-Action is the headline health metric.** An active client (not Unqualified / Lost / Closed Won) with no open follow-up is a leak. The Sales Queue surfaces these in a dedicated audit view, and the Sales Manager dashboard headlines the count — the target is always zero.
- **SLA is computed live, never stored.** Whether a task is on-time, due-now, overdue, or completed-late is derived at render time from `scheduled_datetime` vs now / `actual_datetime`. There is no stored `sla_status` field.
- **Studio ↔ Workflow binding via metadata.** Each Sales Lifecycle workflow carries `metadata = { managed_by: 'sales_process_studio', sales_stage, activity_type, compatibility }`. The Studio uses that metadata to show which workflow implements each activity and to flag drift (a Studio-generated workflow later hand-edited in the Builder).
- **Everything is bilingual + RTL.** All four surfaces render Arabic/English and mirror correctly under `dir="rtl"`.

## The 12 Sales Lifecycle workflows
All twelve live in the **"Sales Lifecycle" (دورة حياة المبيعات)** workflow group and are tagged with `metadata.managed_by = 'sales_process_studio'`. W1–W3 are the pre-existing sales workflows that were moved into the group and tagged; W4–W12 were generated by `scripts/build-sales-lifecycle-workflows.mjs` (each created **disabled** and enabled only after a dev-engine test passed). Branch-by-branch detail lives in the auto-generated workflow PRDs (`docs/prd/workflows/`); this table is the map.

| # | Workflow | Trigger | What it does |
|---|---|---|---|
| W1 | First Follow-up | create on `clients` | Creates the first booking-call follow-up for a brand-new lead. |
| W2 | Booking Call Completed | update on `followups` | 4 branches by outcome: no-answer / interested / wrong-time / not-interested. |
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

Most stage-completing workflows (W2, W4, W7, W9, W11) are **branched**: one trigger fans out into a branch per outcome, each branch self-contained with a global gate (the follow-up type + `actual_datetime` is set + the chosen `call_result`, matched on-change) and its own client move + next-task creation. The create/update steps create downstream follow-ups whose `scheduled_datetime` uses date-expression offsets (e.g. `+1d @10:00`) so the next task lands at a sensible time.

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

## The config layer (`src/lib/salesProcess/`)
This is the single source of truth for the sales recipe, consumed by all four surfaces and the validators:
- **`outcomes.ts`** — `OUTCOME_CATALOG`: the 25 follow-up outcome values, each with bilingual labels and a tone (positive / neutral / negative) that drives the outcome-button color in the Workspace. Append-only — these are stable API names stored on `followups.call_result`.
- **`config.ts`** — `DEFAULT_SALES_PROCESS`: the 9 active lifecycle stages (+ the 3 terminal/side-exit ones), and all 10 follow-up types (appointment_booking_call, whatsapp_follow_up, appointment_confirmation_call, same_day_appointment_confirmation, no_show_recovery_call, follow_up_call_after_visit, offer_follow_up, reservation_payment_follow_up, financing_follow_up, ownership_transfer_follow_up). Each follow-up type declares its objective, primary channel, the context blocks the Workspace should show, a preference summary, an optional call script, and its allowed outcomes — each outcome mapping to required fields → client stage/status preview → next-action preview. `getSalesProcessConfig()` is the single accessor a future persisted/Studio-editable layer can slot into.
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
- **Reads:** `models` (clients / followups / appointments / visits + the 4 downstream models, for ids and schema); `records` (clients, follow-ups, appointments, visits, offers, reservations, financing, ownership transfers); `workflows` (to resolve Studio bindings + drift).
- **Writes:** `records.data` only — every write goes through `saveRecord` (which runs the workflow engine). The Workspace writes the completed follow-up; "Book Appointment" writes an appointment; outcome-driven client moves and next-task creation are written by the workflows, not the surfaces.
- **New fields on existing models (Phase 1 migration):**
  - **followups:** `followup_status` (open / in_progress / completed / cancelled / skipped), `priority`, `outcome_notes`, `lost_reason`, `completed_by_call_id`, `completed_by_chat_id`, `completed_by_user`, `new_appointment_datetime`, `source_stage_snapshot`, `source_status_snapshot`. `call_result` was relabeled "Outcome" and extended to the 25-value catalog. (Also `phone_calls.linked_followup_id` and `appointments.source_followup_id`.)
  - **clients:** `client_owner`, `next_followup_id`, `next_action_type`, `next_action_due_at`, `last_activity_at`, `lost_reason`, `lost_at`, `lifecycle_health`; new Arabic `client_stage` options (خاسر, مغلق ناجح) and `client_status` options (رقم خاطئ, مكرر, تم رفض العرض, يحتاج معلومات تمويل, نقاش عائلي, بانتظار القرار, تم إرسال واتساب, إعادة تواصل لاحقًا, بارد, بانتظار دفعة الحجز). See [clients.md](clients.md).
- **No stored `sla_status`** — SLA is computed live in the Queue / Manager.

## Key files
| File | What it does |
|---|---|
| `src/lib/salesProcess/config.ts` | `DEFAULT_SALES_PROCESS` — stages + 10 follow-up types + per-outcome required fields and previews. The recipe. |
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
| `src/pages/Sales/SalesManagerPage.tsx` | Manager dashboard — funnel, breakdowns, per-rep, rates (admin-only) |
| `src/pages/Sales/lib/salesMetrics.ts` | Pure manager metrics (`computeManagerMetrics`) |
| `src/App.tsx` | Routes `/sales/tasks`, `/sales/process` (admin), `/sales/manager` (admin); swaps the followups form for the Workspace |
| `src/components/layout/Sidebar.tsx` | Sales Tasks (all staff) + Sales Process + Sales Manager (admin-only) sidebar links |
| `scripts/build-sales-lifecycle-workflows.mjs` | Reviewable builders for W4–W12 → migration SQL + dev-engine test JSON |
| `scripts/build-downstream-models.mjs` | Builds the 4 downstream models → migration SQL |
| `supabase/migrations/2026-06-16_sales_os_phase1.sql` | New fields on followups / clients / phone_calls / appointments + the outcome / stage / status options |
| `supabase/migrations/2026-06-16_sales_os_phase5_workflows.sql` | Sales Lifecycle group + metadata-tagging W1–W3 + the W3 confirmation fix |
| `supabase/migrations/2026-06-17_sales_os_downstream_models.sql` | offer_prices / reservations / financing / ownership_transfer models |
| `supabase/migrations/2026-06-17_sales_os_w{4..12}.sql` | The W4–W12 workflow inserts (created disabled) |

## Open questions / known limitations
- **The config is a hardcoded constant in v1.** `DEFAULT_SALES_PROCESS` is not yet persisted or editable from the Studio — changing the process means a code change + a workflow edit. `getSalesProcessConfig()` is the seam a future persisted/Studio-editable layer plugs into.
- **The Studio maps; it doesn't generate.** It detects drift and missing bindings but can't (re)generate or repair a workflow from the UI — that's still done by the build scripts + the Workflow Builder.
- **Stage moves only happen through the workflow engine.** Because client-side workflows fire on the SPA save path, a direct DB write to a trigger record (e.g. via SQL or an importer) does **not** advance the lifecycle. This is by design (single executor) but worth knowing when bulk-loading data.
- **No stored next-action denormalization yet.** `clients.next_followup_id` / `next_action_type` / `next_action_due_at` / `lifecycle_health` exist as fields but the Queue/Manager compute the live next-action picture from the follow-up set rather than relying on those columns. Keeping them populated by the workflows is a follow-up.
- **The on_due scheduled-follow-up sweeper is currently inert in production** because `CRON_SECRET` is unset in Vercel — time-based follow-up automation (and its workflow-run logging) activates the moment the secret is set. See [workflow-automation.md](workflow-automation.md).
- **Multi-value `client_id` is read defensively** (first element) across the queue/context code — the sales process assumes one client per follow-up.
