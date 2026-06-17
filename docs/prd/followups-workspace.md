# PRD: Follow-up Workspace

**Status:** Live
**Last updated:** 2026-06-17
**Related PRDs:** [sales-process.md](sales-process.md), [workflow-automation.md](workflow-automation.md), [clients.md](clients.md), [calling.md](calling.md), [chats.md](chats.md), [record-management.md](record-management.md)

## What it is (in plain English)
The Follow-up Workspace is the guided screen a sales rep uses to work a single follow-up task. Instead of the generic record form (a wall of fields), it shows one clear **mission** at the top ("Booking call — book a project visit"), the call/WhatsApp button, a short call script, only the context that matters for this specific task on the side, and an **Outcome** panel where the rep records what happened. The rep picks one of a short list of allowed outcomes, fills the few fields that outcome needs, and hits **Complete & Save**. That save records the outcome on the follow-up and lets the workflow engine move the client to the next stage and create the next task — the rep never touches a stage dropdown.

It is the front door of the Sales Operating System: it replaces the generic Follow-Ups form for the `followups` model. Power users who need the raw form (to edit an unusual field) can still reach it via an "Advanced Fields" link.

## Why it exists
The generic form treated a follow-up like any other record — every field visible, no guidance, and the rep manually deciding what to set on the client afterward. That produced inconsistent data and missed next steps. The Workspace narrows the rep's job to "make the contact, pick the outcome," validates that they captured what the process needs, and hands the rest to automation. It's the difference between a form and a guided task.

## Key behaviors
- **Replaces the generic followups form.** `src/App.tsx` routes the `followups` model's record page to `FollowUpWorkspacePage` unless the URL carries `?generic=1`. The escape hatch (`?generic=1`, reachable from the "Advanced Fields" link or the "رجوع/Back" affordances) renders the normal record form for power editing.
- **Mission-first layout.** A `MissionHeader` shows the follow-up type's bilingual label + objective, the client, and the attempt number. The main column holds the primary action (call or WhatsApp, channel chosen by the follow-up type's `primary_channel`), the call `ScriptPanel`, and the `OutcomePanel`. The side column holds the `ContextPanel` (only the context blocks the config lists for this type), a `PreferenceSummary`, and a `TimelinePanel`.
- **Only config-allowed outcomes render.** The `OutcomePanel` reads the follow-up type's `allowed_outcomes` from `DEFAULT_SALES_PROCESS`. The first allowed outcome is the primary success path, rendered as a big filled button; the rest render as pills. Each button's color comes from the outcome's tone (positive = green, neutral = gold, negative = red). A type with no config entry shows "No guided outcomes for this type — use Advanced Fields."
- **Dynamic field visibility.** Picking an outcome reveals exactly the fields that outcome needs — and no others. The shared predicate `revealedFieldSlugs()` decides which of `appointment_id`, `reschedule_contact_date`, `new_appointment_datetime`, `lost_reason`, `outcome_notes`, and the channel-appropriate evidence link (`completed_by_call_id` for calls, `completed_by_chat_id` for WhatsApp) appear. `actual_datetime` (completed-at) always shows. The **same** predicate is used by the validator, so what's revealed-and-required is exactly what blocks the save — and a hidden field never blocks it.
- **Live validation (hard errors vs warnings).** `validateFollowUpCompletion()` runs as the rep edits. Hard errors (a required field empty, no outcome chosen) disable Complete & Save and show a red message. A missing-required message **names the field in the user's language** — its Arabic/English display label (built via `buildFieldLabels` from the model), not the raw API slug. Warnings (no call/chat evidence attached, or a dead-end outcome that would leave an active client with no next action) are shown in gold and are overridable — they don't block the save.
- **"What will happen" preview.** Below the revealed fields the panel shows a plain-English preview of what the bound workflow will do — which stage the client moves to, what status is set, and the next action that will be created. This is a preview only; the workflow does the actual write.
- **Appointment-Booked requires creating an Appointment.** For the `appointment_booked` outcome the panel does **not** offer a free-text field — it requires a real Appointment record. It shows a "Book Appointment" button that opens the appointment form (prefilled with the client, phone, sales rep, and a back-link `source_followup_id`); on save the new appointment id is stamped onto the follow-up draft (`appointment_id`) and the button flips to "Appointment created & linked ✓". The follow-up's own save records the outcome but never moves the client to موعد زيارة — the **Appointment Created workflow (W3)** owns that move (so the client only advances once the appointment truly exists).
- **Evidence linking (auto + bidirectional).** For call outcomes the `EvidencePicker` **auto-links the most recent matching outbound call** (matched by `client_link` or by canonicalized phone) as the call that completed this follow-up (`completed_by_call_id`) — no manual click. It shows the linked call's time and a **Change** action; a pre-existing link and an explicit detach are respected (it latches after the first attempt, so it won't immediately re-attach — re-picking is the rep's call). On Complete & Save, the Workspace also stamps `linked_followup_id` back onto that phone call record — so the link is visible from both sides. (See [calling.md](calling.md).) When no matching call exists, the picker shows "no recent outbound calls" and attaching stays a soft warning, not a hard block.
- **The save writes the outcome; the workflow does the rest.** Complete & Save sets `call_result` (the outcome), `actual_datetime` (now, if unset), `followup_status = 'completed'`, `completed_by_user`, and the stage/status snapshots (`source_stage_snapshot` / `source_status_snapshot`, captured from the client at completion time), then calls `saveRecord` with the form-mount version for optimistic-concurrency. The fired Sales Lifecycle workflow then moves the client and creates the next task.
- **Optimistic concurrency.** The page snapshots the record's version at mount and passes it as `expectedVersion`. A concurrent edit by someone else returns a `conflict` and the rep is told to reload before saving (the completion is not applied). A queued (offline) save shows "saved locally — will sync later." The bidirectional evidence write uses its own version and a conflict there does not undo the completion (the pending-sync queue retries).
- **Permissions respected.** The Workspace honors the same view/edit permission hooks as the generic form. A user who can view but not edit sees the read-only Workspace (outcomes and Complete & Save disabled).
- **Bilingual + RTL throughout.** All labels, the script, the previews, and validation messages render Arabic/English and mirror under `dir="rtl"`.

