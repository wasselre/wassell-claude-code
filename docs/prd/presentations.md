# PRD: Presentations

**Status:** Closed loop with per-step retry. User-authored templates run end-to-end; failed or stale steps can be re-run individually without redoing earlier work. Brands are first-class entities; slide structure is separated from brand and lives on the template.
**Last updated:** 2026-04-26 (Phase 3.4 — split slide structure out of the brand into a new free-form `output_structure` text field on the template. Brand now carries only cross-template visual identity (palette, typography, RTL/digit/punctuation rules, banned vocabulary); `output_structure` carries per-deck slide layout (count, sequence, footer rules per slide, slide-specific required phrases). The cloud worker injects both blocks into every step's user message — brand spec first (`## Brand spec`), output structure second (`## Output structure`). Editor adds an "Output structure" textarea section between Brand and Steps. Phase 3.3 — brands promoted to first-class entities (`presentation_brands` table + `brand_id` FK on templates). Editing a brand updates every template that references it; queue path resolves `brand_id` and freezes the brand body into `template_snapshot.brand` so in-flight jobs are immune. Phase 3.1 — per-step Retry button on the detail page; store action `retryPresentationStep` resets the target step + everything downstream to `pending` and re-queues the job; cloud worker's resume path skips already-`completed` steps. Mid-step progress hooked into the agent loop's `onStep`. Step prompts support `{{input_name}}` interpolation. Verified: re-running just step 2 of a prior run took 28.9 s vs 50.7 s for the full pipeline.)
**Related PRDs:** record-management.md, data-storage.md, navigation-layout.md

## Architecture in transition (2026-04-26)

The original design ran a **local daemon** that synced templates from
`~/.claude/ppt/templates/<slug>/template.json` and shelled out to
`claude --print /<command>` for each job. That's being replaced by:

- a **cloud worker** (`cloud-worker/` folder) that polls the same
  `presentation_jobs` table from a long-running Node process, calls the
  Anthropic API via `@anthropic-ai/sdk`, and runs a tool-using agent loop
  (web_search, web_fetch, code_execution, record_lookup, drive_upload). No
  Claude Code CLI dependency, no local Chrome dependency for non-Paseetah
  work. Phases 0 → 1B are done and verified end-to-end (real .pptx in real
  Drive folder).
- an **in-app Template Builder** at `/presentations/templates` so users
  author templates directly in the CRM instead of editing JSON manifests
  on disk. Phase 2.0 ships the list + metadata editor; Inputs / Tools /
  Steps section editors are scheduled for 2.1.

Both worlds coexist while the migration runs: existing daemon-synced
templates stay read-only in the new UI (`is_user_authored: false`) and the
local daemon keeps consuming jobs whose templates declare a `command`.
User-authored templates carry `command: 'cloud:agent'` and are picked up
by the cloud worker once it's deployed (Phase 0 verified locally; Fly.io
deploy still pending). Phase 5 retires the local daemon.

## What it is (in plain English)

Presentations lets a user generate a branded PowerPoint deck — market analysis, project proposal, monthly report, etc. — by picking a pre-built **template** and firing it with one click. The user never opens a slide editor. They pick a template, optionally link a CRM record (a project, a client), fill in any remaining inputs, and hit **Generate**. A job lands in the queue with `status='queued'`. A local background worker ("the daemon") picks it up, runs the matching Claude Code slash command on the user's machine — doing the research, writing the content, building the `.pptx`, uploading to Drive — and writes the Drive URL back to the job. The app polls for updates and shows the link inline.

**Templates are authored outside the app**, in Claude Code, as a slash command + skill + manifest file (`~/.claude/ppt/templates/<slug>/template.json`). Adding a new template doesn't require app code changes — the daemon syncs the manifests into `presentation_templates` on the server, and the app's picker updates automatically.

## Why it exists

