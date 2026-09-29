# Lead-portal registration

**Last updated:** 2026-09-29 (**developer first**: when we deal with a project's developer directly, marketer portals are skipped — in the rep's list and in automatic registration; see "Developer first"). 2026-09-29 (**a project can have several marketers**: a portal / officer tied to a marketer now covers a project when that marketer is ANY of the project's marketers, and the `marketer` fields on portals and officers pick from the one Companies list (the old Marketers list is retired). 2026-09-29 (**Riva status check**: `collect_rows` gained `source:"table"` (plain HTML tables, walks `?page=N` until empty/repeated) and Riva got a `status_recipe` over «طلباتي». Fixed: `{{page}}` was blanked by the template renderer before substitution, so multi-page lists re-read page 1). 2026-09-29 (**Per-client portal registrations, managed like client options**: a registration is no longer a one-off run. `client_portal_registrations` keeps ONE row per (client, portal) with our status (not registered / registering / registered / another broker's / failed) and the portal's own status (verbatim, e.g. «جديد»), the portal ref, projects, dates, notes and a history (`client_portal_registration_events`). Kept current by a trigger on every run, by a **daily 12:00 status check** (`portal_registration_jobs.kind='status_check'` + the portal's `status_recipe`, one code via the ops-WhatsApp relay refreshes every client in that portal) and by manual edits on the client's new «البوابات» tab. A portal-status CHANGE alerts the client's rep (Web Push + an ops-line WhatsApp to the rep's `users.phone`). See "Per-client registrations" below). 2026-09-29 (**«already registered by another broker» is an answer, not a failure**: new terminal status `already_registered` — a recipe `fail` step with `"outcome":"already_registered"` ends the run there; the chat card shows it sky-blue «مسجّل لدى وسيط آخر» with no retry button and warns before a new attempt, the client's activity timeline gets a line, and the ops WhatsApp says «ℹ️ … لن تُعاد المحاولة». Migration `2026-09-29_portal_job_already_registered.sql`. Same day, data only: **Al Ramz redesigned their portal** — recipe rewritten for the new form (required «الوقت المناسب للتواصل» calendar = today 09:32; `#client-*` ids; sign-in waits on `input.otp-input` instead of the URL); old recipe kept as `recipe_prev_2026_09_28`. Also: **late code replies now actually restart the run**: an unanswered code request FAILED the run instead of parking it, because the recipe engine wrapped the timeout; fixed — see step 3 of "WhatsApp code relay"). 2026-09-28 (**no-owner leads are now visible**: an ad lead with no sales rep used to be skipped by the auto-register sweep with only a server log line — nothing in the client's history. It now leaves a `failed` marker row that still lets the run happen once a rep is assigned; see "Owner" under Automatic registration. Same day, data only: Al Ramz's project field now defaults to «تل الربوة 1» for projects not on its 4-item list, and the notes field carries the client's real project name — that is how Al Ramz takes leads for its other projects). 2026-09-24 (**short-name fallback**: a field can declare `min_length` + `fallback_source`; Riva's name uses the client's phone number when the saved name is under 3 characters, because Riva rejects it — «The name field must be at least 3 characters.». Same day: **WhatsApp code relay**: a portal that signs in with an SMS code can now auto-register too — the ops WhatsApp asks the sign-in phone's owner for the code, their reply finishes the run, and a late reply (hours later) restarts it with a fresh code; Al Ramz switched on. See "WhatsApp code relay" below). 2026-09-23 (**automatic registration of ad leads**: a portal with `auto_register` on — Riva today — gets every client whose ad was for a project it covers, with no button press; see "Automatic registration" below). Earlier: 2026-09-14 (initial — model, queue, worker lane, API, in-chat modal, recipe language. Same day: **three real portals configured**. **Riva** (`riva.sa/broker`, email + password, no OTP) → marketer «ريفا». **Al Ramz** (`brokerportal.alramzre.com`, phone + 6-box SMS OTP) → developer «الرمز», OTP handshake verified end-to-end through the real engine. **Safa / Kasb** (`broker.safainv.sa`, phone + 4-box SMS OTP, a Select2 "create opportunity" modal) → developer «صفا للاستثمار», every step verified live in a real session. Field specs gained `hidden`, `map`, `default`; targets gained `exact`; filters `ksa_short`; steps `fill_otp` (segmented OTP) and `screenshot.full`.)

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

