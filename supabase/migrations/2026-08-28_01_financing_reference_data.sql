-- ============================================================================
-- Saudi Real Estate Financing — reference data layer
-- (providers, products, effective-dated versions, regulatory rules, support
--  programs, tax rules, benchmarks, and the source/provenance spine)
--
-- DESIGN RULES THIS FILE ENFORCES IN THE DATABASE, NOT IN PROSE:
--
-- 1. NOTHING IS EVER OVERWRITTEN. Rates, eligibility, fees and regulatory
--    percentages live in *_versions tables with [effective_from, effective_to).
--    A change = a new row. A calculation run pins the exact version ids it used,
--    so a customer conversation from six months ago replays byte-identically.
--
-- 2. EVERY COLLECTED VALUE CARRIES PROVENANCE. `source_id` is NOT NULL on every
--    version table. If we cannot point at an official page that said it, it does
--    not go in. Absent data is NULL + a documented gap — never zero, never a
--    guess. (`fin_data_validation_issues` is where the gap gets named.)
--
-- 3. RATE DISCLOSURE TYPE IS A FIRST-CLASS COLUMN. Saudi banks overwhelmingly
--    publish a "starting from" APR attached to one representative example, not
--    a customer-specific contractual rate. Collapsing those into one "rate"
--    column is the single most dangerous thing this schema could do, so
--    `rate_disclosure_type` is NOT NULL and the CHECK below refuses a rate row
--    that claims to be exact without an actual contractual rate.
--
-- 4. READS ARE OPEN TO AUTHENTICATED STAFF; WRITES ARE ADMIN-ONLY. Bank product
--    data is public information — every salesperson needs it. Editing it is a
--    data-governance act, so it is gated on `wassell_is_admin` and always
--    leaves an audit row.
-- ============================================================================

-- ── Enum-ish domains, expressed as CHECKs so they stay greppable ────────────

-- ── Sources: the provenance spine ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key      text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('regulator','tax_authority','government_program','benchmark','provider')),
  -- Source-hierarchy rank (1 = regulator … 5 = provider site). A conflict
  -- between two sources resolves toward the LOWER number, never toward
  -- "whichever ingestion ran last".
  authority_rank  smallint NOT NULL CHECK (authority_rank BETWEEN 1 AND 9),
  publisher       text NOT NULL,
  title_ar        text,
  title_en        text NOT NULL,
  url             text NOT NULL,
  is_official     boolean NOT NULL DEFAULT true,
  -- Freshness policy per source. Pricing goes stale faster than a law does.
  freshness_days  integer NOT NULL DEFAULT 90 CHECK (freshness_days > 0),
  is_active       boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- A non-official source may never back a stored value. Enforced here so no
  -- future ingestion can quietly seed the DB from a comparison website.
  CONSTRAINT fin_sources_official_only CHECK (is_official = true)
);
COMMENT ON TABLE public.fin_sources IS
  'Official sources only (regulator / tax authority / government program / provider site). Blogs and aggregators are banned by CHECK.';

-- One row per fetch attempt. A failed or blocked fetch is DATA — it is what
-- makes "we could not verify this" visible instead of silently stale.
CREATE TABLE IF NOT EXISTS public.fin_source_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE CASCADE,
  refresh_run_id  uuid,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL CHECK (status IN ('ok','fetch_blocked','fetch_failed','parse_failed','skipped')),
  http_status     integer,
  blocked_reason  text,
  final_url       text,
  content_hash    text,
  content_chars   integer,
  duration_ms     integer,
  error           text,
  -- Trimmed page text kept for the admin "where did this come from" drawer and
  -- for re-parsing without re-fetching. Full snapshots live on disk/storage.
  excerpt         text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_source_records_source_idx ON public.fin_source_records(source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS fin_source_records_run_idx    ON public.fin_source_records(refresh_run_id);

-- Immutable content snapshots, deduped by hash: re-fetching an unchanged page
-- does not create a new snapshot, which is what makes "did this page change?"
-- answerable rather than guessed.
CREATE TABLE IF NOT EXISTS public.fin_source_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE CASCADE,
  content_hash    text NOT NULL,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  content_text    text NOT NULL,
  content_links   jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_tables  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, content_hash)
);

