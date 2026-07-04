# Wassell CRM — Complete Sales System Briefing

> Prepared 2026-07-04 as a handoff document for sales-process improvement work.
> Wassel (وصل العقارية) is a Saudi real-estate marketing company. The CRM is a custom
> no-code platform (React + Supabase): users define their own data models, automations,
> and dashboards. Everything below is what is LIVE in production today.

---

## 1. The big picture

The sales system is built on one covenant:

- **The rep's job:** open a task (a "follow-up"), see the mission, contact the client
  (call or WhatsApp), pick the outcome, save.
- **The workflow engine's job:** move the client between pipeline stages, set status,
  and create the next task. **The workflow engine is the ONLY thing that moves a client
  between stages** — reps never edit `client_stage`/`client_status` by hand (those
  fields are workflow-written).
- **The manager's job:** triage the queue, review call quality (Sales Valuation),
  coach daily, and edit the process (objectives, call scripts, review criteria)
  without code.

Everything is fully bilingual (Arabic-primary, English) and RTL.

---

## 2. The sales pipeline — stages and the models behind them

Client lifecycle stages (stored on `clients.client_stage`, Arabic labels):

| # | Stage (AR) | Stage (EN) | Key activity | Record model |
|---|---|---|---|---|
| 0 | جديد | New | First booking call | followups |
| 1 | الاتصال لحجز موعد | Call to book | Booking call + WhatsApp retry loop | followups |
| 2 | موعد زيارة | Visit appointment | Confirmation calls | appointments + followups |
| 3 | زيارة | Visit | On-site visit | visits |
| 4 | متابعة بعد الزيارة | Post-visit follow-up | After-visit call + rating link | followups |
| 5 | عرض سعر | Offer | Quote sent & chased | offer_prices + followups |
| 6 | حجز | Booking | Reservation + payment | reservations |
| 7 | تمويل | Financing | Bank submission → approval | financing |
| 8 | الإفراغ | Ownership transfer | Deed transfer | ownership_transfer |
| 9 | مغلق ناجح | Closed Won | Terminal success | — |
| — | خاسر / غير مؤهل | Lost / Unqualified | Terminal fail (workflow-written, with lost_reason) | — |

Downstream deal models (all created/advanced by workflows):

- **offer_prices** — client, project, unit, offer_amount, offer_status (sent/signed/accepted/rejected/expired), dates, sales_rep.
- **reservations** — client, offer, project, unit, reservation_amount, payment_status (pending/cheque_received/paid).
- **financing** — financing_status pipeline: documents_required → bank_submitted → valuation → approval → checks → contract → completed; bank, requested_amount.
- **ownership_transfer** — transfer_status: pending → form_issued → scheduled → completed; deed_number.

---

## 3. The Clients model (the central record)

**Basic section:** `client_id` (auto ع###), `client_name`, `phone_number` (required,
duplicate-checked), `client_stage` (12 stages above), `client_status` (~33 fine-grained
statuses like تم إرسال واتساب, بانتظار القرار), `client_sources` (multiselect: promotion,
inbound/outbound WhatsApp/calls, quote, financing, transfer), `notes`.

**Client Preferences section** (the inputs that feed the Project Finder):
- `budget` — range {min,max} SAR (50k–5M)
- `preferred_unit_type` — multiselect (villa, apartment, floor, duplex, townhouse, studio, annex)
- `location` — city/district/region cascade (multi allowed) + `preferred_neighborhoods`
- `location_items` — geo rules: district include/exclude + landmark anchors (within_radius / within_distance / inside_area) backed by PostGIS
- `preferred_area` — range m² (100–2000)
- `preferred_bedrooms` — single number
- `preferred_direction` — 8 compass options
- `preferred_amenities` — multiselect (majlis, maid room, pool, …)
- `preferred_projects` / `preferred_market_listings` — multi-lookups
- `preferred_language` — ar/en

**Multi-selection semantics:** multiple values in ONE preference are alternatives (OR) —
"شقة أو دور" means either earns full credit. Only amenities are cumulative/proportional.

**Sales-OS fields (system-maintained, read-only):**
- `client_owner` ("Sales Consultant" مستشار المبيعات) — auto-derived by a DB trigger from
  the latest follow-up's `sales_rep`