**Automatic registration (2026-09-23).** A portal that signs in without a code
can also run with nobody pressing the button. When its **Auto-register ad leads**
switch («تسجيل عملاء الإعلانات تلقائياً») is on, every client who arrives from an
ad whose campaign is for a project that portal covers is registered in it within
~5 minutes. "Which ad, which project" is the same information the client
profile's acquisition panel shows. Riva is switched on: leads from the يمام 17 and
أكنان 25 campaigns go straight into the Riva broker portal.

## Key behaviors

- **Automatic registration of ad leads.** `/api/cron/portal-auto-register` runs
  every 5 minutes. It reads `portal_auto_register_candidates(since)`: ad touches
  (`client_attributions_effective`) created in the last 3 hours, each with the
  project resolved through ad → execution → campaign → project, the same chain as
  `mos_client_acquisition`. For each, it resolves the covering portals with the
  button's own coverage rule and field prefill (`api/_lib/leadPortals.ts`) and
  enqueues one job (`origin='auto'`, `attribution_id` set) for each portal whose
  `auto_register` is on. Rules:
  - **One attempt per (client, portal), ever.** Any existing job for the pair
    (manual or auto, any status) means the sweep leaves it alone. A failed auto
    run shows in the client's history, and a rep retries it from the button.
  - **A portal that needs a code runs only with the WhatsApp code relay on**
    (`otp_whatsapp_relay`). Without it, a portal whose `otp_channel` is not
    `none` is skipped even if switched on, and the skip is logged.
  - **While a relay portal has a parked run**, new auto runs for it are parked
    on arrival, so an absent phone owner is not pinged once per lead.
  - **A missing required field is a visible failure, not a silent skip.** It
    writes a `failed` job naming the fields, e.g. a client with no phone.
  - **Owner** = the client's `client_owner`, as if they had pressed the button.
    If the client has no owner yet, the CRM user whose email is the portal's
    `login_email` owns the run. **If neither exists, that is a visible failure
    too:** the sweep writes ONE `failed` row (no `user_id`,
    `result.skip_reason='no_owner'`) reading «لا يوجد مندوب مسؤول عن العميل».
    It is a marker, not an attempt: if a rep is assigned within the 3-hour
    window, the next tick registers the client for real. (A table CHECK allows
    an empty `user_id` only on this marker; every real run still needs one.)
  - **No back-fill.** Only touches from the last 3 hours are read, so switching a
    portal on does not register its whole back-catalogue of old leads.
  - Fields are sent exactly as the modal prefills them with no rep edits
    (e.g. Riva's property type = the project's first unit type).
  - The modal's history marks these runs «تلقائي من الإعلان» / "Auto from ad".

- **Entry point.** `ChatDetail` → CRM actions → «تسجيل في البوابة». Shown only when
  the chat is linked to a client (the button is in the linked-client branch,
  beside Notify officer).
- **Portal coverage** for a project P, best first: P listed in the portal's
  `projects` → one of the portal's `officers` covers P (same officer-coverage
  rule as Notify officer) → portal's `developer` = P's developer → portal's
  `marketer` is one of P's marketers (a project can have several since
  2026-09-29). Inactive portals are never offered.
- **Developer first (2026-09-29).** When we have a DIRECT relationship with the
  project's developer — the developer has a portal of its own, or an officer on
  the developer's side covers the project — the client goes to the developer
  only: every portal reached through a marketer (the marketer's own portal, or a
  portal tied to a marketer-side officer) is dropped, from the rep's list AND
  from automatic registration. A marketer's portal is used only when we have no
  direct line to the developer. A portal that explicitly lists the project is
  always kept. This is the same rule Notify officer already follows. Why: a
  project's marketers list records who markets it (Competitor Watch); listing
  Riva on an Al Ramz project must never register the lead with Riva instead of,
  or as well as, Al Ramz. `pickPortals` in `api/_lib/leadPortals.ts`. A portal whose
  recipe is missing/invalid is listed but greyed («بدون أتمتة») with the parse
  error, so the admin knows what to fix.
