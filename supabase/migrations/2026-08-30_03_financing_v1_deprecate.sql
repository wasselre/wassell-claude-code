-- APPLIED TO PRODUCTION 2026-08-30 as migration `financing_v1_deprecate`.
-- Recorded here so the repo matches the database. This one IS idempotent (it
-- drops policies by name and recreates one per table).
--
-- Deprecate the V1 fin_* tables. NOTHING IS DROPPED.
--
-- The data is real (two live customer scenarios plus the reference set) and V2
-- has not yet run in production long enough to be trusted alone. So: keep every
-- row, make the tables read-only to the application, and label them so nobody
-- mistakes them for live structures. Physical removal is a separate, later
-- decision — see docs/financing/CLEANUP-PLAN.md.
--
-- "Read-only" is enforced by REPLACING the write policies, not by revoking
-- grants: RLS is already the authorization boundary here, so a policy that can
-- never be true is the narrowest change that actually stops writes.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fin_sources','fin_source_records','fin_source_snapshots','fin_data_refresh_runs',
    'fin_data_validation_issues','fin_manual_review_queue','fin_providers','fin_products',
    'fin_product_versions','fin_product_rate_versions','fin_product_fee_rules',
    'fin_product_eligibility_rules','fin_product_document_requirements','fin_product_property_rules',
    'fin_project_provider_approvals','fin_regulatory_rules','fin_regulatory_rule_versions',
    'fin_support_programs','fin_support_program_versions','fin_tax_rules','fin_tax_rule_versions',
    'fin_benchmarks','fin_benchmark_observations',
    'fin_scenarios','fin_scenario_applicants','fin_income_sources','fin_obligations',
    'fin_scenario_support','fin_property_scenarios','fin_preferences',
    'fin_calculation_runs','fin_calculation_results','fin_product_match_results',
    'fin_cash_flows','fin_scenario_notes','fin_audit_events'
  ] LOOP
    -- Drop every existing policy on the table, whatever it was called.
    EXECUTE (
      SELECT COALESCE(string_agg(format('DROP POLICY IF EXISTS %I ON public.%I;', policyname, t), ' '), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename = t);

    -- Admins may still READ, for reference and for the cleanup audit.
    EXECUTE format(
      'CREATE POLICY %I_deprecated_read ON public.%I FOR SELECT TO authenticated
         USING (public.wassell_is_admin(auth.uid()))', t, t);

    -- No INSERT/UPDATE/DELETE policy exists, so under RLS every write is denied.
    EXECUTE format(
      'COMMENT ON TABLE public.%I IS ''DEPRECATED 2026-08-30 (financing V1). Superseded by financing_products / financing_rates / financing_rules / financing_scenarios. Data retained, read-only to admins. Removal plan: docs/financing/CLEANUP-PLAN.md''', t);
  END LOOP;
END $$;

-- Verify: no fin_* table retains a write policy.
SELECT count(*) AS remaining_write_policies
FROM pg_policies
WHERE schemaname='public' AND tablename LIKE 'fin\_%' AND cmd <> 'SELECT';
