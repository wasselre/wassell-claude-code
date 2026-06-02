# PRD: Data Migration

**Status:** Live
**Last updated:** 2026-06-01
**Related PRDs:** [import-export.md](import-export.md) (reuses the Excel import core), [record-management.md](record-management.md) (writes records via the same save path), [data-storage.md](data-storage.md) (RPCs + storage bucket), [model-builder.md](model-builder.md) (target field types + options)

## What it is (in plain English)

A guided wizard that turns the messy data developers send us — Excel files, PDFs, screenshots, photos, in any mix — into clean records inside any model, with a human approving every change before it lands. You open **Data Migration** (ترحيل البيانات) in the sidebar, start a new migration, pick which model to import into, and drop in your files. The app reads them into one table, lets you review and fix that table, figures out which column maps to which field, and — for dropdown / multi-select / lookup fields — proposes how to standardize each raw value to match what the app expects (e.g. "شقه" → the option "شقة", "Apartment" → "شقة"), showing every proposed change as a before→after you approve, override, or redirect to a different field. When you're happy, you click **Migrate** and the records are imported.

You don't have to start from messy files: if you already have a clean table, upload an Excel/CSV (or paste into the in-app grid) and jump straight to the mapping step.

## Why it exists

Onboarding a developer's project + units used to be a manual, hours-long job: eyeball the files, retype into a spreadsheet, rename values to match the app's dropdowns, fix number/date formats, match developer/project names to existing records, then import. This wizard builds that whole process into the app, with AI doing the tedious extraction/matching and the operator staying in control via explicit approval gates.

## Key behaviors