- **Customer fields** come from the portal's `required_fields` JSON (defaults:
  name + phone). Values prefill from `client.<slug>` / `project.<slug>` /
  `user.name|email|phone` / `literal:` (multiselects → first value, ranges →
  "min - max"), then `map` translates them into the portal's wording and
  `default` fills gaps. A field with `min_length` + `fallback_source` swaps in
  the fallback when the value is too short (Riva: a name under 3 characters
  → the client's phone as 05XXXXXXXX). `hidden` fields are sent without being shown (a grey
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

- **WhatsApp code relay (2026-09-24).** For auto runs of a portal with
  **Ask for the code on the ops WhatsApp** (`otp_whatsapp_relay`) ticked:
  1. At the `request_input` step, the operations number (`whatsapp_numbers.is_operations`)
     WhatsApps the relay phone (`otp_relay_phone`, default the sign-in phone):
     «وصلك الآن رمز تحقق من … لتسجيل العميل … أرسل لي الرمز هنا».
  2. The owner replies with the code (a bare code, Arabic digits, or the whole
     forwarded SMS all work). `/api/webhook/waha` → `portal_otp_relay_inbound`
     writes it onto the waiting job, and the worker types it in. A reply with no
     digits gets «أرسل أرقام رمز التحقق فقط».
  3. **No code within the step's wait (5 min, the code expires anyway):** the run
     is **parked**, not failed. The browser closes, the job goes back to `queued`
     with `parked_at` set, and the ops number says «انتهت صلاحية الرمز … أرسل لي
     أي رسالة متى ما كنت متاحاً».
     (Until 2026-09-29 this never happened: the recipe engine wrapped the
     timeout into a generic «فشلت الخطوة 4» error, so the run FAILED with
     «otp relay wait timed out» and a late reply restarted nothing. The timeout
     is now a `RecipeInterrupt`, which `stepError` passes through unwrapped;
     regression test in `worker/src/portals/__tests__/recipe.test.ts`.)
  4. **Any later message from that phone** (1 hour, 8 hours later) un-parks every
     parked run of that portal. The worker signs in again, so a **new** code is
     texted, and the owner is told «طلبت الآن رمزاً جديداً». Back to step 2.
  5. The outcome is WhatsApped too: «✅ تم تسجيل العميل …» or «❌ تعذّر … : reason».
  - **One live run per portal** (`claim_next`): the sign-in phone only ever has
    one code outstanding, so an inbound code can never go to the wrong client.
    Queued runs for the same portal wait their turn.
  - Parked runs are skipped by `claim_next` and by the 30-minute "nobody claimed
    it" watchdog. They fail after **7 days** without a reply, or after **8**
    sign-in attempts.
  - A rep pressing «التسجيل في البوابة» for a client whose auto run is parked
    un-parks it (the rep can type the code in the modal as usual).
  - Manual runs never use the relay; the modal is the only code path for them.

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
3. **Turn on automatic registration for a portal (admin).** Open the portal record
   → tick **Auto-register ad leads**. For a portal with an SMS code, also tick
   **Ask for the code on the ops WhatsApp** (and optionally set the WhatsApp that
   receives the codes); otherwise it only applies to portals with OTP channel
   «بدون رمز» (None). From then on, new ad leads for covered projects are
   registered within ~5 minutes. Check the client's portal history in the chat
   modal to see each run.
4. **Fix a broken run.** Open the failed run's screenshots in the modal (or the
   `portal_registration_jobs` row), adjust the recipe on the portal record, «حاول
   مرة أخرى».

## Data touched

- `models` row `lead_portals` (fixed id `1ead0000-0000-4000-8000-000000000001`),
  records in `records`. Fields: `name`, `login_url`, `developer` (lookup),
  `marketer` (lookup → the Companies list, model slug `developers`), `officers` (multi lookup → project_officers), `projects`
  (multi lookup → all_projects), `is_active`, `notes`, `login_phone`,
  `login_email`, `login_password`, `otp_channel`, `required_fields` (JSON text),
  `recipe` (JSON text), `auto_register` (checkbox, 2026-09-23).
- `portal_registration_jobs` — queue + live state (status, phase_ar/en, lead_data,
  login_phone, input_request/input_value, browserbase_session_id, live_view_url,
  screenshots[], result, error_message, heartbeat_at). Realtime-published; RLS
  owner SELECT; all writes via service-role RPCs (`portal_registration_job_*`:
  enqueue, claim_next, progress, session, heartbeat, request_input,
  submit_input, resume, cancel, complete, fail, `portal_registration_jobs_watchdog`).
- `portal_auto_register_candidates(p_since)` — service-role-only SQL function
  that lists recent ad touches with their project. Reads `client_attributions_effective`,
  `mos_execution_ads`, `mos_campaign_executions`, `mos_campaigns`.
