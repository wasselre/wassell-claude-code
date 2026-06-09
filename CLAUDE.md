# Wassell CRM — Claude Code Project Memory

## What This Project Is
A full-stack no-code operational CRM system for a real estate marketing company called Wassel (وصل العقارية).
Users build their own data models, automate workflows, and create shareable dashboards — all without writing code.
Think: Zoho Creator + Zapier + Airtable, built for Saudi Arabian real estate.

## Living Documentation (CRITICAL — Read This)

Every main section of this app has a plain-English PRD in `docs/prd/`. These are the **source of truth for what the app does**; code is the source of truth for *how*. `CLAUDE.md` is the source of truth for architecture, design system, and conventions.

**Hard rule — after any non-trivial change to user-facing behavior in `src/**`, you MUST:**
1. Identify which PRD(s) in `docs/prd/` cover the area you changed (see each PRD's "Key files" table).
2. Update the PRD's `What it is`, `Key behaviors`, `User flows`, `Data touched`, and/or `Key files` sections to match the new reality.
3. Bump the `Last updated` date at the top of the PRD to today's date.
4. If a new feature doesn't fit any existing PRD, consult the decision rule in `docs/prd/README.md` — extend when in doubt; create a new PRD only for distinct user-facing areas with their own page, data, and flow.

**Skip PRD updates ONLY for:** pure refactors, typo fixes, comment-only changes, or test-only changes.

A `PostToolUse` hook at `.claude/hooks/prd-reminder.js` will print a reminder after every `Edit`/`Write`/`MultiEdit` in `src/**`, mapping the file to its PRD. Do NOT rely on the hook — follow the rule proactively. The hook is a safety net.

For large or cross-cutting changes (multiple PRDs, new pages, big refactors), invoke the `prd-updater` subagent:
```
Agent(subagent_type="prd-updater", prompt="Refresh PRDs after <describe the change>")
```

**PRD index:** `docs/prd/README.md`. **PRD template:** `docs/prd/_TEMPLATE.md`.

## Generated model & workflow PRDs (added 2026-06-08)

Unfrozen models and workflows live **only as JSONB rows in Supabase** — created at runtime via the in-app Model Builder + Workflow editor — so they never appear in code and Claude is otherwise blind to them in a fresh session. To close that gap, `scripts/sync-model-workflow-prds.mjs` reads the live DB and writes one deterministic markdown PRD per model and per workflow:

- `docs/prd/models/<model-name-slug>.md` — every section + field (slug/API name, type, required, width, dropdown options with their API `value` + colors, lookups → target model + display field, formulas, ranges, auto-IDs, mirrors, computed rollups, `visible_when`, custom buttons).
- `docs/prd/workflows/<label-slug>-<id8>.md` — trigger (plain English), branches (IF / ELSE IF / OTHERWISE, AND/OR), conditions, and every action with fully resolved field mappings. Handles both the branched and the legacy flat shape.
- A generated `README.md` index in each dir.

**Rules — never violate:**
1. **These two dirs are AUTO-GENERATED — never hand-edit.** Every file carries a banner saying so; the next `npm run sync:prds` overwrites them and prunes files for deleted models/workflows. (The hand-written numbered PRDs in `docs/prd/` root are a separate, human-owned surface — the `prd-reminder` hook and `prd-updater` subagent do NOT touch the generated dirs.)
2. **Run `npm run sync:prds` at the start of any model/workflow task** to refresh from the live DB. A `SessionStart` hook in `.claude/settings.json` runs it (`--hook`) automatically each session — best-effort: it quietly skips (exit 0) if Supabase env is absent and never blocks the session.
3. **The git diff of these dirs is the record of what the user changed in-app** — that is the "what edit happened" trail.
4. Pure templating, no LLM. Reads `models`, `workflows`, `model_groups`, `workflow_groups`, `webhook_slugs`, `roles`, `profiles`. Prefers `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS so no row is hidden); falls back to anon. Auto-loads `.env.local`/`.env` (no `dotenv` dependency).
5. Unresolved references render VISIBLE — `(unknown field)`, `(unknown model)`, `(role)`. These flag **real stale references in the data** (e.g. a deleted role, an orphaned card-title field, the follow-up-type UUID drift), not script bugs.
6. **Don't put secrets in workflow static values** — they'd be rendered into the committed PRD. (Secrets live in server-side env; workflow actions reference `{field_slug}` tokens, not literal keys.)

## Tech Stack
- **Frontend:** React 18 + TypeScript + Vite
- **Styling:** Tailwind CSS v3 (RTL support via `dir` attribute)
- **Database:** Supabase (PostgreSQL + JSONB) with localStorage offline fallback
- **State:** Zustand
- **Routing:** React Router v6
- **i18n:** react-i18next (Arabic + English, full RTL/LTR switching)
- **Drag & Drop:** @dnd-kit/core + @dnd-kit/sortable
- **Charts:** Recharts
- **PDF:** jsPDF (Arabic RTL support)
- **Icons:** Lucide React
- **Font:** Amiri (Google Fonts)

## Design System (Official Wassel Branding)
- **Primary:** Copper Bronze `#B8734F` — buttons, active states, accents (50%)
- **Sidebar:** Charcoal Slate Gray `#4A4E54` background
- **Dark Alt:** Rich Chocolate Brown `#4A2C2A` — headers, contrast areas
- **Secondary:** Deep Terracotta `#8E4E3A` — hover states
- **Surface:** Warm Sand/Beige `#D4B896` — borders, dividers (30%)
- **Background:** Soft Cream `#F5EDE0` — page backgrounds
- **Text:** Charcoal Slate Gray `#4A4E54` — body text (15%)
- **Accent:** Subtle Gold `#C09B5F` — badges, highlights (5%)
- **Currency:** SAR (Saudi Riyal) — ر.س
- Border radius: 8px (inputs), 12px (cards), 16px (modals)
- Typography: Amiri for both Arabic and English text
- Logo: Wassel castle/fort logo from `Wassel Branding/` folder
- RTL: when language = 'ar', set `dir="rtl"` on `<html>`; when 'en', set `dir="ltr"`

## Bilingual Rules (CRITICAL)
- Every model, section, field, and option has BOTH `label_ar` and `label_en`
- All static UI strings go through react-i18next
- Never hardcode Arabic or English text directly in JSX — always use `t('key')` or the `isAr ? x.label_ar : x.label_en` pattern
- The language toggle is in the Header component

## Data Architecture (CRITICAL — Read Before Any Feature)
All model schemas are stored as JSONB in Supabase. A model's schema looks like this:
```json
{
  "sections": [
    {
      "id": "uuid",
      "label_ar": "...",
      "label_en": "...",
      "order": 0,
      "is_base": true,
      "color": "#3B82F6",
      "fields": [
        {
          "id": "uuid",
          "name": "field_slug",
          "label_ar": "...",
          "label_en": "...",
          "type": "dropdown",
          "required": true,
          "order": 0,
          "section_id": "parent-section-uuid",
          "width": "half",
          "show_in_table": true,
          "options": [
            { "id": "uuid", "label_ar": "...", "label_en": "...", "value": "slug", "color": "#hex" }
          ],
          "lookup_model_id": null,
          "lookup_display_field": null
        }
      ]
    }
  ],
  "section_selector_field_id": "uuid-or-null"
}
```

Records are also JSONB: `{ "field_slug": value, "another_field": value }`

## The Section Selector Field (CRITICAL — Unique Feature)
This is a special field type (`section_selector`) that controls which non-base sections appear in the record form.
- Its options are the names of non-base sections in the same model
- When a user selects values in this field, only those sections show in the form
- Base sections (`is_base: true`) ALWAYS show regardless
- Used in the Follow-Ups model to show different fields per follow-up type
- Can be added to any model via the Builder

## Supabase Tables
```
models            — model definitions (schema as JSONB)
model_groups      — sidebar folder groups
records           — all records for all models (data as JSONB)
workflows         — automation workflow definitions
dashboards        — dashboard configurations (widgets as JSONB)
chat_messages     — WhatsApp messages per conversation (Realtime-enabled)
whatsapp_numbers  — local overlay on Haberchat devices: friendly name + default flag
deck_jobs         — queue for the Fly.io deck generation worker (see "Decks generation pipeline")
```

## Frozen models (added 2026-05-05)

Every model can be **frozen** — promoted from a JSONB row in the unified `records` table to its own physical Postgres table with proper typed columns + junction tables for multi-value fields + subtables for `table` fields. One-way action triggered from the Builder UI.

**Two storage shapes coexist:**
- Unfrozen models live as JSONB in `records`. `models.is_hardcoded = false` (default).
- Frozen models live in a dedicated table named `<model.name>` (with junctions `<model>__<field>`). `models.is_hardcoded = true`, `models.table_name = '<name>'`. Custom-UI models (`chats`, `ai_chats`) are excluded from Freeze.

**Architecture:**
- Reads go through the **`unified_records` view** — a `UNION ALL` of `records` + each frozen model's `<name>_v` JSONB-shape view. Same row shape `(id, model_id, data, created_by_user_id, created_at, updated_at)` — consumers don't branch.
- Writes go through the **`record_save(model_id, id, data, created_by, expected_version)` / `record_delete(model_id, id)` SQL RPCs** which dispatch on `is_hardcoded`. The frontend store wraps these in `supabaseRecordUpsert` / `supabaseRecordDelete`. `p_created_by` is COALESCE-preserved on update — first save stamps, later edits don't overwrite. The 5th arg `p_expected_version` (Phase F.2, added 2026-05-07) is the version the client loaded with; on mismatch the RPC raises SQLSTATE 40001 (`version_mismatch`) and the frontend surfaces a "reload to see latest" toast instead of overwriting concurrent edits. Frozen models ignore p_expected_version (no per-frozen-table version column yet — Phase F.2.1 future work). Same posture as the records-table flow.
- A `BEFORE INSERT OR UPDATE` trigger on `records` (`records_block_frozen_writes`) raises a loud exception if anyone tries to write directly to `records` for a frozen model. The dispatcher RPCs route correctly — this trigger is the safety net.

**RLS on frozen tables (CRITICAL — added 2026-05-06):** frozen tables enable RLS and get four policies generated by `regenerate_frozen_model_artifacts` that mirror the records-table policies:
- `frozen_view`   — `wassell_can_view_jsonb(auth.uid(), '<model_id>'::uuid, id, created_by_user_id, jsonb_build_object(...from columns...))`
- `frozen_insert` — `wassell_user_has_action(auth.uid(), '<model_id>'::uuid, 'create')`
- `frozen_update` — `wassell_can_edit_jsonb(...)`
- `frozen_delete` — `wassell_can_edit_jsonb(...)` AND `wassell_user_has_action(..., 'delete')`

`wassell_can_view_jsonb` / `wassell_can_edit_jsonb` build a synthetic `records` row literal from their args and call the existing `wassell_record_passes_scope` evaluator — so per-profile view_scope / edit_scope rules keep working after a model is frozen. **Multi-value fields (junctions / subtables) are intentionally OMITTED from the policy's `jsonb_build_object(...)` expression** — including them would force a per-row join inside the RLS check and tank query performance, and scope rules typically address scalar fields anyway. Scope conditions referencing multi-value fields on a frozen model fail closed in v1 — document this when a customer's profile rules touch a multiselect/lookup field on a model they want to freeze. Junction / subtables get their own `frozen_junction_view` / `frozen_junction_write` policies that gate access via `EXISTS (SELECT 1 FROM <parent> WHERE id = record_id)`, so reach into a junction is gated by the parent's policy.

**When you (Claude in a future session) need to edit a frozen model's schema:**

The user told us during freeze planning that they'd "talk to Claude" instead of editing through the UI. They mean a regular Claude Code chat — not the Builder Agent (which refuses to mutate frozen models). When they ask you to add a field, rename one, change a type, or drop one on a frozen model, you write a migration that does **both** the DDL and the JSONB schema update **atomically**, then refresh the artifacts.

**Migration template** (write to `supabase/migrations/YYYY-MM-DD_<change>.sql`, then ask the user to run it):

```sql
BEGIN;

-- 1. DDL on the dedicated table.
ALTER TABLE public.clients ADD COLUMN birthday timestamptz;
-- For multi-value fields, CREATE TABLE the junction/subtable here.
-- For dropping a field, DROP COLUMN here AND any junction.

-- 2. Update the JSONB schema in models so the Builder UI renders the field
--    (read-only, since the model is frozen) and so the per-model JSONB view
--    knows about it.
UPDATE public.models
SET schema = jsonb_set(
      schema,
      '{sections,0,fields}',
      (schema->'sections'->0->'fields') || jsonb_build_object(
        'id', gen_random_uuid()::text,
        'name', 'birthday',
        'label_ar', 'تاريخ الميلاد',
        'label_en', 'Birthday',
        'type', 'date',
        'required', false,
        'order', 99,
        'section_id', (schema->'sections'->0->>'id'),
        'width', 'full',
        'show_in_table', false
      )
    )
WHERE name = 'clients';

-- 3. Refresh the JSONB-shape view + the unified_records UNION.
SELECT public.regenerate_frozen_model_artifacts(
  (SELECT id FROM models WHERE name = 'clients')
);
SELECT public.rebuild_unified_records();

COMMIT;
```

**Field-type → column type mapping** (used by `freeze_model` and any migration you write — keep in sync):
- `text`, `textarea`, `email`, `phone`, `url`, `dropdown`, `auto_id`, `lookup` (single) → `text`
- `number`, `currency`, `formula` → `numeric`
- `date`, `datetime` → `timestamptz`
- `checkbox` → `boolean`
- `range` → expanded into `<name>_min`, `<name>_max` numeric columns
- `notes`, `section_mirror`, `section_selector`, `assignee` → `jsonb`
- `multiselect` → junction `<model>__<field>` with `(record_id uuid, value text, PK)`
- `lookup is_multi=true` → junction `<model>__<field>` with `(record_id uuid, target_record_id uuid, PK)`
- `table` → subtable `<model>__<field>` with `(id uuid, record_id, row_index, ...row columns)`
- `mirror` → SKIPPED (computed at runtime)
- `whatsapp_history`, `call_history` → SKIPPED (display-only — render derived data from `chat_messages` / `call_logs` based on the parent record's id and phone fields; never stored on the record)

**Hard rules — never violate:**

1. **Migrations on a frozen model MUST update both the table AND `models.schema`.** The Builder UI renders forms from the JSONB schema; if you ALTER a column without updating the JSONB, the new column will exist but the form won't show it. If you update the JSONB without ALTERing the column, the dispatcher RPC's `freeze_apply_row` will try to write to a column that doesn't exist and the save will fail.

2. **Always call `regenerate_frozen_model_artifacts(model_id)` and `rebuild_unified_records()` at the end of the migration.** The first refreshes the `<name>_v` JSONB-shape view so the new column appears in reads AND regenerates the four RLS policies on the parent table (so the policy's inline `jsonb_build_object(...)` expression includes the new field for scope evaluation); the second rebuilds the UNION view across all frozen models. **Skipping the regen call on a schema change leaves the policy referencing columns that no longer exist (or missing the new column from scope checks) — both silent-correctness bugs.**

3. **Never write to `records` for a frozen model.** The records-block trigger will reject it. Use the `record_save` / `record_delete` RPCs (or, in the app, go through the store actions which already do).

4. **Never silently drop data when migrating.** If a column type change could lose information (e.g. text → numeric on rows with non-numeric values), validate first and abort the migration with a useful error — same posture as `freeze_check_coercion`.

5. **The Builder Agent (`api/_lib/builderAgent.ts`) refuses to mutate frozen models.** Don't add a workaround. Schema changes go through migrations written by the main Claude session, full stop.

**Where everything lives:**
- SQL: `supabase/schema.sql`, "FREEZE INFRASTRUCTURE" block at the bottom
- Frontend store actions: `src/stores/appStore.ts` — `freezeModel`, `checkFreezeCoercion`, plus the `supabaseRecordUpsert` / `supabaseRecordDelete` helpers
- UI: `src/pages/Builder/components/FreezeModelModal.tsx`, `src/pages/Builder/components/ModelEditor.tsx` (header pill + readOnly prop fan-out)
- Builder Agent guard: `refuseIfFrozen()` in `api/_lib/builderAgent.ts`
- Server-side reads: `unified_records` view in `api/`, `supabase/functions/`, and `RecordFormPage.tsx`
- Server-side writes: `record_save` RPC in `api/research-project.ts`, `api/run-button-workflow.ts`, `api/_lib/aiAgent.ts`, `api/webhook/hatif-call.ts`
- PRD detail: `docs/prd/data-storage.md` "Frozen models" section

## Auto-generated per-model views (added 2026-04-26)

Every model in `models` has a corresponding `v_<name>` view in the `public` schema (e.g. `v_all_projects`, `v_clients`, `v_competitors`). Views materialize each model's schema fields as **proper typed columns** over the unified `records` JSONB table, so the Supabase Table Editor / SQL Editor / external BI tools see one clean per-model table instead of opaque JSON blobs.

- **Always in sync.** A trigger on the `models` table (`models_view_sync`) regenerates the view on every INSERT/UPDATE of `name` or `schema`, and drops it on DELETE. Adding a field in the Builder → it appears as a column ~immediately. Renaming a model → old view dropped, new one created.
- **Read-only by design.** The app keeps writing to `records`. Views are for inspection, reporting, and external integrations. There's no scenario where the app should write to a `v_*` view.
- **Type mapping** (in `regenerate_model_view`):
  - `number` / `currency` / `formula` → `numeric` (via `try_numeric`)
  - `date` / `datetime` → `timestamptz` (via `try_timestamptz`)
  - `checkbox` → `boolean`
  - `range` → expanded into `<name>_min` and `<name>_max`
  - `multiselect` / `table` / `notes` → `jsonb` (kept structured)
  - everything else → `text`
- **Safe casts.** `try_numeric` / `try_timestamptz` / `try_boolean` return `NULL` on parse failure rather than erroring out the whole view query — protects against the "one row has bad data, the view is unusable" failure mode.
- **Where defined:** `supabase/schema.sql`, last block ("Auto-generated per-model views"). Idempotent re-run.

If you add a new field type to the codebase, update the type mapping in `regenerate_model_view` so the new type lands in views with an appropriate column type. Otherwise it falls through to `text` (still works, just not natively typed).

## Decks generation pipeline (added 2026-05-17 — refactored off Vercel Edge)

Deck generation runs on a Fly.io Node worker, NOT in `/api/generate-deck`. The endpoint just enqueues work.

**Why:** The original Edge function held an SSE stream open for the full Anthropic call. Vercel Edge has a **300s hard ceiling on Pro** (`maxDuration: 300` is the max — can't go higher). Any deck that took >5 min was killed silently — record stuck on `status='generating'`, no `error_message`, UI spinner forever. Happened multiple times in production (record `867a049b-...` on 2026-05-14 + 2026-05-17 was the trigger).

**Architecture:**

```
Browser ──POST /api/generate-deck (Edge, ≤1s)──▶ INSERT deck_jobs (pending) + best-effort POST /wake
                                              └─ 202 { job_id }

Fly.io worker (always-on Node, polls every 3s) ──claim via FOR UPDATE SKIP LOCKED──▶
   Anthropic Skills + code_execution (3-12 min, no timeout)
   writes status / phase to records.data
        ──Realtime───▶ Browser (DeckRightPane reads phase from record, NOT SSE)
   uploads .pptx to wassel-decks bucket → status='ready' + file_url
```

**Where everything lives:**
- Migration:           `supabase/migrations/2026-05-17_deck_jobs_queue.sql` — table, RLS, RPCs, watchdog function
- API endpoint:        `api/generate-deck.ts` (slim — just validates + inserts deck_jobs row)
- Worker source:       `worker/src/index.ts` (poll loop + watchdog tick + `/healthz` + `/wake`)
- Worker pipeline:     `worker/src/runDeckJob.ts` (the actual Claude+upload flow, ported from old Edge function)
- Worker deploy guide: `worker/README.md`
- Client helper:       `src/lib/decks/client.ts` (`enqueueGenerateDeck` replaces the old `streamGenerateDeck`)
- UI:                  `src/pages/Decks/components/DeckRightPane.tsx` (drives view from `record.data.status` + `phase`, has a 6-min "looks stuck → Try again" detector)

**Hard rules — never violate:**

1. **Never re-introduce SSE for `/api/generate-deck`.** The whole point of the rewrite is that no HTTP request is held open for the long Anthropic call. If you find yourself wanting to add `text/event-stream`, you're about to recreate the bug. Status updates flow through Supabase Realtime on the deck record.

2. **The worker uses service-role for Supabase.** It's the only place service-role is allowed (besides the activity-log writer). It enforces ownership by reading `deck_jobs.user_id` set by the API endpoint, which validated the caller's JWT before inserting. Never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.

3. **`deck_job_complete` and `deck_job_fail` only update rows where `status='running'`.** This protects against the worker racing the watchdog: if the watchdog has already marked a stale job failed (worker took >20 min), the worker's late "I'm done" is a no-op, not an overwrite.

4. **The watchdog only writes `status='failed'` to the deck record when current status is `'generating'`.** If the worker raced and wrote `'ready'` first, we leave that alone — the .pptx is real, the user gets their file.

5. **pg_cron is NOT enabled on wassell-prod.** The watchdog cron `cron.schedule(...)` in the migration is wrapped in `IF EXISTS pg_extension` so it's a no-op. The Fly.io worker invokes `deck_jobs_watchdog()` every 5 min itself instead. If you ever enable pg_cron, both will run — that's fine (cheap UPDATE, idempotent).

**When you need to debug a stuck deck:**

1. `SELECT id, status, started_at, error, EXTRACT(EPOCH FROM (now() - started_at))/60 AS minutes FROM deck_jobs WHERE deck_record_id = '<uuid>' ORDER BY created_at DESC;`
2. `fly logs --app wassel-deck-worker | grep <job_id>` — every job logs `[worker] claimed job=...` and a series of `[run] step=...` lines
3. If status='running' but minutes > 20, the watchdog should sweep it on the next 5-min tick. If it doesn't, `SELECT public.deck_jobs_watchdog();` manually.
4. To force-fail a stuck job and unblock the UI: `UPDATE records SET data = data || jsonb_build_object('status','failed','error_message','manual unstick') WHERE id = '<uuid>';` (Realtime pushes it to the browser instantly.)

## Generation jobs pipeline (image chats) (added 2026-06-08)

Image Chats v2 generation runs on the SAME Fly.io worker as decks, draining a SECOND queue (`generation_jobs`, `kind='image'`) on an INDEPENDENT poll loop. `POST /api/image-chat/send` only enqueues; the worker calls fal.ai and fills the assistant message in place. This is the per-message twin of the decks pipeline — read "Decks generation pipeline" above for the shared rationale.

**Architecture:**
- One job per assistant message. The slim endpoint appends a user message + an assistant PLACEHOLDER (`status='queued'`) to `records.data.messages` AND inserts a `generation_jobs` row, then returns 202. The worker claims via `generation_job_claim_next(worker, 'image')`, calls fal.ai, re-hosts outputs to `marketing-assets`, and patches THAT message to `status='completed'` + images. Realtime fans the record update to the SPA — placeholders fill in independently, so generation is concurrent and the composer never blocks.
- Per-message status (`queued|generating|completed|failed|cancelled`) lives on the message; the legacy conversation-level `record.data.status` is now a lossy rollup (kept for back-compat, NOT driven off for UI).

**Where everything lives:**
- Migration: `supabase/migrations/2026-06-08_generation_jobs_queue.sql` — table, RLS, claim/complete/fail/cancel RPCs, watchdog
- Endpoints: `api/image-chat/send.ts` (slim enqueue), `api/image-chat/promote-asset.ts` (asset promote + file_id cache)
- Worker: `worker/src/runImageJob.ts` (pipeline), `worker/src/index.ts` (`imagePollLoop`), `worker/src/imageGen.ts` (COPY of `api/_lib/imageGen.ts`)
- Client: `src/lib/imageChat/client.ts` (`enqueueImageChatTurn` / `cancelImageJob`), `src/lib/assets/promote.ts`, `src/lib/assets/recordTargets.ts`
- UI: `src/pages/ImageChats/components/{ChatThread,MessageBubble,Composer,AssetActionsMenu,AddImageToFilesModal,AddImageToRecordModal}.tsx`
- PRD: `docs/prd/image-chats.md`

**Hard rules — never violate:**

1. **Never hold an HTTP request open for the fal.ai call.** Same rule as decks. `/api/image-chat/send` enqueues and returns fast; the worker does the long poll. If you find yourself awaiting `pollImageGen` in the endpoint, you're recreating the bug we just removed.

2. **`worker/src/imageGen.ts` is a COPY of `api/_lib/imageGen.ts`.** The worker is a standalone npm package (`rootDir:src`; the Dockerfile copies only `src/`) and CANNOT import from `api/_lib`. When you change the chat functions (`resolveChatModelSlug` / `imageGenChat` / `startChatGeneration` / `pollImageGen` / stub mode), change BOTH files. (Decks does the same — `runDeckJob.ts` is "ported from api/generate-deck.ts".)

3. **Concurrent workers are safe via OPTIMISTIC CONCURRENCY — do not force `fly scale count 1`.** `record_save` overwrites the full `data`, so concurrent writers to the same conversation's `messages` array would clobber each other *without protection*. The protection: EVERY write to an `image_chats` record (endpoint append, worker fill, promote cache) uses `record_save` `p_expected_version` + retry on the 40001 version-mismatch (the `records_bump_version` BEFORE-UPDATE trigger increments `version` on each write, so a stale writer is bounced and re-applies onto the latest array). With that in place, ANY number of workers + concurrent endpoint appends are safe — the loser just retries (bounded ~6 attempts; the client's 3-in-flight-per-conversation cap keeps contention well under that). The deck worker app actually runs **5 machines** (throughput/HA) and image jobs ride on them safely. Do NOT pass `p_expected_version: null` for `image_chats` writes (that's the decks posture, safe only because each deck is its own record). *Verified live 2026-06-08: version bumps on UPDATE, record_save raises 40001 on stale version, and the worker pipeline completed a real generation end-to-end across the 5-machine app.*

4. **Server-side writes only for the `image_chats` record — never via the browser store.** The placeholder append (endpoint), the message fill (worker), and the `file_id` dedup cache (promote endpoint) all write via `record_save` directly. Writing the chat record through the SPA store (`saveRecord`) registers a null-`updated_at` entry in the realtime echo-dedup (`src/lib/realtime/dedup.ts`) that would SUPPRESS the next worker fill-in for that conversation. (The Add-to-Record TARGET record write DOES go through the store — safe, because the worker never touches target records.)

5. **complete/fail RPCs only touch `status='running'` jobs; the watchdog/cancel only patch the affected MESSAGE (not the conversation).** Same race-protection posture as decks. A late completion after cancel/watchdog is a no-op; a stuck job fails only its own placeholder, leaving siblings + the composer live.

6. **`FAL_KEY` is now required on the Fly worker** (the deck worker never needed it). Set it via `fly secrets set`. `FAL_KEY='stub'` returns canned picsum URLs for offline/CI.

7. **Asset promote-on-add.** Generated images stay public `marketing-assets` URLs (free chat render). The FIRST Add-to-Files/Record promotes ONE `files` row (server-side copy → `wassel-files`) and caches `files.id` on the message; later Add-to-Record reuses it (dedup). Don't promote at generation time (that would force signed-URL chat rendering + a `files` row per discarded variation).

### Image Chats v3 — Creative Workspace (added 2026-06-09)

v3 replaced the chat framing with a **Creative Workspace**: the session's primary objects are **Generations** (not chat messages), and every output is a first-class **`media_assets`** row (a central media library). Same `generation_jobs` queue + Fly worker + fal.ai underneath.

- **Data shape:** `record.data.generations[]` (was `messages[]`). Each Generation = `{ id, prompt, reference_urls, reference_asset_ids, model_id, aspect_ratio, num_variations, based_on, status, job_id, output_asset_ids, output_urls?, created_at }`. The session also carries `generation_count`, `thumbnail_url`, `thumbnail_asset_id`, `last_generation_at`.
- **`media_assets` table** (`supabase/migrations/2026-06-09_media_assets.sql`): one row per generated output — `kind` (image/video/audio/document), `public_url` (bytes stay in public marketing-assets for cheap canvas render), provenance (`prompt`/`model_id`/`settings`), `source_session_id`/`source_generation_id`, `promoted_file_id`, `created_by_user_id` (= auth.uid(); RLS owner-select). Future-proof for video/audio/docs.
- **Dual-path worker:** `worker/src/runImageJob.ts` branches on `generation_jobs.generation_id` — v3 (create `media_assets` + fill the Generation) vs legacy v2 (fill a message). `message_id` is now nullable.
- **Endpoint:** `api/image-chat/generate.ts` (v3) appends a Generation + inserts a job with `generation_id`. The v2 `api/image-chat/send.ts` stays for back-compat (unused post-cutover).
- **Migration:** `2026-06-09_sessions_to_generations.sql` reshapes existing sessions (`messages` → `generations`, outputs as inline `output_urls`; originals stashed under `_legacy_messages`). Idempotent.
- **UI:** `src/pages/ImageChats/components/StudioWorkspace.tsx` (canvas + timeline + composer + `SelectedAssetPanel`) replaced `ChatThread`/`MessageBubble`/`AssetActionsMenu` (deleted). Outputs resolve via `src/pages/ImageChats/lib/generations.ts` (`media_assets` for v3, inline `output_urls` for migrated). PRD: `docs/prd/image-chats.md`.
- The same hard rules above apply (no held HTTP for fal; optimistic concurrency on every session write; complete/fail/watchdog guards; `worker/src/imageGen.ts` is a copy).

## Offline / Local Fallback
- All data is mirrored to localStorage
- If Supabase is not configured, the app works fully offline
- On every save: update localStorage first (instant), then sync to Supabase (async, silent fail)
- On load: try Supabase first, fall back to localStorage

## Pre-Built System Models
These are defined in `src/data/seedModels.ts` and loaded on first run.
They are editable in the Builder but cannot be deleted (is_system: true).
1. `clients` — Clients model (3 sections)
2. `followups` — Follow-Ups model (5 sections, uses section_selector)
3. `all_projects` — All Projects (group: Projects)
4. `targeted_projects` — Targeted Projects (group: Projects)
5. `our_projects` — Our Projects (group: Projects)
6. `chats` — WhatsApp conversations via Haberchat. Top-level (no group).
   Renders a custom two-pane UI (list + thread) instead of the generic
   record table/form. See `docs/prd/chats.md`.
7. `ai_chats` — Internal Claude-powered AI sales agent. Top-level
   (no group). Each record is one conversation; messages live inline in
   `record.data.messages` as a JSON array. Renders a custom split-pane
   UI. Backed by `api/agent.ts` + `api/_lib/aiAgent.ts`. Requires
   `ANTHROPIC_API_KEY`. See `docs/prd/ai-agent.md`.

## Current Build Status
- [x] Phase 1: Foundation (types, store, layout, routing)
- [x] Phase 2: Model Builder (the most critical feature)
- [x] Phase 3: Record Views (list, form, table, cards)
- [x] Phase 4: Workflow Engine
- [x] Phase 5: Dashboard Builder
- [x] Phase 6: PDF Generation + Public Links
- [x] Phase 7: Polish (home page, schema.sql, toasts)

## Coding Conventions
- All components use TypeScript with explicit prop types
- No `any` types — use proper types from `src/types/index.ts`
- Use Zustand store via `useAppStore` hook — never fetch directly in components
- All IDs are UUIDs generated with `uuid` package
- Dates stored as ISO strings
- Field slugs (the `name` property) are snake_case
- File names: PascalCase for components, camelCase for utilities
- Co-locate component-specific sub-components inside a `components/` subfolder next to the page

## Environment Variables
```
VITE_SUPABASE_URL=your-project-url
VITE_SUPABASE_ANON_KEY=your-anon-key
ANTHROPIC_API_KEY=sk-ant-...      # server-side only, powers /api/agent + decks
SUPABASE_SERVICE_ROLE_KEY=...     # NEW 2026-05-17. Vercel-only env. Used by /api/generate-deck to insert deck_jobs (bypasses RLS) and by the Fly.io worker. NEVER expose to the browser.
WASSEL_DECK_WORKER_URL=...        # NEW 2026-05-17. Vercel-only. URL of the Fly.io worker (e.g. https://wassel-deck-worker.fly.dev). Optional — /api/generate-deck uses it for a fire-and-forget /wake ping after enqueueing; the worker's 3s poll catches missing wakes.
```
See `.env.example` for the full set including Haberchat + Hatif keys.

The Fly.io deck worker has its own env (set via `fly secrets set`): same `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_WASSEL_SKILL_ID`, and optional `ANTHROPIC_WASSEL_REVIEW_SKILL_ID`. See `worker/README.md`.

## Deployment Config (CRITICAL — `vercel.json`)
The app deploys to Vercel. Its config (`vercel.json`) is validated against a **strict JSON schema** (`https://openapi.vercel.sh/vercel.json`) at deploy time — every object inside `headers[]`, `rewrites[]`, `redirects[]`, etc. is `additionalProperties: false`. Any unknown key makes the deploy error out **before the build runs** (duration shows blank in the Vercel dashboard).

**Rules when editing `vercel.json`:**
1. **No custom keys.** JSON has no comments. Do NOT add `_comment`, `//`, `description`, or any other field the schema doesn't list. Explanations go in the commit message, not the JSON.
2. **`npm run build` does NOT validate `vercel.json`** — it only runs `tsc + vite build`. A green local build tells you nothing about deploy-config correctness.
3. **After any edit to `vercel.json` (or adding new Vercel-only config), verify before pushing.** Either:
   - Run `npx vercel build` locally (reproduces the full production build including config validation), OR
   - Open `vercel.json` in an editor with JSON-schema support — the `$schema` reference at the top will surface violations inline.
4. **Past incident (2026-04-22):** commit `f6a07f5` added `_comment` keys inside `headers[]` entries. Local build passed; three consecutive production deploys failed with blank duration until `_comment` was removed in `df7c09a`.

The same "strict schema, not validated by `npm run build`" principle applies to any other deploy-layer config we add later (e.g. `netlify.toml`, GitHub Actions workflows, Supabase `config.toml`).

## Silent Failures (CRITICAL — read before adding any try/catch or skip)

**This codebase has been bitten repeatedly by silent error catches.** All of the following bugs were hidden for weeks-to-months by silent swallowed errors:

- **1,000-row PostgREST truncation** — `supabaseLoad` called `.select('*')` with no pagination and no error surfacing. Counts under-reported across the entire app (706 vs 1,041 projects, 30 vs 636 competitors). Fix landed 2026-04-26 in `de997c0`.
- **localStorage 5–10 MB cliff** — `saveLocal`'s `try { ... } catch { /* silently ignore */ }` swallowed `QuotaExceededError`. Users hit the cap and their offline cache stopped saving with zero feedback. Fix landed 2026-04-26.
- **Inline-create UUID drift** — `value: uuid()` on every dropdown option re-create produced different UUIDs each time, silently breaking filters that referenced the older value. Fix landed 2026-04-26 in `e0a6d3b`.
- **Auto-ID race condition** — read-modify-write of `auto_id_counters` on the client; two concurrent saves silently produce duplicate IDs. Still unfixed.
- **Fire-and-forget Supabase upserts in `saveModel`/`saveRecord`** — if the upsert failed (RLS, network, FK violation), the local store kept the change but Supabase rolled back; next page load wiped the local copy. **Fixed 2026-04-26.** Failed writes now persist to a localStorage-backed queue (`wassell_pending_sync`) and `initialize()` drains it before any `supabaseLoad`. Writes that fail 5 times in a row are dropped with a toast + `console.error`. See `enqueuePendingWrite` / `replayPendingWrites` / the modified `supabaseUpsert` + `supabaseDelete` in `appStore.ts`.

**Hard rules — never violate:**

1. **Never write `try { ... } catch { /* ignore */ }`.** If you genuinely need to swallow an exception, scope it: catch the *specific* error class you're handling, AND write a comment naming the exact case it covers AND log via `console.error` at minimum. The reviewer should be able to read your catch and understand why every other failure mode would still propagate.

2. **Never wrap `reportSupabaseError`, `addToast`, or other error-surfacing paths in conditional skips.** When a toast is "annoying," the right answer is *fix the root cause* or *scope the silence narrowly with documented evidence*. The wrong answer — and we've been burned by it three times — is `if (someCondition) return; // skip the toast`. Every conditional silencer in this repo has a story; the story is always "we added it because the toast was annoying" and the punchline is always "we lost data because nobody knew the operation failed."

3. **Never add a fire-and-forget Supabase write that doesn't both surface AND persist failures.** Use `supabaseUpsert` / `supabaseDelete` from the store — they (a) call `reportSupabaseError` on failure to toast the user AND (b) enqueue the write to the persistent retry queue so it isn't lost when the next page load reads from Supabase. If you're calling `.upsert()` directly anywhere outside those helpers, you've reintroduced the bug — go through the helpers.

4. **When in doubt, fail loudly.** A red toast that the user sees and reports is infinitely better than a silent corruption they discover three months later. We have already lost weeks of trust to silent-failure bugs.

**Reference good examples:**
- `saveLocal` (post-2026-04-26 in `appStore.ts`) — surfaces `QuotaExceededError` once per key per session via toast + `console.error`.
- `supabaseLoad` (post-2026-04-26) — paginates and reports errors via `reportSupabaseError`.
- `supabaseUpsert` / `supabaseDelete` + the `wassell_pending_sync` queue (post-2026-04-26) — surface failures via `reportSupabaseError`, persist them to localStorage, and replay on next `initialize()` so unsynced edits survive a reload. Drops with a loud toast after `MAX_REPLAY_ATTEMPTS` (5) attempts.
- `findExistingOption` + `slugifyOptionLabel` in `DynamicField.tsx` — deterministic, no silent failure modes.

**If another agent (or you in a future session) proposes a fix that adds `if (!isSupabaseConfigured()) return;` or any conditional that skips an error-surfacing path:** push back. Verify against `git log` and `git diff origin/main` before merging — a fix that exists only in chat is not a fix.

## Verifying agent-claimed fixes (CRITICAL)

When any agent (including future Claude sessions) claims to have shipped a fix, verify before believing:

1. **`git log --oneline -10`** — is there a commit that matches?
2. **`git diff origin/main <file>`** — is the change actually in the working tree, or just staged, or only in chat?
3. **`grep -n <function-name> <file>`** — does the function the agent referenced even exist? (We've seen agents reference `isSupabaseConfigured()` which has never existed in this repo.)
4. **For deploy-affecting changes:** `vercel ls --scope wassel1 | head -3` — is the latest deploy `Ready` and from a SHA newer than the claimed fix?

A fix that exists only in an agent's chat output is not deployed and not real. Trust the SHA, not the prose.

## Worktree workflow (CRITICAL — added 2026-05-10)

Many parallel Claude sessions can be running, each in its own `.claude/worktrees/<name>/` worktree on a `claude/<name>` branch. The trap: a worktree created days/weeks ago has a `main` snapshot from days/weeks ago. If it pushes directly to `main`, it can silently revert every commit landed since.

**Past incident (2026-05-10):** with 65 simultaneous worktrees, several were 100+ commits behind `origin/main`. A single force-push from any of them would have wiped everything in between.

### The standard flow — rebase, then push to main. No GitHub UI required.

When the user says "push" or "deploy", do exactly this from the worktree:

```bash
git fetch origin main
git rebase origin/main      # if conflicts, STOP and ask the user
git push origin HEAD:main   # pre-push hook double-checks; Vercel deploys main
```

**No PR. No branch-push-and-wait. No clicking "Merge pull request" on GitHub.** The user has explicitly rejected those flows for routine deploys.

### After the push — verify it deployed AND works live (added 2026-06-08)

Pushing to `main` is **not** "done." Vercel auto-deploys `main`; confirm the deploy succeeded and smoke-test the actual change on the live app before reporting back. Claude can do this directly via the Supabase + Claude-in-Chrome MCPs — full recipes in `docs/claude-live-ops.md`. This is the deploy-side of the "test everything before done" rule.

1. **Capture the pushed SHA:** `git rev-parse HEAD`.
2. **Docs-only-to-PRD skip:** if the push touched ONLY `docs/prd/models/**` + `docs/prd/workflows/**`, `vercel.json`'s `ignoreCommand` skips the build — no deploy, nothing to verify. Any other path (code, `CLAUDE.md`, other docs) DOES deploy.
3. **Confirm the deploy** with the Vercel MCP `list_deployments` (project `prj_4ObF1mUW9KmmhFJDkoHCD0MZzJEh`, team `team_3UCVfsGz7gmIizM7AsVfczzW`): find the `target:"production"` / `meta.githubCommitRef:"main"` entry whose `meta.githubCommitSha` == your SHA, and poll (~30–60 s; builds take ~1–2 min) until `state:"READY"`. On `state:"ERROR"`, pull `get_deployment_build_logs`, fix, re-push.
4. **Smoke-test the live app** with the Claude-in-Chrome MCP on `https://app.wassel.re` (hard-reload to bust the hashed SPA bundle): exercise the exact behavior you changed and confirm it works; check `read_console_messages` (onlyErrors) for new errors; verify data via the Supabase MCP where the change touches data.
5. **Report with proof:** the deployed SHA + deployment id + what you tested. If it failed, say so — a bad prod deploy can be rolled back (deployments are `isRollbackCandidate`).

Skip the live smoke-test only when the change isn't observable in the running app (pure CI/tooling/test-only, or the docs-only skip above) — but still confirm the deploy reached `READY` (step 3).

### The safety net — pre-push hook

`scripts/safe-push-main.sh`, installed via `scripts/install-git-hooks.sh`, refuses any push to `main` whose local tip is not on top of `origin/main`. Lives in the *shared* `.git/hooks/` directory, so a single install protects every worktree of the repo (existing and future). To install or re-install: `bash scripts/install-git-hooks.sh` from any worktree. Bypass with `--no-verify` is **not allowed** without explicit user OK.

The hook is the safety net for when someone skips the rebase. It is NOT the workflow — always rebase proactively so the push goes through on the first try.

### Optional — preview deploys (only when the user asks)

Vercel auto-builds a preview URL for every non-main branch push: `wassell-claude-code-git-claude-<name>-wassel1.vercel.app`. Use this flow ONLY when the user explicitly asks for "a preview," "show me before going live," "open a PR," or similar:

```bash
git push origin HEAD            # branch push → preview URL builds (~2 min)
# user reviews preview URL
git fetch origin main
git rebase origin/main
git push origin HEAD:main       # ships to prod
```

Do not default to this flow. The user has explicitly said they don't want to open GitHub or wait on a preview for every push.

### When work ships

Kill the worktree (`git worktree remove <path>` + `git branch -d claude/<name>`). A stale worktree left around is a future landmine. Audit with `bash scripts/audit-worktrees.sh`; bulk-clean safely with `bash scripts/prune-worktrees.sh --apply` (skips anything dirty).

## Do Not
- Do not use `any` TypeScript type
- Do not hardcode Arabic or English strings in JSX
- Do not fetch from Supabase directly in components — go through the store
- Do not delete system models (is_system: true) — disable the delete button instead
- Do not break RTL layout — always test both directions when adding UI
- Do not add non-schema keys (`_comment`, etc.) to `vercel.json` — see "Deployment Config" above
- Do not silently swallow errors — see "Silent Failures" above
- Do not push directly to `main` from a stale worktree — see "Worktree workflow" above
