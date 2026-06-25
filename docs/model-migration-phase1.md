# Wassell — Model Migration Phase 0 + Phase 1 Plan

> **Status:** Design + plan only. **No SQL applied, no files changed, nothing frozen in prod.**
> **Date:** 2026-06-25
> **Scope of this document:** Phase 0 (audit — see `model-migration-strategy.md`) and **Phase 1 only**: harden `freeze_model` into a production-ready hybrid-typed-table vehicle, and plan a pilot on **regions / cities / districts** to prove the compatibility seam.
> **Hard guardrail (per instruction):** Do **not** touch `clients`, `followups`, `units`, `all_projects`, or any business model until the geography pilot is proven. This document deliberately picks the three lowest-risk reference models as the canary.

All SQL below is **proposed** content for a future migration (`supabase/migrations/2026-XX-XX_freeze_hybrid_overflow.sql`). It is shown for review, not applied. Line references are to the current `supabase/schema.sql` FREEZE INFRASTRUCTURE block.

---

## 0. Why these three models are the right pilot (evidence)

Live schema of the pilot models (queried from `wassell-prod`):

| Model | Rows | Fields | Lookups | Mirrors | Rollups | Multiselect | Subtable | auto_id | Risk surface |
|---|---|---|---|---|---|---|---|---|---|
| **regions** | 13 | 7 | 0 | 0 | 0 | 0 | 0 | 0 | **None** — pure scalars (text/checkbox/datetime). The perfect canary. |
| **cities** | 152 | 11 | 1 (`region_lookup`→regions, single) | 0 | 0 | 0 | 0 | 0 | 1 single lookup → `text` column |
| **districts** | 3,732 | 27 | 2 (`city_lookup`→cities, `region_lookup`→regions, both single) | 0 | 0 | 0 | 0 | 1 (`district_id`) | 2 single lookups + 1 auto_id sequence |

These exercise the **scalar + single-lookup-as-text + auto_id** freeze paths — already implemented and stable — while touching **none** of the dangerous machinery (mirrors, rollups, junctions, subtables, multi-value scope). That lets Phase 1 *design* the dangerous paths and *prove* the safe ones, with no business risk.

Two relationship facts about the pilot:
- `cities.region_lookup`, `districts.city_lookup`, `districts.region_lookup` are **single** lookups → today's freeze stores them as **`text` columns holding the target UUID** (`freeze_model:2009-2010`). **No FK constraint is created by freeze.** The pilot keeps this (zero behavior change). Adding real FK constraints is a *later, optional* hardening that requires the target model frozen first — explicitly **out of pilot scope**.
- `cities.region_name_ar/_en`, `districts.city_name_ar/_en/region_name_ar/_en` are **plain `text` fields** (already-denormalized snapshots), **not `mirror`-type fields**. They migrate as ordinary text columns. The pilot therefore has **zero mirror fields** — confirming mirror machinery is not on the pilot's critical path.

---

## 1. Implementation plan — hybrid typed models with `custom_data` JSONB overflow

### 1.1 The problem the overflow solves

Today `freeze_model` is **all-or-nothing**: every schema field becomes a typed column (or junction/subtable), and the Builder goes fully read-only on a frozen model (`ModelEditor.tsx:35`). That means an admin can never add a field to a typed model without an engineer-authored `ALTER TABLE` migration. The hybrid overflow restores admin self-service for *additive* customization while keeping engineer-owned core fields as typed columns.

### 1.2 The shape

Each frozen table gains one column:

```sql
custom_data jsonb NOT NULL DEFAULT '{}'::jsonb
```

A schema field carries a **storage discriminator** (new optional property on `ModelField` in `src/types/index.ts`):

```ts
storage?: 'column' | 'overflow';   // default 'column'
```

- **`column`** (default, and what every field is at freeze time): typed column / junction / subtable, exactly as today.
- **`overflow`**: lives as a key in `custom_data`. This is what the Builder sets when an admin adds a field to an already-frozen model — **no DDL required**.

The `<name>_v` view merges `custom_data` back into the emitted `data` so **every downstream consumer (SPA store, `unified_records`, analytics, AI agents, workflows, RLS scope) sees overflow fields exactly like column fields**. The overflow is invisible above the view.

### 1.3 Field routing (the decision table freeze logic uses)

