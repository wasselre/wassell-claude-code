-- ============================================================================
-- Saudi Real Estate Financing — customer scenario layer
-- (scenarios, applicants, income, obligations, property, preferences,
--  calculation runs, immutable results, product matches, cash flows, audit)
--
-- WHY THIS IS SEPARATE FROM THE REFERENCE LAYER: reference data is public bank
-- information every rep may read. THIS layer is customer financial data —
-- salaries, debts, credit-card balances. It gets a different RLS posture
-- (owner + assignee + admin, mirroring how the CRM scopes client records),
-- different retention thinking, and its own audit trail.
--
-- CUSTOMER IDENTITY IS NOT DUPLICATED. A scenario points at the existing
-- `records` row for the client/lead; name, phone and budget are read from there.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.fin_scenarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_number bigint GENERATED ALWAYS AS IDENTITY,
  title           text,

  -- CRM linkage. client_record_id is the `records` row of a clients/lead record.
  -- No FK: `records` holds every model's rows and a frozen model would move the
  -- row out of it, so we validate by model at the API boundary instead of
  -- pinning a constraint that a future freeze would break.
  client_record_id uuid,
  client_model_id  uuid REFERENCES public.models(id) ON DELETE SET NULL,
  project_record_id uuid,
  unit_record_id    uuid,
  offer_record_id   uuid,
  reservation_record_id uuid,
  financing_case_record_id uuid,

  status          text NOT NULL DEFAULT 'draft' CHECK (status IN (
                    'draft','calculated','shared','converted','archived')),
  -- Set when the rep marks one scenario as the one being pursued.
  is_preferred    boolean NOT NULL DEFAULT false,
  -- Duplicated-from lineage, so "same customer, 25 years instead of 20" keeps
  -- its ancestry rather than looking like an unrelated scenario.
  duplicated_from_scenario_id uuid REFERENCES public.fin_scenarios(id) ON DELETE SET NULL,

  owner_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_specialist_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,

  -- PDPL posture: an indicative estimate needs no consent, but pushing the
  -- customer's financial data to a bank does. The engine never blocks on this;
  -- the CONVERSION path does.
  consent_to_share_with_provider boolean NOT NULL DEFAULT false,
  consent_recorded_at timestamptz,
  consent_recorded_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  consent_note    text,

  -- Wizard resume state. Kept as jsonb because it is UI progress, not data the
  -- engine reads — the engine only ever reads the normalized child tables.
  wizard_step     text,
  wizard_state    jsonb NOT NULL DEFAULT '{}'::jsonb,

  notes           text,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_scen_client_idx  ON public.fin_scenarios(client_record_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS fin_scen_owner_idx   ON public.fin_scenarios(owner_user_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS fin_scen_status_idx  ON public.fin_scenarios(status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS fin_scen_project_idx ON public.fin_scenarios(project_record_id) WHERE project_record_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS fin_scen_unit_idx    ON public.fin_scenarios(unit_record_id) WHERE unit_record_id IS NOT NULL AND deleted_at IS NULL;
-- One preferred scenario per client, enforced rather than hoped for.
CREATE UNIQUE INDEX IF NOT EXISTS fin_scen_one_preferred_per_client
  ON public.fin_scenarios(client_record_id) WHERE is_preferred AND deleted_at IS NULL;

-- ── Applicants (primary + co-borrower) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_scenario_applicants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     uuid NOT NULL REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,
  applicant_role  text NOT NULL CHECK (applicant_role IN ('primary','co_borrower')),
  display_name    text,

  nationality_type text CHECK (nationality_type IN ('saudi','resident')),
  date_of_birth   date,
  -- Collected ONLY because some published product rules genuinely key on it.
  -- Nullable, never required to produce an estimate.
  gender          text CHECK (gender IN ('male','female')),
  marital_status  text CHECK (marital_status IN ('single','married','divorced','widowed')),
  dependants_count integer CHECK (dependants_count IS NULL OR dependants_count >= 0),
  city_of_residence text,

  employment_type text CHECK (employment_type IN ('employee','retiree','military','self_employed','business_owner','other')),
  employer_sector text CHECK (employer_sector IN ('government','semi_government','military','private','other')),
  employer_name   text,
  employer_classification text,
  job_title       text,
  employment_start_date date,
  service_months  integer CHECK (service_months IS NULL OR service_months >= 0),
  military_rank   text,
  retirement_date date,
  expected_retirement_age integer CHECK (expected_retirement_age IS NULL OR expected_retirement_age BETWEEN 40 AND 100),

  salary_transfer_bank_provider_id uuid REFERENCES public.fin_providers(id) ON DELETE SET NULL,
  salary_transfer_bank_name text,
  willing_to_transfer_salary boolean,
  preferred_provider_ids uuid[],

  -- Explicitly self-declared. Never presented as a credit-bureau fact — we have
  -- no SIMAH access and must not imply otherwise.
  has_declared_credit_issues boolean,
  credit_issues_note text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_appl_scenario_idx ON public.fin_scenario_applicants(scenario_id);
CREATE UNIQUE INDEX IF NOT EXISTS fin_appl_one_primary
  ON public.fin_scenario_applicants(scenario_id) WHERE applicant_role = 'primary';

-- ── Income sources ─────────────────────────────────────────────────────────
-- Declared / verified / qualifying are THREE DIFFERENT NUMBERS and the schema
-- refuses to let them collapse into one. `qualifying_monthly_amount` is written
-- by the engine, never typed by a user.
CREATE TABLE IF NOT EXISTS public.fin_income_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     uuid NOT NULL REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,
  applicant_id    uuid REFERENCES public.fin_scenario_applicants(id) ON DELETE CASCADE,
  income_type     text NOT NULL CHECK (income_type IN (
                    'basic_salary','housing_allowance','other_allowance','pension','commission',
                    'bonus','rental','investment','business','other_recurring','government_support')),
  label           text,
  declared_monthly_amount numeric(14,2) CHECK (declared_monthly_amount IS NULL OR declared_monthly_amount >= 0),
  verified_monthly_amount numeric(14,2) CHECK (verified_monthly_amount IS NULL OR verified_monthly_amount >= 0),
  documentation_status text NOT NULL DEFAULT 'undocumented' CHECK (documentation_status IN (
                    'undocumented','self_declared','payslip','bank_statement','employer_letter','gosi','contract','other')),
  frequency       text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly','quarterly','semi_annual','annual','irregular')),
  averaging_period_months integer CHECK (averaging_period_months IS NULL OR averaging_period_months > 0),
  is_fixed        boolean NOT NULL DEFAULT true,
  -- Written by the engine from the applicable regulatory rule version.
  eligible_pct    numeric(6,3) CHECK (eligible_pct IS NULL OR (eligible_pct >= 0 AND eligible_pct <= 100)),
  qualifying_monthly_amount numeric(14,2) CHECK (qualifying_monthly_amount IS NULL OR qualifying_monthly_amount >= 0),
  exclusion_reason text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_income_scenario_idx ON public.fin_income_sources(scenario_id);

-- ── Existing obligations ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_obligations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     uuid NOT NULL REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,
  applicant_id    uuid REFERENCES public.fin_scenario_applicants(id) ON DELETE CASCADE,
  obligation_type text NOT NULL CHECK (obligation_type IN (
                    'personal_finance','mortgage','auto_finance','auto_lease','credit_card','bnpl',
                    'employer_loan','development_fund','student_finance','guarantee','alimony','other')),
  provider_name   text,
  provider_id     uuid REFERENCES public.fin_providers(id) ON DELETE SET NULL,
  monthly_payment numeric(14,2) CHECK (monthly_payment IS NULL OR monthly_payment >= 0),
  outstanding_balance numeric(16,2) CHECK (outstanding_balance IS NULL OR outstanding_balance >= 0),
  original_amount numeric(16,2),
  remaining_months integer CHECK (remaining_months IS NULL OR remaining_months >= 0),
  end_date        date,
  -- Credit cards do not have an installment; the regulator's rule keys off the
  -- CEILING, so the limit is the field that matters and is captured separately.
  card_limit      numeric(14,2) CHECK (card_limit IS NULL OR card_limit >= 0),
  card_outstanding numeric(14,2) CHECK (card_outstanding IS NULL OR card_outstanding >= 0),
  minimum_payment numeric(14,2),
  balloon_payment numeric(16,2),
  will_be_settled_before_financing boolean NOT NULL DEFAULT false,
  settlement_note text,
  verification_status text NOT NULL DEFAULT 'self_declared' CHECK (verification_status IN (
                    'self_declared','statement','simah_report','creditor_letter','other')),
  -- Written by the engine: what this obligation actually contributed, and why.
  counted_monthly_amount numeric(14,2),
  counting_basis  text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A credit card with neither a limit nor a stated payment cannot be assessed;
  -- forcing one of them present prevents a silent zero.
  CONSTRAINT fin_obl_card_needs_basis CHECK (
    obligation_type <> 'credit_card' OR card_limit IS NOT NULL OR monthly_payment IS NOT NULL OR minimum_payment IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS fin_obl_scenario_idx ON public.fin_obligations(scenario_id);

-- ── Government support / first-home status ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_scenario_support (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     uuid NOT NULL UNIQUE REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,
  is_first_home   boolean,
  sakani_eligible boolean,
  redf_eligible   boolean,
  support_program_id uuid REFERENCES public.fin_support_programs(id) ON DELETE SET NULL,
  monthly_support_amount numeric(14,2),
  support_duration_months integer,
  support_cap_amount numeric(16,2),
  -- 'confirmed' means the rep saw the Sakani certificate. Anything else keeps
  -- the result labelled as depending on unverified support.
  support_status  text NOT NULL DEFAULT 'self_declared' CHECK (support_status IN ('self_declared','confirmed','not_eligible','unknown')),
  previously_used_first_home_benefit boolean,
  previously_used_first_home_tax_support boolean,
  financing_kind  text CHECK (financing_kind IN ('supported','unsupported','unknown')),
  certificate_reference text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Property scenario ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_property_scenarios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     uuid NOT NULL UNIQUE REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,
  source_kind     text NOT NULL DEFAULT 'manual' CHECK (source_kind IN ('manual','project','unit','market_listing')),
  project_record_id uuid,
  unit_record_id  uuid,
  property_price  numeric(16,2) CHECK (property_price IS NULL OR property_price >= 0),
  property_type   text CHECK (property_type IN ('apartment','villa','townhouse','duplex','land','floor','studio','annex','other')),
  property_status text CHECK (property_status IN ('completed','off_plan','self_build','land_and_construction','refinance')),
  city            text,
  district        text,
  developer_name  text,
  project_name    text,
  property_age_years numeric(6,2),
  expected_handover_date date,
  construction_stage text,
  is_first_home   boolean,
  available_cash  numeric(16,2) CHECK (available_cash IS NULL OR available_cash >= 0),
  desired_down_payment numeric(16,2) CHECK (desired_down_payment IS NULL OR desired_down_payment >= 0),
  -- When the bank's valuation is BELOW the sale price, the gap is cash the
  -- customer must find. Modelled explicitly because it is the single most
  -- common upfront-cash surprise.
  expected_valuation numeric(16,2),
  additional_expenses numeric(16,2),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Financing preferences ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_preferences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     uuid NOT NULL UNIQUE REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,
  preferred_term_months integer CHECK (preferred_term_months IS NULL OR preferred_term_months > 0),
  min_term_months integer,
  max_term_months integer,
  rate_preference text CHECK (rate_preference IN ('fixed','variable','no_preference')),
  structure_preference text CHECK (structure_preference IN ('murabaha','ijara','unsure')),
  payment_shape   text CHECK (payment_shape IN ('equal','step_up','balloon')),
  max_acceptable_installment numeric(14,2) CHECK (max_acceptable_installment IS NULL OR max_acceptable_installment >= 0),
  priority        text CHECK (priority IN ('lowest_monthly','lowest_total_cost','lowest_upfront','shortest_term')),
  salary_transfer_preference text CHECK (salary_transfer_preference IN ('willing','unwilling','already_transferred','no_preference')),
  preferred_provider_ids uuid[],
  planned_start_date date,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_pref_term_order CHECK (min_term_months IS NULL OR max_term_months IS NULL OR max_term_months >= min_term_months)
);

-- ── Calculation runs: the reproducibility anchor ───────────────────────────
-- Every run pins the engine version AND the exact reference-version ids it read.
-- Re-running with the same input snapshot + the same pinned versions must
-- reproduce the same numbers; that is what makes a six-month-old customer
-- conversation defensible.
CREATE TABLE IF NOT EXISTS public.fin_calculation_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     uuid NOT NULL REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,
  run_number      integer NOT NULL,
  calculation_mode text NOT NULL CHECK (calculation_mode IN ('affordability','property_payment','comparison','full')),
  engine_version  text NOT NULL,
  as_of_date      date NOT NULL DEFAULT CURRENT_DATE,

  -- Immutable copies. Not FKs into the live child tables: the point is that the
  -- INPUTS are frozen even if the user edits the scenario afterwards.
  input_snapshot  jsonb NOT NULL,
  result_snapshot jsonb NOT NULL,

  -- Pinned reference versions.
  regulatory_rule_version_ids uuid[] NOT NULL DEFAULT '{}',
  support_program_version_ids uuid[] NOT NULL DEFAULT '{}',
  tax_rule_version_ids        uuid[] NOT NULL DEFAULT '{}',
  product_version_ids         uuid[] NOT NULL DEFAULT '{}',
  rate_version_ids            uuid[] NOT NULL DEFAULT '{}',
  benchmark_observation_ids   uuid[] NOT NULL DEFAULT '{}',

  status          text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','failed')),
  error           text,
  duration_ms     integer,
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scenario_id, run_number)
);
CREATE INDEX IF NOT EXISTS fin_runs_scenario_idx ON public.fin_calculation_runs(scenario_id, created_at DESC);

-- Flattened headline numbers for dashboards and lists. Denormalised on purpose:
-- reading them out of `result_snapshot` for every row of a list page would mean
-- parsing a large jsonb per row.
CREATE TABLE IF NOT EXISTS public.fin_calculation_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL UNIQUE REFERENCES public.fin_calculation_runs(id) ON DELETE CASCADE,
  scenario_id     uuid NOT NULL REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,

  declared_income        numeric(14,2),
  verified_income        numeric(14,2),
  qualifying_income      numeric(14,2),
  existing_obligations_monthly numeric(14,2),
  current_dbr_pct        numeric(7,4),
  max_installment        numeric(14,2),
  binding_constraint     text,
  max_financing_amount   numeric(16,2),
  max_property_value     numeric(16,2),
  required_down_payment  numeric(16,2),
  upfront_cash_total     numeric(16,2),
  projected_dbr_pct      numeric(7,4),
  ltv_pct                numeric(7,4),
  selected_monthly_payment numeric(14,2),
  selected_total_repayment numeric(16,2),
  selected_financing_cost  numeric(16,2),
  selected_apr_pct       numeric(7,4),
  apr_basis              text CHECK (apr_basis IN ('calculated','published','unavailable')),

  -- The status vocabulary the product spec mandates. 'approved' is deliberately
  -- absent from the CHECK — it cannot be typed into this column at all.
  result_status   text NOT NULL CHECK (result_status IN (
                    'indicative_match','potentially_suitable','requires_bank_review',
                    'insufficient_information','product_data_unavailable','product_data_stale',
                    'appears_outside_published_criteria','final_approval_required')),
  confidence      text NOT NULL CHECK (confidence IN ('high','medium','low','unavailable')),
  capacity_reducers jsonb NOT NULL DEFAULT '[]'::jsonb,
  missing_information jsonb NOT NULL DEFAULT '[]'::jsonb,
  assumptions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_results_scenario_idx ON public.fin_calculation_results(scenario_id, created_at DESC);

-- ── Per-product match results ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_product_match_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL REFERENCES public.fin_calculation_runs(id) ON DELETE CASCADE,
  scenario_id     uuid NOT NULL REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES public.fin_products(id) ON DELETE CASCADE,
  provider_id     uuid NOT NULL REFERENCES public.fin_providers(id) ON DELETE CASCADE,
  product_version_id uuid REFERENCES public.fin_product_versions(id) ON DELETE SET NULL,
  rate_version_id uuid REFERENCES public.fin_product_rate_versions(id) ON DELETE SET NULL,

  match_status    text NOT NULL CHECK (match_status IN (
                    'indicative_match','potentially_suitable','requires_bank_review',
                    'insufficient_information','product_data_unavailable','product_data_stale',
                    'appears_outside_published_criteria')),
  match_reasons   jsonb NOT NULL DEFAULT '[]'::jsonb,
  exclusion_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  unknown_criteria  jsonb NOT NULL DEFAULT '[]'::jsonb,

  estimated_monthly_payment numeric(14,2),
  estimated_total_cost      numeric(16,2),
  estimated_financing_amount numeric(16,2),
  required_down_payment     numeric(16,2),
  required_upfront_cash     numeric(16,2),
  applied_term_months       integer,
  applied_rate_pct          numeric(7,4),
  rate_basis      text CHECK (rate_basis IN ('contractual','range_midpoint','starting_from','example','unavailable')),
  published_apr_pct numeric(7,4),
  calculated_apr_pct numeric(7,4),
  max_ltv_pct     numeric(7,4),
  confidence      text NOT NULL CHECK (confidence IN ('high','medium','low','unavailable')),
  data_age_days   integer,
  is_stale        boolean NOT NULL DEFAULT false,
  sort_rank       integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- An installment we present must say what rate produced it. No rate basis =>
  -- no number. This is the constraint that makes "precise-looking guess"
  -- structurally impossible rather than merely discouraged.
  CONSTRAINT fin_match_payment_needs_basis CHECK (
    estimated_monthly_payment IS NULL OR (rate_basis IS NOT NULL AND rate_basis <> 'unavailable')
  )
);
CREATE INDEX IF NOT EXISTS fin_match_run_idx ON public.fin_product_match_results(run_id, sort_rank);
CREATE INDEX IF NOT EXISTS fin_match_scenario_idx ON public.fin_product_match_results(scenario_id, created_at DESC);

-- ── Cash-flow schedule (what APR was actually computed from) ───────────────
CREATE TABLE IF NOT EXISTS public.fin_cash_flows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_result_id uuid REFERENCES public.fin_product_match_results(id) ON DELETE CASCADE,
  run_id          uuid NOT NULL REFERENCES public.fin_calculation_runs(id) ON DELETE CASCADE,
  sequence        integer NOT NULL,
  flow_date       date NOT NULL,
  flow_type       text NOT NULL CHECK (flow_type IN ('disbursement','installment','fee','insurance','balloon','down_payment','tax')),
  amount          numeric(16,2) NOT NULL,
  -- Signed direction so an IRR solver reads the row without re-deriving intent.
  direction       text NOT NULL CHECK (direction IN ('to_borrower','from_borrower')),
  principal_component numeric(16,2),
  profit_component    numeric(16,2),
  outstanding_balance numeric(16,2),
  included_in_apr boolean NOT NULL DEFAULT true,
  label           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_result_id, sequence)
);
CREATE INDEX IF NOT EXISTS fin_cf_run_idx ON public.fin_cash_flows(run_id, sequence);