CREATE TABLE IF NOT EXISTS public.fin_data_refresh_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  trigger         text NOT NULL CHECK (trigger IN ('manual','scheduled','backfill')),
  triggered_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  sources_total   integer NOT NULL DEFAULT 0,
  sources_ok      integer NOT NULL DEFAULT 0,
  sources_blocked integer NOT NULL DEFAULT 0,
  sources_failed  integer NOT NULL DEFAULT 0,
  versions_created integer NOT NULL DEFAULT 0,
  issues_opened   integer NOT NULL DEFAULT 0,
  error           text,
  summary         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS fin_refresh_runs_started_idx ON public.fin_data_refresh_runs(started_at DESC);

-- Named gaps and contradictions. The whole point: an unknown is an OPEN ISSUE
-- with a name, not a zero silently flowing into an installment.
CREATE TABLE IF NOT EXISTS public.fin_data_validation_issues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refresh_run_id  uuid REFERENCES public.fin_data_refresh_runs(id) ON DELETE SET NULL,
  source_id       uuid REFERENCES public.fin_sources(id) ON DELETE SET NULL,
  entity_type     text NOT NULL CHECK (entity_type IN ('provider','product','product_version','rate_version','regulatory_rule','support_program','tax_rule','benchmark','source')),
  entity_id       uuid,
  severity        text NOT NULL CHECK (severity IN ('info','warning','error')),
  issue_type      text NOT NULL,
  message_en      text NOT NULL,
  message_ar      text,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','wont_fix')),
  resolved_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  resolution_note text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_issues_open_idx ON public.fin_data_validation_issues(status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS fin_issues_entity_idx ON public.fin_data_validation_issues(entity_type, entity_id);

-- Extracted changes awaiting a human decision. An automated parser may PROPOSE
-- a new rate; it may not publish one, because a mis-parsed percentage silently
-- becomes a wrong monthly payment on a customer's screen.
CREATE TABLE IF NOT EXISTS public.fin_manual_review_queue (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refresh_run_id  uuid REFERENCES public.fin_data_refresh_runs(id) ON DELETE SET NULL,
  source_id       uuid REFERENCES public.fin_sources(id) ON DELETE SET NULL,
  entity_type     text NOT NULL,
  entity_id       uuid,
  change_kind     text NOT NULL CHECK (change_kind IN ('new','changed','removed','expired','conflict')),
  proposed        jsonb NOT NULL,
  previous        jsonb,
  diff_summary    text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','superseded')),
  decided_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  decision_note   text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_review_pending_idx ON public.fin_manual_review_queue(status, created_at DESC);

-- ── Providers ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_providers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key    text NOT NULL UNIQUE,
  name_ar         text NOT NULL,
  name_en         text NOT NULL,
  short_name_en   text,
  provider_type   text NOT NULL CHECK (provider_type IN ('bank','foreign_bank','real_estate_finance_company','finance_company','government_fund')),
  -- LTV ceilings differ by ENTITY TYPE under SAMA's circulars (banks 70% vs
  -- finance companies 85% for a non-first home), so this is a rule input, not
  -- decoration.
  sama_license_number text,
  sama_license_date   date,
  website_url     text,
  logo_url        text,
  is_active       boolean NOT NULL DEFAULT true,
  -- Set when SAMA's public register could not be read; surfaced in admin so
  -- nobody mistakes "we listed it" for "SAMA confirmed it".
  license_verified boolean NOT NULL DEFAULT false,
  license_source_id uuid REFERENCES public.fin_sources(id) ON DELETE SET NULL,
  notes           text,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_providers_active_idx ON public.fin_providers(is_active) WHERE deleted_at IS NULL;

-- ── Products ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES public.fin_providers(id) ON DELETE CASCADE,
  product_key     text NOT NULL,
  name_ar         text NOT NULL,
  name_en         text NOT NULL,
  category        text NOT NULL CHECK (category IN (
                    'residential_purchase','off_plan','self_build','land_and_construction',
                    'land_purchase','refinance','equity_release','buy_to_let','other')),
  -- The Islamic contract shape. NULL when the provider does not publish it —
  -- which is common and must not be invented, because the contract shape drives
  -- which cash-flow method is even applicable.
  structure       text CHECK (structure IN ('murabaha','ijara','diminishing_musharaka','tawarruq','istisna','other')),
  official_url    text,
  application_url text,
  is_active       boolean NOT NULL DEFAULT true,
  retired_at      timestamptz,
  retired_reason  text,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, product_key)
);
CREATE INDEX IF NOT EXISTS fin_products_provider_idx ON public.fin_products(provider_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS fin_products_active_idx   ON public.fin_products(is_active, category) WHERE deleted_at IS NULL;

-- ── Product versions: eligibility + limits, effective-dated ────────────────
CREATE TABLE IF NOT EXISTS public.fin_product_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES public.fin_products(id) ON DELETE CASCADE,
  version_number  integer NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  is_active       boolean NOT NULL DEFAULT true,

  -- Applicability -----------------------------------------------------------
  -- Every one of these is NULLABLE ON PURPOSE. NULL means "the official source
  -- does not publish this", which the matcher reports as
  -- 'requires_bank_confirmation' rather than treating as "no restriction".
  applies_to_saudi        boolean,
  applies_to_resident     boolean,
  applies_to_first_home   boolean,
  applies_to_additional_home boolean,
  supported_financing     boolean,          -- REDF/Sakani-supported variant
  unsupported_financing   boolean,
  property_types          text[],           -- apartment/villa/townhouse/duplex/land/other
  property_status         text[],           -- completed/off_plan/self_build/land_and_construction/refinance
  employment_types        text[],           -- employee/military/retiree/self_employed/business_owner
  employer_sectors        text[],           -- government/semi_government/military/private
  requires_approved_employer boolean,
  requires_salary_transfer   boolean,

  min_salary              numeric(14,2) CHECK (min_salary IS NULL OR min_salary >= 0),
  min_salary_no_transfer  numeric(14,2) CHECK (min_salary_no_transfer IS NULL OR min_salary_no_transfer >= 0),
  min_employment_months   integer CHECK (min_employment_months IS NULL OR min_employment_months >= 0),
  min_age_years           integer CHECK (min_age_years IS NULL OR min_age_years BETWEEN 15 AND 100),
  max_age_at_application  integer CHECK (max_age_at_application IS NULL OR max_age_at_application BETWEEN 15 AND 120),
  max_age_at_maturity     integer CHECK (max_age_at_maturity IS NULL OR max_age_at_maturity BETWEEN 15 AND 120),
  retiree_eligible        boolean,

  min_amount              numeric(16,2) CHECK (min_amount IS NULL OR min_amount >= 0),
  max_amount              numeric(16,2) CHECK (max_amount IS NULL OR max_amount >= 0),
  min_term_months         integer CHECK (min_term_months IS NULL OR min_term_months > 0),
  max_term_months         integer CHECK (max_term_months IS NULL OR max_term_months > 0),
  min_down_payment_pct    numeric(6,3) CHECK (min_down_payment_pct IS NULL OR (min_down_payment_pct >= 0 AND min_down_payment_pct <= 100)),
  max_ltv_pct             numeric(6,3) CHECK (max_ltv_pct IS NULL OR (max_ltv_pct > 0 AND max_ltv_pct <= 100)),
  max_salary_multiple     numeric(8,2) CHECK (max_salary_multiple IS NULL OR max_salary_multiple > 0),
  grace_period_months     integer CHECK (grace_period_months IS NULL OR grace_period_months >= 0),

  -- How this product's cash flows are actually built. Without a documented
  -- method we say so rather than assuming standard amortisation.
  calculation_method      text NOT NULL DEFAULT 'unknown' CHECK (calculation_method IN (
                            'fixed_amortizing','flat_profit','ijara_rental','variable_benchmark_margin',
                            'step_up','balloon','staged_construction','off_plan_staged',
                            'manual_quotation','unknown')),
  supports_balloon        boolean,
  supports_step_up        boolean,
  early_settlement_terms  text,
  insurance_required      boolean,
  insurance_notes         text,
  required_documents      text[],
  application_channels    text[],
  conditions_notes        text,

  -- Provenance --------------------------------------------------------------
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE RESTRICT,
  source_url      text NOT NULL,
  source_title    text,
  source_date     date,
  published_at    timestamptz,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  expires_at      timestamptz,
  extraction_method text NOT NULL DEFAULT 'manual_review' CHECK (extraction_method IN ('automated_parse','manual_review','manual_entry','provider_feed')),
  confidence      text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  content_hash    text,
  reviewed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  -- Manual-override bookkeeping: the extracted original is preserved, never
  -- rewritten, so "what did the robot say before a human changed it" is answerable.
  override_reason text,
  overridden_from_version_id uuid REFERENCES public.fin_product_versions(id) ON DELETE SET NULL,
  original_extracted jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,

  UNIQUE (product_id, version_number),
  CONSTRAINT fin_pv_period_valid CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT fin_pv_amount_order CHECK (min_amount IS NULL OR max_amount IS NULL OR max_amount >= min_amount),
  CONSTRAINT fin_pv_term_order   CHECK (min_term_months IS NULL OR max_term_months IS NULL OR max_term_months >= min_term_months),
  CONSTRAINT fin_pv_age_order    CHECK (min_age_years IS NULL OR max_age_at_application IS NULL OR max_age_at_application >= min_age_years),
  -- LTV and down payment are two views of one constraint; if both are published
  -- they must agree, otherwise we captured one of them wrong.
  CONSTRAINT fin_pv_ltv_dp_agree CHECK (
    max_ltv_pct IS NULL OR min_down_payment_pct IS NULL
    OR abs((100 - max_ltv_pct) - min_down_payment_pct) <= 0.001
  )
);
CREATE INDEX IF NOT EXISTS fin_pv_product_idx  ON public.fin_product_versions(product_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS fin_pv_active_idx   ON public.fin_product_versions(is_active, effective_from DESC) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS fin_pv_expiry_idx   ON public.fin_product_versions(expires_at) WHERE expires_at IS NOT NULL;

-- ── Rate versions: priced separately because pricing moves far faster ──────
CREATE TABLE IF NOT EXISTS public.fin_product_rate_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      uuid NOT NULL REFERENCES public.fin_products(id) ON DELETE CASCADE,
  product_version_id uuid REFERENCES public.fin_product_versions(id) ON DELETE SET NULL,
  version_number  integer NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  is_active       boolean NOT NULL DEFAULT true,

  rate_type       text NOT NULL CHECK (rate_type IN ('fixed','variable','mixed','unknown')),
  -- THE most important column in this schema. It is what stops a published
  -- "starting from 3.49%" marketing figure from being presented as a
  -- customer's contractual rate.
  rate_disclosure_type text NOT NULL CHECK (rate_disclosure_type IN (
                    'exact_rate','starting_from','published_range','representative_example',
                    'promotional','quotation_required')),

  -- Contractual profit rate — what an installment is actually computed from.
  contractual_rate_pct      numeric(7,4) CHECK (contractual_rate_pct IS NULL OR (contractual_rate_pct >= 0 AND contractual_rate_pct <= 100)),
  contractual_rate_min_pct  numeric(7,4),
  contractual_rate_max_pct  numeric(7,4),
  -- APR as PUBLISHED by the provider (not something we derived).
  published_apr_pct         numeric(7,4) CHECK (published_apr_pct IS NULL OR (published_apr_pct >= 0 AND published_apr_pct <= 100)),
  published_apr_min_pct     numeric(7,4),
  published_apr_max_pct     numeric(7,4),

  -- Variable pricing components
  benchmark_id    uuid,
  benchmark_name  text,
  margin_pct      numeric(7,4),
  benchmark_reset_months integer CHECK (benchmark_reset_months IS NULL OR benchmark_reset_months > 0),

  -- The representative example the published figure hangs off. Storing it is
  -- what lets the UI say "that 3.49% assumes SAR 500k over 20 years at 90% LTV"
  -- instead of implying it applies to the customer in front of the rep.
  example_amount        numeric(16,2),
  example_term_months   integer,
  example_property_price numeric(16,2),
  example_ltv_pct       numeric(6,3),
  example_salary        numeric(14,2),
  example_segment       text,
  example_monthly_payment numeric(16,2),
  example_total_repayment numeric(16,2),
  example_down_payment  numeric(16,2),
  included_fees         text[],
  excluded_fees         text[],
  rate_assumptions      text,
  applicability_notes   text,

  campaign_start_date   date,
  campaign_end_date     date,

  -- Provenance (same contract as product versions)
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE RESTRICT,
  source_url      text NOT NULL,
  source_title    text,
  source_date     date,
  published_at    timestamptz,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  expires_at      timestamptz,
  extraction_method text NOT NULL DEFAULT 'manual_review' CHECK (extraction_method IN ('automated_parse','manual_review','manual_entry','provider_feed')),
  confidence      text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  content_hash    text,
  reviewed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  override_reason text,
  original_extracted jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,

  UNIQUE (product_id, version_number),
  CONSTRAINT fin_rv_period_valid CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT fin_rv_range_order  CHECK (
    (contractual_rate_min_pct IS NULL OR contractual_rate_max_pct IS NULL OR contractual_rate_max_pct >= contractual_rate_min_pct)
    AND (published_apr_min_pct IS NULL OR published_apr_max_pct IS NULL OR published_apr_max_pct >= published_apr_min_pct)
  ),
  -- An 'exact_rate' claim without an exact rate is the bug this catches.
  CONSTRAINT fin_rv_exact_needs_rate CHECK (
    rate_disclosure_type <> 'exact_rate' OR contractual_rate_pct IS NOT NULL
  ),
  -- A variable product must name what it floats on, or it cannot be repriced.
  CONSTRAINT fin_rv_variable_needs_benchmark CHECK (
    rate_type <> 'variable' OR benchmark_name IS NOT NULL OR benchmark_id IS NOT NULL
  ),
  -- A published range must actually carry a range.
  CONSTRAINT fin_rv_range_needs_bounds CHECK (
    rate_disclosure_type <> 'published_range'
    OR (contractual_rate_min_pct IS NOT NULL AND contractual_rate_max_pct IS NOT NULL)
    OR (published_apr_min_pct IS NOT NULL AND published_apr_max_pct IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS fin_rv_product_idx ON public.fin_product_rate_versions(product_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS fin_rv_active_idx  ON public.fin_product_rate_versions(is_active, effective_from DESC) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS fin_rv_expiry_idx  ON public.fin_product_rate_versions(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_rv_campaign_idx ON public.fin_product_rate_versions(campaign_end_date) WHERE campaign_end_date IS NOT NULL;

-- ── Fee rules (separate rows so a fee can change without a product version) ─
CREATE TABLE IF NOT EXISTS public.fin_product_fee_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_version_id uuid NOT NULL REFERENCES public.fin_product_versions(id) ON DELETE CASCADE,
  fee_type        text NOT NULL CHECK (fee_type IN ('administrative','valuation','insurance_life','insurance_property','registration','early_settlement','other')),
  label_ar        text,
  label_en        text NOT NULL,
  amount_fixed    numeric(14,2) CHECK (amount_fixed IS NULL OR amount_fixed >= 0),
  amount_pct      numeric(7,4) CHECK (amount_pct IS NULL OR amount_pct >= 0),
  pct_base        text CHECK (pct_base IN ('finance_amount','property_price','outstanding_balance','annual_premium')),
  cap_amount      numeric(14,2),
  floor_amount    numeric(14,2),
  is_mandatory    boolean NOT NULL DEFAULT true,
  -- Drives APR: SAMA's APR includes all unavoidable costs. A fee flagged
  -- include_in_apr=false must justify itself in `notes`.
  include_in_apr  boolean NOT NULL DEFAULT true,
  payable_upfront boolean NOT NULL DEFAULT true,
  notes           text,
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE RESTRICT,
  source_url      text NOT NULL,
  confidence      text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_fee_has_amount CHECK (amount_fixed IS NOT NULL OR amount_pct IS NOT NULL),
  CONSTRAINT fin_fee_pct_needs_base CHECK (amount_pct IS NULL OR pct_base IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS fin_fee_version_idx ON public.fin_product_fee_rules(product_version_id);

-- ── Structured eligibility rules beyond the flat columns ───────────────────
CREATE TABLE IF NOT EXISTS public.fin_product_eligibility_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_version_id uuid NOT NULL REFERENCES public.fin_product_versions(id) ON DELETE CASCADE,
  rule_key        text NOT NULL,
  label_ar        text,
  label_en        text NOT NULL,
  operator        text NOT NULL CHECK (operator IN ('eq','neq','gte','lte','gt','lt','in','not_in','between','exists','boolean')),
  field_path      text NOT NULL,
  value_numeric   numeric(16,4),
  value_numeric_2 numeric(16,4),
  value_text      text,
  value_list      text[],
  value_boolean   boolean,
  is_hard_requirement boolean NOT NULL DEFAULT true,
  failure_message_ar text,
  failure_message_en text,
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE RESTRICT,
  source_url      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_elig_version_idx ON public.fin_product_eligibility_rules(product_version_id);

CREATE TABLE IF NOT EXISTS public.fin_product_document_requirements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_version_id uuid NOT NULL REFERENCES public.fin_product_versions(id) ON DELETE CASCADE,
  document_key    text NOT NULL,
  label_ar        text,
  label_en        text NOT NULL,
  applies_when    jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_mandatory    boolean NOT NULL DEFAULT true,
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE RESTRICT,
  source_url      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_version_id, document_key)
);

CREATE TABLE IF NOT EXISTS public.fin_product_property_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_version_id uuid NOT NULL REFERENCES public.fin_product_versions(id) ON DELETE CASCADE,
  rule_key        text NOT NULL,
  label_en        text NOT NULL,
  label_ar        text,
  property_types  text[],
  property_status text[],
  min_property_value numeric(16,2),
  max_property_value numeric(16,2),
  max_property_age_years integer,
  requires_project_approval boolean,
  allowed_cities  text[],
  notes           text,
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE RESTRICT,
  source_url      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Which provider has approved which of OUR projects. Deliberately EMPTY at
-- install: bank project-approval lists are not public, so seeding this with
-- guesses would be the most damaging possible fabrication (a rep telling a
-- customer "the bank approves this project"). Rows arrive only from a named
-- human with evidence.
CREATE TABLE IF NOT EXISTS public.fin_project_provider_approvals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES public.fin_providers(id) ON DELETE CASCADE,
  project_record_id uuid NOT NULL,
  approval_status text NOT NULL CHECK (approval_status IN ('approved','not_approved','pending','unknown')),
  approved_at     date,
  expires_at      date,
  evidence_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  evidence_note   text,
  recorded_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, project_record_id)
);
COMMENT ON TABLE public.fin_project_provider_approvals IS
  'Bank project-approval records. Seeded EMPTY on purpose — approval lists are not public. Absence renders as "project approval not verified", never as approved.';

-- ── Regulatory rules ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_regulatory_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key        text NOT NULL UNIQUE,
  authority       text NOT NULL CHECK (authority IN ('SAMA','ZATCA','MOMRAH','REDF','other')),
  category        text NOT NULL CHECK (category IN (
                    'responsible_lending','qualifying_income','debt_burden','salary_deduction',
                    'ltv','down_payment','apr_methodology','fees','early_settlement',
                    'variable_rate_disclosure','insurance','tax','support_program','term_limits')),
  label_ar        text NOT NULL,
  label_en        text NOT NULL,
  description_ar  text,
  description_en  text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fin_regulatory_rule_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid NOT NULL REFERENCES public.fin_regulatory_rules(id) ON DELETE CASCADE,
  version_number  integer NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  is_active       boolean NOT NULL DEFAULT true,
  -- The machine-readable rule body. Shape is per-category and validated by the
  -- engine's zod-equivalent guards; kept as jsonb because a DBR band table and
  -- an LTV matrix genuinely have different shapes and flattening them into 40
  -- nullable columns would obscure both.
  payload         jsonb NOT NULL,
  -- The exact wording we read, so a reviewer can check the parse against the
  -- regulator's own sentence without leaving the app.
  citation_text   text,
  citation_ref    text,
  supersedes_version_id uuid REFERENCES public.fin_regulatory_rule_versions(id) ON DELETE SET NULL,

  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE RESTRICT,
  source_url      text NOT NULL,
  source_title    text,
  source_date     date,
  published_at    timestamptz,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  expires_at      timestamptz,
  extraction_method text NOT NULL DEFAULT 'manual_review' CHECK (extraction_method IN ('automated_parse','manual_review','manual_entry','provider_feed')),
  confidence      text NOT NULL DEFAULT 'high' CHECK (confidence IN ('high','medium','low')),
  content_hash    text,
  reviewed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  override_reason text,
  original_extracted jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  UNIQUE (rule_id, version_number),
  CONSTRAINT fin_rrv_period_valid CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS fin_rrv_rule_idx   ON public.fin_regulatory_rule_versions(rule_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS fin_rrv_active_idx ON public.fin_regulatory_rule_versions(is_active, effective_from DESC);

-- ── Government support programs ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_support_programs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_key     text NOT NULL UNIQUE,
  authority       text NOT NULL CHECK (authority IN ('REDF','MOMRAH','Sakani','other')),
  name_ar         text NOT NULL,
  name_en         text NOT NULL,
  program_type    text NOT NULL CHECK (program_type IN ('subsidised_mortgage','down_payment_grant','profit_subsidy','self_build_support','rental_support','other')),
  official_url    text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fin_support_program_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id      uuid NOT NULL REFERENCES public.fin_support_programs(id) ON DELETE CASCADE,
  version_number  integer NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  is_active       boolean NOT NULL DEFAULT true,
  monthly_support_amount numeric(14,2),
  support_duration_months integer,
  support_cap_amount     numeric(16,2),
  subsidised_principal_cap numeric(16,2),
  down_payment_grant_amount numeric(16,2),
  max_property_value     numeric(16,2),
  eligibility_notes_ar   text,
  eligibility_notes_en   text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set false when the numbers could not be read from an official page. The
  -- engine then treats the support as DECLARED-ONLY and says so on the result.
  figures_verified boolean NOT NULL DEFAULT false,
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE RESTRICT,
  source_url      text NOT NULL,
  source_title    text,
  source_date     date,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  expires_at      timestamptz,
  extraction_method text NOT NULL DEFAULT 'manual_review' CHECK (extraction_method IN ('automated_parse','manual_review','manual_entry','provider_feed')),
  confidence      text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  reviewed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, version_number),
  CONSTRAINT fin_spv_period_valid CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- ── Tax rules (RETT and its first-home treatment) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.fin_tax_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_key         text NOT NULL UNIQUE,
  authority       text NOT NULL DEFAULT 'ZATCA',
  name_ar         text NOT NULL,
  name_en         text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fin_tax_rule_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_rule_id     uuid NOT NULL REFERENCES public.fin_tax_rules(id) ON DELETE CASCADE,
  version_number  integer NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  is_active       boolean NOT NULL DEFAULT true,
  rate_pct        numeric(7,4) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 100),
  base            text NOT NULL DEFAULT 'transaction_value' CHECK (base IN ('transaction_value','fair_market_value','higher_of_both')),
  payer           text CHECK (payer IN ('seller','buyer','either')),
  first_home_relief_cap numeric(16,2),
  first_home_relief_notes_ar text,
  first_home_relief_notes_en text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  citation_text   text,
  citation_ref    text,
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE RESTRICT,
  source_url      text NOT NULL,
  source_date     date,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  confidence      text NOT NULL DEFAULT 'high' CHECK (confidence IN ('high','medium','low')),
  reviewed_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tax_rule_id, version_number),
  CONSTRAINT fin_tv_period_valid CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- ── Benchmarks + observations (variable-rate repricing + stress tests) ─────