| Field condition | Storage | Where written | Where read |
|---|---|---|---|
| Virtual type (`mirror`, `whatsapp_history`, `call_history`) | none | — | `_v` view (mirror: JOIN — §2.3); others derived in UI |
| `storage='overflow'` (admin-added post-freeze) | `custom_data` key | `freeze_apply_row` overflow step | `_v` view `|| custom_data` merge |
| multi-value (`multiselect`, multi-`lookup`, `table`) | junction/subtable | existing junction logic | `_v` view aggregate |
| everything else (`storage='column'` or absent) | typed column | existing scalar UPDATE | `_v` view column key |

### 1.4 Lifecycle of an admin-added custom field (no migration)

```
Admin (Builder) → add field {storage:'overflow'} to models.schema
  → saveModel() upserts models row
  → AFTER UPDATE trigger on models (NEW §1.6) calls regenerate_frozen_model_artifacts(model_id)
  → <name>_v view + RLS policy refreshed (custom_data already merged → field appears in data)
  → record_save(...) writes the value into custom_data via freeze_apply_row
  → SPA reads it back through unified_records like any other field. Done. No ALTER TABLE.
```

### 1.5 Lifecycle of promoting an overflow field to a typed column (engineer migration, optional, later)

```sql
ALTER TABLE public.<name> ADD COLUMN <slug> <type>;
UPDATE public.<name> SET <slug> = custom_data->>'<slug>';          -- backfill
UPDATE public.<name> SET custom_data = custom_data - '<slug>';     -- de-dup
-- flip storage flag in models.schema for that field: 'overflow' → 'column'
SELECT public.regenerate_frozen_model_artifacts('<model_id>');
SELECT public.rebuild_unified_records();
```

Documented for completeness; **not used in the pilot.**

---

## 2. Required changes to `freeze_model` (and its helpers)

Five targeted edits. Each is additive/backward-compatible — a model with no overflow fields and no mirrors behaves identically to today.

### 2.1 `freeze_model` — add the overflow column to CREATE TABLE, skip overflow fields in the column loop

**Edit A** (column loop, `schema.sql:1981-2012`): skip overflow-flagged fields so they don't get a column.

```sql
    IF public.freeze_is_virtual(v_ftype) THEN CONTINUE; END IF;
    IF public.freeze_is_multi_value(v_ftype, v_is_multi) THEN CONTINUE; END IF;
+   IF COALESCE(v_field->>'storage','column') = 'overflow' THEN CONTINUE; END IF;
```

**Edit B** (CREATE TABLE, `schema.sql:2022-2026`): add `custom_data` to the table tail.

```sql
   EXECUTE format(
     'CREATE TABLE public.%I (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), %s,
+       custom_data jsonb NOT NULL DEFAULT ''{}''::jsonb,
        created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())',
     v_table,
     CASE WHEN v_columns = '' THEN 'placeholder_unused boolean' ELSE v_columns END
   );
```

(At freeze time every field is `column`, so Edit A is a no-op on first freeze. It matters for re-freeze and for correctness if a schema ever carries an overflow flag pre-freeze.)

### 2.2 `freeze_apply_row` — write overflow keys into `custom_data`

After the scalar-UPDATE block (`schema.sql:1844-1849`), add an overflow assignment. Build the overflow object from **schema fields explicitly flagged `overflow`** (deterministic, auditable — not "residual keys", which could swallow stale data):

```sql
+ -- 1b. Collect overflow-flagged fields and replace custom_data wholesale.
+ DECLARE v_overflow text[] := ARRAY[]::text[];
+ -- (in practice: accumulate during the field loop; shown separately for clarity)
+ FOR v_field IN SELECT field FROM jsonb_array_elements(v_model.schema->'sections') sec(value),
+      LATERAL jsonb_array_elements(sec.value->'fields') field LOOP
+   IF COALESCE(v_field->>'storage','column') = 'overflow'
+      AND v_field->>'name' IS NOT NULL THEN
+     v_overflow := array_append(v_overflow, v_field->>'name');
+   END IF;
+ END LOOP;
+ IF array_length(v_overflow, 1) IS NOT NULL THEN
+   EXECUTE format('UPDATE public.%I SET custom_data = COALESCE((
+       SELECT jsonb_object_agg(k, $1->k) FROM unnest($2::text[]) k WHERE $1 ? k
+     ), ''{}''::jsonb), updated_at = now() WHERE id = $3', v_table)
+   USING p_data, v_overflow, p_id;
+ END IF;
```

