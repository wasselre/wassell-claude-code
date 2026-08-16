# Superseded market-ingest migrations — do not replay

Last updated: 2026-08-16

Two recovered migrations were absorbed into the applied reconciliation
`2026-09-04_00_market_listings_view_reconciliation.sql` and must **never be replayed**.
This document exists so a future session that rediscovers PR #13 does not try to land
`2026-09-03_00` or `2026-09-03_01`.

## Absorbed into `2026-09-04_00`

| Recovered file | Absorbed by | Why it must not be replayed |
|---|---|---|
| `2026-09-03_00_hotfix_market_listings_view_exposure.sql` | `2026-09-04_00` | The three views were flipped to `security_invoker=true` with grants tightened by the applied migration; replaying repeats a completed change against pinned state. |
| `2026-09-03_01_market_listings_view_fast_path.sql` | `2026-09-04_00` | Conflicting `market_listings_view_fast` policy AND missing `market_listings_view_deny_none` — a measured ~299 s regression for scope-`none` users. |

## Restructured original

| Recovered file | Disposition | Why |
|---|---|---|
| `2026-09-03_06_ingestion_provenance_outbox.sql` | SPLIT into `2026-09-05_04_ingestion_audit.sql` (landed in this branch) + `2026-09-05_06_listing_provenance_outbox.sql` (deferred, blocked on `_05`) | `listing_field_provenance` and `mirror_outbox` FK to `public.market_listings`, a table no repository file creates. No FK was weakened. |

## Where the originals live

PR #13 / branch `recovery/market-ingest-original-worktree` / commit
`01b474569b8fed1b5b2aadbbb534f93f23569458` — read-only history.

## Not carried forward

| Artifact | Why not carried forward |
|---|---|
| `gate-a.patch` | Redundant full diff of superseded files. |
| `hotfix-tests.sql` | Tests the obsolete `2026-09-03_00`. |
| `perf-fix-tests.sql` | Tests the obsolete `2026-09-03_01`. |
| `perf-fix-access-matrix.md` | Superseded by the applied migration's own matrix. |
| `frozen-generated-objects.md` | Captured definitions predating three regenerations — stale; must be recaptured with the freeze baseline. |

---

*Content may be cherry-picked from PR #13 by hand with review; commits may not. Do not
merge it. Do not rebase it.*
