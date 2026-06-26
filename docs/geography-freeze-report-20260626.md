# Geography Freeze — Final Report

> **Date:** 2026-06-26 · **Project:** `wassell-prod` (`zhqqsxwealdwqzrbpwyv`)
> **Scope executed:** Froze the three geography reference models — `regions`, `cities`, `districts` — each individually halt-gated, pre-validated, backed up, and post-validated. **No other model touched.**
> **Outcome:** All three frozen successfully. **No rollback needed.** Documentation only — this report makes no DB change.

This is the Phase-2 (reference tier) execution record, following the Phase-0 audit (`model-migration-strategy.md`), the Phase-1 mechanism (`model-migration-phase1.md` + `model-migration-phase1-pilot-report.md`), and the gate sequence (website-dependency check → RLS/backup/baseline → freeze regions → cities → districts).

---

## 1. Final frozen model state (prod)

| Model | Rows | Frozen at (UTC) | Physical table | View |
|---|---|---|---|---|
| **regions** | 13 | 2026-06-26T00:10:25Z | `public.regions` | `regions_v` |
| **cities** | 152 | 2026-06-26T00:16:32Z | `public.cities` | `cities_v` |
| **districts** | 3,733 | 2026-06-26T00:21:58Z | `public.districts` | `districts_v` |

**Total frozen models in prod: 3** (was 0 before this work). Every other model remains unfrozen JSONB in `records`. The hierarchy resolves end-to-end through `unified_records`: district → city → region.

---

## 2. Validation summary

Accepted pass criterion (per operator decision): **field-level equivalence**, not exact JSON checksum — known typed-table normalization is acceptable when it preserves semantic value and is explicitly reported (§3).

| Check | regions | cities | districts |
|---|---|---|---|
| Freeze succeeded | ✅ | ✅ | ✅ |
| `records` residual = 0 | ✅ 0 | ✅ 0 | ✅ 0 |
| Physical table + `_v` view exist | ✅ | ✅ | ✅ |
| `unified_records` count == baseline | ✅ 13 | ✅ 152 | ✅ 3733 |
| IDs preserved | ✅ all 13 baseline ids present | ✅ fingerprint `83adcb11…` == baseline | ✅ fingerprint `5e4c34b7…` == baseline |
| Lookup integrity — 0 orphans | ✅ (no outbound lookups) | ✅ city→frozen-region 0 | ✅ district→frozen-city 0, district→frozen-region 0 |
| Field-level equivalence | ✅ only `source_updated_at` | ✅ only `source_updated_at` (152/152) | ✅ only `source_updated_at` (3732); `non_coercion_field_diffs: 0`; `coord_numeric_mismatches: 0` |
| `record_save` update → version bump → restore | ✅ Najran (v2, field-equiv) | ✅ Riyadh city (v2, field-equiv) | ✅ King Salman (v2, **exact** match to backup) |

**Cross-model lookup integrity (post-freeze, all 0 orphans):** cities `region_lookup` → frozen `regions`; districts `city_lookup` → frozen `cities`; districts `region_lookup` → frozen `regions`. The id values were preserved through every freeze, so every inbound geo reference still resolves via `unified_records`.

### RLS access — before vs after

Impersonated via `SET LOCAL ROLE … + request.jwt.claims` against a real admin (`31621e58…`), a real salesperson on the **Sales** profile (`38993e35…`), and the `anon` role.

| Role | regions | cities | districts | Verdict |
|---|---|---|---|---|
| **admin** (before → after) | 13 → 13 | 152 → 152 | 3733 → 3733 | ✅ unchanged |
| **salesperson** (before → after) | 13 → 13 | 152 → 152 | 3733 → 3733 | ✅ unchanged |
| **anon** (before → after) | 1 → 0 | 1 → 0 | 8 → 0 | ⚠️ **expected, non-breaking** |

**Anon drop explained:** before freeze, anon read a narrow slice of geo rows (those referenced by *public* projects) via the public-website lookup-target policy on the `records` table. After freeze, those rows live in the frozen tables, whose generated RLS policies are `TO authenticated` only, and `records` no longer holds them — so anon reads 0. This is **non-breaking** because the public website does **not display** any city/district/region lookup field (verified in the website-dependency gate: `all_projects` card/maps config and `site_settings` card slots reference none of `city_lookup`/`district_lookup`/`region_lookup`). The website's `loadLookupTargets` fetch for these models simply returns empty — a non-fatal, invisible result.