Semantics: `custom_data` is **replaced** each save with exactly the overflow-flagged keys present in `p_data` — same wholesale-replace posture the scalar UPDATE uses, so a removed key clears.

### 2.3 `regenerate_frozen_model_artifacts` — merge overflow + (design) mirror JOINs into the `_v` view and RLS policy

**Edit C — overflow merge** (`_v` view, `schema.sql:1709-1712`): append `custom_data` to the emitted `data`, and skip overflow fields in the key loop.

```sql
   EXECUTE format(
     'CREATE VIEW public.%I WITH (security_invoker = true) AS
        SELECT t.id, %L::uuid AS model_id,
-          jsonb_strip_nulls(jsonb_build_object(%s)) AS data,
+          (jsonb_strip_nulls(jsonb_build_object(%s)) || COALESCE(t.custom_data, ''{}''::jsonb)) AS data,
           t.created_by_user_id, t.created_at, t.updated_at
        FROM public.%I t',
     v_view_name, p_model_id, v_view_keys, v_table
   );
```

In the field loop (`schema.sql:1656-1697`) add, alongside the existing `freeze_is_virtual` skip:

```sql
+   IF COALESCE(v_field->>'storage','column') = 'overflow' THEN CONTINUE; END IF;  -- comes via custom_data merge
```

**Edit D — overflow in the RLS policy synthetic row** (`schema.sql:1702`): so scope rules can address overflow fields.

```sql
-  IF v_data_json = '' THEN v_data_json := '''{}''::jsonb'; ELSE v_data_json := 'jsonb_build_object(' || v_data_json || ')'; END IF;
+  IF v_data_json = '' THEN v_data_json := 'COALESCE(custom_data, ''{}''::jsonb)';
+  ELSE v_data_json := '(jsonb_build_object(' || v_data_json || ') || COALESCE(custom_data, ''{}''::jsonb))'; END IF;
```

**Edit E (DESIGN ONLY — not exercised by the pilot) — mirror fields become JOIN-backed `_v` columns.** Today `mirror` is `freeze_is_virtual` → it is dropped from the frozen `data` entirely; it only still resolves because the **client** mirror resolver (`mirrorResolver.ts`) recomputes it from the in-memory record map. That leaves **server-side readers blind to mirror values** (AI agents, server analytics). For models that DO have mirrors (followups, units, sales_valuation_reviews — Phase 3+), extend the view loop to emit a correlated subquery:

```
for each field where type='mirror':
  resolve sibling = schema field whose id = field.mirror_via_lookup_field_id   (a SLUG → column)
  resolve target_model = sibling.lookup_model_id ; target_slug = field.mirror_target_field_name
  target source = (target frozen?) '<target>_v'  : 'v_<target>'   -- frozen → _v view, unfrozen → typed v_ view
  emit:  '<mirror_slug>', (SELECT tv.data->>'<target_slug>' FROM <target_source> tv WHERE tv.id = t.<sibling_col>::uuid)
```

This makes mirrors resolve **server-side** for frozen models, closing the single biggest gap before any mirror-bearing model is frozen. **The pilot has zero mirror fields, so Edit E is designed here but neither applied nor exercised until Phase 3.** It must ship and be tested before `followups`/`units` are touched.

### 2.4 Subtables & junctions — already handled; what to verify

No code change needed. The existing `freeze_model` already creates junction tables for `multiselect`/multi-`lookup` (`schema.sql:2060-2069`), subtables for `table` fields (`:2070-2083`), their RLS (`:2093-2102`), and `freeze_apply_row` already replaces junction/subtable rows on every save (`:1851-1892`), and `regenerate_frozen_model_artifacts` already re-aggregates them into the `_v` `data` (`:1674-1692`). **The pilot uses none of these.** Phase 1's only obligation is to add a regression test (a Tier-3 sandbox model with a multiselect + a table field) confirming the overflow edits (§2.1-2.3) didn't disturb junction/subtable handling.

### 2.5 Rollups — DESIGN ONLY, not in pilot