The firm generates 15-slide Arabic real-estate decks regularly. Today that flow is: open Claude Code, type `/wassel <brief>`, wait, copy the Drive link. This works for one operator on one machine, but it isolates deck generation from the CRM where the project records actually live. Presentations puts the trigger inside the CRM so (a) a deck is bound to a project record, (b) history is visible to the team, and (c) adding new deck types (study, monthly report, client proposal) is a pure Claude-Code authoring exercise — no app releases.

## Key behaviors

- **URL:** `/presentations` (list of all past + pending jobs), `/presentations/:jobId` (one job's detail).
- **Sidebar:** top-level nav entry (between Home and the model list), available to every signed-in user.
- **New presentation flow (two entry points):**
  - **From `/presentations`:** click `+ New Presentation` → `TemplatePickerModal` lists every available template → picking one swaps the modal to an input form → submit → job is inserted with `status='queued'` → app navigates to the detail page for that job.
  - **From a CRM record:** every record page shows a `Generate deck` action button in the header bar whenever there is ≥1 template with `record_binding.model_slug === model.name`. Clicking opens the same picker modal but filtered to matching templates only, with the record pre-bound to the job. When exactly one template matches (today's case for Targeted Projects), the modal auto-advances past the picker straight into the pre-filled input form.
- **Template catalog (`presentation_templates`):**
  - Daemon-owned. The app reads, never writes. (Phase 1 exception: a bundled seed of the `wassel` template ships so the picker isn't empty before the daemon lands.)
  - Each template has `slug`, bilingual labels, a Claude slash command to fire, an icon, an `input_schema` describing what to collect from the user, and an optional `record_binding` that links the template to a specific model (e.g. Wassel → `targeted_projects`).
  - `is_available=false` hides a template from the picker without breaking old jobs that referenced it.
- **Input types in `input_schema`:** `text`, `textarea`, `number`, `date`, `dropdown`. Each input has `source='user'` (blank for the user to fill) or `source='record_field'` (prefill from the selected record's field slug). The form lets the user override a prefilled value — but switching the linked record refreshes every un-touched `record_field` input.
- **Record binding:** when a template declares `record_binding`, the input form shows a record picker at the top; the user must pick one unless `optional=true`.
- **Job lifecycle (`presentation_jobs`):** `queued` → `running` → `completed` or `failed` or `canceled`. Status transitions are written by the daemon; the app only inserts new rows and can cancel `queued` rows. The snapshot of both the template manifest and (if any) the linked record data is frozen at queue time so later edits to either don't mutate in-flight jobs.
- **Idempotency:** every new job carries a `client_dedup_key` = SHA-256 of (template_id + record_id + normalized inputs). A unique partial index blocks a second `queued`/`running` row with the same key; double-clicking "Generate" returns the existing job rather than duplicating work.
- **Daemon offline banner:** the page reads a singleton `daemon_status` row. If `last_heartbeat_at` is missing or older than 60 seconds, a warning banner shows at the top of `/presentations` with "last seen X min ago" copy. The daemon heartbeats every 15s while running, so the banner disappears within 15s of `npm start`.

- **The daemon.** A local Node process in `daemon/`. Polls `presentation_jobs` via the `claim_next_presentation_job` RPC (which uses `FOR UPDATE SKIP LOCKED` so concurrent daemons never pick the same row). For each claim it spawns `claude --print --permission-mode bypassPermissions "<template.command> <brief>"`, tails stdout, and writes back when the CLI exits. Single worker (Paseetah drives real Chrome). Crash recovery: on boot, any `running` row matching this host+pid flips to `failed` with `error_code='daemon_restarted'` — no auto-resume. Heartbeat row upserted every `HEARTBEAT_INTERVAL_MS` (default 15s). Job wall-clock capped at `JOB_TIMEOUT_SECONDS` (default 30 min); exceeded jobs are SIGTERM'd then SIGKILL'd and classified as `timeout`. Writes a daily rotating log file to `daemon/logs/daemon-YYYY-MM-DD.log` (overridable via `LOG_DIR`); logs older than 7 days are swept on boot. Opt-in Windows-service wrapper at `daemon/scripts/install-service.mjs` — auto-start on login for users who don't want to keep a terminal open.

- **Result sentinel.** Every template's slash command must print a final line of the form `###PRESENTATION-RESULT###{...json...}` where the JSON matches `PresentationJobResult`. The daemon parses the last such line in stdout. Progress updates use `###PRESENTATION-PROGRESS###{"stage":"...","message_ar":"...","message_en":"..."}` (one per line, any number); each updates the job row's `progress_*` columns in real time. The `/wassel` command emits the result sentinel at the end of Step 5, and progress sentinels at the top of each step — `paseetah` (Step 1), `research` (Step 2), `upload` (Step 3). The app's list and detail pages render `progress_message_ar` / `progress_message_en` inline next to the Running chip.

- **Template manifests on disk.** Each template is `~/.claude/ppt/templates/<slug>/template.json`. The daemon reads these on boot and upserts them into `presentation_templates` by id. A chokidar watcher resyncs within a second of any manifest edit. Manifests that disappear from disk flip the DB row to `is_available=false` (the app hides unavailable templates from the picker but keeps them for historical jobs that referenced them).
- **Polling:** `usePresentationJobsPolling` refreshes the daemon heartbeat every 3 seconds, and any jobs in `queued`/`running` every 3 seconds on the list page (1.5 seconds on the detail page). Polling stops when all visible jobs are terminal. No Supabase Realtime in v1.
- **Result payload:** a completed job carries `drive_deck_url`, `drive_folder_url`, and optionally `drive_sheet_url` (the evidence sheet). The detail page renders each as a copper link. A `research_stats` object (filled / total / gaps / conflicts) is shown as a footnote when present.

- **Local-paths fallback.** When the slash command couldn't upload to Drive but still produced the deliverable locally, its result sentinel carries `"ok": true` with all `drive_*` URLs null and a `local_paths` object mapping `{name: "C:\path\..."}`. The detail page swaps its "Result" card for an amber-tinted "Drive upload failed — files saved locally" card that lists each local path as a copyable `<code>` block. The user copies the path, uploads to Drive manually, and their deliverable is in hand instead of lost.
- **Error surfacing:** failed jobs classify into bilingual copy per `error_code` (chrome session expired, Drive upload failed, Claude Code error, timeout, daemon restarted, validation failed, unknown). The raw stdout tail is tucked behind a collapsed `<details>` block.
- **Retry:** failed or canceled jobs expose a retry button that queues a fresh job with the same template + record + inputs and navigates to it. The old job stays around as history.
- **Cancel:** only queued jobs can be canceled from the app. Running-job cancellation is out of scope for v1 (killing a mid-Paseetah run or mid-Drive-upload leaves orphan state).

## User flows

1. **Happy path from `/presentations`:** click `+ New Presentation` → pick the Wassel template → (optional) link a Targeted Project record → fill project brief → click Generate → land on the job detail page in `Queued` → daemon claims within ~5s → status flips to `Running` → the job runs for ~15 min (Paseetah, research, build, review, Drive upload) → status flips to `Completed` with a Drive link → click link to open the deck.
2. **Double-click protection:** click Generate twice → second click returns the same job id; no duplicate row is created.
3. **Daemon offline:** job stays `Queued` indefinitely. Banner at the top of `/presentations` reads "Presentations daemon is not running. Queued jobs will stay pending until you start the daemon on your machine." Starting `cd daemon && npm start` makes the banner disappear within 15s and the queue drains.
4. **Failure:** a `chrome_session_expired` error surfaces as "paseet.ai session expired. Sign in in Chrome, then retry." with a Retry button that queues a fresh job.
5. **Cancel:** on a queued job, clicking Cancel flips status to `canceled` and disables the button. Retry is shown in its place.

## Data touched

- **Writes:** `presentation_jobs` (inserts on queue, updates on cancel + retry flow).
- **Reads:** `presentation_templates` (catalog), `daemon_status` (heartbeat), `records` + `models` (for record binding + snapshot labels).
- **localStorage mirrors:** `wassell_presentation_templates`, `wassell_presentation_jobs` (dual-write for offline parity, same pattern as models/records).

## Key files

### App (frontend)

| File | What it does |
|---|---|
| `src/pages/Presentations/PresentationsListPage.tsx` | List of jobs, daemon-offline banner, "New" button, template picker entry |
| `src/pages/Presentations/PresentationDetailPage.tsx` | One job — status, progress, result links, error detail, retry/cancel. **Phase 3:** renders one card per entry in `job.step_outputs` with kind icon, status chip (pending/running/done/failed/skipped), duration, tool-call badges, output preview behind `<details>`, and a Drive "Open" link when the step uploaded a file. **Phase 3.1:** per-step Retry button appears on completed/failed/skipped steps once the parent job is in a terminal state. |
| `src/pages/Presentations/TemplateListPage.tsx` | **Phase 2** — `/presentations/templates`. Lists every template with user-authored vs daemon-synced badges; clone (any) / edit + delete (user-authored only). |
| `src/pages/Presentations/TemplateEditorPage.tsx` | **Phase 2 + 3.3 + 3.4** — `/presentations/templates/:templateId`. Sections: Basics, Record binding, Inputs, Tools, Brand (selector — see `BrandSelector.tsx`), **Output structure** (free-form markdown textarea — count, sequence, footer rules per slide, slide-specific required phrases; injected into every step's prompt), Steps. Read-only banner for daemon-synced templates. Save commits to store + Supabase. |
| `src/pages/Presentations/BrandsListPage.tsx` | **Phase 3.3** — `/presentations/brands`. Lists every brand with palette swatches preview, system badge, in-use template counter; New brand / clone / edit / delete (system brands non-deletable). |
| `src/pages/Presentations/BrandEditPage.tsx` | **Phase 3.3** — `/presentations/brands/:brandId`. Top-level slug + bilingual labels editor; wraps `BrandEditor` for the body (palette, typography, design_rules, text_rules, forbidden/required phrases). |
| `src/pages/Presentations/components/template/BrandSelector.tsx` | **Phase 3.3** — Dropdown that lists every brand + a compact preview (color swatches, font name, counts). "Manage brands" link → `/presentations/brands`. "Edit brand" link → `/presentations/brands/:brandId`. |
| `src/pages/Presentations/components/template/BrandEditor.tsx` | **Phase 3.2** (originally inline-on-template; now reused on `/presentations/brands/:id`) — Editor for the brand body: palette swatches, font, design_rules, text_rules, forbidden/required phrase lists. |
| `src/data/seedPresentationBrands.ts` | **Phase 3.3 + 3.4** — Bundled `wassel` brand seed (system brand). Phase 3.4 trimmed `design_rules` to visual identity only (footer band colors, hyperlink styling, card icons, format) and cleared `required_phrases` (slide-specific phrases moved to template's `output_structure`). |
| `src/pages/Presentations/components/template/InputsEditor.tsx` | **Phase 2.1** — Editor for `template.input_schema`. Inline cards per input: bilingual labels, slug, type dropdown (text/textarea/number/date/dropdown), required toggle, value source (user / record_field — the latter renders a dropdown of bound model field slugs), placeholders, and inline DropdownOptionsEditor for dropdown-type inputs. Up/down/delete reorder. |
| `src/pages/Presentations/components/template/ToolsEditor.tsx` | **Phase 2.1** — 5-row checkbox list of every cloud-worker tool, driven by `TEMPLATE_TOOL_REGISTRY`. Each row shows the bilingual label/description and a server-side or custom badge. |
| `src/pages/Presentations/components/template/StepsEditor.tsx` | **Phase 2.1** — Ordered list of step cards. Each card: kind dropdown, optional bilingual label override, prompt textarea (with sensible default per kind), and a tool-subset checklist constrained to the template's enabled tools. Add buttons per kind at the bottom; up/down/delete on each card. |
| `src/pages/Presentations/components/TemplatePickerModal.tsx` | Template picker → input form flow in a single modal |
| `src/pages/Presentations/components/InputForm.tsx` | Renders a form from `template.input_schema`; prefills from the linked record |
| `src/pages/Presentations/hooks/usePresentationJobsPolling.ts` | Refreshes daemon heartbeat + live jobs on an interval; auto-stops on terminal status |
| `src/types/index.ts` | `PresentationInput`, `PresentationTemplate` (with `tools` / `steps` / `is_user_authored` / `brand_id` / `output_structure`), `PresentationBrandRecord`, `PresentationBrand` + sub-types, `PresentationToolName`, `PresentationStepKind`, `PresentationStep`, `PresentationJob`, `DaemonStatus`, job status / error enums |
| `src/stores/appStore.ts` | State + actions — Phase 2 adds template CRUD; Phase 3.3 adds brand CRUD (`createPresentationBrand`, `updatePresentationBrand`, `deletePresentationBrand`, `duplicatePresentationBrand`) and seeds the wassel brand on first run; Phase 3.4 backfills `output_structure: ''` on init for pre-migration template rows |
| `src/data/seedPresentationTemplates.ts` | Bundled `wassel` template seed — daemon upserts by `id`; offline / pre-daemon fallback |
| `src/data/templateToolRegistry.ts` | **Phase 2** — Bilingual descriptors for the cloud worker's tool surface. Authoritative source for the Tools checklist in Phase 2.1. |
| `src/components/layout/Sidebar.tsx` | Top-level Presentations nav item + nested "Templates" sub-link (`nav-item-sub` class) |
| `supabase/schema.sql` | Tables `presentation_templates` (extended with `tools` / `steps` / `is_user_authored` / `created_by` / `brand_id` FK / `output_structure` text), `presentation_brands` (Phase 3.3 — first-class brand entities), `presentation_jobs` (with `step_outputs` jsonb for per-step state), `daemon_status` + idempotency unique index + `claim_next_presentation_job` RPC + idempotent `ALTER TABLE ADD COLUMN IF NOT EXISTS` for existing prod DBs |
| `src/pages/Records/RecordFormPage.tsx` | Host of the record-level `Generate deck` action button and the `RecordDecksPanel` below the form |
| `src/pages/Records/components/RecordDecksPanel.tsx` | Inline "recent decks for this record" panel — up to 3 most recent, status chips, Drive links |

### Cloud worker (replaces local daemon — Phases 0–1B done)

| File | What it does |
|---|---|
| `cloud-worker/src/index.ts` | Main loop — boot-time stale-job sweep, heartbeat, claim via `claim_next_presentation_job` RPC, dispatch to runner |
| `cloud-worker/src/runner.ts` | **Phase 3 / 3.1 / 3.3 / 3.4** — when `template.steps` is non-empty, walks each step in order, persists per-step state to `step_outputs`, passes earlier-step output as context to later steps, scrapes `drive_url` from any `drive_upload` tool calls. Phase 3.1 seeds `stepOutputs` from the job row's existing `step_outputs` so re-queued jobs skip steps already marked `completed`; supports `{{input_name}}` interpolation; agent loop's `onStep` hook writes per-iteration progress mid-step. **Phase 3.3** injects the snapshotted brand body (`## Brand spec`) into every step's user message. **Phase 3.4** also injects the template's `output_structure` (`## Output structure`) — separate block so the model sees brand and slide layout as distinct sections. |
| `cloud-worker/src/agentLoop.ts` | Manual agent loop with `tool_use` dispatch, `pause_turn` handling, container-id threading, file_id surfacing, usage tracking, `onStep` hook. **Phase 3:** accepts an `enabledTools` filter so the runner can scope each step to its declared tool subset. |
| `cloud-worker/src/tools/builtin.ts` | Anthropic-hosted tool descriptors: `web_search_20260209`, `web_fetch_20260209`, `code_execution_20260120` |
| `cloud-worker/src/tools/recordLookup.ts` | Custom client-side tool — reads `models` + `records` JSONB by slug |
| `cloud-worker/src/tools/driveUpload.ts` | Custom client-side tool — downloads from Anthropic Files API → uploads to Google Drive via OAuth2 with auto-refresh |
| `cloud-worker/src/tools/index.ts` | Tool registry + dispatch (server-side vs client-side names) |
| `cloud-worker/src/oauth-init.ts` | One-time loopback OAuth flow (`http://127.0.0.1:8765`) — captures the Drive refresh token and writes it to `cloud-worker/.env` |
| `cloud-worker/src/heartbeat.ts` | 15s upsert to the singleton `daemon_status` row (id `presentations`, hostname prefixed `cloud:`) |
| `cloud-worker/src/{env,supabase,anthropic,types,version}.ts` | Env loading + validation, service-role Supabase client, Anthropic client, narrow row types, version string |
| `cloud-worker/Dockerfile` + `cloud-worker/fly.toml` | Single shared-cpu-1x machine on Fly.io (~$15/mo); no HTTP listener |
| `cloud-worker/README.md` | Setup, local dev, Fly.io deploy, switch-from-local-daemon instructions |

### Legacy local daemon (still functional — retired in Phase 5)

| File | What it does |
|---|---|
| `daemon/src/index.ts`, `runner.ts`, `templates.ts`, `heartbeat.ts`, `smoke.ts`, `logger.ts` | Original local daemon — claims jobs from Supabase, spawns `claude --print`, syncs templates from disk |
| `daemon/scripts/install-service.mjs` + siblings | Opt-in Windows-service wrapper via `node-windows` |
| `~/.claude/ppt/templates/wassel/template.json` | On-disk manifest the local daemon syncs to the DB |
| `~/.claude/commands/wassel.md` | Slash command the local daemon invokes; § 5 defines the `###PRESENTATION-RESULT###` sentinel contract |
| `~/.claude/skills/template-scaffolder/SKILL.md` | Generates the three-file bundle for a new file-based template (becomes optional once Phase 2 lands) |

## Open questions / known limitations

- **Progress sentinels don't land live — they arrive in a batch at end of run.** `/wassel` emits three stage sentinels (`paseetah`, `research`, `upload`), but the daemon invokes Claude with `--output-format text`, which buffers stdout until the CLI exits. The sentinels ARE parsed correctly on exit (verified end-to-end with the `ping-test` template, which completes in ~5 s with correct UTF-8 and Arabic), but during the 10–15 min real pipeline the Running chip stays on `Running (…)` with no stage subtitle. Fixing this requires switching the runner to `--output-format stream-json` and unwrapping the assistant-text events from each event line — a parser overhaul that's deferred until we hit a user who needs the live view.
- **Single worker.** Paseetah drives the real Chrome window — two concurrent runs would thrash it. The daemon enforces strict serialization via `FOR UPDATE SKIP LOCKED`; concurrent queued jobs wait in line. A "N ahead of you" hint on queued jobs is a nice-to-have that isn't in yet.
- **Running-job cancel is out of scope.** Only queued jobs can be canceled from the app. Safe-cancel of a running job would need a cooperative shutdown flag the daemon polls between stages plus a Drive-folder cleanup pass, neither of which is cheap to build right.
- **Windows service runs as LocalSystem by default.** LocalSystem can't see the logged-in user's Chrome profile, which Paseetah needs. The install script documents overriding `svc.user` / `svc.password` to the user's own account, but this is manual.
- **Service-role key on one machine.** The daemon needs the Supabase service-role key locally. If a teammate needs to fire decks, they need their own daemon running on their own box — a shared queue isn't in v1.
- **Linux / macOS service wrappers** (systemd / launchd) aren't shipped. Only the Windows-service wrapper is in the box; other platforms stick with `npm start`.