- `next_followup_id`, `next_action_type`, `next_action_due_at` — derived from the earliest
  open follow-up by a SECURITY DEFINER Postgres trigger
- `last_activity_at`, `lifecycle_health` (on_track / overdue / no_next_action / closed)
- `lost_reason` (10 options) + `lost_at`

**Client Property Options (separate store, `client_property_options`):** every property
option ever surfaced for a client (project / unit / market listing), with status
(suitable / main_focus / presented / interested / not_interested / eliminated / reserved
/ closed), match_score, added_from (project_finder / manual / follow_up), and a
snapshotted facts object (city/district/price/area/beds/baths). Eliminated options are
never silently reactivated — reactivation is an explicit action. This is deliberately
separate from preference INPUTS.

**Client 360 cockpit UI:** 8 KPI tiles (next action due, last activity, counts of
follow-ups/visits/appointments/calls, latest visit rating, health) + 8 tabs: Overview,
Preferences (inline-editable), Options, Timeline, WhatsApp, Calls, Related Records
(one table per model referencing this client), Sales Notes/Lifecycle. The clients list
is a cockpit too: 9 KPI cards, view presets (Sales Queue / All / At Risk / Closed-Lost),
rich filter bar.

**Virtual history sections:** `whatsapp_history` and `call_history` render live from
`chat_messages` / `call_logs` matched by phone — nothing stored on the client.

---

## 4. The Follow-Ups model + Follow-up Workspace

Follow-ups are THE task record of the sales process.

**Key fields:** `client_id` (required lookup), `appointment_id` / `visit` (contextual
lookups), mirror fields (client_name, client_phone, appointment_date…),
`scheduled_datetime` (due date — required), `sales_rep` (assignee), `followup_number`
(attempt count), `followup_status` (open / in_progress / completed / cancelled /
skipped), `priority`.

**`followup_type` is a section-selector** — a special field type unique to this CRM
that controls which form sections render. The 10 live types:

1. `appointment_booking_call` — book a project visit
2. `appointment_confirmation_call` — confirm attendance (day-before + day-of)
3. `same_day_appointment_confirmation` — same-day WhatsApp reminder
4. `no_show_recovery_call` — after a missed appointment
5. `follow_up_call_after_visit` — post-visit call
6. `whatsapp_follow_up` — two-phase WhatsApp (send → wait → record reply)
7. `offer_follow_up` — chase the quote
8. `reservation_payment_follow_up` — collect booking payment
9. `financing_follow_up` — track bank progress
10. `ownership_transfer_follow_up` — deed transfer chase

**Outcome section:** `call_result` (~25 outcomes: interested, not_interested, no_answer,
wrong_time, appointment_booked, rescheduled, offer_accepted, offer_rejected,
family_discussion, needs_financing_info, recontact_later, requested_another_visit,
visited_other_project, invalid_number, …), `outcome_notes`, `actual_datetime`,
`lost_reason`, `new_appointment_datetime`, `reschedule_contact_date`, plus evidence
links `completed_by_call_id` (→ phone_calls) and `completed_by_chat_id` (→ chats), and
stage/status snapshots for audit.

**WhatsApp two-phase mechanics:** sending a WhatsApp does NOT complete the task. It sets
`whatsapp_state = message_sent_waiting_response`, `followup_status = in_progress`, and
repurposes `scheduled_datetime` as the escalation deadline (attempt 1 → +24h; attempt 2 →
day 5 from first send). When the customer replies, the rep records the response outcome.
If they never reply, a server cron escalation fires (see workflows below).

**The Follow-up Workspace** (replaces the generic form for reps):
- **Mission header** — bilingual objective ("حجز زيارة مشروع"), client name+phone, attempt #.
  Objective text is manager-editable per type (Sales Manager page → `sales_process_overrides`).
- **Primary action** — Call or WhatsApp per the type's channel. WhatsApp opens the existing
  conversation inline (popup thread) or the composer pre-filled to start one.