CREATE TABLE IF NOT EXISTS public.fin_scenario_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     uuid NOT NULL REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,
  body            text NOT NULL,
  is_internal     boolean NOT NULL DEFAULT true,
  author_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_notes_scenario_idx ON public.fin_scenario_notes(scenario_id, created_at DESC);

-- ── Audit: who touched customer financial data, and when ───────────────────
CREATE TABLE IF NOT EXISTS public.fin_audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     uuid REFERENCES public.fin_scenarios(id) ON DELETE CASCADE,
  entity_type     text NOT NULL,
  entity_id       uuid,
  event_type      text NOT NULL,
  actor_user_id   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  actor_email     text,
  -- Deliberately holds no salary/debt VALUES — only which fields moved. Logging
  -- the numbers would push customer financial data into a table with a broader
  -- read audience than the scenario itself.
  changed_fields  text[],
  summary_en      text NOT NULL,
  summary_ar      text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_audit_scenario_idx ON public.fin_audit_events(scenario_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fin_audit_actor_idx ON public.fin_audit_events(actor_user_id, created_at DESC);

-- Audit + results + cash flows are append-only: a result you can edit is not a
-- record of what the customer was shown.
CREATE OR REPLACE FUNCTION public.fin_tg_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (attempted %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_audit_events','fin_calculation_runs','fin_calculation_results',
                           'fin_product_match_results','fin_cash_flows'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fin_tg_append_only()', t, t);
  END LOOP;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_scenarios','fin_scenario_applicants','fin_income_sources','fin_obligations',
                           'fin_scenario_support','fin_property_scenarios','fin_preferences'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fin_tg_touch_updated_at()', t, t);
  END LOOP;
END $$;

-- Auto-number runs per scenario so callers never race on run_number.
CREATE OR REPLACE FUNCTION public.fin_tg_run_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.run_number IS NULL OR NEW.run_number = 0 THEN
    SELECT COALESCE(MAX(run_number), 0) + 1 INTO NEW.run_number
    FROM public.fin_calculation_runs WHERE scenario_id = NEW.scenario_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fin_runs_number ON public.fin_calculation_runs;
CREATE TRIGGER fin_runs_number BEFORE INSERT ON public.fin_calculation_runs
  FOR EACH ROW EXECUTE FUNCTION public.fin_tg_run_number();

-- ── Access control ─────────────────────────────────────────────────────────
-- Customer financial data is NOT world-readable inside the org. A scenario is
-- visible to its owner, the assigned financing specialist, its creator, and
-- admins. Everything downstream (income, obligations, results, cash flows)
-- inherits that decision through one EXISTS on the parent, so there is exactly
-- one place where visibility is defined.
CREATE OR REPLACE FUNCTION public.fin_can_access_scenario(p_scenario_id uuid, p_auth_uid uuid DEFAULT auth.uid())
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.fin_scenarios s
    WHERE s.id = p_scenario_id
      AND s.deleted_at IS NULL
      AND (
        public.wassell_is_admin(p_auth_uid)
        OR s.owner_user_id = public.wassell_app_user_id(p_auth_uid)
        OR s.assigned_specialist_user_id = public.wassell_app_user_id(p_auth_uid)
        OR s.created_by_user_id = public.wassell_app_user_id(p_auth_uid)
      )
  );
$$;
GRANT EXECUTE ON FUNCTION public.fin_can_access_scenario(uuid, uuid) TO authenticated, service_role;

ALTER TABLE public.fin_scenarios ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_scenarios_view ON public.fin_scenarios;
CREATE POLICY fin_scenarios_view ON public.fin_scenarios FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL AND (
      public.wassell_is_admin(auth.uid())
      OR owner_user_id = public.wassell_app_user_id(auth.uid())
      OR assigned_specialist_user_id = public.wassell_app_user_id(auth.uid())
      OR created_by_user_id = public.wassell_app_user_id(auth.uid())
    )
  );