The 11 `all_projects` rollups are maintained by triggers on the `records` table (`2026-06-15_persist_project_rollups.sql`). When `all_projects`/`units` are frozen (Phase 3), those triggers stop firing (rows leave `records`). The design: re-create `records_fill_project_rollups` as a `BEFORE INSERT/UPDATE` trigger on the **frozen `all_projects` table** (filling the rollup columns), and `records_touch_project_on_unit_change` as an `AFTER` trigger on the **frozen `units` table**. `recalc_project_rollups_data` keeps its logic; only its read source (units) and write target (the project row) change from `records` to the typed tables. **Explicitly deferred — the pilot has no rollups.** This is documented now so the Phase 1 mechanism work knows the shape, but it is not built or applied here.

### 2.6 (Optional, deferred) per-table `version` column

Frozen tables have no `version` column, so `record_save` ignores `p_expected_version` for frozen models (`schema.sql:3017-3023` has no version check). Reference tables are not concurrently edited, so the pilot does **not** need this. When a high-churn model is frozen (Phase 4/5), add `version int NOT NULL DEFAULT 1` + a bump trigger + a version check in the frozen branch of `record_save`. **Designed, deferred, not in pilot.**

### 2.7 NEW trigger — keep frozen artifacts in sync with Builder schema edits

So the overflow-add lifecycle (§1.4) needs no special client RPC. The existing `models_view_sync` trigger regenerates the typed `v_<name>` view but **skips frozen models** (the live `regenerate_model_view` is frozen-aware). Add a sibling:

```sql
CREATE OR REPLACE FUNCTION public.tg_models_frozen_artifacts_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.is_hardcoded AND NEW.schema IS DISTINCT FROM OLD.schema THEN
    PERFORM public.regenerate_frozen_model_artifacts(NEW.id);  -- refresh _v + policies
    -- NOTE: rebuild_unified_records() NOT needed — column set unchanged for overflow adds.
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER models_frozen_artifacts_sync
  AFTER UPDATE OF schema ON public.models
  FOR EACH ROW EXECUTE FUNCTION public.tg_models_frozen_artifacts_sync();
```

Guard: an overflow-only add changes the policy's synthetic-row expression but **not** the `_v` column set, so `regenerate` is safe and `rebuild_unified_records` is unnecessary (the UNION member shape is unchanged). A *column* schema change (engineer ALTER) still uses the manual migration template (which calls both regen + rebuild).

---

## 3. Compatibility strategy — proving the seam holds after freezing one reference model

**Canary = `regions`** (13 rows, 7 scalars, zero lookups, zero external-BI likelihood). The thesis: because **reads go through `unified_records` and writes through `record_save`**, freezing `regions` is invisible to every consumer. Here is the proof obligation per consumer, with the exact mechanism.

| Consumer | Why it keeps working | Proof step |
|---|---|---|
| **`unified_records`** | `rebuild_unified_records` adds `regions_v` to the UNION with identical row shape `(id, model_id, data, created_by_user_id, created_at, updated_at)` (`schema.sql:2251`). | `SELECT count(*), min(created_at) FROM unified_records WHERE model_id = '<regions>'` equals pre-freeze. |
| **`record_save`** | Dispatches on `is_hardcoded` → frozen branch INSERT placeholder + `freeze_apply_row` (`schema.sql:3017-3023`). | Save an edit to a region via the SPA form; confirm the row updates and `regions_v.data` reflects it. |
| **`record_delete`** | Frozen branch hard-deletes from the typed table (`schema.sql:2381`). | Create a throwaway region, delete it, confirm gone from `unified_records`. |
| **SPA store / forms** | `initialize()` loads `unified_records` and buckets by `model_id` (`appStore.ts:2028`) — frozen rows arrive identically. `saveRecord → supabaseRecordUpsert → record_save` already routes correctly. The Builder reads `is_hardcoded` and renders read-only (`ModelEditor.tsx:35`). | Open the regions list + a record form in the SPA; render, edit, save, reload. No console errors; no `records_block_frozen_writes` exceptions. |
| **Dashboards / analytics** | Isomorphic engine reads `data[slug]` over `unified_records` (server `analyticsRun.ts:120`) or the in-memory map (client `useAnalyticsQuery.ts:23`). Slug = column name by construction. | Any widget grouping/filtering on a regions field returns identical results pre/post. (Few/none today — regions is reference data — so mainly a no-regression check.) |
| **Workflows** | No workflow triggers on `regions` (confirmed — not in the 17 workflows). Slug-keyed engine unaffected. | Confirm no workflow references `regions`; smoke-test an unrelated workflow still fires. |
| **AI assistants** | All four read `unified_records.data` by slug. `regions` is read indirectly (geo context for projects). The `_v` view re-emits the same `data`. | `get_project`/`get_customer_context` that surface region names return identical output pre/post. |
| **RLS / scope** | `frozen_view`/`insert`/`update`/`delete` policies call `wassell_can_*_jsonb`, which rebuild a synthetic row from columns and call the same `wassell_record_passes_scope` (`schema.sql:2281`). Column name = slug, so scope rules resolve. regions has no multi-value fields → no fail-closed risk. | Impersonate a non-admin profile; confirm the same regions rows are visible/editable as before. |
| **Builder** | Already renders read-only for `is_hardcoded` (`ModelEditor.tsx:35`). | Open regions in the Builder; confirm read-only banner, Freeze/Delete disabled. |
| **Hybrid overflow (NEW)** | Add a throwaway overflow field to regions' schema → value round-trips through `custom_data` → appears in `unified_records.data`. | The §5 overflow round-trip test. |