- **One migration = one record** in the `data_migration` system model. The entire wizard state (target model, raw table, mappings, value decisions, result) lives on `record.data`, so you can close the tab and resume exactly where you left off.
- **Two entry modes** from one drop zone: clean **Excel/CSV is parsed in the browser** (never sent to AI) and goes straight to the review table; **PDF/images/screenshots** are uploaded and read by Claude into a unified table. You can also start with a blank table.
- **The raw table is yours to edit:** edit cells in-app, add/remove rows & columns, **download it as Excel**, fix it externally, and **re-upload** — or keep editing in place. Re-uploading replaces the table and resets downstream mappings (headers may have changed).
- **AI suggests column→field mappings**, you adjust them. Range fields expose two targets (min/max). Non-importable field types (formulas, mirrors, auto-IDs, files, notes) are never offered as targets.
- **Value standardization with approval (the core promise):** for each dropdown/multi-select/lookup column, the app proposes, per distinct value, one of: match an existing option/record, create a new option/record (only on your explicit approval), leave blank, or **move this value's rows to a different field** (splitting a column). Nothing is created or changed until you click Migrate. "Accept all high-confidence" bulk-applies the ≥90%-confident proposals.
- **Multi-select stays multi-value end-to-end** — values are kept comma/`،`-separated and standardized per token, never collapsed to one (a deliberate departure from the Excel template export, whose single-select in-cell dropdown can't represent multiple values).
- **AI-counted number fields** — flag a number field (e.g. bathrooms / bedrooms) as "AI-counted" in the mapping step. For each unit the AI reads that row's full description and returns the **total** (summing explicit numbers AND implied ones — an en-suite mentioned in a bedroom = +1 bathroom — without double-counting; 0 when unknown), shown per-unit and **editable before migrate**. A counted field is computed, not mapped from a column (it's removed from the column targets). One row = one unit. The AI's text (notes / mapping & standardization reasons / count reasons) follows the UI language — Arabic in the Arabic app.
- **Lookups avoid duplicates:** "link existing" rewrites the value to the matched record's display so the importer resolves to that record; only an explicit "create new" mints a new developer/project.
- **Migrate reuses the proven import core** (`mapImportedRows`) and the standard `saveRecord` path, so auto-IDs, formulas, frozen-model dispatch, duplicate-skip, and the offline retry queue all work exactly as they do elsewhere. Per-row failures are reported, never silently dropped.
- **`data_migration` is never freezable and never a migration target** (it's excluded from the target picker and the Freeze modal).

## User flows

1. **Main happy path (messy files):** New migration → pick model → drop PDF/images → *Extract data* → review/fix the raw table → *Suggest column mapping* → adjust → *Review values* → approve/override each value → *Migrate* → "Imported N records into <model>".
2. **Fast path (clean data — "start at step 5"):** New migration → pick model → upload a clean Excel/CSV (or start blank + paste) → review → mapping → standardize → migrate.
3. **Edit-and-re-upload:** at the review step, Download Excel → fix in Excel → Re-upload corrected (mappings reset) → continue.
4. **Error/empty states:** an AI step that fails or times out shows a loud toast + the wizard stays put so you can retry or fall back to manual mapping; a model with no dropdown/lookup columns skips straight to a "ready to migrate" state; very large tables (>500 rows) render the first 500 for in-app editing with a note that all rows still migrate (edit the rest via download).

## Data touched

- **Reads:** `models.schema` (target field types, options, lookup config), `records.data` of the lookup-target and target models (existing values for matching + duplicate-skip), uploaded files in the `wassel-migrations` Storage bucket.
- **Writes:** `records.data` (JSONB) for the imported rows + any auto-created lookup records, via `record_save`; the target model's `schema` when the user approves new options; the `data_migration` record's own `data` at every step (resume state); uploaded files to `wassel-migrations` (`<auth.uid()>/<recordId>/uploads/...`).
- **AI:** `POST /api/migrate` (`action: extract | suggest_mappings | standardize`) — Claude vision for extraction, text for mapping/standardization. No data is persisted server-side; the endpoint fetches signed-URL files and returns structured JSON.
- **Bulk RPC available (not yet wired into the live path):** `records_bulk_save` + `record_reserve_auto_ids` exist as a future fast-path for very large imports.

## Key files

| File | What it does |
|---|---|
| `src/pages/DataMigration/DataMigrationPage.tsx` | Split-pane shell: past migrations list + active wizard |
| `src/pages/DataMigration/components/MigrationWizard.tsx` | Step machine; reads/writes wizard state on the record |
| `src/pages/DataMigration/components/steps/*` | One file per step (pick model, upload, review, mapping, standardize, migrating, done) |
| `src/pages/DataMigration/components/EditableRawGrid.tsx` | In-app editable raw table |
| `src/pages/DataMigration/components/ValueStandardizationColumn.tsx` | Per-value before→after approval UI (the core) |
| `src/pages/DataMigration/components/CountFieldReview.tsx` | Per-unit review of AI-counted number fields (editable) |
| `src/pages/DataMigration/lib/client.ts` | Upload + signed-URL + `/api/migrate` callers (with timeouts) |
| `src/pages/DataMigration/lib/applyStandardization.ts` | Rewrites raw cells to canonical values + routes values to other fields |
| `src/pages/DataMigration/lib/runMigration.ts` | Orchestrates apply → `mapImportedRows` → dup-skip → `saveRecord` |
| `src/pages/DataMigration/lib/{types,targetFields,buildStandardization}.ts` | Shared types + field/option helpers + AI→decision bridge |
| `api/migrate.ts` + `api/_lib/migrateAgent.ts` | The AI endpoint + Anthropic tool-use logic |
| `src/lib/excelUtils.ts` | `readExcelFile`, `exportRawTable`, `mapImportedRows` (reused) |
| `src/data/seedModels.ts` | `data_migration` system model seed |
| `supabase/migrations/2026-06-01_*.sql` | `wassel-migrations` bucket + RLS; `records_bulk_save` / `record_reserve_auto_ids` RPCs |

## Open questions / known limitations

- **AI quality needs live verification:** extraction/mapping/standardization were verified end-to-end with simulated responses and via the deterministic fallbacks; the actual Claude calls require the authenticated app (MFA-gated) to validate output quality. The non-AI paths (clean-Excel entry, grid editing, mapping adjustment, value approval, route-to-field, migrate) are fully verified.
- **Extraction size:** bounded by Anthropic per-request limits (images ≤5MB, capped file count) and the model's output budget (≈a few hundred rows). For very large datasets use the clean-Excel path; oversized inputs surface a `truncated` notice rather than failing silently.
- **Bulk insert path:** the live migrate uses `saveRecord` per row (correct + proven, slower at scale). `records_bulk_save` is built and DB-verified but not yet wired in — a clean follow-up to speed up multi-thousand-row imports.
- **Routed values aren't re-standardized:** a value moved to another field is stored as-is; if that target field is itself a dropdown, the value may need manual fixing afterward.
- **One target model per migration:** units link to projects via the normal lookup auto-match (a "project name" column resolves/creates the project) — there is no combined parent+child wizard.
