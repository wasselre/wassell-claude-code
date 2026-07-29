# Financing V1 cleanup plan — deferred physical removal

_Written 2026-08-30. Not to be executed yet._

## Why the V1 tables still exist

V1's four migrations were **already applied to production** and the tables held
real data — two customer scenarios created through the live app, plus the
reference set. Dropping them as part of the V2 cutover would have been an
unsafe destructive change on live customer work, so instead:

- every row was **kept**
- all 36 `fin_*` tables were made **read-only to admins** (write policies
  removed, so RLS denies every INSERT/UPDATE/DELETE)
- each table carries a `DEPRECATED 2026-08-30` comment pointing here
- the data the application actually needs was **copied into the V2 tables**

Nothing in the running application reads `fin_*` any more.

## What was copied into V2

| From V1 | To V2 | Notes |
|---|---|---|
| 2 customer scenarios + their child rows + latest completed run | `financing_scenarios` (2 rows) | Child tables collapsed into `input_snapshot`; the run's frozen result became `result_snapshot`. Same UUIDs, so any external reference still resolves. |
| 31 products across 16 providers | `financing_products` (6 rows) | One flagship product per bank, chosen for the most complete published eligibility. |
| 9 rate versions | `financing_rates` (4 rows) | Only the rates belonging to the 6 retained products. |
| 8 regulatory rule versions + 1 tax + 2 support programmes | `financing_rules` (6 rows) | `fee_cap` and `early_settlement` dropped — V2 computes no APR and models no settlement, so they had no consumer. |
| 57 source snapshots, 66 sources, 8 refresh runs, 100+ validation issues | *(not copied)* | Artefacts of the ingestion platform. Retained in V1 tables for reference only. |

## Preconditions before dropping anything

Do not run the removal until **all** of these hold:

1. **V2 has been live for at least one full quarter** with reps creating
   scenarios, so we know the simplified model covers real usage.
2. **No V1 row is newer than the V2 cutover.** Verify:
   ```sql
   SELECT max(created_at) FROM fin_scenarios;   -- must predate 2026-08-30
   ```
   A newer row means something still writes to V1 — find it first.
3. **The two migrated scenarios still reconcile.** Their V2 `result_snapshot`
   should equal the V1 run's `result_snapshot` byte for byte:
   ```sql
   SELECT s.scenario_number,
          v2.result_snapshot = r.result_snapshot AS matches
   FROM financing_scenarios v2
   JOIN fin_scenarios s ON s.id = v2.id
   JOIN fin_calculation_runs r ON r.scenario_id = s.id
   ORDER BY s.scenario_number;
   ```
4. **A full backup exists** and has been restore-tested — not just a snapshot in
   the dashboard.
5. **Someone other than the author signs off.** This deletes customer financial
   history.

## Removal order

Drop children before parents; the append-only triggers must go first or they
will refuse the cascades.

```sql
BEGIN;

-- 1. Triggers that block deletion
DROP TRIGGER IF EXISTS fin_audit_events_append_only        ON public.fin_audit_events;
DROP TRIGGER IF EXISTS fin_calculation_runs_append_only    ON public.fin_calculation_runs;
DROP TRIGGER IF EXISTS fin_calculation_results_append_only ON public.fin_calculation_results;
DROP TRIGGER IF EXISTS fin_product_match_results_append_only ON public.fin_product_match_results;
DROP TRIGGER IF EXISTS fin_cash_flows_append_only          ON public.fin_cash_flows;
DROP TRIGGER IF EXISTS fin_bobs_immutable                  ON public.fin_benchmark_observations;
DROP TRIGGER IF EXISTS fin_snapshots_immutable             ON public.fin_source_snapshots;
-- plus the five *_append_only triggers on the version tables

-- 2. Scenario layer (children first)
DROP TABLE IF EXISTS public.fin_cash_flows,
                     public.fin_product_match_results,
                     public.fin_calculation_results,
                     public.fin_calculation_runs,
                     public.fin_scenario_notes,
                     public.fin_audit_events,
                     public.fin_income_sources,
                     public.fin_obligations,
                     public.fin_scenario_support,
                     public.fin_property_scenarios,
                     public.fin_preferences,
                     public.fin_scenario_applicants,
                     public.fin_scenarios CASCADE;

-- 3. Reference layer
DROP TABLE IF EXISTS public.fin_product_fee_rules,
                     public.fin_product_eligibility_rules,
                     public.fin_product_document_requirements,
                     public.fin_product_property_rules,
                     public.fin_project_provider_approvals,
                     public.fin_product_rate_versions,
                     public.fin_product_versions,
                     public.fin_products,
                     public.fin_providers,
                     public.fin_regulatory_rule_versions,
                     public.fin_regulatory_rules,
                     public.fin_support_program_versions,
                     public.fin_support_programs,
                     public.fin_tax_rule_versions,
                     public.fin_tax_rules,
                     public.fin_benchmark_observations,
                     public.fin_benchmarks CASCADE;

-- 4. Ingestion layer
DROP TABLE IF EXISTS public.fin_manual_review_queue,
                     public.fin_data_validation_issues,
                     public.fin_source_snapshots,
                     public.fin_source_records,
                     public.fin_data_refresh_runs,
                     public.fin_sources CASCADE;

-- 5. Orphaned functions
DROP FUNCTION IF EXISTS public.fin_can_access_scenario(uuid, uuid);
DROP FUNCTION IF EXISTS public.fin_rule_version_at(text, date);
DROP FUNCTION IF EXISTS public.fin_product_version_at(uuid, date);
DROP FUNCTION IF EXISTS public.fin_rate_version_at(uuid, date);
DROP FUNCTION IF EXISTS public.fin_tg_version_append_only();
DROP FUNCTION IF EXISTS public.fin_tg_append_only();
DROP FUNCTION IF EXISTS public.fin_tg_observation_immutable();
DROP FUNCTION IF EXISTS public.fin_tg_touch_updated_at();
DROP FUNCTION IF EXISTS public.fin_tg_run_number();

COMMIT;
```

## Rollback

Until the drop runs, rollback is trivial: `backup/financing-v1-full` (commit
`ed58df05`) restores the V1 application code, and the tables it expects are
still present with their data. Re-granting the write policies is the only DB
change needed.

**After** the drop there is no rollback except a database restore. That is the
reason for precondition 4.

## Also to remove at that point

- `src/lib/financing/money.ts` — keep only if still imported (it is, by
  `payment.ts` and `capacity.ts`)
- Nothing else: the V1 scripts, snapshots, pages and docs were deleted during
  the V2 cutover, not deferred.
