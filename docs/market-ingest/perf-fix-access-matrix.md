# market_listings performance fix — access matrix, plans, tests (for review)

**Status:** migration WRITTEN, **not applied**. Fix-forward =
`supabase/migrations/2026-09-03_01_market_listings_view_fast_path.sql`; the freeze
baseline (`_02`) creates the same policy for fresh-DB parity.

## Root cause
After the 2026-09-03_00 hotfix made `market_listings_summary` `security_invoker=true`,
the base-table `frozen_view` RLS policy (a 90-column jsonb rebuild + `wassell_can_view_jsonb()`
**per row**, no scope-class guard) runs under every authenticated read of 314,070 rows →
statement timeout. The summary VIEW already had a scope-class fast path in its own WHERE
(2026-07-17); the base table did not.

## Fix
A SEPARATE permissive SELECT policy `market_listings_view_fast`:
`USING ((SELECT wassell_view_scope_class((SELECT auth.uid()), <model>)) = 'all')`.
The scalar subquery is an uncorrelated **InitPlan** — evaluated ONCE per statement. For an
`'all'` profile it is constant-true, so the `frozen_view` per-row call short-circuits (OR of
two permissive policies). `frozen_view` is untouched and remains the scoped path for
`'filtered'` profiles. No SECURITY DEFINER bypass; summary stays `security_invoker=true`.

## Access matrix (active users, resolved 2026-08-09)
| Profile | admin | active users | scope_class | Under the fix |
|---|---|---|---|---|
| Administrator | yes | 3 | all | fast path — all rows |
| New Profile | no | 2 | all | fast path — all rows |
| Technical Admin – Abdulmohsen | no | 1 | all | fast path — all rows |
| New Profile | no | 1 | none | denied — 0 rows |
| New Profile | no | 1 | none | denied — 0 rows |
| anon | — | — | none (no grant) | permission denied |
| service_role | — | — | all (bypass) | all rows (BYPASSRLS) |

**Product decision to confirm:** the 2 active non-admin `none` users could read all market
listings before the hotfix (via the `security_invoker=false` bypass bug). Under the corrected
RLS they see nothing. If the business wants them to keep access, the fix is a **config change**
(add `market_listings` view permission to their profile) — never a weakening of RLS.

## Before / after query plans (isolated rolled-back tx, prod data)
- **Before (prod today), non-admin 'all', summary count:** `Seq Scan` with leading
  `wassell_can_view_jsonb(<full 90-col jsonb>)` from `frozen_view` — evaluated for all 314,070
  rows → times out.
- **After, 'all', real SPA keyset page** (`WHERE id > cursor ORDER BY id LIMIT 1000`):
  `Index Scan using market_listings_pkey`; scope-class `InitPlan rows=1`; the per-row
  `wassell_can_view_jsonb` InitPlans are **never executed**; scan stops at 1000 rows;
  **39 ms** (beats the 2026-07-17 fast-path target of 460 ms/page).
- **After, 'filtered'** (temp `source='bayut'` restriction, rolled back): per-row check
  **engages** (`InitPlan rows=1`, executed), `Rows Removed by Filter: 1636` → bayut subset,
  **543 ms** (summary) / **1607 ms** (direct base-table via `frozen_view`). Auto-fallback confirmed.
- **service_role baseline** (no RLS): `Parallel Index-Only Scan`, count in **174 ms**. The
  residual seq-scan cost of a full `count(*)` under RLS is inherent to having a row filter at all
  (index-only is impossible with any RLS qual); it is unchanged by this fix and matches the prior
  `security_invoker=false` behavior. The SPA pages by `id` with `LIMIT`, which stays index-bounded (39 ms).

## Durability
`regenerate_frozen_model_artifacts()` drops only `frozen_view/insert/update/delete` by name and
recreates them; the separately-named `market_listings_view_fast` survives any future schema
regeneration. The freeze baseline also creates it, so a fresh replay cannot leave it missing.