CREATE TABLE IF NOT EXISTS public.fin_benchmarks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_key   text NOT NULL UNIQUE,
  name_ar         text NOT NULL,
  name_en         text NOT NULL,
  tenor           text CHECK (tenor IN ('overnight','1w','1m','3m','6m','12m','2y','other')),
  administrator   text,
  official_url    text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fin_benchmark_observations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_id    uuid NOT NULL REFERENCES public.fin_benchmarks(id) ON DELETE CASCADE,
  observation_date date NOT NULL,
  rate_pct        numeric(7,4) NOT NULL CHECK (rate_pct >= -10 AND rate_pct <= 100),
  source_id       uuid NOT NULL REFERENCES public.fin_sources(id) ON DELETE RESTRICT,
  source_url      text NOT NULL,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  confidence      text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('high','medium','low')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (benchmark_id, observation_date)
);
CREATE INDEX IF NOT EXISTS fin_bobs_latest_idx ON public.fin_benchmark_observations(benchmark_id, observation_date DESC);

ALTER TABLE public.fin_product_rate_versions
  DROP CONSTRAINT IF EXISTS fin_rv_benchmark_fk;
ALTER TABLE public.fin_product_rate_versions
  ADD CONSTRAINT fin_rv_benchmark_fk FOREIGN KEY (benchmark_id)
  REFERENCES public.fin_benchmarks(id) ON DELETE SET NULL;

