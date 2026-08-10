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
document_templates— binds a wassel_doc to a record model = the doc-generation template registry
document_jobs     — queue for the templated-PDF generation worker (see "Document generation pipeline")
listing_mirror_settings — kill switch + optional photo cap for the listing-photo mirror (see "Listing photo mirror")
```

## Database migrations — apply them yourself (added 2026-08-05)

**Standing rule from the user: NEVER ask whether to apply a migration — always apply it yourself.** When you write a migration under `supabase/migrations/`, apply it to the live database in the same session via the Supabase MCP (`apply_migration` against the `wassell-prod` project), then confirm it landed. Do not stop at "the migration must be applied" or "want me to apply it?" — that ask is exactly what the user has told us not to do.

- This **overrides** any older "ask the user to run it" wording elsewhere in this file (e.g. the frozen-model migration template below).
- Prefer backward-compatible migrations so applying early (before the code PR merges) is safe; call out explicitly if a migration is NOT backward-compatible and would break the currently-deployed code, but still apply it — don't withhold it pending a question.
- After applying, verify (query the changed object / run the migration's own validation) and report what landed with proof, same as any other change.

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
--
-- The two helpers CANNOT be called on their own — see "unwinding the view chain"
-- below. Drop every dependent view first, then rebuild in reverse:
DROP VIEW IF EXISTS public.v_our_projects_scope;   -- depends on unified_records
DROP VIEW IF EXISTS public.unified_records;        -- depends on <name>_v

SELECT public.regenerate_frozen_model_artifacts(
  (SELECT id FROM models WHERE name = 'clients')
);
SELECT public.rebuild_unified_records();

CREATE VIEW public.v_our_projects_scope AS ...;    -- restore the exact definition

COMMIT;
```

**Unwinding the view chain (CRITICAL — learned 2026-07-30):** neither helper uses
`CASCADE`. `regenerate_frozen_model_artifacts` runs a plain `DROP VIEW <name>_v`, but
`unified_records` is built on it; `rebuild_unified_records` runs a plain
`DROP VIEW unified_records`, but `v_our_projects_scope` is built on THAT. Calling
either one directly now fails with `SQLSTATE 2BP01 cannot drop view … because other
objects depend on it`. Before writing a frozen-model migration:

1. `SELECT DISTINCT dependent.relname FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class dependent ON dependent.oid = r.ev_class JOIN pg_class source ON source.oid = d.refobjid WHERE source.relname = 'unified_records' AND dependent.relname <> 'unified_records';`
   — enumerate the dependents, because the list grows every time someone stacks a
   reporting view on `unified_records`.
2. Capture each dependent's `pg_views.definition` AND its `pg_class.reloptions`, then
   drop them, call the two helpers, and recreate them.
   **`reloptions` is load-bearing:** `unified_records` and `<name>_v` are
   `security_invoker=true`, but `v_our_projects_scope` is NOT. Recreating it as an
   invoker view silently changes whose RLS applies to the website's project feed.
3. **Grants DO need restoring — the opposite of what this file said until
   2026-08-09.** Supabase's `ALTER DEFAULT PRIVILEGES` grants
   anon/authenticated/service_role on any new view in `public`, so recreating a
   view that deliberately LACKED those grants silently WIDENS access. Capture
   `information_schema.role_table_grants` per dependent and `REVOKE` back to the
   captured set. Measured: `v_market_listings` and `v_market_properties` had only
   postgres/service_role, and `market_listings_summary` had no anon grant.
4. **The generated `frozen_*` RLS policies block column DDL.** Their inline
   `jsonb_build_object(...)` names every column, so an `ALTER COLUMN … TYPE` or
   `DROP COLUMN` fails with `0A000 cannot alter type of a column used in a policy
   definition`. Drop all four first; `regenerate_frozen_model_artifacts` recreates
   them.
5. **`regenerate_model_view()` will NOT rebuild the `v_<name>` passthrough for a
   frozen model** — it returns early on `is_hardcoded`. If you dropped `v_<name>`
   as part of the unwind you must recreate it by hand, or the transaction fails at
   the very end.
6. **Never `ALTER COLUMN … TYPE` in place on a large frozen table.** It rewrites
   the whole table under `ACCESS EXCLUSIVE` — `market_listings` is 4.5 GB, which is
   a multi-minute outage and also exceeds the Supabase MCP's request timeout. Use
   add-shadow-column → batched backfill → catalog-only rename swap; only the swap
   locks, and it touches no heap pages. Worked example: `2026-08-09_03`.

The live dependency graph as measured on 2026-08-09 (re-derive it, it grows):
`market_listings` ← `market_listings_v`, `market_listings_summary`, `v_market_listings`;
`market_listings_v` ← `unified_records`;
`unified_records` ← `v_market_properties`, `v_our_projects_scope`, `v_website_public`.

Do it all in ONE transaction: the drops take `ACCESS EXCLUSIVE`, so concurrent readers
block until `COMMIT` instead of meeting a missing view.

**Field-type → column type mapping** (used by `freeze_model` and any migration you write — keep in sync):
- `text`, `textarea`, `email`, `phone`, `url`, `dropdown`, `auto_id`, `lookup` (single) → `text`
- `number`, `currency`, `formula` → `numeric`
- `date`, `datetime` → `timestamptz`
- `checkbox` → `boolean`
- `range` → expanded into `<name>_min`, `<name>_max` numeric columns
- `notes`, `section_mirror`, `section_selector`, `assignee`, `multi_image`, `multi_video` → `jsonb`
  - **`multi_image` / `multi_video` were MISSING from this map until 2026-08-09** and fell through to the `text` default below. They store a JSON array of URLs, so a text column held the array as a *string*, and `<name>_v` emitted `data.<field>` as a jsonb string instead of an array — every consumer gating on `Array.isArray()` silently saw nothing. That is what broke the listing photo mirror and the photo-cleaning lane after `market_listings` froze. Fixed in `freeze_model`, `freeze_apply_row` and `freeze_check_coercion` (`2026-08-09_04`); `market_listings`' own columns were converted by `2026-08-09_03`.
