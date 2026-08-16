# Phase 1 · Gate A — market-ingest governance & evidence migrations

Last updated: 2026-08-16

> **Status: Gate A complete.** Six migrations — the freeze baseline
> (`2026-09-03_02`), the four additive governance/evidence migrations
> (`2026-09-05_01…04`) and the provenance/outbox migration (`2026-09-05_06`) —
> are merged and **applied to no database**. CI executes the entire replay chain,
> including the **unmodified** `2026-09-04_00`, and proves it converges to the
> six-policy secure state and to the five-way `unified_records` fingerprint
> `74602527636617c3549508a67fcc220d`. Storage enforcement remains DEFERRED to
> Gate B. No canonical `market_listings` writer exists yet.

### Ordering — why the baseline sorts at `2026-09-03_02`

`2026-09-04_00` is applied, immutable, and its preflight aborts when
`public.market_listings` is absent. Migrations replay lexically, so a baseline numbered
after it could never create the table in time and every fresh path would stop dead.
Numbering the baseline **below** it is the only resolution that does not edit an applied,
ledger-recorded migration. The proven replay order is:

`2026-09-03_02` → **`2026-09-04_00` (unmodified)** → `2026-09-05_01…04` → `2026-09-05_06`

CI job `freeze-baseline-sequence` executes exactly that chain against Postgres 17, from the
supported pre-freeze predecessor fixture, and additionally proves the production-shaped
assert-only path, idempotency, and fail-closed drift refusal.

This is the single authoritative Gate A document. Someone landing cold should be able to
understand from this file alone what is done, what is deliberately not done, and why.

---

## 1. Completed prerequisite: the security reconciliation

`supabase/migrations/2026-09-04_00_market_listings_view_reconciliation.sql` is already
applied to production:

- Applied to production **2026-08-14**; ledger version `20260814070621`, name
  `market_listings_view_reconciliation`.
- git blob `6c32d059442c6dc96e9c21d30905d303b7d2ca9d`; SHA-256
  `73645b4af59a229cfff9c1555dfde4ad7e450e5e6aeb23bdd120239ac1bc6f9f`; 35,398 bytes, pure LF.