-- ── History integrity: versions are append-only ────────────────────────────
-- Reproducing a six-month-old calculation is only possible if the version rows
-- it pinned still say what they said. These triggers make "just fix the number
-- in place" impossible; corrections create a new version instead.
CREATE OR REPLACE FUNCTION public.fin_tg_version_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen_cols text[] := ARRAY['effective_from','payload','source_id','source_url','content_hash'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'financing version rows are append-only — retire the version (effective_to / is_active) instead of deleting %', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Closing a version (effective_to / is_active) and review bookkeeping are the
  -- only mutations allowed; the substance is frozen.
  IF NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION 'effective_from is immutable on financing version % — create a new version', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    RAISE EXCEPTION 'source_id is immutable on financing version % — create a new version', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fin_product_versions','fin_product_rate_versions','fin_regulatory_rule_versions',
    'fin_support_program_versions','fin_tax_rule_versions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_append_only BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fin_tg_version_append_only()',
      t, t);
  END LOOP;
END $$;

-- Benchmark observations are facts on a date — never rewritten.
CREATE OR REPLACE FUNCTION public.fin_tg_observation_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'benchmark observations are immutable (attempted % on %)', TG_OP, OLD.id
    USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS fin_bobs_immutable ON public.fin_benchmark_observations;
CREATE TRIGGER fin_bobs_immutable BEFORE UPDATE OR DELETE ON public.fin_benchmark_observations
  FOR EACH ROW EXECUTE FUNCTION public.fin_tg_observation_immutable();