---

## 3. Accepted normalization (explicitly recorded)

Across all three models, the **only** field-level differences from the pre-freeze backup are designed, lossless typed-table coercions:

1. **`source_updated_at`** (`datetime` → `timestamptz`): bare date `"2026-06-25"` → `"2026-06-25T00:00:00+00:00"` (midnight UTC). Calendar date and meaning preserved; the CRM's `new Date(...)` parses both identically. Applies to all regions (13), all cities (152), and 3,732/3,733 districts (the one manual district has no such field).
2. **District coordinates** (`center_lat`, `center_lng`, `centroid_lat`, `centroid_lng`; `number` → `numeric`): **numerically preserved** — `coord_numeric_mismatches: 0`, and in fact byte-identical because they were stored as JSON numbers (precision preserved by `numeric`).
3. **`district_id`** (`auto_id`): was **unpopulated** in all 3,733 district rows pre-freeze → nothing to preserve; no uniqueness concern. The freeze-created sequence is vestigial.
4. **`boundary_geojson`**: **absent** in all district records (boundary geometry lives in the separate physical `district_boundaries` table, not in the records-model data) → no coercion.

`non_coercion_field_diffs: 0` for districts confirms that, excluding `source_updated_at` and the four coordinate fields, every field is byte-identical across all rows. No dropped fields, no unexpected nulls, names/SPL-ids/lookups all preserved.

---

## 4. Backup

- **`public._backup_geo_records_20260626`** — full pre-freeze `records` rows (all columns) for all three models. Verified at capture: regions 13/13, cities 152/152, districts 3733/3733. **Retained** as the rollback safety net.
- Rollback path (if ever needed, per model): copy `<name>_v` rows back into `records` → flip `models.is_hardcoded=false, table_name=NULL` → drop the typed table + `_v` → `rebuild_unified_records()`. Record ids are identity-preserved, so reverting one geo model never breaks another's inbound lookups. The backup table is the hard fallback.

---

## 5. Forward blockers (do NOT proceed without resolving)

1. **`developers`** — do **not** freeze until: (a) the marketing-website data layer (`js/wassel-data.js` `loadLookupTargets`, and `api/project-units.js`) reads from **`unified_records`** instead of the `records` table; and (b) an **anon read policy** exists on the frozen REF tables (the freeze-generated policies are `authenticated`-only). Unlike the geo trio, `developers` **is displayed** (map popup chip via `site_settings.card_chip1_field='developer'`), so freezing it without these would blank that chip.
2. **`all_projects` / `units`** — do **not** freeze until the **rollup** (11 trigger-maintained aggregates on `all_projects`, keyed off `records`) and **mirror** (units' 4 mirror fields; the current freeze maps `mirror → SKIPPED`, dropping them server-side) machinery is designed, built, and tested. These must co-migrate atomically with their triggers re-pointed to the typed tables (see `model-migration-phase1.md` §2.3, §2.5).
3. **`clients` / `followups`** — do **not** freeze until the **multi-value RLS** caveat (frozen RLS omits multiselect/multi-lookup fields from scope evaluation → fails closed) is resolved for any profile scope rule that references such a field, and the full dependency graph (followups' 5 mirrors + self-FKs; clients' 13-model fan-in; the `_fill_client_next_action` / `_touch_client` / `svr_*` triggers) is solved.
4. **matchAgent / geography-reading code** — any server code that reads `districts`/`cities`/`regions` from the **`records`** table directly must switch to **`unified_records`** before relying on the now-frozen geography (frozen rows are no longer in `records`). The matchAgent geography path was reported not-yet-deployed; it was **not** touched here.

---

## 6. Mechanism note (already shipped, for traceability)

The hybrid-overflow freeze mechanism and the safe re-regen RPC used here were applied to prod and committed earlier (`10d38af`):
- `supabase/migrations/2026-06-25_freeze_hybrid_overflow.sql`
- `supabase/migrations/2026-06-25_refresh_frozen_model_artifacts.sql`

**This report is documentation only — it changes no database schema and freezes no further model.**
