# Spec: Binghatti weekly unit updates (broker portal → CRM)

**Written:** 2026-10-05 · **For:** an implementing agent (Codex) · **Owner:** operator (r.abanumay@wassel.re)

## 1. Goal

Binghatti (بن غاطي, Dubai) is our largest developer: **44 CRM projects, 4,795 units**
(2,778 شقة · 1,476 استوديو · 491 فيلا · 50 مكتب), all under developer
`759fa833-e60e-4775-86ab-292005c8d517`. They were imported once (2026-07/08) and have
**never been updated** — statuses are a stale snapshot (almost everything still says
`available`). Make them update **automatically every week** through the existing
automated project-update lane, exactly like Riva / Safa / Almajdiah / Menaco already do.

Done = a weekly scheduled run reads Binghatti's broker portal, updates status + price of
every Binghatti unit, adds newly released units, marks units gone from the portal as sold,
and every write is logged and revertable.

## 2. Read first (the system you are extending)

- `CLAUDE.md` → section **"Automated project updates (portals + developer WhatsApp groups)"**
  — hard rules 1–10. They are not optional. The ones that bite here:
  1. every write logged in `project_update_changes` (before/after) — revert must work;
  2. ONE reconciler (`worker/src/projectUpdates/reconcile.ts`); adapters only fetch + parse;
  5. the safety brake is not approval — never loosen `brake_share` to push a run through;
  8. **never create a unit without area, price, bedrooms AND unit type** — skip it and let
     the existing WhatsApp notice tell the operator (`result.incomplete`).
- PRD: `docs/prd/project-updates.md` (sources table, key behaviors).
- Code to copy from:
  - `worker/src/runProjectUpdateJob.ts` — `runPerProject()` + the `ProjectSourceAdapter`
    interface; see the `safa_broker` case (snapshot-from-portal + adapter) and `MENACO`.
  - `worker/src/projectUpdates/safa.ts` — `loadBrokerSnapshot()` (reads a file the portal job
    saved; freshness check), the closest model for Binghatti.
  - `worker/src/projectUpdates/apply.ts` — `applyResult()` (writes + change log + notices).
  - `worker/src/runPortalRegistrationJob.ts` + `worker/src/portals/recipe.ts` — Browserbase
    sessions, recipe steps, `request_input` (SMS code via WhatsApp relay), `saveItems`
    (uploads to `portal-registrations/inventory/<portal_record_id>/<key>.json`).
  - Docs for the recipe language: `docs/lead-portal-recipes.md`.
- Never raise SQLSTATE 40001/40P01; never swallow errors silently; apply your migrations to
  the live DB yourself (Supabase MCP, project `wassell-prod`) and verify them.

## 3. The source: `partners.binghatti.com` (verified 2026-08-07 by a logged-in session)

- ASP.NET, server-rendered, **login-gated**. Broker account name on the portal: "WASL".
- **Sign-in = user ID + SMS code + Google reCAPTCHA.** The SMS goes to the operator's phone.
- **Full available inventory as JSON:** the `/Properties` page carries an attribute
  `data-available-units-url`. GET that URL (same session cookies) →
  `{ data: { items, totalCount, pageNo, pageSize } }`, `pageSize` capped at **1000** → page
  until `items` collected == `totalCount`. On 2026-08-07: **4,815 units across 43 projects.**
- Each item: `{ id (unitId), projectId, number, code, unitTypeId, actualPrice, totalArea,
  netArea, bedroomsCount, floorNumber }`. Prices in **AED**.
- **The list holds AVAILABLE units only** (no status column). A unit missing from a complete
  list = sold/reserved → treat as `sold` (same posture as Safa's broker list).
- Per-unit detail page `/Properties/ProjectDetails?projectId=&unitId=&unitTypeId=` holds the
  unit's payment plans (`.pd-payment__card`). **Out of scope for v1** (thousands of requests,
  the portal rate-limits and froze a browser tab on 2026-08-07). Do not fetch detail pages in
  the weekly run.
- The public site `binghatti.com` is behind Cloudflare and its `/en/projects` prices are dead
  launch prices — never use it as a price source.

