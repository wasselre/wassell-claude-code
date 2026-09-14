# Lead-portal registration

**Last updated:** 2026-09-14 (initial — model, queue, worker lane, API, in-chat modal, recipe language. Same day: **three real portals configured**. **Riva** (`riva.sa/broker`, email + password, no OTP) → marketer «ريفا». **Al Ramz** (`brokerportal.alramzre.com`, phone + 6-box SMS OTP) → developer «الرمز», OTP handshake verified end-to-end through the real engine. **Safa / Kasb** (`broker.safainv.sa`, phone + 4-box SMS OTP, a Select2 "create opportunity" modal) → developer «صفا للاستثمار», every step verified live in a real session. Field specs gained `hidden`, `map`, `default`; targets gained `exact`; filters `ksa_short`; steps `fill_otp` (segmented OTP) and `screenshot.full`.)

## What it is

Some developers, marketers, and project officers run a **broker portal**: a website
where a broker must register an interested customer (name, phone, sometimes more)
so the broker is credited for the lead. Until now the rep only notified the
project's officer over WhatsApp ("Notify officer"); registering in the portal was
a manual, per-portal browser chore.

This feature makes it a button. Next to **Notify officer** in a chat there is
**Register in portal** («تسجيل في البوابة»). The rep picks the project, the app
lists the portals behind it, shows the customer fields that portal needs
(prefilled from the client record), and starts a run. A **Browserbase** browser on
the Fly worker signs in to the portal and fills the form by replaying that
portal's **recipe**. When the portal asks for a one-time code (most sign in by
phone + OTP), the modal asks the rep for it; the rep reads it off the sign-in
phone, types it, and the browser continues. The final screenshot is the proof.

Each portal is different, so each portal is **data**: one record in the
**Lead portals** model holding the login URL, who it covers, the sign-in phone,
the required customer fields, and the JSON recipe. Adding a portal is an edit in
the app, not a deploy. The recipe language is documented in
`docs/lead-portal-recipes.md`.

## Key behaviors

- **Entry point.** `ChatDetail` → CRM actions → «تسجيل في البوابة». Shown only when
  the chat is linked to a client (the button is in the linked-client branch,
  beside Notify officer).
- **Portal coverage** for a project P, best first: P listed in the portal's
  `projects` → one of the portal's `officers` covers P (same officer-coverage
  rule as Notify officer) → portal's `developer` = P's developer → portal's
  `marketer` = P's marketer. Inactive portals are never offered. A portal whose
  recipe is missing/invalid is listed but greyed («بدون أتمتة») with the parse
  error, so the admin knows what to fix.
- **Customer fields** come from the portal's `required_fields` JSON (defaults:
  name + phone). Values prefill from `client.<slug>` / `project.<slug>` /
  `user.name|email|phone` / `literal:` (multiselects → first value, ranges →
  "min - max"), then `map` translates them into the portal's wording and
  `default` fills gaps. `hidden` fields are sent without being shown (a grey
  line lists them); a hidden required field with no value blocks Start with
  "missing on the client record". The sign-in phone (`login_phone`) is shown
  only for portals that sign in by phone.
- **Safa / Kasb (2026-09-14).** Sign-in by phone + a 4-box SMS OTP (boxes are
  `.otp__digit`; a hidden `otp-autofill` helper sits alongside, so the recipe
  targets the class, not `input[type=text]`). The rep sees only the notes field;
  name, phone, and project are sent silently. The project is Safa's «إنشاء فرصة
  جديدة» Select2 dropdown whose option values are numeric ids, so the field maps
  each CRM Safa project name to its id (all 12 map). Units are left empty. Every
  step was verified live (login, OTP, Select2 project pick, form fill); the
  assembled recipe was not run end-to-end through the engine and the submit is
  untested (option C). Note: Safa's login occasionally returns a transient
  "Server Error" on the first attempt, then succeeds.
- **Al Ramz (2026-09-14).** Sign-in by phone + a 6-box SMS OTP, so it exercises
  the full pause/resume handshake: the rep enters the code the portal texts to
  the stored sign-in phone. The rep sees 3 fields: project (Al Ramz's name,
  only 4 are open to brokers — ستون الندى / تل الربوة 1 / ربوة الرمز / ستون الملقا),
  unit type (from the project), notes. Sent silently: name, phone. The projects
  field is a multi-select custom dropdown (closed with Escape after picking).
  Verified end-to-end (login → OTP relayed via the job row → form filled)
  through the real worker code; the submit itself is untested (option C).