## User flows
1. **Complete a booking call — interested (happy path):**
   1. Rep opens a booking-call follow-up → mission "Book a project visit," call button, script.
   2. Rep dials, talks, clicks the **Interested** outcome → `actual_datetime` auto-fills, the preview reads "set status مهتم; create the next action."
   3. Validation passes → rep clicks **Complete & Save** → toast "Follow-up completed."
   4. The Booking Call Completed workflow (W2) sets the client status and schedules the next task; the rep returns to the follow-ups list.
2. **Appointment booked:**
   1. Rep picks **Appointment Booked** → the panel shows "Book Appointment."
   2. Rep clicks it → the appointment form opens prefilled → rep saves → `appointment_id` is stamped on the draft and the panel shows "Appointment created & linked ✓."
   3. Rep clicks **Complete & Save** → the follow-up is completed; W3 (fired by the new appointment) moves the client to موعد زيارة and creates the confirmation follow-ups.
3. **A losing outcome:**
   1. Rep picks "Offer Rejected" (on an offer follow-up) → the `lost_reason` field reveals and is required.
   2. Rep selects a reason → preview reads "move the client to خاسر; set status تم رفض العرض." → Complete & Save.
   3. W9 moves the client to the Lost side-exit with the reason; no next task is created (terminal).
4. **Power-user escape hatch:** Rep needs to edit a field the Workspace doesn't expose → clicks **Advanced Fields** → the generic record form opens (`?generic=1`) → edits and saves there.
5. **Error / empty states:**
   - Outcome chosen but a required field empty → red message, Complete & Save disabled.
   - No guided config for this follow-up type → "No guided outcomes for this type — use Advanced Fields."
   - Concurrent edit → "This record was just edited by someone else — reload before saving."
   - No recent outbound calls to attach → the evidence picker shows "No recent outbound calls."