## 4. How CRM units map to the portal (verified against the live DB 2026-10-05)

- CRM unit field `developer_unit_code` = portal `code` (e.g. `BWRT-208`, `BURJ-8101`).
  **This is the match key.** Fallback: portal `number` ↔ CRM `unit_number` after stripping
  leading letters (`OF112` → `112`, `TA1106` → `1106`), only when unique on both sides
  (the reconciler already enforces uniqueness).
- Existing Binghatti unit fields: `total_price` (SAR), `source_price` (AED),
  `source_fx_rate`, `source_currency`, `unit_area`, `source_net_area`, `source_total_area`,
  `bedrooms`, `bathrooms`, `floor`, `source_floor`, `unit_type`, `source_unit_type`,
  `payment_plans`. **SAR = AED × 1.021103** (operator decision; keep BOTH: write
  `source_price` AED and `total_price` SAR together). Check which area the import stored
  in `unit_area` (Wraith `BWRT-208`: `unit_area` 56.09) against the portal's `netArea` /
  `totalArea` for the same unit before deciding — keep it consistent with the existing rows.
- Unit type: map `unitTypeId` → `شقة / استوديو / فيلا / مكتب` (+ `تاون هاوس`, `بنتهاوس`
  if they occur). The id→name table is NOT known yet — discover it on the first capture
  (the `/Properties` page filters, or by joining items to existing CRM units by code and
  reading their `unit_type`). A bedroom count of 0 is a studio. An unknown `unitTypeId`
  = missing type → the unit is NOT created (four-essentials rule).
- Project map: a 41-project portal `projectId` → CRM `all_projects` id map was built on
  2026-08-07 (Skyflame 1 & 2 → ONE CRM Skyflame; Flare 01 & 02 → ONE CRM Flare; DUSK and
  HAVEN exist only on the portal). Rebuild it by joining portal items to CRM units on
  `developer_unit_code`, then record it as `unit_updates` rows (§6). Portal-only projects
  are reported, never auto-created into Our Projects (CLAUDE.md rule 6).

## 5. Sign-in and capture (Browserbase)

### 5.1 Add the portal record (operator does this in the app)
A `lead_portals` record «بن غاطي — بوابة الوسطاء»: login URL, login ID, `otp_channel=sms`,
`otp_whatsapp_relay=true`, developer = Binghatti. **Credentials are entered by the operator,
never written into code, migrations or recipes** (recipes reference `{{portal.*}}`).

### 5.2 Keep the login: persistent Browserbase context (new)
Today every portal job opens a fresh session (`createSession()` in
`runPortalRegistrationJob.ts`) — Binghatti would then need an SMS code + CAPTCHA every run.
Add **per-portal persistent contexts**:
- `POST https://api.browserbase.com/v1/contexts` once per portal; store the context id on the
  `lead_portals` record (e.g. `browserbase_context_id`, system-managed).
- Create sessions with `browserSettings.context = { id, persist: true }`.
- A run first opens `/Properties`; if it lands on the login page, run the sign-in steps;
  otherwise skip them. Measure and record how long the login survives.
- Make it opt-in per portal (a flag on the record) so Riva/Safa/Al-Ramz are unchanged.

### 5.3 Sign-in steps
1. Fill the user ID (`{{portal.login_id}}`).
2. **CAPTCHA: completed by a person.** New `request_input` kind (e.g. `live_view`): the job
   goes to `awaiting_input`, and the WhatsApp relay sends the operator the session's live-view
   link (`liveViewUrl` is already created in `createSession()`) with "tick «I'm not a robot»".
   The worker waits (heart-beating, like the SMS wait) until the CAPTCHA widget reports solved
   or the page advances, then continues.
3. SMS code: the existing relay (`request_input` kind `otp` → WhatsApp → reply → resume).
4. Fail loudly with a screenshot if the login page comes back.

### 5.4 Capture the inventory
New recipe step (closed vocabulary — add it to `KNOWN_STEPS`, document it in
`docs/lead-portal-recipes.md`), e.g. `save_json`:
- read the URL from the page (`attr` of a selector — `[data-available-units-url]`),
- fetch it in-page with the session cookies, page through `pageNo` until all `totalCount`
  items are collected (fail loudly if the count never matches),
