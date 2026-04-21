# PRD: Data Storage, Sync & Offline

**Status:** Live
**Last updated:** 2026-04-18 (storage shape for multi-select lookup + mirrored sections; migration v7; system models no longer overwritten on reload — Builder edits are authoritative; `section_mirror` field type storage)
**Related PRDs:** model-builder.md, record-management.md, navigation-layout.md

## What it is (in plain English)
All of the app's data — models, records, workflows, dashboards, users, settings — is stored in a Supabase PostgreSQL database, with the flexible parts (schemas, record data, widget configs) held as JSONB. Every save is **mirrored to the browser's localStorage first** so the user sees an instant response, and then synced to Supabase in the background. If Supabase isn't configured at all, the app works fully offline against localStorage alone.

## Why it exists
Real-estate offices in Saudi Arabia sometimes have spotty connectivity. We don't want a hang during save. The localStorage-first approach gives instant feedback, and the JSONB-in-Postgres approach lets us ship schema changes (new field types, new workflow actions) without a DB migration.

## Key behaviors
- **6 Supabase tables:** `models`, `model_groups`, `records`, `workflows`, `dashboards`, `model_views`.
- **JSONB columns** hold the variable parts:
  - `models.schema` — the full sections/fields/options tree. `ModelField.is_multi` (optional bool) toggles a `lookup` field into multi-select mode. `ModelSection.is_mirrored` + `mirror_via_lookup_field_id` + `mirror_source_section_id` mark a section as mirrored from another model (local `fields` stays empty).
  - `models.card_config` — card view layout
  - `records.data` — field-slug → value map. Single-select lookup stores a `string` (record id); multi-select lookup (`is_multi: true`) stores a `string[]`. Mirror fields and mirrored sections store **nothing** — values are derived at render time by `mirrorResolver` / `sectionMirrorResolver`. `section_mirror` fields store a `Record<childSlug, value>` of **local overrides** only — any child value whose sync-back is on bypasses this map and flows into the linked record via the standard mirrored-section fan-out on save.
  - `workflows.definition` — trigger + conditions + actions
  - `dashboards.widgets` — widget configs + layout
  - `model_views.field_ids` / `model_views.conditions` — per-user saved table view (columns + filters)
- **Save path:**
  1. Update Zustand store in memory (UI re-renders).
  2. Write to localStorage synchronously (instant persistence).
  3. Fire-and-forget sync to Supabase (`.upsert()`); errors are toasted but don't block the UI.
- **Mirrored-section write-back:** when saving a record that contains mirrored sections, `RecordFormPage` first calls `saveRecord` on each linked target record (merging pending mirror edits into its `data`) **before** saving the current record. This fans one user action out to multiple records — always in the same Save click, never piecemeal.
- **Load path:**
  1. Try Supabase first on `initialize()`.
  2. If Supabase is not configured OR the fetch fails, fall back to localStorage.
  3. If neither has data, seed from `src/data/seedModels.ts` and `src/data/seedUsers.ts`.
  4. Run pending schema migrations (`src/lib/schemaMigrations.ts`) to reshape stored data when the schema evolves.
  5. Run an idempotent heal pass that re-attaches orphaned project system models to the Projects group and re-seeds the group if it was deleted. This runs on every load (not gated by schema version), because a user can orphan models by deleting the Projects group in the Builder.
  6. **Run `refreshSystemModels` on every load.** Inserts any system model from `SEED_MODELS` that isn't already in the user's store (so new default models added in code reach existing installs). Does NOT overwrite system models that already exist — **Builder edits to system models are authoritative and persist across reloads and deploys**, exactly like custom models. To propagate a structural change to a system model that already exists in an install, add a versioned migration in `schemaMigrations.ts` (the `migration_N_to_M` pattern). Non-system models are untouched.
- **Stable group IDs for system groups:** the Projects group uses a hardcoded UUID (`PROJECTS_GROUP_ID` in `seedModels.ts`). Re-seeding the group always produces the same id, so stored models' `group_id` references survive a wipe-and-reseed.
- **Supabase configured via env:** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. If missing, the client is a no-op shim.
- **All IDs** are UUIDs (via `uuid` package).
- **Dates** are stored as ISO strings.
- **Field slugs** (the `name` prop) are snake_case.
- **No server-side validation or RLS is assumed yet** — the client is the trust boundary. Worth hardening later.

## User flows
1. **First-run offline:** User opens app with no Supabase env → app seeds from `seedModels.ts` → all data lives in localStorage → fully functional.
2. **First-run online:** User opens app with Supabase configured → app queries tables → if empty, seeds → otherwise loads existing data.
3. **Normal save:** User clicks Save → UI updates instantly → Supabase upsert resolves seconds later in the background.
4. **Offline edit while online was expected:** User loses connection → saves still succeed locally → next successful Supabase call doesn't currently replay queued changes (see limitations).

## Data touched
- Tables: `models`, `model_groups`, `records`, `workflows`, `dashboards` (and if wired: `users`, `roles`, `profiles`, `translations`).
- `localStorage` keys: one per store slice.
- Supabase storage bucket for file-type field uploads.

## Key files
| File | What it does |
|---|---|
| `src/lib/supabase.ts` | Client init (no-op if env missing) |
| `src/stores/appStore.ts` | All load/save logic, localStorage mirror, Supabase sync, heal on init |
| `src/lib/schemaMigrations.ts` | Versioned migrations + heal pass. Current `SCHEMA_VERSION = 7` (v7 wipes old follow-up records, refreshes Clients schema for multi-select lookups, and inserts Appointments + Units models for returning users) |
| `src/data/seedModels.ts` | Seed content for first-run (incl. stable `PROJECTS_GROUP_ID`; exports `appointmentsId` and `unitsId`) |
| `src/data/seedUsers.ts` | Demo users |
| `src/lib/mirrorResolver.ts` | Mirror-field resolution (single + multi-select sibling support) |
| `src/lib/sectionMirrorResolver.ts` | Mirrored-section resolution (sibling lookup → source section + target record) |
| `supabase/` | SQL schema (`schema.sql`) |
| `.env.example` | Documents required env vars |

## Open questions / known limitations
- **No offline queue replay:** edits made while offline are in localStorage but won't auto-push when connectivity returns — a full page refresh is needed to trigger a re-sync path.
- **No conflict resolution:** last write wins; two users editing the same record at once will silently overwrite each other.
- **No row-level security policies** configured in Supabase yet — any anon key holder has full table access.
- **No real-time subscriptions** — changes from other clients aren't pushed until the page reloads.
- **JSONB size** — very large models or records could exceed practical JSONB limits; no guardrails.