## Data touched
- **Reads:** `models` (followups + clients + appointments + phone_calls ids/schema); `records` (the follow-up, its client, linked appointment/project, and the client's recent outbound phone calls for the evidence picker); `users` (to resolve the completed-by / rep names).
- **Writes:** `records.data` for the follow-up (the outcome + completion fields + snapshots) via `saveRecord`; a new appointment record when "Book Appointment" is used; `linked_followup_id` back onto the attached phone_call record. All client stage/status moves and next-task creation are written by the **workflow engine**, not this page.
- **Storage shapes:** the follow-up's completion writes `call_result`, `actual_datetime`, `followup_status`, `completed_by_user`, `completed_by_call_id` / `completed_by_chat_id`, `lost_reason`, `outcome_notes`, `new_appointment_datetime`, `appointment_id`, `reschedule_contact_date`, `source_stage_snapshot`, `source_status_snapshot` — all on `records.data` (followups is unfrozen JSONB).

## Key files
| File | What it does |
|---|---|
| `src/pages/Followups/FollowUpWorkspacePage.tsx` | The Workspace page — layout, draft state, Complete & Save, bidirectional evidence stamp, the appointment modal, the Advanced-Fields link |
| `src/pages/Followups/components/MissionHeader.tsx` | Mission / objective / client / attempt-number header |
| `src/pages/Followups/components/PrimaryAction.tsx` | The call or WhatsApp button (channel from the follow-up type) |
| `src/pages/Followups/components/ScriptPanel.tsx` | The call-script panel for the type |
| `src/pages/Followups/components/ContextPanel.tsx` | Renders only the context blocks the config lists for this type |
| `src/pages/Followups/components/PreferenceSummary.tsx` | Compact client-preference summary (with "edit full" → Advanced Fields) |
| `src/pages/Followups/components/TimelinePanel.tsx` | The client's recent activity timeline for context |
| `src/pages/Followups/components/OutcomePanel.tsx` | Outcome buttons (tone-colored), dynamic revealed fields, live validation, "what will happen" preview, Complete & Save |
| `src/pages/Followups/components/EvidencePicker.tsx` | Auto-links the most recent matching outbound call as `completed_by_call_id` (Change to pick another / detach) |
| `src/pages/Followups/lib/followupContext.ts` | `resolveFollowupContext` / `readFollowupType` — resolves client, appointment, project, type, phones, attempt number |
| `src/lib/salesProcess/config.ts` | `DEFAULT_SALES_PROCESS` — the allowed outcomes + required fields + previews the panel reads |
| `src/lib/salesProcess/validators.ts` | `validateFollowUpCompletion`, `revealedFieldSlugs`, `isOutcomeFieldVisible` — the shared visibility + validation |
| `src/lib/salesProcess/outcomes.ts` | `OUTCOME_CATALOG` / `getOutcome` — labels + tone for the outcome buttons |
| `src/pages/Records/components/RecordFormModal.tsx` | The appointment-creation modal opened by "Book Appointment" |
| `src/App.tsx` | Swaps the followups form for the Workspace unless `?generic=1` |

## Open questions / known limitations
- **Advanced Fields is the only edit-everything path.** The Workspace intentionally exposes a curated field set; anything outside the config (e.g. a custom field a customer added to followups) is only editable via `?generic=1`. That's by design but means the Workspace doesn't auto-discover custom fields.
- **Evidence picker is outbound-only and capped.** It suggests the 5 most recent **outbound** calls. An inbound call the rep wants to cite as evidence isn't offered; the generic form's lookup is the fallback.
- **The "leaves client without next action" warning is heuristic.** It fires on a non-terminal outcome whose preview has no next action. It's a soft nudge, not a guarantee — the actual next action is created by the workflow.
- **One client per follow-up.** Context resolution reads the first `client_id` if the field is an array; the Workspace assumes a single client per task.
- **Appointment-booked depends on W3 being enabled.** If the Appointment Created workflow is disabled, completing an appointment-booked outcome creates the appointment but the client won't advance — the Studio's "Missing/Advanced" badges are how an admin notices.