**Dual-read / dual-write:** none needed. `unified_records` *is* the dual-read (it unions records + frozen views permanently). There is no transition window where a consumer must read two places — the view does it. Writes always go through the one dispatcher. This is the strangler seam working as designed.

**Pre-flight checks before freezing even `regions`** (these are the real risks, all external to the seam):
1. **`v_regions` external consumers.** `freeze_model` drops `v_regions` (`schema.sql:2137`) and replaces it with `regions_v`. Grep `api/`, `worker/`, `scripts/`, and the **separate marketing-website repo** for `v_regions`/`v_cities`/`v_districts`. Any BI/SQL/endpoint reading `v_regions` must switch to `regions_v` or `unified_records`. *(Open question Q1.)*
2. **Direct `records` writers for geo.** The district/geography import (shipped 2026-06-25) and any backfill `scripts/` that INSERT geo rows directly into `records` will be **blocked** by `records_block_frozen_writes` after freeze. Confirm all geo writes go through `record_save`. *(Open question Q2.)*
3. **PostGIS physical geo tables coexistence.** The 2026-06-25 geography migration created physical region/city/district tables + PostGIS boundaries *separate from* the `regions`/`cities`/`districts` **records-models**. Freezing the records-model creates `public.regions` — **confirm no name collision** with the physical geo table. `freeze_model` already aborts if `public.regions` exists (`schema.sql:1967-1972`), so a collision fails loudly, not silently — but we must know the physical table's name *before* attempting freeze. *(Open question Q3 — blocking.)*

---

## 4. Pilot migration plan — regions → cities → districts (in that order)

**Order rationale:** freeze the *referenced* model before the *referencing* one is not strictly required (single lookups are stored as text, not FKs), but doing regions→cities→districts means each step's lookup targets are already proven. Each model is an independent `freeze_model` call (its own transaction).

### Step P0 — Pre-flight (no mutation)
- Resolve open questions Q1–Q3 (§3 pre-flight).
- Snapshot: `CREATE TABLE _backup_geo_records_<date> AS SELECT * FROM records WHERE model_id IN (<regions>,<cities>,<districts>);`
- Record baselines: per-model `count(*)`, a checksum of `data` (e.g. `md5(string_agg(data::text, '' ORDER BY id))`), and a sample of 5 ids per model.
- Apply the Phase-1 mechanism migration (§2 edits A–D + §2.7 trigger) on a **Supabase branch** first; run the §2.4 sandbox regression (multiselect + table field) there.

### Step P1 — Freeze `regions` (canary)
- `SELECT public.freeze_model('<regions_model_id>');`
- Run the **entire §3 compatibility checklist** + §5 validation. **Halt the pilot here and report** before proceeding. This is the proof gate.

### Step P2 — Freeze `cities`
- `SELECT public.freeze_model('<cities_model_id>');`
- `cities.region_lookup` (single) → `region_lookup text` column holding the region UUID. Confirm lookups from `cities` to `regions` still resolve in the SPA (the picker reads the target from the in-memory map; the id is preserved in the column). Re-run §5.

