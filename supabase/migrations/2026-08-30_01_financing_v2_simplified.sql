-- ============================================================================
-- Financing V2 — the simplified model
--
-- WHY THIS EXISTS: V1 was built as a regulatory archival platform (36 tables,
-- effective-dated version graphs, a source-snapshot store, an ingestion runtime).
-- Wassel needs an indicative prequalification tool. This migration collapses it
-- to FOUR tables that one developer can hold in their head.
--
-- V1 IS ALREADY IN PRODUCTION AND HOLDS REAL CUSTOMER SCENARIOS, so nothing is
-- dropped here. The `fin_*` tables keep their data and are marked deprecated in
-- migration 03; a separate cleanup plan removes them later, once V2 has run long
-- enough to be trusted.
--
-- ON "ORGANIZATION": this application is SINGLE-TENANT — there is no
-- organizations table, and there never was. The "organization and RLS model"
-- that actually exists is users + profiles + `wassell_is_admin`, so V2 reuses
-- exactly that. Adding an org column here would be a decorative field that
-- protects nothing.
-- ============================================================================

-- ── 1. Products ────────────────────────────────────────────────────────────
-- The provider is INLINE, not a separate table. Six products from six banks does
-- not need a join to learn a bank's name, and `provider_type` (bank vs finance
-- company) is the only provider attribute the maths actually reads — it selects
-- which SAMA LTV cell applies.
CREATE TABLE IF NOT EXISTS public.financing_products (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key          text NOT NULL,
  provider_name_ar      text NOT NULL,
  provider_name_en      text NOT NULL,
  provider_type         text NOT NULL DEFAULT 'bank'
                          CHECK (provider_type IN ('bank','real_estate_finance_company')),
  product_key           text NOT NULL,
  name_ar               text NOT NULL,
  name_en               text NOT NULL,
  is_active             boolean NOT NULL DEFAULT true,

  -- Eligibility. NULL means "the bank does not publish this", which the matcher
  -- reports as requires_bank_review. It never means "no restriction".
  supported_financing   text CHECK (supported_financing IN ('supported','unsupported','both')),
  property_types        text[],
  nationality           text[],          -- {'saudi','resident'}
  employment_sectors    text[],          -- {'government','semi_government','military','private'}
  employment_types      text[],          -- {'employee','military','retiree','self_employed','business_owner'}
  min_salary            numeric(14,2) CHECK (min_salary IS NULL OR min_salary >= 0),
  min_salary_no_transfer numeric(14,2),
  min_age               integer,
  max_age_at_maturity   integer,
  requires_salary_transfer boolean,
  first_home_applicable boolean,
  additional_home_applicable boolean,
  min_down_payment_pct  numeric(6,3) CHECK (min_down_payment_pct IS NULL OR min_down_payment_pct BETWEEN 0 AND 100),
  max_ltv_pct           numeric(6,3) CHECK (max_ltv_pct IS NULL OR max_ltv_pct BETWEEN 0 AND 100),
  max_term_months       integer CHECK (max_term_months IS NULL OR max_term_months > 0),
  max_amount            numeric(16,2),

  -- Anything that varies bank-to-bank and does not deserve a column: net-vs-gross
  -- income basis, MOI approval for regular iqama, minimum service months, etc.
  criteria              jsonb NOT NULL DEFAULT '{}'::jsonb,

  official_url          text,
  last_verified_at      date,
  notes                 text,
  confidence            text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),

  retired_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_key, product_key)
);
CREATE INDEX IF NOT EXISTS financing_products_active_idx ON public.financing_products(is_active) WHERE retired_at IS NULL;