- save `{ saved_at, totalCount, items }` via `rt.saveItems('units', …)` →
  `portal-registrations/inventory/<binghatti portal record id>/units.json`.
Throttle: one list request at a time; this is a few requests, not thousands.

Which job runs it: either the portal's daily `status_check` (as Safa does — check whether a
status check without `collect_rows` is allowed) or a dedicated inventory job kind. Either is
fine; one sign-in per day/week must cover it.

## 6. The adapter and the weekly run

- `worker/src/projectUpdates/binghatti.ts`: `loadBinghattiSnapshot(supabase)` (fresh < 36 h
  AND `items.length === totalCount`, else the run marks nothing sold — Safa's rule), and a
  `ProjectSourceAdapter` that groups items by `projectId` and maps each to a `SourceUnit`:
  `sourceId=id`, `unitCode=code`, `unitNumber`, `price` = AED × 1.021103 (rounded to the
  riyal like existing rows), `area` (per §4), `bedrooms`, `unitType` (per §4), `floor`
  via `mapFloor`, `status='available'`.
- The reconciler writes `total_price`; extend the adapter/apply path so `source_price` (AED)
  is written in the same patch and logged — never one without the other.
- Policy: `{ absentAvailable: snapshotComplete ? 'sold' : 'leave', createMissing: true,
  updatePrices: true, keepReserved: true }` (the portal never shows reservations).
- `source_type = 'binghatti_broker'`; one `unit_updates` row per CRM project with
  `source_url = https://partners.binghatti.com/Properties?projectId=<portal id>` (two portal
  ids map to one CRM project for Skyflame and Flare — support a list of ids per row, or two
  rows feeding one project; do not double-sell).
- Add a `case 'binghatti_broker'` in `runProjectUpdateJob()`; add `binghatti_broker` to
  `project_update_settings.scheduled_sources` ONLY after §7 passes.

**Expect the brake on the first live run.** The CRM snapshot is months stale; a correct first
run will flip a large share of units to sold, and `brakeReason` holds any project above 50%.
That is correct behaviour. Run dry first, report per project what would change to the
operator, and let the operator approve via `params.override_brake` (the mechanism exists).

## 7. Testing (required before scheduling)

1. Unit tests with a trimmed REAL JSON fixture from the first capture (mapping, AED→SAR,
   type map, studio = 0 bedrooms, incomplete units skipped, Skyflame/Flare merge).
2. `npx tsc --noEmit -p worker` clean; `npx vitest run` in `worker/` green.
3. Deploy the worker (`fly deploy --app wassel-deck-worker`), run the capture once with the
   operator (CAPTCHA tap + SMS code), confirm `units.json` has `totalCount` items.
4. Dry run: `select project_update_enqueue('binghatti_broker','dry1:binghatti_broker','manual',true,'{}')`
   — read `project_update_runs.summary`: matched / to-sold / price changes / incomplete per project.
5. Report to the operator, live run (with overrides they approve), then a second dry run
   must show **0 changes** (idempotent).
6. Prove revert on one project: `select project_update_revert('<run id>')` on a test run.

## 8. Deliverables

- Code: `binghatti.ts`, recipe step(s), persistent-context support, `request_input`
  live-view kind + relay message, `runProjectUpdateJob` case, tests.
- Migrations (applied + verified): `unit_updates` rows for the Binghatti projects, the
  `lead_portals` recipe (after the operator creates the record), any new columns,
  `scheduled_sources`.
- Docs: `docs/prd/project-updates.md` sources table + behaviors; `CLAUDE.md` section rule
  for Binghatti; `docs/lead-portal-recipes.md` for new steps.
- Ship per CLAUDE.md "Worktree workflow": rebase on `origin/main`, push `HEAD:main`, deploy
  the worker, verify.

## 9. Out of scope (v1)

- Per-unit payment plans from detail pages (rate-limited; phase 2).
- Creating portal-only projects (DUSK, HAVEN) — report them.
- Anything on `binghatti.com` (Cloudflare, stale prices).