### Step P3 — Freeze `districts`
- `SELECT public.freeze_model('<districts_model_id>');`
- `district_id` (auto_id) → `freeze_model` creates sequence `districts__district_id_seq` (`schema.sql:2105-2127`). **Known no-op:** the client still assigns auto_ids via `record_assign_auto_id` against `auto_id_counters` (`autoIdAssigner.ts:168`); the freeze-created sequence is currently **vestigial** (pre-existing freeze behavior, not introduced here). District reference data is static, so this is immaterial for the pilot — flag it, don't fix it here.
- Confirm `city_lookup`/`region_lookup` resolve; re-run §5.
- **3,732 rows** — also the memory-footprint datapoint: measure SPA boot/`unified_records` load before vs after (the server-paged-list optimization is Phase 2 work, **not** in this pilot — freezing alone does not change the "load all into memory" behavior; it only enables the later paged path).

### Step P4 — Prove the hybrid overflow end-to-end (on `regions`, lowest stakes)
- See §5 overflow round-trip. Demonstrates an admin-style additive custom field with **no ALTER TABLE**.

### What the pilot deliberately does NOT do
- No FK constraints added (lookups stay text — parity).
- No mirror/rollup/junction/subtable machinery exercised (none present).
- No `version` column (reference tables, no concurrency).
- No server-paged list rewrite (Phase 2).
- No Builder UI relaxation shipped (overflow proven at the SQL/test layer first; UI productization is follow-on Phase 1 frontend work).
- **No business model touched.**

---

## 5. Validation checklist & rollback path

### 5.1 Validation checklist (run per model after each freeze)

**Data integrity**
- [ ] `SELECT count(*) FROM unified_records WHERE model_id='<m>'` == pre-freeze baseline.
- [ ] `data` checksum: per-field spot check on 5 sampled ids — every field present pre-freeze is present post-freeze with the same value (incl. `created_at`, `created_by_user_id`).
- [ ] `freeze_check_coercion('<m>')` returned 0 rows (freeze aborts otherwise — proves no silent coercion loss).
- [ ] No rows left behind: `SELECT count(*) FROM records WHERE model_id='<m>'` == 0.

**Seam (read)**
- [ ] `regions_v` / `cities_v` / `districts_v` exists and `SELECT * ... LIMIT 5` returns the JSONB `data` shape.
- [ ] `unified_records` UNION includes the new `_v` (check `pg_get_viewdef('unified_records')`).
- [ ] SPA: model list renders, record form opens, fields populate. No console errors; `read_console_messages` clean.

**Seam (write)**
- [ ] SPA edit → save → reload shows the change (round-trips through `record_save` → `freeze_apply_row` → `_v`).
- [ ] Create a throwaway record → appears in `unified_records` → delete it → gone.
- [ ] Direct `INSERT INTO records(model_id=...)` for the frozen model **raises** `records_block_frozen_writes` (negative test — confirms the guard).

**RLS**
- [ ] Non-admin impersonation (real `auth.users.id`) sees the same row set as pre-freeze (scope parity).
- [ ] Per-model action grants (create/edit/delete) behave identically.

**Downstream**
- [ ] No workflow references the model (confirmed) — and an unrelated workflow still fires.
- [ ] An AI fact-sheet that surfaces geo names (`get_project`) returns identical output pre/post.
- [ ] Any analytics widget touching the model returns identical aggregates.