-- Snapshots likewise.
DROP TRIGGER IF EXISTS fin_snapshots_immutable ON public.fin_source_snapshots;
CREATE TRIGGER fin_snapshots_immutable BEFORE UPDATE OR DELETE ON public.fin_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.fin_tg_observation_immutable();

-- ── updated_at bookkeeping ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fin_tg_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fin_sources','fin_providers','fin_products','fin_regulatory_rules',
                           'fin_support_programs','fin_data_validation_issues',
                           'fin_project_provider_approvals'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_touch ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fin_tg_touch_updated_at()', t, t);
  END LOOP;
END $$;

-- ── Version-selection helpers (the ONLY sanctioned way to pick a version) ──
-- Effective-dated selection lives in the database so the SPA, the API and any
-- future worker cannot each invent their own "which rule was live then" logic.
CREATE OR REPLACE FUNCTION public.fin_rule_version_at(p_rule_key text, p_as_of date DEFAULT CURRENT_DATE)
RETURNS public.fin_regulatory_rule_versions
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.*
  FROM public.fin_regulatory_rule_versions v
  JOIN public.fin_regulatory_rules r ON r.id = v.rule_id
  WHERE r.rule_key = p_rule_key
    AND r.is_active
    AND v.is_active
    AND v.effective_from <= p_as_of
    AND (v.effective_to IS NULL OR v.effective_to > p_as_of)
  ORDER BY v.effective_from DESC, v.version_number DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.fin_product_version_at(p_product_id uuid, p_as_of date DEFAULT CURRENT_DATE)