- `multiselect` → junction `<model>__<field>` with `(record_id uuid, value text, PK)`
- `lookup is_multi=true` → junction `<model>__<field>` with `(record_id uuid, target_record_id uuid, PK)`
- `table` → subtable `<model>__<field>` with `(id uuid, record_id, row_index, ...row columns)`
- `mirror` → SKIPPED (computed at runtime)
- `whatsapp_history`, `call_history` → SKIPPED (display-only — render derived data from `chat_messages` / `call_logs` based on the parent record's id and phone fields; never stored on the record)

**Hard rules — never violate:**

1. **Migrations on a frozen model MUST update both the table AND `models.schema`.** The Builder UI renders forms from the JSONB schema; if you ALTER a column without updating the JSONB, the new column will exist but the form won't show it. If you update the JSONB without ALTERing the column, the dispatcher RPC's `freeze_apply_row` will try to write to a column that doesn't exist and the save will fail.

2. **Always call `regenerate_frozen_model_artifacts(model_id)` and `rebuild_unified_records()` at the end of the migration — wrapped in the view-chain unwind above.** The first refreshes the `<name>_v` JSONB-shape view so the new column appears in reads AND regenerates the four RLS policies on the parent table (so the policy's inline `jsonb_build_object(...)` expression includes the new field for scope evaluation); the second rebuilds the UNION view across all frozen models. **Skipping the regen call on a schema change leaves the policy referencing columns that no longer exist (or missing the new column from scope checks) — both silent-correctness bugs.** Calling them WITHOUT dropping the dependent views first fails outright with `2BP01` — see "Unwinding the view chain".

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

## Persisted project rollups (units → all_projects) (added 2026-06-15; +2 available-only ranges 2026-07-04)

The thirteen `all_projects` aggregate fields (`unit_count`, `available_units` / `sold_units` / `reserved_units`, `price_range` / `area_range` / `bedroom_range` / `bathroom_range`, `available_price_range` / `available_area_range`, `avg_min_price_per_m2` / `avg_max_price_per_m2` / `avg_price_per_m2`) are **STORED aggregates maintained by Postgres triggers** — NOT virtual.

**Two range families (QA-003, 2026-07-04 — `supabase/migrations/2026-07-04_available_unit_rollups.sql`):** `price_range` / `area_range` span ALL units including sold + reserved (internal/admin surfaces keep them). `available_price_range` / `available_area_range` span AVAILABLE units only (`_rollup_status_is(unit_status,'available')`; JSON null when no units are available). **Customer-facing outputs MUST quote the available family** — WhatsApp project messages (`src/lib/projectMessageFacts.ts`), the website (site_settings card price slots = `available_price_range`; OG "ابتداءً من" in `Wassel Website/api/project.mjs`), the AI sales agent (`api/_lib/aiAgent.ts` prompt + price aggregate/budget filter, available-first), and the copywriter prompt (`api/_lib/copywriterAgent.ts`). Don't revert any of them to the all-unit range; a sold-out project deliberately shows NO price rather than a stale one. They were live-computed in JS and stripped before persist until 2026-06-15, so the database was blind (SQL views, the AI sales agent, BI, frozen models all read `records.data` and saw null). Now they live in `records.data` and every reader uses the same stored value.

**Architecture (all in `supabase/migrations/2026-06-15_persist_project_rollups.sql`):**
- `recalc_project_rollups_data(project_id) → jsonb` recomputes the patch from the project's units. **SECURITY DEFINER** so it counts ALL units regardless of the writer's RLS (else a salesperson who can create a unit but not edit the project would under-count it). Honors BOTH `is_rollup` and the legacy `is_computed` flag.
- **BEFORE INSERT/UPDATE trigger `records_fill_project_rollups`** on the all_projects rows fills the patch inline (`NEW.data := NEW.data || recalc(...)`) on EVERY write — so a user edit (or the removed save-strip) can never wipe them; the DB is authoritative.
- **AFTER INSERT/UPDATE/DELETE trigger `records_touch_project_on_unit_change`** on the units rows "touches" the linked project(s) (`UPDATE records SET data=data WHERE id=<project>`), which fires the BEFORE-fill recompute. Handles the **unit-moved-between-projects** case by touching BOTH old and new project. SECURITY DEFINER so the project UPDATE bypasses RLS. Realtime then pushes the new project row to the SPA (this replaces the old `useRolledUpRecords` subscription for live updates).
- No recursion: the touch targets a DIFFERENT model_id (all_projects) than units, and the BEFORE-fill mutates `NEW` inline (no second write).
- Schema flags are `is_rollup` / `rollup_kind` / `read_only:true` (renamed from `is_computed` / `computed_kind` on 2026-06-15; the transitional dual-read + the legacy aliases were removed in Phase 2). Lesson for renaming a flag on a live app: ship the app's reader change FIRST, then flip the DB flags.

**Hard rules — never violate:**

1. **The SQL aggregation in `recalc_project_rollups_data` MUST stay semantically identical to the JS in `src/lib/ourProjectsRollup.ts`** (bilingual `unit_status` matching, `try_numeric` coercion, skip `unit_area<=0` for price/m², `{min,max}` range shape, counts→0 when empty). They are two implementations of the same recipe; drift = the stored number disagrees with what the UI computes. Verified equal for all 11 projects-with-units before cutover.
2. **Never re-introduce the save-strip** for `is_rollup` fields in `appStore.saveRecord`. The trigger is the source of truth; stripping is pointless and the comment there explains why.
3. **Both triggers are SECURITY DEFINER for a reason** (count all units / bypass project RLS). Don't downgrade them to invoker rights or rollups silently under-count for non-admin writers.
4. **`all_projects` and `units` are UNFROZEN** (JSONB in `records`). If either is ever frozen, the triggers (which key off `records`) must move to the frozen table's write path — revisit before freezing.
5. **Single source of truth (Phase 2, done 2026-06-15):** the JS rollup engine (`src/lib/ourProjectsRollup.ts`), the `useRolledUpRecords` hook, `rollupRecordForMirror`, and the copywriter's ported recompute were all DELETED — every consumer (form, list, mirrors, `projectMessageFacts`, `get_project`) now reads the stored value. The SQL `recalc_project_rollups_data` is the ONE implementation. Don't re-add a client-side recompute; if a reader shows empty rollups, fix the trigger/data, not the reader.

**Backfill snapshot:** `public._backup_all_projects_rollups_20260615` (full pre-backfill `records` rows for all_projects). Drop once confirmed unneeded.

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

3. **Concurrent workers are safe via OPTIMISTIC CONCURRENCY — do not force `fly scale count 1`.** `record_save` overwrites the full `data`, so concurrent writers to the same conversation's `messages` array would clobber each other *without protection*. The protection: EVERY write to an `image_chats` record (endpoint append, worker fill, promote cache) uses `record_save` `p_expected_version` + retry on the 40001 version-mismatch (the `records_bump_version` BEFORE-UPDATE trigger increments `version` on each write, so a stale writer is bounced and re-applies onto the latest array). With that in place, ANY number of workers + concurrent endpoint appends are safe — the loser just retries (bounded ~6 attempts; the client's 3-in-flight-per-conversation cap keeps contention well under that). The deck worker app actually runs **5 machines** (throughput/HA) and image jobs ride on them safely. Do NOT pass `p_expected_version: null` for `image_chats` writes (that's the decks posture, safe only because each deck is its own record). *Verified live 2026-06-08: version bumps on UPDATE, record_save raises 40001 on stale version, and the worker pipeline completed a real generation end-to-end across the 5-machine app.* **Exception — clean-text jobs (2026-07-19):** the listing-photo cleaning fills (`runCleanTextJob`) no longer use `recordSaveWithRetry` at all — each terminal write calls the `clean_text_entry_patch` RPC (single row-locked UPDATE merging ONE `data.cleaning[]` element by entry id; migration `2026-07-19_clean_text_entry_patch.sql`). A same-second burst of ~3 s klein cleans convoyed on version conflicts and saturated the PostgREST pool on 2026-07-18 — do NOT "simplify" clean-text back to whole-data `record_save`. The optimistic posture above remains correct for `image_chats` session writes (whole-`generations[]` rewrites by many writer kinds).

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

## Office preview pipeline (files) (added 2026-06-11)

THIRD queue on the same Fly worker: `file_preview_jobs` converts office documents (DOC/DOCX/PPT/PPTX/XLS/XLSX) to PDF with headless LibreOffice so the Files preview modal + public share links render them inline. **Self-hosted by explicit decision** — Microsoft/Google embed viewers were rejected because they require giving an external service a fetchable URL of the file (contradicts the Files system's private-by-default posture).

- Flow: `POST /api/files/office-preview` (poll surface: ready→signed URL / pending / failed+retry) → `file_preview_enqueue` RPC (atomic, one active job per file via partial unique index) → worker `runPreviewJob.ts` (download → `soffice --convert-to pdf` in an isolated profile → upload `<uid>/<file_id>.preview.pdf` to the same private bucket) → `file_preview_complete` flips `files.preview_status='ready'`. Cache never invalidates (file bytes are immutable). Share-link creation + anon share views warm the cache.
- Migration: `supabase/migrations/2026-06-11_office_preview_pipeline.sql` (files.preview_* columns + queue + enqueue/claim/complete/fail/watchdog RPCs, service-role only).

**Hard rules — never violate:**
1. **Never hold an HTTP request open for the conversion** (same rule as decks/image-chats).
2. **`OFFICE_MIMES` in `worker/src/runPreviewJob.ts` is a COPY of `OFFICE_PREVIEW_MIMES` in `api/_lib/files.ts`** (and mirrored in `src/lib/files/client.ts`) — change all three together.
3. **Kill soffice as a process GROUP** (`spawn detached:true` + `kill(-pid)`), never via execFile's built-in timeout — the launcher re-spawns `soffice.bin`, and killing only the parent leaves an orphan that ate a 512 MB machine's memory until its health check went critical (live incident 2026-06-11).
4. **Alpine has NO `font-amiri` package** — Amiri TTFs are ADDed from google/fonts in the Dockerfile; `font-noto-arabic` comes from apk. Removing the fonts makes Arabic docs render as tofu.
5. **Known capacity limit:** `shared-cpu-1x:512MB` machines cannot convert very large image-heavy decks (a 17 MB pptx exceeded the 240 s ceiling). That's a graceful degradation (failure card + Download), not a bug. Scaling worker memory is a user billing decision.

## PDF compression pipeline (files) (added 2026-06-11)

FOURTH queue on the same Fly worker: `pdf_compress_jobs` compresses PDFs with Ghostscript (`gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook`, apk `ghostscript` in the Dockerfile) for the Files "Compress PDF" action (single + bulk). **Self-hosted by explicit decision** — the iLovePDF API was evaluated (user supplied its docs) and rejected: file bytes to a third party + a 250 files/month cap that dies under bulk compression.

- Flow: `POST /api/files/compress-pdf` (start=true → `pdf_compress_enqueue` RPC, atomic one-active-job-per-file; no flag → poll latest-job state) → worker `runCompressJob.ts` (download → gs → upload NEW object → INSERT NEW `files` row `"<name> (مضغوط).pdf"` carrying the source's folder/record-link/owner) → `pdf_compress_complete` with result id + before/after bytes. Saving <5% = complete with `result_file_id=NULL` ("no gain", no copy created). Bulk in the SPA enqueues all targets up-front, then watches with one sequential round-robin poll sweep.
- Migration: `supabase/migrations/2026-06-11_pdf_compress_pipeline.sql` (queue + enqueue/claim/complete/fail/watchdog RPCs, service-role only).

**Hard rules — never violate:**
1. **Never hold an HTTP request open for the compression** (same rule as the other three queues).
2. **Kill gs as a process GROUP** (`spawn detached:true` + `kill(-pid)`) — same posture as soffice (rule 3 above); 540 s timeout, 150 MB input cap.
3. **complete/fail RPCs only touch `status='running'` jobs**; `pdf_compress_watchdog()` sweeps running >15 min (must stay above the 540 s job ceiling).
4. **Never compress in place.** The result is always a NEW files row + NEW storage object (file bytes are immutable — the office-preview cache depends on it, and a bad compression must never destroy a source document). A failed `files` INSERT must remove the just-uploaded object.
5. **Timeouts requeue, they don't fail (attempts < 3).** Fly shared-cpu machines throttle to 1/16 vCPU once burst credits drain — measured live 2026-06-11: the SAME 19 MB brochure took 2m50s on a credit-fresh machine and >9 min (timeout) on a drained one. On a gs timeout the worker calls `pdf_compress_requeue` so a different machine claims the job, and sits out 2 poll intervals so the throttled machine doesn't re-claim its own requeue. Don't "fix" a timeout by only raising the ceiling — check which MACHINE ran it first.

## Document generation pipeline (records → templated PDFs) (added 2026-06-21)

SIXTH queue on the same Fly worker: `document_jobs` turns a CRM record into an official **A4 branded PDF** generated from a template. **A template is just an ordinary Wassel document** (`kind='wassel_doc'`, authored/branded/versioned in the normal Documents editor) bound to a record model via `document_templates`. ONE engine for the whole platform (Reservations + Offer Prices now; Financing/Deed/Contracts/Brochures later = add a template, no engine change). User decision: NOT hardcoded per-type generators; templates are business-editable in-app. Full PRD: `docs/prd/document-generation.md`.

- Flow: `POST /api/generate-document` (validate + `document_job_enqueue` via service-role after RLS-gating the SOURCE RECORD; templates are shared assets validated by existence/active/binding, NOT file-access) → worker `runDocumentJob.ts` claims via `document_job_claim_next` (JOINs `wassel_documents` for the template content+settings), resolves `{{tokens}}` from source→client→unit→unit's project→project (first-wins, same formatting as the editor preview), builds a branded **DOCX** (logo embedded), converts **DOCX→PDF via the SAME LibreOffice path as office-preview**, uploads to `wassel-files`, INSERTs a first-class `files` row (`kind='pdf'`), and `document_links` it to client/unit/project → `document_job_complete`. SPA polls `POST /api/document-status` (`{jobId}` → ready/pending/failed; `{recordId}` → list generated PDFs). **Send to customer** = `POST /api/send-document` (resolve client phone via `ksa_phone_canon` → download PDF → Haberchat `uploadFile`+`sendMessage` → log `activity_log document_sent`); the SPA shows a confirm modal (recipient + device + caption) first.
- UI: generic `RecordDocumentsPanel` on the record form (self-hides when the model has no templates) + `SendDocumentModal`; admin authoring at `/settings/document-templates` (`DocumentTemplatesPage` + `NewTemplateModal`, starters in `src/lib/documents/recordDocTemplates.ts`).
- Migrations: `supabase/migrations/2026-06-21_document_templates.sql` + `2026-06-21_document_generation_pipeline.sql`.

**Hard rules — never violate:**
1. **Never hold an HTTP request open for the render** (same rule as the other five queues — enqueue + poll, no SSE).
2. **`worker/src/documents/{variables,docx,pageSettings}.ts` are COPIES of `src/lib/documents/{variables,export,pageSettings}.ts`** (the worker is a standalone package — same posture as `worker/src/imageGen.ts`). Change BOTH together. **Deliberate divergence:** the src `buildDocxBlob` SKIPS images; the worker `docx.ts` EMBEDS base64 data-URI images as `ImageRun` (that's how the template logo reaches the PDF) — don't "fix" the worker copy to match src.
3. **complete/fail RPCs only touch `status='running'` jobs**; `document_jobs_watchdog()` sweeps running >10 min (above the 240 s soffice ceiling). soffice killed as a process GROUP (copied from `runPreviewJob.ts`).
4. **The generated PDF's `files.uploaded_by_user_id` is the public.users id; the storage-path prefix is `auth.uid()`** — the job carries BOTH (`owner_user_id` + `owner_auth_uid`). Confusing them makes the file invisible to its owner.
5. **Templates are shared, non-sensitive forms:** `document_templates` SELECT is open to all authenticated users (the Generate panel must list them for every role); writes are admin-only. The generate endpoint gates on SOURCE-RECORD visibility, not template file-access.
6. **Starters (`recordDocTemplates.ts`) are editable SEEDS, never the engine** — the engine always reads the live `wassel_doc`. The official Reservation/Offer templates must be created once via Settings → Document Templates before the panel appears on those records.

## Data Migration extraction pipeline (records → worker queue) (added 2026-06-23)

SEVENTH queue on the same Fly worker: `data_migration_jobs` runs the Data Migration wizard's **file-heavy AI vision** work (`extract` / `plan` / `discuss`) so it no longer happens synchronously inside a browser-held `/api/migrate` request. **Why:** for a `units` target, extraction is multi-call source-fusion (`discover` → `fuse_batch` per ~20 units) and every fuse batch re-sends the brochure/floor-plan PDFs to Claude; a large image-heavy brochure blew past Vercel's 300 s `maxDuration`, the connection was killed before a response, the browser threw `TypeError: Failed to fetch`, and the old in-tab job died on reload before its catch could persist `status='failed'` — freezing the record at `status='extracting'`, `error_message=null` (two real migrations, الماجدية 174/183, 2026-06-23). Same rationale + pattern as the decks/image queues above.

- Flow: `POST /api/migrate {action:'extract'|'plan'|'discuss'}` validates auth, RLS-gates the source record, writes the busy/status field **server-side** (+ for plan/discuss appends the operator's message), inserts ONE job via `data_migration_job_enqueue`, pings `/wake`, returns 202. The worker (`worker/src/runMigrationJob.ts`) claims via `data_migration_job_claim_next`, runs the copied agent with NO timeout, and patches the record (`status`/`phase`/`progress_done`/`progress_total`/`raw_table`/`prep_*`/`summary`) at every step. The SPA reads it live via Supabase Realtime — no held HTTP. `discover`/`fuse_batch` are NOT separate kinds: they run inside ONE `extract` job (keeps the unit index, the fuse prompt-cache, and the recursive `max_tokens` auto-split in one run). The fast text-only actions (`suggest_mappings`/`standardize`) stay synchronous on `/api/migrate`; the local `import` step (`startMigrationJob`) stays client-side (local record writes, not a held-open Anthropic call).
- Migration: `supabase/migrations/2026-06-23_data_migration_jobs_queue.sql` (table + indexes incl. one-active-per-record unique, RLS, enqueue/claim/complete/fail/cancel/watchdog RPCs, + a one-time cleanup that unsticks legacy `extracting`/`migrating` records to `failed`).

**Hard rules — never violate:**
1. **Never hold an HTTP request open for the extraction/plan/discuss vision call** (same rule as the other six queues — enqueue + Realtime, no SSE, no awaiting the agent in `/api/migrate`).
2. **`worker/src/migrateAgent.ts` is a VERBATIM COPY of `api/_lib/migrateAgent.ts`** (the worker is standalone — same posture as `worker/src/imageGen.ts`). Change BOTH when you touch extraction logic, model IDs, prompts, tools, or `ExtractionTruncatedError`. The orchestration wrapper (fuse auto-split, fusion summary, `applyDiscussColumns`) lives in `worker/src/runMigrationJob.ts` and must stay in sync with the deleted client logic / `StepReviewRaw.applyDiscussColumns`.
3. **SOLE-WRITER rule (echo-dedup):** during a job the BROWSER must never write the migration record via the store — a browser write registers a null-`updated_at` entry in the realtime echo-dedup (`src/lib/realtime/dedup.ts`) that would SUPPRESS the worker's next update. So the busy/status flip + message append happen server-side in `/api/migrate` (service role), and all job-time writes are the worker's. **Those worker writes use `record_save` with `p_expected_version: null` (VERSION-UNAWARE) — do NOT use optimistic concurrency here.** The data_migration draft is a single-logical-owner record that the browser wizard ALSO writes version-unaware (`MigrationWizard` `patch` + `jobRunner.patchMigrationRecord`, `expectedVersion:null`), which freely bumps the row's `version`; an optimistic worker write therefore loses every race and tight-loops on the 40001 retry → **Postgres CPU storm** (the 2026-06-23 الماجدية 174 incident — `runMigrationJob.patchRecord` originally copied the image_chats `p_expected_version`+retry posture; fixed to version-unaware in commit 44d0200). `p_expected_version`+retry is correct ONLY for image_chats (where every writer is optimistic), NOT here. The browser only reads via Realtime. (The `import` step is the lone exception — it writes the record from the tab, but no worker touches the record then.)
4. **complete/fail RPCs only touch `status='running'` jobs; the cancel/watchdog patch the record per-kind** (extract → `status='failed'`; plan/discuss → clear `prep_busy`/`discuss_busy`, status untouched). `data_migration_jobs_watchdog()` sweeps running >45 min (well above the worst-case sequential multi-batch run) — so a crashed worker can never leave a record stuck forever.

## Listing photo mirror (Aqar → our bucket) (added 2026-07-29)

Market-listing photos are copied into a bucket we own **at scan/import time**, so nothing user-facing ever downloads from `images.aqar.fm`. Rides the existing `generation_jobs` queue as `kind='listing-mirror'` (the same shape as `video-convert`).

**Why:** Aqar's Cloudflare blocklists datacenter egress **by ASN** and began 403-ing Fly's ranges around 2026-07-24. The clean-text lane downloaded each photo before calling fal, so every photo showed «فشل» with `source re-host failed: source fetch 403` — no fal/Anthropic spend involved. Measured 2026-07-29: laptop 200, me-central1 VM 200, Fly bom 200, but Fly **sin** (4 of 5 machines), a fresh Fly **fra**, and Fly **sjc** all 403. **Region-hopping is not a fix.**

**Architecture:**
- `records.data.image_mirror_map = { "<aqar url>": "<our listing-photos url>" }`, keyed by SOURCE URL (same convention as `video_mp4_map`) → order-independent and idempotent on re-scan.
- Trigger `records_enqueue_listing_mirror` (AFTER INSERT/UPDATE on `records`) enqueues one job per market listing whose `image_urls` actually changed. `IS DISTINCT FROM` makes the weekly reconcile's ~3,000 price/sold updates free.
- Worker `worker/src/runListingMirrorJob.ts` downloads via `worker/src/lib/aqarFetch.ts` (direct → me-central1 proxy), uploads to `listing-photos` at `<listing_id>/<sha256(source_url)>.<ext>` with `upsert:true`, and merges the map via the row-locked `listing_mirror_map_patch` RPC.
- `api/templates/clean-listing-images.ts` resolves the map into each clean-text job's `params.fetch_url`; `runCleanTextJob` hands that straight to fal (no Aqar download, no re-host).
- Migration: `supabase/migrations/2026-07-29_listing_photo_mirror.sql`. Backfill: `scripts/backfill-listing-mirrors.mjs`. PRD detail: `docs/prd/chats.md` (Listing Message bullet).

**Hard rules — never violate:**

1. **Never make the historical backfill automatic, and never remove `max_queue_depth`.** 408,399 photos currently download through the me-central1 proxy, which shares a small VM with the **WhatsApp gateway**. Two guards keep that bounded: the backfill is an operator-run, throttled, resumable script (`--dry-run` first), and `listing_mirror_enqueue` refuses to queue past `listing_mirror_settings.max_queue_depth` (default 200) **for every caller including the trigger** — otherwise one scanner catch-up run (the 2,121 listings pending on 2026-07-29) would queue ~16,000 downloads in a single batch. Turning a listing away costs nothing: the backlog lives in the DATA (`image_mirror_map`), not in the queue, so it is picked up by the next scan-update, the backfill, or the clean lane's self-heal.
2. **Never delete the `LISTING_IMAGE_PROXY_*` fallback.** It is no longer a stopgap — it is the only working egress from Fly, so it is the path the mirror itself downloads through, AND the clean lane's fallback for un-mirrored photos. Removing it breaks both. (Decision + rationale recorded in `infra/imgproxy/README.md`.)
3. **A missing mirror must always degrade, never fail.** The clean lane falls back to the direct→proxy download and enqueues a mirror for next time. Never make `fetch_url` required.
4. **Partial mirroring is success.** One refused photo stays un-mirrored (and falls back); the job fails only when EVERY photo failed, which is the real signal that egress is broken. Don't "fix" this by failing the whole listing.
5. **Keep the map write on `listing_mirror_map_patch`.** It merges one sub-object inside a single row-locked UPDATE — no version check, so it can never convoy against the scanner's merge, the REGA lookup worker, or the video-convert cache on the same listing row (same lesson as `clean_text_entry_patch`, 2026-07-18).
6. **The scanner must keep updating listings through `market_listing_merge`** (`data = data || jsonb_strip_nulls(patch)`). A raw `PATCH /records {data:…}` replaces the whole JSONB column and would wipe `image_mirror_map`, `video_mp4_map`, `original_image_urls`, and the REGA fields.
7. **Storage does not cascade.** Deleting a listing removes its job (FK CASCADE) but leaves its mirrored photos in the bucket; replaced photos leak the same way. Objects are namespaced `<listing_id>/…`, so pruning is "delete prefixes with no matching record" — via the **Storage API**, not SQL (`storage.protect_delete` refuses a direct DELETE on `storage.objects`). Keep this manual; deleting bytes from a trigger is how a bad join destroys data.

**Verified live 2026-07-29** (migration applied, worker deployed, prod): a 5-photo listing mirrored in 4.0s with 0 failures, each object byte-identical to Aqar's original (87,610 B); the worker logged `direct fetch refused (source fetch 403) — retrying via image proxy` for all 5, confirming Fly sin is blocked and the proxy is the working path. A real clean-text job then logged `using mirrored source`, completed in 8.8s, produced a correct watermark-free image, and made **zero** Aqar requests. Trigger checked both ways: a no-op `data = data` write on a real listing enqueued nothing (the weekly-reconcile shape), while an INSERT enqueued one job with `reason='scan-insert'`.

## Documents real-time collaboration (Yjs CRDT) (added 2026-06-11)

Wassel documents (`kind='wassel_doc'`) are co-editable: TipTap `Collaboration` binds the editor to a shared Y.Doc; updates flow over Supabase Realtime **broadcast** channel `ydoc:<file_id>` via `SupabaseCollabProvider` (`src/lib/documents/collab.ts`) — no websocket server. `wassel_documents` now has THREE content representations: `content_json`/`content_html` (readable derivations — previews, share links, exports) and `ydoc_state` (base64 CRDT blob — the collaboration source of truth).

**Hard rules — never violate:**
1. **Never bootstrap a Y.Doc from `content_json` when `ydoc_state` exists.** CRDT merging depends on shared internal identities; two independent JSON bootstraps duplicate every paragraph on merge. Seeding happens EXACTLY ONCE, guarded by `UPDATE … WHERE ydoc_state IS NULL` (losers re-fetch the winner's blob). If you ever rewrite a doc's content server-side (migration/script), either go through a live editor session or NULL out `ydoc_state` in the same transaction so the next open re-seeds.
2. **Never set TipTap `content` on a collab-bound editor** (it would re-insert the body into the shared doc for every joiner — duplication). The page mounts `DocumentEditor` only after `bootstrapCollabDoc` resolves and passes `ydoc`; `initialContent` is used only in the no-Supabase fallback.
3. **StarterKit `undoRedo` must stay OFF under collab** — `Collaboration` registers Y.UndoManager-backed undo/redo (undo only reverts YOUR edits).
4. **Suggestions/automation must ignore remote transactions** — filter with `isChangeOrigin(tr)` (see SuggestionExtensions' appendTransaction) or remote edits get marked as local proposals.
5. `canEdit` on the doc editor page is **effective-role-aware** (`wassell_effective_file_roles` RPC), NOT uploader-only — shared editors need the editing surface for co-editing. RLS remains the server-side gate.

## Durable bilingual translation (AR/EN record values) (added 2026-08-02, W1–W8)

One human entry → automatic generation + persistence of BOTH languages → both usable everywhere. A user types a field in whatever language; the OTHER language is machine-translated (DeepSeek, Haiku fallback) and displayed on demand. `records.data` is never mutated by translation — translations live in their own tables. The approved-plan lives at `~/.claude/plans/soft-launching-backus.md`; PRD is `docs/prd/internationalization.md`.

**Architecture (migrations `supabase/migrations/2026-09-01_0*` + `2026-09-02_0*`):** `translation_units` (ONE canonical source-state row per `(resource_kind, entity_id, field_path)` with a monotonic `generation` for CAS) → `translation_variants` (per-language ar/en display rows, `role='source'|'target'`) → `translation_revisions` (append-only). Plus `translation_field_policies` (which fields translate; `classification_status` heuristic `proposed` → human `confirmed`), context-keyed `translation_memory`, `translation_glossary`, `translation_settings` (global kill switch), the coalescing `translation_jobs` queue, and `search_documents` (trigram search). The Fly worker's 8th lane (`worker/src/runTranslationJob.ts`) drains the queue: tier resolution official-counterpart → glossary → TM → provider, generation-CAS variant activation, protected-fact assertion (digits/URLs must survive translation).

**LIVE state (2026-08-02):** pipeline enabled; `record` resource enabled + `read_live`; 6 cutover models (`all_projects`, `developers`, `units`, `clients`, `our_projects`, `competitors`); ~10.4k units. The SPA reads variants per record via `src/lib/recordTranslation/{store,resolver}.ts` (`resolveFieldDisplay(entityId, fieldPath, raw, lang)`).

**Hard rules — never violate:**

1. **NEVER import the browser translation store into a module that `api/**` or `worker/**` also import.** `projectView.ts`, `recordSearch.ts`, `analytics/grouping.ts`, `workflowEngineCore.ts` are imported by server bundles — pulling in `@/lib/recordTranslation/store` (which imports `@/lib/supabase` + `import.meta.env`) breaks the server build (the W0 `grouping.ts` regression). Translation reaches these via an **INJECTED resolver** (`translate` / `localizeField` / `resolveText` param passed from the caller), never an import. Same rule the `localizedName.ts` cross-import (src↔api, tsconfig.api.json) is the ONE exception to — it's pure and documented.

2. **The capture trigger (`tg_records_enqueue_translation`) is the highest-blast-radius object — every record save runs it.** Its enqueue predicate matches a changed key against `split_part(field_path,'[',1) = key OR key = either side of twin_counterpart_path`. Editing it: re-emit VERBATIM from the LIVE definition (`pg_get_functiondef`) with ONLY your one change; the scalar-match clause must stay identical (a slip can only mis-enqueue a harmless job, never break the save, but keep it that way). It skips any `wassell.system_write` GUC (twin_fill / element_id_backfill / row-id backfill) so machine writes never re-capture.

3. **Generation CAS is the correctness backbone.** Every worker activation is `WHERE generation = claimed_generation`; a save landing mid-provider-call bumps the generation (the capture trigger clears displays + search text SYNCHRONOUSLY in the same tx) and the stale result is discarded. The lifecycle RPCs (`record_translation_approve/human_edit/set_source_lang`) take `p_expected_generation` and raise 40001 on mismatch. Never serve a `translation_variants` row where `variant.generation <> unit.generation` — every reader (SQL `record_data_localized`, the SPA store, `v_website_public`, the server `recordLang` overlay) enforces this.

4. **Ship DARK, activate deliberately.** Policies land `proposed`; nothing processes until a human `confirmed`s them (or a migration does, for the cutover set). Resources gate capture; `translation_settings.is_enabled` gates BOTH the capture trigger AND `translation_job_claim_next` + `translation_reconcile` (the W2 kill-switch-bypass lesson: OFF must mean off everywhere). Twin go-live = flip the pair policies to `confirmed` (both the capture trigger AND `translation_twin_backfill` gate on `classification_status='confirmed' AND field_path LIKE 'pair:%'`) + run `translation_twin_backfill(model_id)` to sweep existing one-sided records. **Twin pairs went LIVE 2026-08-05** for `chat_templates` (pair:body) and `posts_content` (pair:body/headline/prose/spec) — confirmed + backfilled; ongoing edits auto-fill via the capture predicate.

5. **Twins (`pair:*`) materialize into the PHYSICAL column, not a variant.** `record_twin_fill` (CAS: source-sha unchanged AND target still empty/prior-machine-text) writes the other `_en`/`_ar` column under the `system_write='twin_fill'` GUC. v1 fills EMPTY sides only. Don't route twins through the variant/display path — the app reads the twin columns directly. **The source-CAS trim MUST match the worker's JS `.trim()`** — `record_twin_fill` hashes `regexp_replace(col,'^\s+|\s+$','')` (full `\s` class), NOT `btrim(col)` (space-only): a `btrim` there silently SKIPS any twin whose authored side ends in a newline (the 2026-08-05 go-live bug, fixed in `2026-09-02_09_twin_fill_trim_parity.sql`). A digit/URL the DeepSeek output drops trips `assertFactsIntact` and the item fails LOUDLY (stays one-sided, retryable) — that guard is correct, don't weaken it.

6. **The website (`v_website_public`) is the ONLY anon-exposed translation surface, gated by the TWO-KEY rule:** a field needs BOTH `public_publishable=true` in its policy AND a `website_publish_fields` allowlist row. The view is `security_invoker=false` by design (it embeds is_public × allowlist × generation-valid) and MUST be dropped/recreated in the frozen-model view-chain unwind. The separate `Wassel Website` repo (C:/Users/rayan/Claude/Wassel Website, Vercel project `wassel-website`, no git — deploy via `vercel --prod`) overlays `value_en` at load; it reads the view, never the translation tables.

7. **Client search folding must stay identical to SQL `wassell_search_norm`.** `normalizeForSearch` (`src/lib/recordSearch.ts`) folds أإآ→ا, ة→ه, ى→ي, strips tatweel, unifies digits — the SAME as the IMMUTABLE SQL function (which backs the trigram GIN expression indexes). Changing the SQL function requires REINDEXing those GINs in the same migration.

8. **The legacy on-demand overlay (`src/lib/valueTranslation/runtime.ts` `resolveDisplayText`) is NOT dead — do not remove it.** It still serves: (a) `resolveFieldDisplay`'s fallback when a render site has no record id, and (b) the Marketing OS content values (`useMosText`, W6-M — `mkt_*` is NOT in the durable pipeline). It doubles as the worker's translation memory. Removing it needs those consumers migrated first.

9. **Migration gotchas:** (a) PostGIS/frozen-table RPCs need `SET check_function_bodies = off` so the CI ephemeral DB (no PostGIS, minimal fixture) can create them; (b) guard data-fixes on frozen tables (`districts`, etc.) with `to_regclass` — CI doesn't have them; (c) NEVER call `digest` inside the records capture trigger (search_path); the trigger uses a stub `source_rev`, the worker computes the real sha. CI validates every `2026-09-0*` migration against `postgres:17` via `.github/workflows/ci.yml` `db-migrations` + `supabase/tests/ci/smoke_translation.sql` (smokes 1–13).

## Marketing OS capabilities are DATA (added 2026-08-06)

The Marketing workspace (`/m`) permission model has TWO axes, both editable in **Marketing → Settings → Roles and permissions** (`SettingsAccess.tsx`, a segmented Surfaces/Capabilities matrix):

- **Surfaces** (`surface_access` table) — coarse rail visibility per role: `full` / `read` / `hidden`. Editing surfaces is visibility ONLY.
- **Capabilities** (`role_capabilities` table — `(role_id, capability)`, presence = granted) — what a role can DO. This is what RLS enforces and what the UI's `can()` checks. **Capabilities used to be hardcoded** in the `wassell_mos_can` SQL `CASE` + a duplicate client `MATRIX` + scattered `role === 'ceo'` component checks; all three were collapsed into this one data table on 2026-08-06.

**How it resolves (keep these in sync):**
- `wassell_mos_can(capability)` — the RLS gate — reads `role_capabilities` (admin bypass via `wassell_is_admin`; `viewer` read-floor kept hardcoded). Signature unchanged, so all `mos_*` RLS policies are untouched.
- `wassell_mos_capabilities()` — the caller's capability UNION over held roles — is shipped in the bootstrap `me.capabilities`; the client `can()` reads that Set. **There is no client capability matrix anymore** — do not re-add one.
- The canonical capability list lives in THREE places that MUST stay in sync: the seed in `supabase/migrations/2026-08-06_01_role_capabilities.sql`, `CAPABILITIES` in `api/marketing-os.ts`, and the `Capability` type in `MarketingWorkspace.tsx`. Adding a capability = seed it + add to both TS lists + reference it in the component/RLS that gates on it.

**Hard rules:**
1. **Never gate a Marketing UI element on the ACTIVE role string** (`role === 'ceo'`). Use `can('<capability>')` — capabilities are the union of HELD roles, and active-role gating is exactly the bug that hid the CEO's Content tab. Fine-grained view gates exist for this: `view_content_body`, `view_activity`, `compare_versions`.
2. **Changing what a role can do is a DATA edit** (the Roles screen, or `role_capabilities` rows) — NOT a code change. Roles are fully customizable presets; `ceo`/`writer`/etc. have no baked-in meaning in code.
3. **Capability writes go through the `capability_set` action** (RLS `role_capabilities_ins`/`_del` gated by `manage_roles`) — same posture as `surface_set`. Don't write `role_capabilities` from the browser store.
4. **`roles.domain`** (`sales`/`marketing`/`intel`) namespaces the shared `roles` table. Marketing roles are `mos_*` keys / `domain='marketing'`.
5. **Hand-assigned tasks are a SEPARATE table from the workflow queue** (added 2026-08-10). `workflow_role_tasks` stays workflow-only: bound to a content item, one open row per item, owned by a role, closing it advances the pinned path. Manual tasks live in `mos_manual_tasks` (+ `mos_task_series` for repeat rules, materialized by the idempotent `mos_task_series_materialize()` on every task read — pg_cron is not enabled here). Don't "unify" them: the one-open-per-subject unique index, the five-role CHECK and the advance-on-close RPC all assume the workflow shape. Assigning to others is gated by the `assign_task` capability; assigning to yourself is always allowed; a BEFORE-UPDATE trigger (`mos_tg_manual_task_guard`) stops an assignee editing their way out of a task they can only close.
5. Marketing-Intelligence still uses its OWN hardcoded `wassell_mkt_can` CASE + `mkt_role_grants` (NOT yet folded into `role_capabilities` — that's pending Phase 5). Sales permissions are a SEPARATE engine (`profiles.model_permissions` — see `docs/prd/access-control.md`); do not conflate.

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

## Encrypted secrets bundle — how any fresh checkout gets its env (added 2026-08-09)

**This repo is PUBLIC.** Secrets still travel with it, encrypted. `secrets/wassel-secrets.enc` is an AES-256-CBC (PBKDF2, 600k iterations) tarball of `.env`, `.env.local`, `.deploy-secrets.local`, and `~/.fly/config.yml`. It **is committed**; the passphrase is not.

**If you are a session in a fresh checkout — cloud sandbox, new worktree, new machine — run this first:**

```bash
bash scripts/bootstrap-session.sh
```

It unseals secrets, installs deps, installs the pre-push hook, refreshes the generated PRDs, and prints what the environment can and cannot do. It needs `WASSEL_SECRETS_PASSPHRASE` in the env (cloud) or `.secrets-passphrase.local` in the main working tree (laptop). This also fixes the long-standing "a fresh worktree has no `.env`" problem — `unseal.sh` restores into the *current* working tree and finds the passphrase in the main tree.

**Hard rules — never violate:**

1. **Never commit a plaintext secret.** `.gitignore` blocks `.env`, `.env.local`, `*.local`, `.secrets-passphrase.local`. Do not add exceptions, and do not "temporarily" commit a key to debug a cloud session — this repo is public and history is forever.
2. **Editing a secret does not update the bundle.** Re-run `bash scripts/secrets/seal.sh` and commit `secrets/wassel-secrets.enc` + `secrets/MANIFEST.md`. A cloud session reading a stale bundle fails in confusing ways.
3. **`secrets/MANIFEST.md` is generated — never hand-edit.** It records variable *names* only, so the bundle's contents stay auditable without the key.
4. **Adding a new secret file** means adding a line to `scripts/secrets/files.list` before sealing, or it is silently absent in the cloud. `seal.sh` warns loudly about listed-but-missing files; it never drops one quietly.
5. **If the passphrase leaks, rotating it is not enough** — the old ciphertext stays in git history, so rotate the underlying keys too.

Full runbook, including the one variable to set per cloud environment and what still cannot work in a sandbox: `docs/cloud-session-setup.md`.

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