**Hybrid overflow round-trip (Step P4, on regions)**
- [ ] Add `{ name:'pilot_note', type:'text', storage:'overflow', ... }` to `regions` schema via `UPDATE models SET schema=...` (or Builder once relaxed).
- [ ] `models_frozen_artifacts_sync` trigger fired → `regions_v` refreshed.
- [ ] `record_save('<regions>', '<id>', '{"pilot_note":"hello", ...existing...}', null, null)` → no error.
- [ ] `SELECT data->>'pilot_note' FROM unified_records WHERE id='<id>'` == `'hello'` (value stored in `custom_data`, surfaced via merge).
- [ ] `SELECT custom_data FROM public.regions WHERE id='<id>'` == `{"pilot_note":"hello"}` (proves it's in overflow, not a column).
- [ ] Remove the field from schema → value disappears from `data` on next save (wholesale-replace semantics).
- [ ] **Cleanup:** drop the throwaway `pilot_note` field; confirm regions back to baseline.

### 5.2 Rollback path

Rollback granularity is **one model** (each freeze is independent; record ids are identity-preserved, so reverting one model never breaks another's lookup ids).

**Per-model un-freeze (the supported reversal):**
```sql
BEGIN;
-- 1. Copy frozen rows back into records as JSONB (read via the _v view).
INSERT INTO records (id, model_id, data, created_by_user_id, created_at, updated_at)
SELECT id, model_id, data, created_by_user_id, created_at, updated_at
FROM public.<name>_v;
-- 2. Flip the model back to unfrozen FIRST (so the block-frozen-writes guard releases
--    and rebuild/regen treat it as a records-model again).
UPDATE models SET is_hardcoded = false, table_name = NULL WHERE id = '<m>';
-- 3. Drop frozen artifacts.
DROP VIEW IF EXISTS public.<name>_v;
DROP TABLE IF EXISTS public.<name> CASCADE;   -- CASCADE drops junctions/subtables/sequence
-- 4. Rebuild the UNION + regenerate the typed v_<name> view for the now-unfrozen model.
SELECT public.rebuild_unified_records();
-- 5. (models_view_sync recreates v_<name> on the is_hardcoded flip; verify it exists.)
COMMIT;
```
Verify with the §5.1 data-integrity checks (count + checksum) against the `_backup_geo_records_<date>` snapshot.

**Hard fallback (if the un-freeze is itself wrong):** restore from the `_backup_geo_records_<date>` table — it holds the exact pre-freeze `records` rows. Re-insert, flip flags, rebuild.

**Why rollback is low-stress here:**
- `unified_records` keeps serving reads throughout (half-migrated is a valid state).
- regions/cities/districts have **no inbound workflow triggers and no rollups**, so there's no trigger state to unwind.
- Lookups are text ids → un-freezing doesn't require re-keying.
- The pilot is gated: P1 (regions) must fully pass before P2/P3, so at most one small model is ever mid-flight.

---

## 6. Open questions / pre-flight results

Three blocking pre-flight checks were resolved during planning (2026-06-25):

1. ✅ **RESOLVED — no PostGIS table collision, no boundary-FK break.** `information_schema` confirms there is **no** physical `public.regions` / `public.cities` / `public.districts`. The 2026-06-25 geography migration created `district_boundaries` and `district_aliases` (different names), and **both have zero foreign keys** — they key off SPL ids, not records ids. So `freeze_model` creating `public.regions/cities/districts` is safe, and moving the districts records-model rows out of `records` does not touch the boundary tables.
2. ✅ **RESOLVED for this repo — no `v_*` consumers.** A grep of the whole worktree found **no** code reading `v_regions` / `v_cities` / `v_districts` (only this doc). Freeze drops these views with no in-repo breakage. **Still open:** the **marketing-website repo** is separate and not visible from here — confirm it doesn't read those views (it uses service-role geo endpoints per memory; verify).
3. ⚠️ **Partially open — direct `records` writers for geo.** The matchAgent *reads* districts; the geo import was a one-time migration/script. Confirm no *ongoing* job INSERTs geo rows straight into `records` (blocked by `records_block_frozen_writes` post-freeze). Low risk — grep `scripts/` before P3.
4. **Overflow contract** — confirm the explicit `storage:'overflow'` flag (auditable) over residual-key capture (automatic but riskier). Recommendation: explicit flag.
5. **Builder UI relaxation timing** — ship the "add custom field to frozen model" Builder change *in* Phase 1 (after the SQL seam is proven on the pilot), or defer to Phase 7? Recommendation: prove at SQL/test layer in the pilot; ship the UI relaxation right after, still within Phase 1.

---

## 7. What is explicitly NOT in this plan (per your guardrails)

- ❌ No freeze of `clients`, `followups`, `units`, `all_projects`, or any business model.
- ❌ No mirror machinery applied (designed in §2.3 Edit E; first used Phase 3).
- ❌ No rollup trigger port applied (designed in §2.5; first used Phase 3).
- ❌ No `version` column on frozen tables (designed in §2.6; deferred to Phase 4/5).
- ❌ No FK constraints, no server-paged list rewrite (Phase 2+).
- ❌ Nothing applied to prod — this is a reviewable plan + proposed migration content only.
```