- **Script panel** — call-guidance bullets, manager-editable per type (AR+EN).
- **Context panel** — client preferences inline (editable mid-call, save + "Edit Full
  Preferences" modal), recent-activity timeline, type-relevant context blocks.
- **"المشاريع المقترحة / Suggested Projects" button** — opens the Project Finder seeded
  with the live preference draft (section 6).
- **Register Visit** — evidence capture ("the client says they already visited"): opens a
  pre-filled Visits form with a same-day duplicate guard; the visit fires the normal
  after-visit workflow; the follow-up outcome stays whatever the rep picks.
- **Outcome panel** — tone-colored outcome buttons (green/gold/red), only the outcomes
  allowed for that type; picking one reveals exactly the fields it needs; live validation
  (hard errors block, warnings overridable); a **"what will happen" preview** forecasts
  the workflow's move in plain language.
- **Appointment-booked special case** — requires creating a REAL appointment record
  (button opens pre-filled form; id stamped back). The Appointment-Created workflow owns
  the client move, so the client only advances when the appointment truly exists.
- **Complete & Save** — stamps outcome + completion, fires the bound lifecycle workflow,
  returns the rep to the queue with filters preserved.

---

## 5. WhatsApp chats + phone calls

### WhatsApp (the `chats` model + Haberchat gateway)

- All WhatsApp traffic runs through **Haberchat** (a Wassenger whitelabel). Serverless
  proxies keep the API token server-side. Multiple WhatsApp numbers/devices supported,
  with a default device and a per-send device picker.
- **Two-pane UI:** conversation list (tabs: All / Clients / Advertisers / Other) +
  message thread with composer. Realtime: inbound webhook → `chat_messages` table →
  Supabase Realtime pushes to every open browser instantly. Outbound is optimistic with
  ack progression (sent → delivered → read).
- **Chat↔client matching:** phones are canonicalized to KSA E.164 (`ksa_phone_canon`
  handles 05…, +966…, 00966…, bare 9-digit) and matched to client records; self-healing
  (a chat linked to a deleted client re-links to a new client with the same phone).
  Client rows show **preference chips** (unit types, area range, one location chip) so
  the rep sees what the client wants while chatting.
- **Status:** Active / Resolved / Archived, with a one-click **Done** button (→ resolved,
  moved to the Closed filter). A customer message in a closed chat auto-reopens it.
- **Start-new-chat:** search existing clients (full record-search engine) or type a
  number manually (with "matches saved client" detection). Media/files up to 10 MB.
- **Advertisers tab:** chats whose phone matches an `advertisers` record — these come
  from the REGA license lookup on market listings ("التواصل مع المعلن" scrapes the
  advertiser's phone from their public REGA license, then opens an in-app WhatsApp chat).

### Chat templates (`chat_templates`)

Two categories, filterable in the picker (which is available in open chats AND
start-new-chat, with inline template creation):

- **Project messages (رسائل المشاريع)** — bulk-generated from `our_projects`:
  deterministic bilingual body (project name, unit types, city/district, bed/bath ranges,
  area, "prices start from", and a website link `wassel.re/project?id=…#units`); missing
  fields are omitted, never faked. Templates carry the project's gallery images which
  **fan out as separate WhatsApp image messages** after the text.
- **Listing messages** — generated per `market_listings` record: Claude writes a grounded
  bilingual message from the listing's facts, and each listing photo is **cleaned by an
  image model** (removes agency banners/watermarks/CTAs) via the background worker.
  Approved templates are named `@<aqar-ad-id>` (searchable), linked to the listing, and
  the cleaned photos are sent with the message.
- **Contact messages (رسائل التواصل)** — greetings, reminders, check-ins.

### Phone calls (Hatif integration, `phone_calls` model)

- Every call on a Hatif channel posts a webhook → written to `call_logs` (rich: word-level
  transcript, evaluation, raw event) AND to a lightweight `phone_calls` CRM record
  (direction, status, duration, sentiment, AI summary, recording URL with inline player,
  transcript, DTMF digit).
- **Auto-linking:** customer phone canonicalized → client matched; Hatif agent matched to
  a CRM user by email/name.
- **Call ↔ follow-up evidence:** the Workspace outcome panel auto-suggests the client's
  recent outbound calls as completion evidence (`completed_by_call_id`); a DB trigger
  also links late-arriving recordings to the closest completed call follow-up within 2h —
  the relationship forms regardless of order.
- **Outbound IVR:** a workflow action can place an automated Hatif call (TTS with field
  tokens or uploaded audio, DTMF menu); the chosen digit lands back on the call record.
- Limitation: no click-to-bridge live calling — the Call button is a `tel:` link.

### AI sales agent (`ai_chats`) — RETIRED

A conversational Claude agent (search projects, answer questions, capture leads) exists
but is unwired behind a `PROJECT_FINDER_ONLY` flag. The deterministic Project Finder
replaced it as the live matching tool. Code/data intact; one flag flip restores it.

---

## 6. The Project Finder (project matching) + client preferences

**What it is:** a deterministic, geography-verified matching engine — no AI in scoring.
Three surfaces:
1. **Follow-up Workspace** — "Suggested Projects" seeded with the live preference draft.
2. **Standalone `/project-finder`** — ad-hoc discovery ("what do we have in الملقا under 2M?"), details-only cards.
3. **Client 360 → Options tab** — everything ever saved for the client, with statuses and actions.

**Scoring (`scoreProject`, weights sum to 100):**
location 30 · budget 25 · unit type 20 · area 10 · bedrooms 8 · bathrooms 6 ·
availability 5 · amenities 2.

- Only dimensions the client requested count — BUT a requested dimension the project has
  NO data for keeps full weight and earns ZERO (the "honesty rule": data-poor listings
  can't inflate to Strong by renormalization).
- Bands: **Strong ≥75, Good ≥60, Partial <60**; a wrong-unit-type project is hard-capped
  to Partial.
- **Geo gate:** selected districts are a HARD pre-filter, verified by PostGIS
  point-in-polygon against 3,732 official SPL district boundaries. Geo confidence
  (high/medium/low) is shown; distance is measured to the nearest selected district
  centroid or landmark anchor.
- **Grouping is location-centric only:** exact district → nearby (≤12 km, distance-scored)
  → same city → broader. Within a group: score desc → listing quality_score desc
  (tiebreak ONLY, never affects ranking otherwise) → price/m² asc. Our own portfolio
  (`our_projects`, score ≥70) is pinned to the top of every group.
- **Sources:** our_projects + all_projects by default; the 46k-listing `market_listings`
  (Aqar import) is opt-in, scoped to requested districts, DB-pre-filtered, and returns a
  loud `too_many` signal (asking for more criteria) instead of ever truncating.

**Cards show:** source badge, score+band, distance ("~4.2 كم من النرجس"), facts grid,
data-gap flags, market-intelligence deal badge ("Strong value −18%" etc. — decision
support, non-ranking), Details, and Contact-advertiser (market listings).

**Rep actions:** inline status dropdown (one-click save to the client's options),
bulk-select + save, eliminate-with-reason (modal, notes required), map view (branded
Google basemap with clustered pins), refinement toolbar (score slider 70–100, sort,
hard post-filters), and **edit preferences + re-run** (persists the edits to the client,
then re-matches).

---

## 7. Workflow automations (the engine + the 19 live workflows)

### Engine capabilities

- **Triggers:** on_create, on_update, on_delete, webhook, button_click (all client-side,
  fire synchronously after save) + **on_due** (server-side Vercel cron: every 5 min for
  follow-ups, every 30 min for appointment no-shows, Riyadh-local time math).
- **Branches:** IF / ELSE-IF / OTHERWISE, evaluated top-to-bottom, first match wins.
  Conditions support AND/OR mode and "only on change" (fires only on false→true
  transition). Edited on a React Flow canvas.
- **Actions:** update_record (any record in any model, with dedup keys), create_record
  (with skip-if-exists), send_notification, send_whatsapp_message, assign_user
  (static / by role / dynamic), http_request, outbound_ivr. Value sources include
  trigger fields, date expressions (`+2d @10:00`), and formulas (IF/CONCAT/DAYS/…).
- **Safety:** server-side create is atomic + idempotent; on_due updates use optimistic
  concurrency so a human edit is never overridden; recursion depth capped at 3;
  every run logged with full traces (500-run retention, admin-only at /workflow/logs).
- A server-authoritative runner exists but is **inert** (enrollment allowlist empty) —
  everything except on_due currently fires in the browser. Consequence worth knowing:
  client-side workflows do NOT fire on direct DB writes.

### The live catalog (17 active, 2 disabled), by pipeline stage

**New lead**
- **W1 First Follow-up** (create on clients): new client in stage New → creates booking-call
  follow-up #1, assigned to a static rep. *Known issue: the schedule expression has no
  time-of-day (`+0d` with blank time).*
- *Welcome new contact via WhatsApp* (create on contacts) — INACTIVE test artifact.

**Booking-call loop**
- **W2 Booking Call Completed** (update on followups): branches — no-answer (<10 attempts →
  next call +1, client "No response"), interested (→ WhatsApp follow-up), wrong time
  (reschedule), not interested (→ Unqualified/Not Interested), plus an escalation leg
  that re-enters the WhatsApp loop after a day-5 escalation call goes unanswered.

**Appointment + visit**
- **W3 Appointment booked via call** (create on appointments): client → موعد زيارة, sends
  WhatsApp with project name/location, creates TWO confirmation follow-ups (day-before +
  day-of 10:00).
- **W4 Confirmation Completed** (update on followups): 7 branches — confirmed, no-answer
  (WhatsApp reminder), rescheduled (moves appointment + new confirmation), cancelled-rebook,
  cancelled-lost, wrong-time, not-interested.
- **Auto-close appointment as No-Show after 24h** (on_due on appointments): 24h past
  appointment_date and still open → status no_show + recovery follow-up (version-guarded;
  human edits win).
- **W5 No-Show Recovery** (update on appointments → no_show): same recovery actions for a
  manual no-show flag.
- **W6 Visit → After-Visit** (create on visits): client → زيارة, creates after-visit call
  (+1d 10:00, assigned to the visit's rep), and arms the **visit-rating timer**.
- **W7 After-Visit Completed** (update on followups): 7+ branches — request offer,
  still interested (+2d), needs financing info (+2d), family discussion (+3d),
  not interested (lost), no answer (+1d, capped → terminal "تعذّر التواصل"), wrong time,
  requested another visit (re-enter booking), visited other project (at-risk, requires
  notes, NOT auto-lost), recontact later, invalid number (terminal).

**Offer**
- **W8 Offer Created** (create on offer_prices): client → عرض سعر / "quote sent",
  offer follow-up +1d 10:00.
- **W9 Offer Follow-up Completed**: accepted (→ حجز, reservation-payment follow-up),
  waiting decision (+2d), needs financing info (+2d), rejected (lost + reason),
  no answer (+1d), wrong time (reschedule).

**Reservation → financing → transfer**
- **W10 Reservation Created** (create on reservations): client → تمويل / "reserved",
  financing follow-up +1d.
- **W11 Financing Status Updated** (update on financing, only-on-change): bank_submitted →
  status "البنك"; valuation → "التقييم"; completed → stage الإفراغ + ownership-transfer
  follow-up.
- **W12 Ownership Transfer Completed** (update on ownership_transfer → completed): client →
  **مغلق ناجح (Closed Won)**.

**WhatsApp cadence + escalation**
- **WhatsApp Response Completed** (update on followups): records the customer's reply —
  interested (new WhatsApp +5d), request offer, wrong time / recontact later (reschedule),
  not interested (lost).
- **WhatsApp No-Response Escalation** (on_due, server): 24h silence → WhatsApp attempt #2;
  day-5 silence → escalation booking CALL. Closes the waiting follow-up via its
  self-stamped `source_followup_id`.

**Misc**
- **Apology WhatsApp on missed call** (create on phone_calls): inbound missed/no-answer →
  automatic apology message.
- **Send Visit Rating** (on_due on followups): ~2h after a visit, WhatsApps the client a
  public no-login rating link `app.wassel.re/rate/{token}` → 5-star page → score lands on
  the visit + mirrored to the client. (Created inactive, gated on frontend deploy.)
- **Targeted Projects** (update on all_projects, marketing group): is_targeted flips true →
  creates a targeted_projects record (deduped) + sets project study status.
- *Workflow "1"* — INACTIVE, legacy flat-shape, broken references (unknown fields, blank
  notification). Candidate for deletion.

---

## 8. Rep & manager surfaces

- **Sales Queue** (`/sales/tasks`): 9 views (My Tasks, Due Now, Overdue, Today, Tomorrow,
  Waiting for Customer, High Priority, No Owner, Completed), live SLA computation, and a
  **"No Next Action" audit** (active clients with no open follow-up — headline target
  is zero). One-tap call/WhatsApp per row.
- **Sales Rep Workspace** (profile-assignable): **My Clients** (tabs: All, Interested,
  Serious, Active, Late, Unqualified/Inactive; per-client card with health, rating stars,
  next follow-up, related-record counts, quick actions) and **My Tasks** (today's
  follow-ups split Calls vs Conversations, late ones, other tasks). Reps see only their
  own; managers see all + per-rep filter.
- **Sales Process Studio** (`/sales/process`, admin, read-only): visual lifecycle map —
  per-stage client counts, overdue counts, linked/missing workflows, per-activity outcome
  maps with stage/status previews, and time-based automations per stage. A map, not an
  editor.
- **Sales Manager** (`/sales/manager`, admin): headlines (No-Next-Action count, overdue /
  open / completed, booking-call no-answer rate, on-time completion rate), pipeline
  funnel, outcome breakdown, lost-reason breakdown, per-rep table, and the **Follow-up
  Instructions editor** (per-type Goal + Call Guidance, AR/EN → live in every rep's
  Workspace immediately).

---

## 9. Quality & coaching loop

### Sales Valuation (تقييم المبيعات)
Five models + DB triggers (live since 2026-06-23, pausable via settings):

- When a follow-up completes, a trigger creates a **review** if criteria match: high-risk
  outcomes, manager-selected call results, missing next step, deterministic system flags
  (notes <15 chars, no next step, result-vs-notes mismatch, unregistered visit, late
  completion), random sample %, or review-all override.
- Manager reviews with full context (live follow-up data, client preferences, expandable
  call history with recording + transcript + AI summary). Mistake entry is two fields:
  **classification** (13 seeded categories with score deductions) + **coaching notes**
  (plus optional recorded voice note). Scores: correct 100 / minor 85 / major 65 /
  critical 40, or 100 − category deduction.
- A mistake auto-creates a **correction task** due next business day; rep completes,
  manager approves; reps can dispute. Per-rep **daily coaching summaries** roll up
  automatically. Two dashboards (manager + rep). Playlist navigation (prev/next through
  the filtered queue, save auto-advances). Retroactive backfill + prune actions in
  settings.

### Visit rating
Visit registered → 2h timer → WhatsApp with a public 5-star rating link (no login, no
personal data shown) → score on the visit, mirrored to `clients.latest_visit_rating`,
surfaced in the 360, lists, and dashboards.

---

## 10. Known gaps / improvement hooks (honest list)

1. **W1 scheduling bug:** first follow-up date expression has no time-of-day; also assigns
   to one hardcoded rep UUID rather than round-robin/rules.
2. **Workflow "1"** is broken/stale (unknown-field references) — should be deleted.
3. **Templating in W3's WhatsApp body** (`{project_id.project_name}` etc.) should be
   verified as actually resolving at send time.
4. **No group/channel WhatsApp sending** (composer disabled for groups).
5. **No click-to-call bridge** — only `tel:` links + automated IVR.
6. **AI sales agent retired** — conversational automation is dormant by choice; the
   deterministic finder is the live tool.
7. **Client-side execution:** most workflows fire in the browser — they do NOT fire on
   direct DB writes/imports; the server runner exists but is not enrolled.
8. **"Incomplete Client Preferences"** block in My Tasks is a placeholder (logic deferred).
9. **Auto-ID race** (known, unfixed): concurrent saves can duplicate auto IDs.
10. Chat **labels** exist in data but have no editing UI (removed intentionally).

---

## 11. Where things live (for engineers)

- Models are JSONB schemas in Supabase `models`; records in `records` (some frozen to
  typed tables). Generated per-model/per-workflow PRDs: `docs/prd/models/`,
  `docs/prd/workflows/`. Hand-written PRDs: `docs/prd/` (sales-process.md,
  followups-workspace.md, clients.md, chats.md, project-matching-assistant.md,
  workflow-automation.md, sales-rep-workspace.md, sales-valuation.md, visit-rating.md).
- Matching engine: `api/_lib/matchAgent.ts` (`scoreProject`), geo: `geoMatch.ts` + PostGIS RPCs.
- Workflow engine: client store engine + `api/_lib/workflowSweeper.ts` (on_due cron).
- WhatsApp: `api/haberchat/*` proxies, `chat_messages` table, Realtime.
- Calls: Hatif webhook → `call_logs` + `phone_calls`.
