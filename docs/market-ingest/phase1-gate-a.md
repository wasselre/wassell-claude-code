# Phase 1 · Gate A — Migrations 02–06 (schema documentation, r3)

**Status:** files written to the worktree only. **Not applied** to any database. No branch, commit, push, DB apply, data/grant/worker/schedule change. Gate B/Gate C and migrations `06–10` **not begun**. The 608 interrupted claims untouched.

## Files
| File | Role |
|---|---|
| `2026-09-03_01_market_listings_view_fast_path.sql` | base-table scope-class fast-path policy; performance fix-forward for the 00 hotfix |
| `2026-09-03_02_…freeze_baseline.sql` | Folds the ad-hoc freeze + the *valid* part of the 2026-08-05 UAE migration; three-layer pinned reconciliation; `v_market_properties` security fix |
| `2026-09-03_03_listing_sources_registry.sql` | source registry (admin-read) |
| `2026-09-03_04_raw_capture.sql` | immutable multi-artifact capture (two-axis capture/retention) |
| `2026-09-03_05_field_catalog_and_gaps.sql` | catalog / authoritative mappings / gaps (+ security_invoker view) |
| `2026-09-03_06_ingestion_provenance_outbox.sql` | runs/items / append-only audit / provenance / outbox / quarantine |
| `docs/market-ingest/phase1-gate-a.md` | this document |
| `docs/market-ingest/frozen-generated-objects.md` | verbatim generated policies/views + Storage role design |
| `docs/market-ingest/gate-a.patch` | full unified diff of all the above |

## 1. Three-layer pinning (correction 1) — and the raw-md5 problem
The model schema stores fields with **random UUIDs** (`schema_has_random_field_ids=true`), so `md5(models.schema)` is **non-deterministic** — a fresh DB rebuilding the model would never match it. The generated RLS policies/views depend on the field **generator inputs**, not the UUIDs. So `02` pins the three layers that actually determine the artifacts:
- **L1 — canonical generator-input fingerprint** (per field: name, type, required, width, is_multi, default, validation, lookup target resolved to model **slug/name** not UUID, lookup_display, dropdown option values sorted; excludes random id + labels; `md5` of concat sorted by name) = **`5bf5bb0271aa288233ad3fd3467987d1`**.
- **L2 — generator function hash** `md5(pg_get_functiondef(regenerate_frozen_model_artifacts))` = **`415e0006b8be1eb6200c147b336bfcfe`**.
- **L3 — output fingerprints**: frozen policies = **`e2a93cf195706b5fb04e3e0548b919e5`**, generated views (`market_listings_v`+`unified_records`) = **`2bad4bb0c7f546423f8656b570f9cf22`**.

`02` **folds the valid UAE model fields** (names+types) so a fresh DB reaches L1; asserts L1+L2 before regenerating (fresh) and asserts L3 after; on **production** all three are asserted and the generator is **never** run. **Schema parity** (Gate B) is proven by **normalized `pg_dump --schema-only` diff** of (full history + `02–06`) vs a restored-production schema — the model *data* row's UUIDs are not in a schema-only dump, so they do not affect parity, and the fingerprints guarantee identical policies/views.

## 2. Two-axis capture / retention
`page_capture_manifest.state` (7 capture states + `why_expected`) is independent of `raw_snapshot_artifacts.retention_state` (`durable_original / durable_existing_asset / external_reference_only / retention_failed / not_applicable`), constrained-consistent with `retention_mode`. An external URL satisfies discovery, never durable retention.

## 3. Enforceable Storage immutability (correction 3)
**Now in migration `04`** (bucket + `market_raw_uploader` role + policies), not only the companion doc. `service_role` has **BYPASSRLS**, so "no UPDATE/DELETE policy" does **not** make `market-raw` immutable to the worker if it uploads with the `service_role` key. The enforceable design:

