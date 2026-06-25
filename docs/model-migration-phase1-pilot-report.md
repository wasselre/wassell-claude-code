# Phase 1 Pilot — Before/After Report (Synthetic Sandbox Canary)

> **Date:** 2026-06-25 · **Target:** `wassell-prod` (`zhqqsxwealdwqzrbpwyv`)
> **Scope run:** Phase 1 mechanism migration + a synthetic sandbox canary freeze/validate/rollback.
> **Business models touched:** NONE. No real `regions`/`cities`/`districts` row was touched. clients/followups/units/all_projects untouched.
> **End state:** prod is back to **0 frozen models** (pre-pilot state); the hardened freeze functions remain (behavior-neutral until a real freeze).

---

## 1. What was applied to prod

| Change | How | Reversible? |
|---|---|---|
| **Mechanism migration** `freeze_hybrid_overflow` | `apply_migration` — replaced 3 functions (`freeze_model`, `freeze_apply_row`, `regenerate_frozen_model_artifacts`) with the live prod bodies + surgical `-- HYBRID` overflow edits. `record_save` untouched. | Yes — these functions only execute for frozen models; with 0 frozen models they change no live behavior. File: `supabase/migrations/2026-06-25_freeze_hybrid_overflow.sql`. |
| **Sandbox model + group + 20 rows** | `execute_sql` — synthetic `sandbox_geo_pilot` (scalars + dropdown, mirroring `regions`) in a throwaway `🧪 Sandbox (Claude)` group. | Yes — fully deleted at end. |

**Why a synthetic canary and not real `regions`:** strictly more conservative — it proved the seam against the **real prod schema + real freeze functions + real `record_save`/`unified_records`/RLS path** while touching **zero real reference data**. A Supabase preview branch was rejected because this project's schema is managed via MCP (not fully in `supabase/migrations`), so a branch would have an incomplete schema + empty geo tables — a hollow test.

---

## 2. Before → After (the validation evidence)

| Check | Before (baseline) | After freeze | Verdict |
|---|---|---|---|
| Rows via `unified_records` | 20 | 20 | ✅ |
| Content checksum (`md5(string_agg(data))`) | `49745c15e85f8eaf1499979236f29db2` | `49745c15e85f8eaf1499979236f29db2` | ✅ **byte-identical** |
| Row IDs | `…000001`–`…000020` | same, `ids_match_expected = true` | ✅ **preserved** |
| `records`-table residual rows | 20 | 0 (moved to typed table) | ✅ |
| Typed table columns | — | `name_ar text`, `name_en text`, `sort_order numeric`, `is_active boolean`, `source_updated_at timestamptz`, `status text`, **`custom_data jsonb DEFAULT '{}'`**, `version int`, `created_by_user_id`, `created_at`, `updated_at` | ✅ correct type mapping + overflow column |

**Write seam (`record_save` / `record_delete`, the same RPCs the app uses):**

| Test | Result | Verdict |
|---|---|---|
| Update a row via `record_save` | change visible in `unified_records` (`name_en` → "District 1 (UPDATED)") | ✅ |
| Optimistic concurrency | `version` bumped 1 → 2 on update | ✅ |
| Create via `record_save` | row count 20 → 21 | ✅ |
| Delete via `record_delete` | row count 21 → 20, temp row gone | ✅ |

**Hybrid `custom_data` overflow (the new capability):**

| Test | Result | Verdict |
|---|---|---|
| Add `pilot_note` field with `storage:'overflow'` (no DDL) | field added to `models.schema` | ✅ |
| Refresh artifacts | `_v` + policies regenerated | ✅ |
| Physical column added for overflow field? | **No** (`pilot_note` column count = 0) | ✅ no DDL |
| Save value via `record_save` | `unified_records.data->>'pilot_note'` = **"hello from overflow"** | ✅ surfaced like a column |
| Column field still resolves alongside overflow | `data->>'name_en'` = "District 2" | ✅ merge is non-destructive |
| Physical storage | `custom_data` = `{"pilot_note": "hello from overflow"}` | ✅ lives in overflow |

**Rollback / un-freeze path:**

| Test | Result | Verdict |
|---|---|---|
| Copy `_v` rows back to `records`, drop typed table, rebuild | 20 rows back via `unified_records` | ✅ |
| Overflow value survives un-freeze | `data->>'pilot_note'` = "hello from overflow" (merged back into `data`) | ✅ no data loss |
| Column edit survives un-freeze | `data->>'name_en'` = "District 1 (UPDATED)" | ✅ |
| Typed table removed | gone | ✅ |
| Final cleanup | model/group/table/records all 0; **`frozen_models_total = 0`**; `unified_records` = 28,948 rows | ✅ prod pristine |