DROP POLICY IF EXISTS fin_scenarios_insert ON public.fin_scenarios;
CREATE POLICY fin_scenarios_insert ON public.fin_scenarios FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_is_admin(auth.uid())
    OR created_by_user_id = public.wassell_app_user_id(auth.uid())
  );
DROP POLICY IF EXISTS fin_scenarios_update ON public.fin_scenarios;
CREATE POLICY fin_scenarios_update ON public.fin_scenarios FOR UPDATE TO authenticated
  USING (public.fin_can_access_scenario(id, auth.uid()))
  WITH CHECK (public.fin_can_access_scenario(id, auth.uid()));
DROP POLICY IF EXISTS fin_scenarios_delete ON public.fin_scenarios;
CREATE POLICY fin_scenarios_delete ON public.fin_scenarios FOR DELETE TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fin_scenario_applicants','fin_income_sources','fin_obligations','fin_scenario_support',
    'fin_property_scenarios','fin_preferences','fin_calculation_runs','fin_calculation_results',
    'fin_product_match_results','fin_scenario_notes','fin_audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_scoped ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_scoped ON public.%I FOR ALL TO authenticated
         USING (public.fin_can_access_scenario(scenario_id, auth.uid()))
         WITH CHECK (public.fin_can_access_scenario(scenario_id, auth.uid()))', t, t);
  END LOOP;
END $$;

-- Cash flows hang off a run, not a scenario column — reach them through it.
ALTER TABLE public.fin_cash_flows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_cash_flows_scoped ON public.fin_cash_flows;
CREATE POLICY fin_cash_flows_scoped ON public.fin_cash_flows FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.fin_calculation_runs r
                 WHERE r.id = run_id AND public.fin_can_access_scenario(r.scenario_id, auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.fin_calculation_runs r
                 WHERE r.id = run_id AND public.fin_can_access_scenario(r.scenario_id, auth.uid())));