- Storage bucket `portal-registrations` (private; signed URLs from the API).
- `activity_log` — `portal_lead_registered` on success (category `record`,
  target = the client).

## Per-client registrations («البوابات» tab) — added 2026-09-29

- **One row per client per portal** (`client_portal_registrations`), backfilled from every run on file. Two statuses: **our status** (`not_registered` / `registering` / `registered` / `already_registered` / `failed`) and the **portal status** exactly as the portal writes it (`portal_status` label + `portal_status_code`). Also `portal_ref` (Al Ramz «#14157»), `project_names` (ours) vs `registered_as` (what the portal was told, e.g. «تل الربوة 1» for ريا النخيل), `registered_at`, `registered_via` (auto / manual_run / manual_entry / portal_sync), `last_checked_at`, `notes`.
- **Runs update it by trigger** (`portal_jobs_sync_registration`): queued/running → registering; done → registered; already_registered; failed; a new attempt never downgrades a registered client. Every terminal run adds a history line.
- **Status check** = a `portal_registration_jobs` row with `kind='status_check'` and no client, on the same queue (so claim_next's one-live-run-per-portal keeps ONE code outstanding, and park/restart-on-reply works unchanged). The worker replays the portal's `status_recipe` (sign-in + `collect_rows`), then `portal_status_sync_apply()` matches the rows by canonical phone: refreshes status/ref, flips a listed client to registered, and CREATES rows for our clients found in the portal but never recorded. The ops WhatsApp reports «✅ فُحصت حالات … تغيّر منها N». One live check per portal (unique index).
- **Daily at 12:00 Riyadh** (`/api/cron/portal-status-sync`, 09:00 UTC) for every active portal with `status_sync_enabled` + `status_recipe` and at least one registered client; also on demand from «تحديث الحالات». Unanswered code → the check parks and restarts on the next reply, it does not nag.
- **Rep alert on a real change** (not the first reading): Web Push (`push_outbox`, kind `portal_status_change`, link `/model/clients/<id>?tab=portals`) + a WhatsApp from the operations line to the rep's `users.phone`. **Known gap (2026-09-29): no active user has `users.phone` set, so the WhatsApp leg sends nothing until reps' phones are filled in.**
- **Manual side:** edit our status / portal status / ref / notes (each edit is a history line), add a registration made outside the app, and a warning when a registered client was missing from the portal's list at the last check.
- **Status checks exist for Al Ramz** (Inertia JSON, needs a code) **and Riva** (its «طلباتي» Livewire table via `collect_rows` `source:"table"`, no code — runs unattended; statuses جديد / طلب مفتوح / مغلق / قائمة انتظار). Safa has no `status_recipe` yet — its portal status is edited by hand until one is written. Riva's `recipe` «بالفعل» refusal now ends with `outcome: already_registered` too.

## Key files

| Area | File |
|---|---|
| Per-client registrations (tables, run trigger, status-check queue + sync) | `supabase/migrations/2026-09-29_client_portal_registrations.sql` |
| Registrations API (list / edit / add / check now) | `api/_lib/portalRegistrations.ts`, `api/portal-registration.ts` |
| Daily 12:00 status check | `api/cron/portal-status-sync.ts` (+ `vercel.json` cron) |
| Status check in the worker (`collect_rows`, `kind='status_check'`) | `worker/src/portals/recipe.ts`, `worker/src/runPortalRegistrationJob.ts` |
| «البوابات» tab on the client | `src/pages/Clients/components/tabs/ClientPortalsTab.tsx`, `src/pages/Clients/ClientDetailPage.tsx` |
| Migration | `supabase/migrations/2026-09-14_06_lead_portals.sql` |
| API | `api/portal-registration.ts` (GET options/history/job, POST start/input/cancel) |
| Shared portal logic | `api/_lib/leadPortals.ts` — coverage, field parse/prefill, recipe check, worker wake (used by the button API AND the auto sweep) |
| Auto sweep | `api/cron/portal-auto-register.ts` (Vercel cron, every 5 min) + `supabase/migrations/2026-09-23_01_portal_auto_register.sql` |
| WhatsApp code relay | `supabase/migrations/2026-09-24_01_portal_otp_whatsapp_relay.sql` (park / inbound / notify RPCs, one-live-run claim), relay in `worker/src/runPortalRegistrationJob.ts`, inbound hook in `api/webhook/waha.ts` |
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