---

## 3. Finding from the pilot (this is why we pilot)

**`regenerate_frozen_model_artifacts` cannot be called standalone once the model is in `unified_records`.** It runs `DROP VIEW <name>_v`, but `unified_records` depends on `<name>_v`, so the drop fails with `2BP01: cannot drop view … because other objects depend on it`. This has **never fired in prod** because no model was ever frozen, so a *second* artifact regen (e.g. after a schema edit on a frozen model) had never run. The pilot hit it on the overflow-field add.

- **Impact:** the *first* freeze works (regen runs before `unified_records` includes the new `_v`). But **any later schema refresh on a frozen model** — including adding an overflow field via the future Builder trigger — needs the sequence: `DROP VIEW unified_records` → `regenerate_frozen_model_artifacts(id)` → `rebuild_unified_records()`. The pilot used exactly that and it worked.
- **Recommended follow-up (small, before the real geo freeze if overflow-on-geo is wanted):** add a `refresh_frozen_model_artifacts(model_id)` RPC that wraps `drop unified → regen → rebuild` atomically, and have the deferred `models_frozen_artifacts_sync` Builder trigger call it. This also corrects the CLAUDE.md frozen-migration template (which currently says "call regen then rebuild" — that ordering hits this bug).
- **Note:** this is a *pre-existing* latent issue in the live `regenerate_frozen_model_artifacts`, not introduced by the overflow migration.

---

## 4. What is proven vs not

**Proven on the real prod stack:** typed-table creation + correct type mapping; **byte-identical data** through `unified_records`; ID preservation; `record_save`/`record_delete` dispatch; frozen-table optimistic concurrency (`version` bump); the **hybrid `custom_data` overflow** (add field with no DDL → value round-trips → lives in overflow); and a clean **un-freeze** that preserves both column and overflow data.

**Not exercised (by design — out of pilot scope):**
- **RLS impersonation.** The frozen `frozen_view/insert/update/delete` policies regenerated without error and the overflow merge is wired into the policy's synthetic row, but a non-admin profile impersonation test wasn't run (the synthetic model had no profile grants). Do this on the **real geo freeze**, where profiles apply.
- **Mirrors / rollups / junctions / subtables.** None present in the pilot (or in regions/cities/districts) — the mirror JOIN + rollup-trigger-port machinery is designed (Phase 1 doc §2.3/§2.5) but **not** built or tested; it's gated to Phase 3 before any mirror/rollup-bearing model.
- **SPA live UI.** Validation was DB-level (the seam). A browser smoke-test on the real geo models is part of the real-freeze gate.

---

## 5. Go / No-Go recommendation for the real geography freeze

**Recommendation: GO is justified on the mechanism, but with two gates first.** The seam is proven; the mechanism is sound. Before freezing real `regions`/`cities`/`districts`:

1. **Decide the refresh-RPC follow-up** (§3). Needed only if you want admin overflow fields on the geo models or the Builder auto-refresh; the freeze itself doesn't need it. Recommend shipping the tiny `refresh_frozen_model_artifacts` RPC first regardless — it makes the mechanism truly production-ready.
2. **Close the two still-open pre-flight items** (from `model-migration-phase1.md` §6): confirm the **marketing-website repo** doesn't read `v_regions/v_cities/v_districts` (this repo is clean; freeze drops those typed views), and grep `scripts/` for any ongoing direct-`records` geo writes (blocked post-freeze).
3. **Run RLS impersonation + a SPA smoke-test** as part of the real freeze (not needed for the synthetic canary).

**Still do NOT touch** clients, followups, units, all_projects, or any mirror/rollup-bearing model — those wait for the Phase 3 mirror/rollup machinery, which is designed but unbuilt.

---

## 6. Artifacts

- Migration applied: `supabase/migrations/2026-06-25_freeze_hybrid_overflow.sql` (recorded in `supabase_migrations` as `freeze_hybrid_overflow`).
- Plans: `docs/model-migration-strategy.md` (Phase 0 audit), `docs/model-migration-phase1.md` (Phase 1 design + pilot plan), this report.
- Prod state: **0 frozen models**, hardened freeze functions in place, no sandbox residue.