- **Riva (the first portal, 2026-09-14).** Sign-in by email + password from the
  record; no OTP. The rep sees 4 fields: project (Riva's name, mapped from ours,
  e.g. «إلوفي» → «إلوﭬي»), property type (from the project's unit types),
  purchase method (default financing), notes. Sent silently: name, phone (as
  `5XXXXXXXX` under the +966 selector), purpose (from `purchase_objective`,
  default residence), subsidy = «مدعوم». Budget, city, bank name and unit are
  left empty. Success check: the form disappears after «إرسال العميل» (a
  validation error keeps it visible → the run fails with the screenshot).
  Riva's form is Livewire — selectors target `wire:model` attributes with
  escaped `:` and `.`.
- **Duplicate guard.** The modal lists the client's earlier runs and warns when
  the same portal already has a `done` run for this client. The database also
  collapses a double-click into one job (one active job per client + portal).
- **The run** is a `portal_registration_jobs` row: `queued` → `running` →
  (`awaiting_input` ⇄ `running`)* → `done` | `failed` | `cancelled`. The modal
  follows it via Supabase Realtime (owner-only RLS) plus a 4-second poll that
  also brings signed screenshot URLs. Progress labels come from `phase` steps in
  the recipe.
- **OTP handshake.** A `request_input` step flips the job to `awaiting_input`
  with a bilingual prompt; the modal shows an input; the rep's answer is written
  to the row by the API (owner-gated RPC); the worker, polling its own row every
  1.5 s and heart-beating, consumes it and resumes. Default wait 5 minutes, then
  the run fails with «انتهت مهلة انتظار الرمز».
- **Live view.** The Browserbase live-view URL is written on the row and embedded
  as an iframe in the modal (toggle + open-in-window) so the rep can watch and,
  if a portal does something unexpected, take over.
- **Stop.** «إيقاف التسجيل» cancels the row; the worker notices between steps or
  in its OTP wait and closes the browser within seconds.
- **Evidence.** Every `screenshot` step, the step before each `request_input`,
  the final page on success, and the page on failure are saved to the private
  `portal-registrations` bucket under `<job id>/…`. On success the worker writes
  a `portal_lead_registered` activity-log line on the client.
- **Failures are bilingual.** Recipe errors are stored as `"<ar>\n<en>"`; the
  modal shows the line for the current language and offers «حاول مرة أخرى»
  (back to the form with the same values).
- **Watchdog.** A live job with no heartbeat for 5 minutes is failed (worker
  crash); a queued job nobody claims in 30 minutes is failed with a message
  naming the likely cause (the Browserbase lane is not enabled on the worker).
- **Safety posture.** No HTTP request is held open for the browser (enqueue +
  Realtime). The recipe vocabulary has no arbitrary JavaScript. Secrets are
  referenced (`{{portal.login_password}}`), never pasted into steps. Every run is
  started by a person for one client and can be stopped by that person.

## User flows

1. **Register a lead.** Chat with a linked client → «تسجيل في البوابة» → pick the
   project (prefilled when the client has exactly one preferred project) → pick
   the portal (auto-selected when one) → check the fields → «ابدأ التسجيل» →
   watch the phases / live view → when asked, type the OTP → «تم التسجيل» +
   screenshots → Close.
2. **Add a portal (admin).** Settings → **Lead portals** → new record → name,
   login URL, developer/marketer/officers/projects, sign-in phone, OTP channel,
   `required_fields` JSON, `recipe` JSON → Active. Test from a real chat; the
   failure screenshot names the step that broke.
3. **Fix a broken run.** Open the failed run's screenshots in the modal (or the
   `portal_registration_jobs` row), adjust the recipe on the portal record, «حاول
   مرة أخرى».

## Data touched

- `models` row `lead_portals` (fixed id `1ead0000-0000-4000-8000-000000000001`),
  records in `records`. Fields: `name`, `login_url`, `developer` (lookup),
  `marketer` (lookup), `officers` (multi lookup → project_officers), `projects`
  (multi lookup → all_projects), `is_active`, `notes`, `login_phone`,
  `login_email`, `login_password`, `otp_channel`, `required_fields` (JSON text),
  `recipe` (JSON text).
- `portal_registration_jobs` — queue + live state (status, phase_ar/en, lead_data,
  login_phone, input_request/input_value, browserbase_session_id, live_view_url,
  screenshots[], result, error_message, heartbeat_at). Realtime-published; RLS
  owner SELECT; all writes via service-role RPCs (`portal_registration_job_*`:
  enqueue, claim_next, progress, session, heartbeat, request_input,
  submit_input, resume, cancel, complete, fail, `portal_registration_jobs_watchdog`).
- Storage bucket `portal-registrations` (private; signed URLs from the API).
- `activity_log` — `portal_lead_registered` on success (category `record`,
  target = the client).

## Key files

| Area | File |
|---|---|
| Migration | `supabase/migrations/2026-09-14_06_lead_portals.sql` |
| API | `api/portal-registration.ts` (GET options/history/job, POST start/input/cancel) |
| Worker lane | `worker/src/runPortalRegistrationJob.ts` (+ `portalPollLoop` in `worker/src/index.ts`) |
| Recipe engine | `worker/src/portals/recipe.ts` — step vocabulary, templating, filters |
| Browser client | `src/lib/portalRegistration/client.ts` |
| Modal | `src/pages/Chats/components/RegisterLeadPortalModal.tsx` |
| Entry point | `src/pages/Chats/components/ChatDetail.tsx` (CrmActions «تسجيل في البوابة») |
| Admin entry | `src/pages/Settings/SettingsPage.tsx` → `/model/lead_portals` |
| Recipe docs | `docs/lead-portal-recipes.md` |

## Open items

- Worker needs `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` (already set for
  the REGA lane) — the portal lane shares the gate.
- Riva is configured and dry-run verified through the real engine up to the
  submit click; the submit itself has NOT been exercised (operator chose to let
  the first real registration be the proof). Saudi mobiles only for now (the
  +966 selector is left at its default).
- Password-based portals store the password on the portal record (visible to
  anyone with access to the model). If a portal needs a secret that must not be
  in a record, move it to a worker env var and reference it from a code adapter.