- **Dedicated uploader role** `market_raw_uploader` — `NOLOGIN`, **`NOBYPASSRLS`**, `GRANT market_raw_uploader TO authenticator`. The worker uploads with a **scoped JWT whose `role` claim = `market_raw_uploader`**, minted from a signing key that is **not** the `service_role` key.
- **Storage policies** (on `storage.objects`): `INSERT` for `market_raw_uploader` where `bucket_id='market-raw'`; **no** `UPDATE`/`DELETE` policy for it or for `anon`/`authenticated`. Content-addressed key ⇒ `upsert=false` (an existing hash is a no-op, never an overwrite). Exact DDL in `frozen-generated-objects.md`.
- **Threat boundary (documented, honest):**
  - **Immutable to** all application + ingestion roles: `anon`, `authenticated`, and `market_raw_uploader` (INSERT-only, non-bypass).
  - **Mutable only** through explicit infrastructure authority: `postgres` / `service_role` (BYPASSRLS). **No routine worker uses these for `market-raw`.**
  - Content-addressed key + `upsert=false` + **hash verification** (publisher checks `sha256(bytes)=key` before recording `raw_blobs.content_hash`).
  - **Mutation/deletion audit + alert**: any `DELETE`/`UPDATE` on `market-raw` objects (only possible via infra authority) is logged and alerted; `storage.protect_delete` refuses direct SQL DELETE on `storage.objects`.
- **Gate-B verification required:** that the current Supabase Storage version honors a custom `role` JWT claim for `market_raw_uploader` (custom-role auth support varies by version). If it does not, the fallback is a small edge signer/proxy that holds INSERT-only, never the `service_role` key.

## 4. Media-retention classifications (correction 2 — verified)
| Aqar asset | Ownership (verified) | retention_state | bytes retained |
|---|---|---|---|
| Gallery images (`images.aqar.fm`) | mirrored to Wassell `listing-photos` | `durable_existing_asset` | linked + hashed, no copy |
| Detail HTML/JSON/RSC bundle | Wassell `market-raw` | `durable_original` | yes |
| Floor plans / documents | Wassell `market-raw` | `durable_original` | yes (when present) |
| **Videos (Cloudflare HLS)** | **`customer-tcdl2qnu9671k3x4.cloudflarestream.com` = Aqar's Cloudflare Stream account (third-party)** — no `video_mp4_map` re-host exists | **`external_reference_only`** | **no** — retain stable Stream video ID (e.g. `37904cfb…`) + `.m3u8` manifest URL + metadata |
| Virtual tours / panoramas | third-party | `external_reference_only` | no |

17,982 Aqar listings carry video, all on Aqar's Cloudflare account ⇒ `external_reference_only`, **not** durable, **surfaced as a retention-risk metric** in the run report (`external_only_media_count`). No third-party segment mirroring in Phase 1. If a video URL is ever confirmed to be a **Wassell-controlled** Cloudflare/Storage asset, it reclassifies to `durable_existing_asset`.

## 5. Reconciled production sizes
heap **1,266 MB** + indexes **240 MB** + **TOAST 2,185 MB** = 3,691 ≈ total **3,692 MB** (TOAST = `source_payload`/large text out-of-line). Junction 71 MB / 535,350 links. Largest: `idx_ml_price` 45, `idx_ml_bedrooms` 33, **`idx_ml_source_ext` 25 (existing non-unique on `(source,external_id)`)**, `idx_ml_dupe` 23, pkey 21. Unique index (mig 09) over **314,070** rows, 0 dups/nulls ⇒ seconds–minutes, no long ACCESS EXCLUSIVE; the non-unique `idx_ml_source_ext` can then be dropped (−25 MB).

## 6. Least-privilege RLS
Every new table: admin-only read via `wassell_is_admin((SELECT auth.uid()))`; `service_role` bypasses (workers); `anon`/`PUBLIC` revoked; no INSERT/UPDATE/DELETE grants to app roles; raw-evidence/audit tables also append-only via trigger. `v_source_field_status` is `security_invoker=true`. Full matrix unchanged from r2.