-- ── 2. Rates ───────────────────────────────────────────────────────────────
-- Version history = insert a new row and flip the old one's is_active. That is
-- the whole mechanism; no effective-dated graph, no content hashing.
CREATE TABLE IF NOT EXISTS public.financing_rates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        uuid NOT NULL REFERENCES public.financing_products(id) ON DELETE CASCADE,

  -- The safeguard that survives from V1 intact: a "starting from" marketing
  -- figure can never be stored as though it were the customer's exact rate.
  disclosure_type   text NOT NULL CHECK (disclosure_type IN
                      ('exact_rate','starting_from','representative_example','quotation_required')),
  rate_type         text NOT NULL DEFAULT 'fixed' CHECK (rate_type IN ('fixed','variable')),

  contractual_rate_pct numeric(7,4) CHECK (contractual_rate_pct IS NULL OR contractual_rate_pct BETWEEN 0 AND 100),
  published_apr_pct    numeric(7,4) CHECK (published_apr_pct IS NULL OR published_apr_pct BETWEEN 0 AND 100),
  starting_apr_pct     numeric(7,4) CHECK (starting_apr_pct IS NULL OR starting_apr_pct BETWEEN 0 AND 100),

  -- {property_price, ltv_pct, term_months, monthly_payment, note}
  example           jsonb,

  effective_from    date NOT NULL DEFAULT CURRENT_DATE,
  expires_at        date,
  source_url        text NOT NULL,
  last_verified_at  date NOT NULL DEFAULT CURRENT_DATE,
  confidence        text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  -- An admin can force-mark a rate stale without waiting for the age threshold.
  marked_stale      boolean NOT NULL DEFAULT false,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,

  CONSTRAINT financing_rates_exact_needs_rate CHECK (
    disclosure_type <> 'exact_rate' OR contractual_rate_pct IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS financing_rates_product_idx ON public.financing_rates(product_id, is_active, effective_from DESC);

-- ── 3. Rules ───────────────────────────────────────────────────────────────
-- One row per regulatory rule, current version only. History lives where it is
-- actually needed: inside each scenario's frozen result snapshot.
CREATE TABLE IF NOT EXISTS public.financing_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key         text NOT NULL UNIQUE,
  label_ar         text NOT NULL,
  label_en         text NOT NULL,
  payload          jsonb NOT NULL,
  source_url       text NOT NULL,
  citation         text,
  effective_from   date NOT NULL,
  last_verified_at date NOT NULL DEFAULT CURRENT_DATE,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ── 4. Scenarios ───────────────────────────────────────────────────────────
-- Applicants, incomes, obligations and preferences live in `input_snapshot`.
-- Capacity, matches and cash figures live in `result_snapshot`. Six tables
-- became two JSON columns, and the snapshots are what made the calculation
-- reproducible in V1 anyway — the child tables were never what a replay read.
CREATE TABLE IF NOT EXISTS public.financing_scenarios (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_number       bigint GENERATED ALWAYS AS IDENTITY,
  title                 text,

  client_record_id      uuid,
  project_record_id     uuid,
  unit_record_id        uuid,
  financing_case_record_id uuid,

  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','calculated','converted','archived')),

  owner_user_id         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_user_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_by_user_id    uuid REFERENCES public.users(id) ON DELETE SET NULL,

  input_snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_snapshot       jsonb,
  selected_product_id   uuid REFERENCES public.financing_products(id) ON DELETE SET NULL,
  calculation_version   text,

  -- Consent gate kept from V1: converting to a financing case is what puts
  -- customer financial data in front of a provider.
  consent_to_share      boolean NOT NULL DEFAULT false,
  consent_recorded_at   timestamptz,
  consent_recorded_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  deleted_at            timestamptz,

  -- A completed scenario must carry the frozen result that produced it.
  CONSTRAINT financing_scenarios_calculated_has_result CHECK (
    status = 'draft' OR status = 'archived' OR result_snapshot IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS financing_scenarios_client_idx  ON public.financing_scenarios(client_record_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS financing_scenarios_owner_idx   ON public.financing_scenarios(owner_user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS financing_scenarios_project_idx ON public.financing_scenarios(project_record_id) WHERE project_record_id IS NOT NULL AND deleted_at IS NULL;

-- ── Freeze the snapshot once a scenario completes ──────────────────────────
-- The one immutability rule V2 keeps. A stored result is the record of what a
-- customer was shown; editing it in place would make that record worthless.
-- Re-calculating writes a NEW snapshot only from a draft, so a completed
-- scenario is a permanent artefact.
CREATE OR REPLACE FUNCTION public.financing_freeze_completed_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL
     AND NEW.result_snapshot IS DISTINCT FROM OLD.result_snapshot THEN
    RAISE EXCEPTION 'financing_scenarios: result_snapshot is frozen once completed (scenario %) — duplicate the scenario instead of rewriting its result', OLD.scenario_number
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS financing_scenarios_freeze ON public.financing_scenarios;
CREATE TRIGGER financing_scenarios_freeze BEFORE UPDATE ON public.financing_scenarios
  FOR EACH ROW EXECUTE FUNCTION public.financing_freeze_completed_snapshot();

CREATE OR REPLACE FUNCTION public.financing_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS financing_products_touch ON public.financing_products;
CREATE TRIGGER financing_products_touch BEFORE UPDATE ON public.financing_products
  FOR EACH ROW EXECUTE FUNCTION public.financing_touch_updated_at();
DROP TRIGGER IF EXISTS financing_rules_touch ON public.financing_rules;
CREATE TRIGGER financing_rules_touch BEFORE UPDATE ON public.financing_rules
  FOR EACH ROW EXECUTE FUNCTION public.financing_touch_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────────
-- Reference data (products / rates / rules): readable by any authenticated
-- user, writable by admins. Bank product data is public information; editing it
-- is a governance act.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['financing_products','financing_rates','financing_rules'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_read ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_write ON public.%I FOR ALL TO authenticated
      USING (public.wassell_is_admin(auth.uid())) WITH CHECK (public.wassell_is_admin(auth.uid()))', t, t);
  END LOOP;
END $$;

-- Customer financial data: owner, assignee, creator, or admin. Same posture as
-- V1, expressed inline because there are no child tables left to share it with.
ALTER TABLE public.financing_scenarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS financing_scenarios_view ON public.financing_scenarios;
CREATE POLICY financing_scenarios_view ON public.financing_scenarios FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND (
    public.wassell_is_admin(auth.uid())
    OR owner_user_id      = public.wassell_app_user_id(auth.uid())
    OR assigned_user_id   = public.wassell_app_user_id(auth.uid())
    OR created_by_user_id = public.wassell_app_user_id(auth.uid())));

DROP POLICY IF EXISTS financing_scenarios_insert ON public.financing_scenarios;
CREATE POLICY financing_scenarios_insert ON public.financing_scenarios FOR INSERT TO authenticated
  WITH CHECK (public.wassell_is_admin(auth.uid())
              OR created_by_user_id = public.wassell_app_user_id(auth.uid()));

DROP POLICY IF EXISTS financing_scenarios_update ON public.financing_scenarios;
CREATE POLICY financing_scenarios_update ON public.financing_scenarios FOR UPDATE TO authenticated
  USING (public.wassell_is_admin(auth.uid())
         OR owner_user_id      = public.wassell_app_user_id(auth.uid())
         OR assigned_user_id   = public.wassell_app_user_id(auth.uid())
         OR created_by_user_id = public.wassell_app_user_id(auth.uid()))
  WITH CHECK (public.wassell_is_admin(auth.uid())
         OR owner_user_id      = public.wassell_app_user_id(auth.uid())
         OR assigned_user_id   = public.wassell_app_user_id(auth.uid())
         OR created_by_user_id = public.wassell_app_user_id(auth.uid()));

DROP POLICY IF EXISTS financing_scenarios_delete ON public.financing_scenarios;
CREATE POLICY financing_scenarios_delete ON public.financing_scenarios FOR DELETE TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

COMMENT ON TABLE public.financing_products IS 'V2 financing products. Provider inlined; variable criteria in the criteria jsonb. Replaces fin_providers + fin_products + fin_product_versions + 4 rule tables.';
COMMENT ON TABLE public.financing_rates IS 'V2 pricing. Version history = new row + is_active flip. disclosure_type stops a "starting from" figure being presented as an exact rate.';
COMMENT ON TABLE public.financing_rules IS 'V2 regulatory rules, current version only. Historical values live in each scenario''s frozen result_snapshot.';
COMMENT ON TABLE public.financing_scenarios IS 'V2 scenarios. Inputs and results are JSON snapshots; result_snapshot is frozen once completed_at is set.';
