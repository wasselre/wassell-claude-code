# schema.sql ↔ live-prod drift (freeze infrastructure)

> **Date:** 2026-06-25 · **Project:** `wassell-prod` (`zhqqsxwealdwqzrbpwyv`)
> **Why this exists:** `supabase/config.toml` states the project is *"managed mostly through the Supabase dashboard / MCP."* As a result `supabase/schema.sql` is a **stale reference snapshot**, not the deploy source. The authoritative function bodies are (a) the `supabase/migrations/*.sql` files and (b) live prod (`pg_get_functiondef`). This doc inventories the freeze-related drift confirmed during the Phase 1 migration work so a future session doesn't trust the wrong body.

## Standing rule

**Before editing any freeze/record function, fetch the LIVE body:**
```sql
SELECT pg_get_functiondef('public.freeze_model(uuid)'::regprocedure);
```
Never copy the body out of `schema.sql` — it is behind prod. Apply changes as a new migration in `supabase/migrations/` (the record), then keep `schema.sql` in sync or extend this doc.

## Confirmed drifts (freeze block)

| Object | `schema.sql` snapshot | Live prod (authoritative) | Source of truth |
|---|---|---|---|
| `freeze_model(uuid)` | 4-arg era; CREATE TABLE has **no `custom_data`**; no overflow skips | + `custom_data jsonb DEFAULT '{}'` column; skips `storage='overflow'` fields from column + junction loops | `migrations/2026-06-25_freeze_hybrid_overflow.sql` |
| `freeze_apply_row` | signature `(uuid,uuid,jsonb,uuid)` | signature **`(uuid,uuid,jsonb,uuid,integer)`** (`p_expected_version`); version-mismatch check; **writes overflow keys to `custom_data`** | same migration (overflow); version arg pre-existed in prod |
| `regenerate_frozen_model_artifacts` | no `version` column ALTER; `_v` data = `jsonb_build_object(...)` only; no overflow handling | ALTERs `version` **and `custom_data`**; installs `bump_version_trigger`/`frozen_bump_version()`; `_v` data = `jsonb_build_object(...) || custom_data`; policy synthetic row merges `custom_data`; `_v` carries trailing `t.version`; skips `storage='overflow'` | same migration |
| `refresh_frozen_model_artifacts(uuid)` | **absent** | **NEW** safe re-regen wrapper (advisory-lock → drop unified → regen → rebuild). Fixes the `2BP01` standalone-regen failure found in the Phase 1 pilot | `migrations/2026-06-25_refresh_frozen_model_artifacts.sql` |
| `record_save(uuid,uuid,jsonb,uuid,integer)` | 5-arg with basic version check | + conflict-storm breaker (`session_save_blocks` / `record_save_blocks`, `noop` vs `reject` modes); detailed `RAISE LOG` on conflict. **Frozen branch unchanged** (placeholder INSERT + `freeze_apply_row`) — **NOT modified by Phase 1** | conflict-storm migrations (2026-06-21/24); not touched here |
| `rebuild_unified_records()` | selects 6 cols; no advisory lock | selects **7 cols incl. `version`** from records + each `_v`; takes `pg_advisory_xact_lock` | prod / frozen-versioning migration |
| `freeze_is_virtual(text)` | excludes `mirror` + (per schema.sql comment) whatsapp/call_history | excludes **only `'mirror'`** in prod | prod |

## Reconciliation status

- **Documented (this doc) + banner added** to `schema.sql`'s FREEZE block header pointing here. This is the chosen "document the drift" path — a full rewrite of `schema.sql`'s inline freeze bodies is a separate, larger, riskier cleanup and is **not** done here (Phase 1 scope discipline).
- **Migrations are the authoritative record** of the Phase 1 changes and are committed (`2026-06-25_freeze_hybrid_overflow.sql`, `2026-06-25_refresh_frozen_model_artifacts.sql`).
- **Recommended future cleanup (not blocking the geography freeze):** regenerate `schema.sql` from prod (`pg_dump --schema-only` or per-function `pg_get_functiondef`) so the reference snapshot matches live. Track as its own task; do not fold into a model-freeze migration.

## Going-forward discipline

No architecture change lives only in prod: every freeze/schema change ships as a `supabase/migrations/*.sql` file in the repo (even when applied via MCP), and the apply method is noted in the commit. This doc is the index of what is known-drifted until the snapshot is regenerated.