RETURNS public.fin_product_versions
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.* FROM public.fin_product_versions v
  WHERE v.product_id = p_product_id AND v.is_active
    AND v.effective_from <= p_as_of
    AND (v.effective_to IS NULL OR v.effective_to > p_as_of)
  ORDER BY v.effective_from DESC, v.version_number DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.fin_rate_version_at(p_product_id uuid, p_as_of date DEFAULT CURRENT_DATE)
RETURNS public.fin_product_rate_versions
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.* FROM public.fin_product_rate_versions v
  WHERE v.product_id = p_product_id AND v.is_active
    AND v.effective_from <= p_as_of
    AND (v.effective_to IS NULL OR v.effective_to > p_as_of)
    -- An expired campaign is not current pricing.
    AND (v.campaign_end_date IS NULL OR v.campaign_end_date >= p_as_of)
  ORDER BY v.effective_from DESC, v.version_number DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.fin_rule_version_at(text, date)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_product_version_at(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_rate_version_at(uuid, date)    TO authenticated, service_role;

-- ── RLS: reference data is readable by staff, writable by admins only ──────
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
    'fin_benchmarks','fin_benchmark_observations'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_read ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_read ON public.%I FOR SELECT TO authenticated USING (true)', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_write ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_write ON public.%I FOR ALL TO authenticated
         USING (public.wassell_is_admin(auth.uid()))
         WITH CHECK (public.wassell_is_admin(auth.uid()))', t, t);
  END LOOP;
END $$;

COMMENT ON TABLE public.fin_product_rate_versions IS
  'Pricing versions. rate_disclosure_type distinguishes an exact contractual rate from a "starting from" marketing figure or a representative example — the matcher refuses to quote an installment as exact unless a contractual rate exists.';