## 7. Governance source-of-truth
`source_field_mappings` = the only authoritative decision (versioned; history retained). `source_field_catalog` holds no status. `schema_gap_events.status` is a distinct lifecycle; a trigger forbids `resolved`/`wont_map` without a terminal mapping decision. `v_source_field_status` reconciles.

## 8. `v_market_properties` security audit (correction 6)
- **Owner:** `postgres`. **Grantees (current prod):** `anon`, `authenticated`, `service_role` (all `arwdDxtm`). **security_invoker:** `false`. **Selects:** the full `ml.data` (contact info + raw `source_payload`).
- **Result today per role:** `anon` → **reads every listing's full data** (RLS bypassed); ordinary `authenticated` salesperson → **same full exposure**; admin → same; `service_role` → same. This is a **live data-exposure bug** — the definer-style view + broad grants + full-data column defeat `frozen_view`.
- **Why invoker=false existed:** the freeze scratchpad created it to feed the website/finder de-duplicated inventory without per-row RLS cost — but it over-exposed.
- **Fix in `02` (desired final state):** `security_invoker=true` + `REVOKE ... FROM anon` + `GRANT SELECT TO authenticated, service_role`. Now the caller's own `frozen_view` RLS applies; a non-admin sees only rows they may view; `anon` has no access. Applying `02` to production **closes the exposure**.
- **Gate-B check:** confirm no consumer depended on anon reading this view (it should not have); if the website needs de-duplicated inventory, route it through a controlled, column-restricted, RLS-respecting path.

## 9. UAE-migration disposition (correction 4) — 2026-08-05_uae_portals_and_dedup.sql
**Not committed as-is.** Field-by-field:

| Part of 2026-08-05 | Classification | Disposition |
|---|---|---|
| `source` dropdown options (bayut/dubizzle/propertyfinder) | Still valid + required | **Folded into `02`** (model reconciliation) |
| UAE model fields (`title_ar…source_payload`, 18 fields) | Still valid + required | **Folded into `02`** (names+types; reach L1 fingerprint) |
| `market_permit_key(text)` function | Already represented | **Superseded** — `02` owns it |
| `v_market_properties` (reads `public.records`) | **Obsolete after freeze** (records is empty for this model; and it was over-exposed) | **Superseded** — `02` ships the `unified_records`-based, **security-fixed** view |
| Migration's stated assumptions (unfrozen model, `records` writes, `market_listing_merge`, pre-freeze views) | **Unsafe/incorrect post-freeze** | **Do not replay** — the retired-merge stub + records-object removal are in `02` |
| UAE-adapter-specific logic | None present | n/a (adapters are Phase 3) |

**Action:** the untracked `supabase/migrations/2026-08-05_uae_portals_and_dedup.sql` should be **removed from the worktree** (recommended) and must **not** be committed; its only still-valid content (source options + UAE fields) lives in `02`. This avoids backdating a broken migration or making fresh environments replay obsolete records-based architecture.

## Assumptions & blockers
1. `02` correctness (fresh==prod schema) is proven by the **Gate B normalized schema-dump diff**; the three-layer pin makes the generated artifacts deterministic.
2. **`market-raw` bucket + `market_raw_uploader` role/policies** are Storage-layer (applied at Gate B; DDL in the companion doc). Custom-role JWT support must be **verified against the current Storage version** (fallback: INSERT-only edge signer).
3. **Videos/tours = `external_reference_only`** (metadata only) — surfaced as retention risk; confirm acceptable for Phase 1.
4. **`v_market_properties` fix changes production behavior** (closes anon full-data read) — confirm no legitimate anon consumer before applying.
5. **Delete the untracked 2026-08-05 file** (do not commit) — confirm.
6. `record_save` guard/`edit_listing`/publisher/planner/unique-index/lockdown are `06–10`, not begun.