- Reviewed commit `92ff9966980c171f9a712d99d1ebd1bc74dea8a5`; merged via
  `374f8c5f5f4902caf426be70d704c5e06a05312f` (PR #14).
- Re-verified 2026-08-16: the file on `origin/main` is byte-identical to the ledger body.

> **Never re-run, edit, amend or reformat this migration.** Its repository blob must stay
> byte-identical to the production ledger body. It is a ONE-SHOT reconciliation pinning six
> production objects by md5.

What it established in production: RLS on `market_listings`; permissive
`market_listings_view_fast`; restrictive `market_listings_view_deny_none`;
`market_listings_summary` / `v_market_listings` / `v_market_properties` all
`security_invoker=true`; `authenticated` holding exactly SELECT on the summary; `anon`
reaching zero rows.

---

## 2. THE BOOTSTRAP GAP

This discovery drives everything below:

> `public.market_listings` is created by **no file in this repository.** The only
> `CREATE TABLE market_listings` statements anywhere in the tree are in two CI fixtures.

Evidence, all verifiable from the repo:

- The supported fresh-bootstrap path is `supabase/branch-bootstrap-01…14.sql` applied in
  order by `node scripts/apply-branch-bootstrap.mjs`, auto-generated from live production
  catalogs by `scripts/generate-branch-bootstrap.mjs`.
- That set was generated and verified **2026-08-01** — five days BEFORE the ad-hoc
  production freeze of 2026-08-06. Its `market_listings_summary`
  (`branch-bootstrap-06.sql:46`) still reads `FROM records`, the pre-freeze JSONB shape.
- The bootstrap contains four `_backup_market_listings_*` tables and two views, but **not**
  the base table.
- `supabase/schema.sql`, the older parallel path, contains **zero** references to
  `market_listings`.
- The frozen table therefore exists **only on production**, created by out-of-repo
  scratchpad SQL.

> **Why a fail-closed preflight was rejected as insufficient.** An earlier draft guarded the
> dependency with a `PREFLIGHT:` check that raised a clear, actionable error when
> `public.market_listings` was absent. That was rejected. A preflight converts an obscure
> foreign-key error into a well-worded one, but the migration remains **permanently
> un-replayable** on every repo-derived database — fresh bootstrap, CI, branch, or local —
> until the freeze baseline exists. Renaming a failure is not resolving a dependency. The
> dependency was removed by SPLITTING the migration instead.

**Complete bootstrap parity remains BLOCKED.** No CI job in this repository can assert
fresh-vs-production schema parity for the market-listings surface until the deferred freeze
baseline lands. Do not add a fixture stub to make such a claim possible.

---

## 3. Recovered `2026-09-03_00` and `_01` are permanently superseded

Both were absorbed into `2026-09-04_00` and must **never be replayed**. Two concrete reasons:

1. Both `2026-09-03_01` and `2026-09-04_00` create a policy named
   `market_listings_view_fast` — two files fighting over one policy name.
2. `2026-09-03_01` **lacks** `market_listings_view_deny_none`. Measured: for a scope-`none`
   user the fast-path-only version costs ~0.95 ms/row across 314,070 rows (~299 s →
   statement timeout) versus 596 ms today. Replaying it alone is a measured availability
   regression.

See `docs/market-ingest/superseded-migrations.md`.

---

## 4. PR #13 is recovery evidence, not a merge source

- Branch `recovery/market-ingest-original-worktree`, head
  `01b474569b8fed1b5b2aadbbb534f93f23569458`, built on `c7e0bf8c`.
- **35 migrations behind** current `main`, including seven touching `market_listings`:
  `2026-08-07_market_listings_frozen_finder_fix`,
  `2026-08-08_01_market_listings_aqar_dupe_groups`,
  `2026-08-09_01_market_listings_frozen_read_paths`,
  `2026-08-09_02_market_listings_frozen_write_paths`,
  `2026-08-09_03_market_listings_multi_image_jsonb`,
  `2026-08-09_04_freeze_map_multi_image_video_jsonb`,
  `2026-09-04_00_market_listings_view_reconciliation`.

> **Never merge, never rebase PR #13.** Content is cherry-picked by hand with review;
> commits are not.

---

## 5. The `_04` / `_06` split

Only two objects in the PR #13 original depended on `market_listings`:
`listing_field_provenance.record_id` and `mirror_outbox.record_id`, both
`REFERENCES public.market_listings(id) ON DELETE CASCADE`.

**No foreign key was weakened or removed to achieve the split.** The two listing-keyed
tables that remain — `listing_change_events.record_id` and `listing_change_review.record_id`
— already carried **no FK** in the original by deliberate design (the audit must survive a
listing deletion; a quarantined change may reference a listing that does not yet exist).
Those comments are preserved verbatim in `_04`.

The seam is natural: what stays is the run ledger, the attempt state machine, the
append-only change audit and the quarantine queue — a coherent, complete model. What moves
out are two listing-keyed *projections* that are meaningless before a canonical listing
table exists.

---

## 6. Exact object inventory: included vs deferred

**Included in this branch — four migrations, twelve tables, one view, zero changes to any
existing object.**

| Migration | Objects created |
|---|---|
| `2026-09-05_01_listing_sources_registry.sql` | `listing_sources` + `tg_listing_sources_touch()` + trigger + 4 seed rows |
| `2026-09-05_02_raw_capture.sql` | `raw_blobs`, `raw_snapshots`, `raw_snapshot_artifacts`, `page_capture_manifest`, `_ml_reject_mutation()`, `raw_snapshot_derive_class(uuid)`, 4 append-only triggers, 6 indexes |
| `2026-09-05_03_field_catalog_and_gaps.sql` | `source_field_catalog`, `source_field_mappings`, `schema_gap_events`, view `v_source_field_status`, `tg_schema_gap_requires_decision()`, `tg_source_field_catalog_touch()`, 2 triggers, 4 indexes |
| `2026-09-05_04_ingestion_audit.sql` | `ingestion_runs`, `ingestion_items`, `listing_change_events`, `listing_change_review`, `trg_change_events_immutable`, 6 indexes |

The only rows written by the entire set are the four `listing_sources` seeds — `aqar`
active, `bayut` / `dubizzle` / `propertyfinder` inactive, `publishing_enabled = false` for
all four.

**Deferred — reserved filenames, NOT authored:**

| Reserved | Owns | Blocked by |
|---|---|---|
| `2026-09-05_05_market_listings_freeze_baseline.sql` | the frozen `market_listings` shape + pinned generated artifacts | live fingerprint remeasurement (Section 7) |
| `2026-09-05_06_listing_provenance_outbox.sql` | `listing_field_provenance`, `mirror_outbox`, both FKs to `market_listings(id)`, `ix_outbox_pending`, `tg_mirror_outbox_touch()`, `trg_mirror_outbox_touch`, their RLS policies and grants | **`_05`** — it cannot run before the baseline creates the table |

> **`_05` is a hard prerequisite for `_06`.** When `_06` is authored, its two foreign keys
> to `public.market_listings(id)` must be present and unweakened. Do not omit or relax them
> to make `_06` land earlier.

Apply order: `_01 → _02 → _03 → _04`. Each fails closed with a named `PREFLIGHT:` error
when a dependency is missing.

---

## 6b. Production remeasurement — 2026-08-16 (read-only)

Measured directly against `wassell-prod` inside `BEGIN READ ONLY` (verified
`transaction_read_only = on`). No mutation. This section exists so the freeze baseline can
be authored without repeating the measurement.

**Identity and fingerprints**

| Fact | Measured 2026-08-16 | vs. PR #13 |
|---|---|---|
| `models.id` | `8f06bc39-4bee-42e9-9fab-77023fb89ede` | unchanged |
| `is_hardcoded` / `table_name` | `true` / `market_listings` | unchanged |
| **Raw** `md5(models.schema)` — *production identity evidence only, NOT a fresh-DB pin* | `44e7ce3ffc050cba5f49b97b5667cf83` | **still matches** |
| **L2** generator `md5(pg_get_functiondef(regenerate_frozen_model_artifacts))` | `415e0006b8be1eb6200c147b336bfcfe` | **still matches** |
| Rows / columns | 314,070 / 91 | `image_urls`,`video_urls` now `jsonb` |
| RLS / owner | enabled / `postgres` | — |

The raw schema md5 is **not** usable as the fresh-database L1 pin: `models.schema` carries
random per-field UUIDs and display labels, so a rebuilt model never reproduces it. A
canonical normalized generator-input fingerprint (field name, type, required, width,
is_multi, lookup target by slug, dropdown option values sorted; UUIDs and labels excluded)
is still **not yet measured** and must be computed before the baseline pins L1.

**L3 output fingerprints — current six-policy state** (these are the live values, not a
statement that the historical ones changed):

| Object | `md5` | Shape |
|---|---|---|
| `frozen_view` qual | `6087e8fdcfcb9f3df3da7898c1163c18` | permissive SELECT, `{authenticated}`, 2,829 ch |
| `frozen_update` qual = withcheck | `9f0255206b5395282618aa80bd147719` | permissive UPDATE, 2,829 ch |
| `frozen_delete` qual | `5c85c440b19c5541a150f8b6f57922a5` | permissive DELETE, 2,950 ch |
| `frozen_insert` withcheck | `4928c9574ded1309015b08236950b256` | permissive INSERT, 114 ch |
| `market_listings_view_fast` qual | `b80e72543ad3b57e163b283456f62418` | **permissive** SELECT, 153 ch |
| `market_listings_view_deny_none` qual | `4f400ee19d9149b0554841e4e1086075` | **restrictive** SELECT, 155 ch |
| `market_listings_v` viewdef | `09af7a872c06f8d3acc81b7ebe5c82ec` | 3,194 ch |
| `unified_records` viewdef | `74602527636617c3549508a67fcc220d` | 1,056 ch |

**The six preconditions the unmodified `2026-09-04_00` pins — all verified live 2026-08-16:**
`market_listings_summary` `0ddd7ab480fcf167ca9d684d9c1f2db6`; `v_market_listings`
`3675d4c9bab1019312eae01035ab18ba`; `v_market_properties` `416a3eaac713f2eaf27d46f8867c5d4a`;
`frozen_view` qual `6087e8fdcfcb9f3df3da7898c1163c18`; `wassell_view_scope_class`
`0bcfabe9df9da91ea4d874104fec65d6`; `wassell_can_view_jsonb` `c9a781616085d3b06eec12d68238b502`.
All three views are plain views owned by `postgres`.

**Physical shape:** 91 columns; constraints `market_listings_pkey` and
`market_listings_created_by_user_id_fkey → users(id) ON DELETE SET NULL`; 13 indexes;
junction tables `market_listings__basic_info_missing_keys` and `market_listings__features`.

**Dependency graph:** `market_listings` ← `market_listings_summary`, `market_listings_v`,
`v_market_listings`. `unified_records` ← `v_market_properties`, `v_our_projects_scope`,
`v_website_public`.

### 6b.1 Production has FOUR frozen models, not one

`unified_records` is a `UNION ALL` over `records`, `cities_v`, `districts_v`,
`market_listings_v` and `regions_v` — `models` reports `is_hardcoded` for **cities,
districts, market_listings, regions**.

This constrains the freeze baseline. `2026-09-04_00` requires `v_market_properties`, which
reads `FROM unified_records`. On a fresh path the baseline must therefore also produce
`unified_records` — but it can only honestly reconstruct the *market_listings* frozen model.
The baseline must consequently build a **reduced** `unified_records` (`records UNION ALL
market_listings_v`) and document the deviation. This is sufficient for convergence, because
`v_market_properties`'s own viewdef references `unified_records` by name only, so its pinned
md5 is unaffected by what `unified_records` unions. It is **not** sufficient for
fresh-vs-production schema parity, which remains out of scope and blocked.

---

## 7. The freeze baseline is DEFERRED and BLOCKED

Four blockers:

1. **Fingerprints must be remeasured live.** The PR #13 values are STALE and must not be
   copied — recorded here only so a future session recognises them as the stale set:
   L1 `5bf5bb0271aa288233ad3fd3467987d1`; L2 `415e0006b8be1eb6200c147b336bfcfe`;
   L3 policies `e2a93cf195706b5fb04e3e0548b919e5`; L3 views
   `2bad4bb0c7f546423f8656b570f9cf22`.
   Stale because `2026-08-09_03` rewrote `image_urls`/`video_urls` text→jsonb, dropped and
   rebuilt the whole view chain and called `regenerate_frozen_model_artifacts` +
   `rebuild_unified_records`; and `2026-08-30_01` recreated `market_listings_summary`.
2. **Production now carries six policies on `market_listings`, not four** — the four
   `frozen_*` plus the two from the applied reconciliation. The historical baseline asserts
   a four-policy shape and will not match.
3. **It must absorb a tracked follow-up:** when the baseline lands it must itself create
   BOTH `market_listings_view_fast` AND `market_listings_view_deny_none` and grant the
   summary SELECT-only to `authenticated`, so a fresh replay converges without the one-shot
   file.
4. **Fresh-replay ordering is unresolved.** Files replay lexically, so `_05` runs after
   `2026-09-04_00`. On a fresh database `2026-09-04_00` runs first and aborts by design
   (`market_listings` absent). Whoever writes `_05` must confirm that abort is a clean,
   intended stop and that CI reflects it. Do not hand-wave this.

Remeasurement requires **read-only** production access with a rotated credential via a
protected `PGPASSFILE` — never Supabase MCP mutation.

---

## 8. Storage enforcement DEFERRED to Gate B

Not created by `_02`: the `market-raw` private bucket, the `market_raw_uploader`
NOLOGIN/NOBYPASSRLS role, `GRANT market_raw_uploader TO authenticator`, and the INSERT-only
/ admin-read `storage.objects` policies.

Threat model, honestly: `service_role` has `BYPASSRLS`, so "no UPDATE/DELETE policy" does
not make a bucket immutable to a worker holding the service_role key. The design needs a
dedicated non-bypass uploader role reached by a scoped JWT — which depends on the deployed
Supabase Storage version honouring a custom `role` JWT claim. **That is unverified.** Gate B
must prove it; the documented fallback is an INSERT-only edge signer that never holds the
service_role key.

Interim: `raw_blobs.storage_bucket` / `storage_object_path` exist as plain text columns
recording where bytes live; nothing writes them; no code path needs the bucket.

---

## 9. The capture-state model (seven states)

`page_capture_manifest.state`, one row per expected section, with `why_expected` recording
the evidence it should exist (`source_reported_count | tab | button | embedded_identifier |
api_reference | platform_contract | none`).

| State | Meaning | Reduces completeness? | Schema gap? |
|---|---|---|---|
| `captured` | present and captured | no | no |
| `not_present` | genuinely absent from the listing | **no** | **no** |
| `not_applicable` | cannot apply to this listing type | **no** | **no** |
| `missing_expected` | evidence said it should be there; not captured | yes → `partial` | no (capture failure, not a mapping gap) |
| `blocked` | access refused / anti-bot / auth wall | yes → `blocked` | no |
| `failed` | attempted and errored | yes → `failed` | no |
| `unknown` | state undeterminable | yes → `partial` | no |

`raw_snapshot_derive_class` precedence: `blocked` > `failed` > (`missing_expected` or
`unknown`) → `partial` > otherwise `complete`.

> **Optional absence is not a failure and is not a schema gap.** A listing with no floor
> plan records `not_present` and stays `complete`.

---

## 10. The retention-state model (independent axis)

Capture state and retention state are **two independent axes**: capture answers "did we get
it", retention answers "do we durably hold it". Never conflate them.

`retention_mode`: `original_bytes`, `immutable_mirror`, `manifest_and_segments`,
`source_url_metadata_only`, `existing_storage_ref`.
`retention_state`: `durable_original`, `durable_existing_asset`,
`external_reference_only`, `retention_failed`, `not_applicable`.

Enforced consistency (`retention_mode_state_consistent`):

- `existing_storage_ref` → `durable_existing_asset` | `retention_failed`
- `source_url_metadata_only` → `external_reference_only` | `not_applicable`
- `original_bytes` / `immutable_mirror` / `manifest_and_segments` → `durable_original` | `retention_failed`

| Asset | retention_state | Bytes retained |
|---|---|---|
| Aqar gallery images (already mirrored to `listing-photos`) | `durable_existing_asset` | linked + hashed, not re-copied |
| Detail HTML / JSON / RSC bundle | `durable_original` | yes |
| Floor plans, documents | `durable_original` | yes when present |
| Videos (Aqar's Cloudflare Stream account) | `external_reference_only` | **no** — retain video ID, manifest URL, metadata |
| Virtual tours / panoramas (third-party) | `external_reference_only` | no |

An external URL satisfies discovery, never durable retention. No third-party segment
mirroring in this phase. `external_reference_only` counts are surfaced as a retention-risk
metric, not hidden.

---

## 11. Governance: one authority, one lifecycle

- **`source_field_mappings` is the SOLE authoritative mapping decision**, keyed
  `(platform, source_path, contract_version)`; latest version active, older retained as
  history.
- **`source_field_catalog` is discovery evidence and holds NO decision** — so status can
  never drift between two tables.
- **`schema_gap_events` is a separate review lifecycle** (`open → notified → in_review →
  resolved | wont_map`); `tg_schema_gap_requires_decision` forbids `resolved`/`wont_map`
  unless the matching mapping carries a terminal decision.
- `v_source_field_status` (`security_invoker=true`) reconciles all three.
- **contract_version naming contract:** "latest" is a DESCENDING TEXT sort — lexical, so
  `'v9'` sorts after `'v10'`. Versions must be zero-padded (`v001`…`v010`). Deliberately not
  enforced by a CHECK: the padding width is a Phase-3 adapter decision.

> **Captured but unmapped ⇒ a schema gap.** Any datum captured with no authoritative mapping
> decision raises a `schema_gap_events` row and notifies the operator. Nothing is silently
> dropped.
>
> **Optional and absent ⇒ NOT a schema gap.** A field the listing simply does not have is
> recorded `not_present`/`not_applicable` and raises nothing. Conflating the two would bury
> real gaps under routine noise.

---

## 12. Explicitly NOT in this phase

- **No quality scoring or ranking.** No score/rank/quality-named object exists and none may
  be added in Gate A; only the deterministic inputs a later scorer would consume are
  captured. CI asserts this on object names.
- No canonical `market_listings` writer.
- No worker, schedule or Aqar application change; no listing-row data change.
- No change to issue #15 (users whose scope resolves to `none`).
- No revocation of the existing broad `anon` privileges on the `market_listings` base table
  — a separate hardening task. `anon` currently reaches zero rows because no RLS policy
  targets it.

---

## 13. Access matrix and RLS posture

Posture: RLS enabled everywhere; exactly one SELECT policy per table
`TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())))`;
`REVOKE ALL FROM PUBLIC, anon`; `GRANT SELECT TO authenticated, service_role`;
**no INSERT/UPDATE/DELETE grant to any application role anywhere**. Writes arrive later via
owner-run definer RPCs. `service_role` reads by BYPASSRLS. Raw-evidence and audit tables are
additionally append-only by trigger (`_ml_reject_mutation`), so even the owner cannot
UPDATE or DELETE them without dropping the trigger.

| Object | `anon` | `authenticated` (non-admin) | `authenticated` (admin) | `service_role` |
|---|---|---|---|---|
| `listing_sources` | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `raw_blobs` (append-only) | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `raw_snapshots` (append-only) | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `raw_snapshot_artifacts` (append-only) | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `page_capture_manifest` (append-only) | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `source_field_catalog` | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `source_field_mappings` | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `schema_gap_events` | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `ingestion_runs` | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `ingestion_items` | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `listing_change_events` (append-only) | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `listing_change_review` | no privileges | SELECT granted; admin-only policy → zero rows | SELECT | SELECT (BYPASSRLS) |
| `v_source_field_status` (view, `security_invoker=true`) | no privileges | SELECT granted; caller's admin-gated base-table RLS applies → zero rows | SELECT (via base-table policies) | SELECT (BYPASSRLS) |

---

## 14. What CI proves, and what it does not

Job `market-ingest-gate-a` in `.github/workflows/ci.yml` runs
`supabase/tests/ci/run_market_ingest_gate_a_test.sh` against an ephemeral Postgres 17.
`db-migrations` globs only `2026-09-01_0*` / `2026-09-02_0*`, so it never executes this set
— the dedicated job is the only coverage.

> CI proves the four additive migrations apply cleanly, idempotently, and with the designed
> constraints, indexes, triggers, RLS policies and grants **against the supported
> predecessor fixture**. It does **not** prove whole-repository fresh-database parity.
> Complete bootstrap parity remains blocked (Section 2).

The fixture contains only Supabase-managed platform primitives (roles, `auth` schema,
`auth.uid()`) and genuine repo-provided predecessors (`aqar_listing_evidence`,
`wassell_is_admin`). It must never create a `market_listings` stub.

---

## 15. Open questions for the operator

1. Freeze-baseline fingerprint remeasurement — needs rotated read-only production access.
2. Gate B: does the deployed Storage version honour a custom `role` JWT claim?
3. Fresh-replay behaviour of `2026-09-04_00` once `_05` exists (Section 7 blocker 4).
4. Issue #15.
5. `anon` base-table grant revocation.
6. Whether the branch-bootstrap set should be regenerated post-freeze so `market_listings`
   enters the supported bootstrap — which would change how `_05` is written.
