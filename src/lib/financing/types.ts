/**
 * Domain types for the Saudi real-estate financing engine.
 *
 * The engine is a PURE function of (inputs, pinned reference versions) → result.
 * It imports nothing from React, the store, or Supabase, so the same code runs
 * in the browser, in an Edge function, and in a unit test without a database.
 */

// ────────────────────────────────────────────────────────────────────────────
// Result vocabulary
//
// 'approved' does not exist here and must never be added. An indicative
// calculation is not a bank decision, and the type system is the cheapest place
// to make that impossible to express.
// ────────────────────────────────────────────────────────────────────────────
export type ResultStatus =
  | 'indicative_match'
  | 'potentially_suitable'
  | 'requires_bank_review'
  | 'insufficient_information'
  | 'product_data_unavailable'
  | 'product_data_stale'
  | 'appears_outside_published_criteria'
  | 'final_approval_required';

export type MatchStatus = Exclude<ResultStatus, 'final_approval_required'>;

export type Confidence = 'high' | 'medium' | 'low' | 'unavailable';

export type RateDisclosureType =
  | 'exact_rate'
  | 'starting_from'
  | 'published_range'
  | 'representative_example'
  | 'promotional'
  | 'quotation_required';

export type RateBasis = 'contractual' | 'range_midpoint' | 'starting_from' | 'example' | 'unavailable';

export type CalculationMethod =
  | 'fixed_amortizing'
  | 'flat_profit'
  | 'ijara_rental'
  | 'variable_benchmark_margin'
  | 'step_up'
  | 'balloon'
  | 'staged_construction'
  | 'off_plan_staged'
  | 'manual_quotation'
  | 'unknown';

export type EmploymentType = 'employee' | 'retiree' | 'military' | 'self_employed' | 'business_owner' | 'other';
export type EmployerSector = 'government' | 'semi_government' | 'military' | 'private' | 'other';
export type NationalityType = 'saudi' | 'resident';

export type PropertyType = 'apartment' | 'villa' | 'townhouse' | 'duplex' | 'land' | 'floor' | 'studio' | 'annex' | 'other';
export type PropertyStatus = 'completed' | 'off_plan' | 'self_build' | 'land_and_construction' | 'refinance';

export type IncomeType =
  | 'basic_salary'
  | 'housing_allowance'
  | 'other_allowance'
  | 'pension'
  | 'commission'
  | 'bonus'
  | 'rental'
  | 'investment'
  | 'business'
  | 'other_recurring'
  | 'government_support';

export type ObligationType =
  | 'personal_finance'
  | 'mortgage'
  | 'auto_finance'
  | 'auto_lease'
  | 'credit_card'
  | 'bnpl'
  | 'employer_loan'
  | 'development_fund'
  | 'student_finance'
  | 'guarantee'
  | 'alimony'
  | 'other';

export type DocumentationStatus =
  | 'undocumented'
  | 'self_declared'
  | 'payslip'
  | 'bank_statement'
  | 'employer_letter'
  | 'gosi'
  | 'contract'
  | 'other';

export type IncomeFrequency = 'monthly' | 'quarterly' | 'semi_annual' | 'annual' | 'irregular';

// ────────────────────────────────────────────────────────────────────────────
// Explanation primitives
//
// Every number the engine produces carries the trail that produced it. These
// are structured (not prose) so the UI can render them bilingually and the
// tests can assert on them.
// ────────────────────────────────────────────────────────────────────────────

/** A bilingual, machine-checkable explanation line. */
export interface ExplanationLine {
  code: string;
  label_ar: string;
  label_en: string;
  /** The value this line is about, when it is numeric. */
  value?: number | null;
  /** Where the number came from — a rule key, product id, or input field. */
  basis?: string;
  /** Rule/product version pinned for this line, when applicable. */
  version_id?: string | null;
}

/** Something we do not know, named rather than defaulted to zero. */
export interface MissingInformation {
  code: string;
  label_ar: string;
  label_en: string;
  /** What the absence costs: does it block a number, or only lower confidence? */
  impact: 'blocks_calculation' | 'lowers_confidence' | 'requires_bank_confirmation';
}

export interface Assumption {
  code: string;
  label_ar: string;
  label_en: string;
  value?: number | string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Regulatory rule payloads
//
// These mirror the jsonb stored in fin_regulatory_rule_versions.payload. The
// engine never hard-codes a percentage; it reads one of these.
// ────────────────────────────────────────────────────────────────────────────

/** One income band of the DBR rule set (SAMA Responsible Lending, Arts 15–17). */
export interface DbrBand {
  /** Inclusive lower bound of total monthly income, in SAR. */
  income_from: number;
  /** Exclusive upper bound; null = open-ended. */
  income_to: number | null;
  /** Salary-deduction ceiling for employees, % of GROSS SALARY (not total income). */
  salary_deduction_employee_pct: number;
  /** Salary-deduction ceiling for retirees, % of pension. */
  salary_deduction_retiree_pct: number;
  /** Ceiling on obligations EXCLUDING real-estate finance, % of total monthly income. */
  excluding_real_estate_pct: number | null;
  /** Ceiling on ALL obligations, % of total monthly income. */
  total_obligations_pct: number | null;
  /** Ceiling on ALL obligations for MoH/REDF-supported mortgage beneficiaries. */
  total_obligations_supported_pct: number | null;
  /**
   * True when the band leaves real-estate obligations to the creditor's own
   * credit policy (SAMA Art. 17). The engine then reports
   * 'requires_bank_review' instead of inventing a ceiling.
   */
  real_estate_per_creditor_policy?: boolean;
}

export interface DbrRulePayload {
  kind: 'dbr_bands';
  bands: DbrBand[];
}

export interface QualifyingIncomeRulePayload {
  kind: 'qualifying_income';
  /** % of gross salary counted. SAMA Art. 14(a): the full amount. */
  gross_salary_pct: number;
  /** % of other periodic income counted. SAMA Art. 14(b): half. */
  other_periodic_income_pct: number;
  /** Which income types are treated as "other periodic income". */
  other_periodic_income_types: IncomeType[];
  /** Minimum months of history the rule expects for other income to count. */
  other_income_min_history_months: number | null;
  /** Government subsidies are excluded... */
  government_subsidy_excluded: boolean;
  /** ...except MoH/REDF support in real-estate finance products. */
  housing_support_included_in_real_estate: boolean;
}

export interface CreditCardRulePayload {
  kind: 'credit_card_obligation';
  /**
   * SAMA Art. 13(a): the monthly obligation of a credit card equals the
   * MINIMUM REPAYMENT OF THE CREDIT CEILING — i.e. a % of the limit, not of
   * the balance and not the customer's actual payment.
   */
  basis: 'minimum_repayment_of_ceiling';
  /** The minimum-repayment percentage applied to the ceiling. */
  minimum_repayment_pct: number;
}

export interface LtvRulePayload {
  kind: 'ltv';
  /** Ceilings keyed by provider type then by first-home status. */
  bank_first_home_pct: number;
  bank_additional_home_pct: number;
  finance_company_first_home_pct: number;
  finance_company_additional_home_pct: number;
  /** Whether the first-home ceiling is restricted to citizens. */
  first_home_citizens_only: boolean;
}

export interface FeeCapRulePayload {
  kind: 'fee_cap';
  /** % of the amount of financing. */
  pct_of_finance_amount: number;
  /** Absolute SAR cap; the lower of the two applies. */
  absolute_cap: number;
}

export interface AprMethodRulePayload {
  kind: 'apr_method';
  /** 'cash_flow_irr' = solve the discount rate over actual dated cash flows. */
  method: 'cash_flow_irr';
  /** SAMA: "periods between dates shall be based on a year of 12 equal months". */
  day_count: 'twelve_equal_months';
  /** Minimum precision of the published figure, in basis points. */
  precision_basis_points: number;
  /** Whether unavoidable fees must be included in the APR cash flows. */
  include_unavoidable_fees: boolean;
}

export interface TermLimitRulePayload {
  kind: 'term_limits';
  /** General consumer-finance ceiling in months. */
  max_term_months: number;
  /** Product categories exempt from it (real estate, credit cards). */
  exempt_categories: string[];
}

export interface EarlySettlementRulePayload {
  kind: 'early_settlement';
  /** Months of term cost the creditor may claim as reinvestment cost. */
  max_reinvestment_months: number;
  basis: 'declining_balance';
}

export type RegulatoryRulePayload =
  | DbrRulePayload
  | QualifyingIncomeRulePayload
  | CreditCardRulePayload
  | LtvRulePayload
  | FeeCapRulePayload
  | AprMethodRulePayload
  | TermLimitRulePayload
  | EarlySettlementRulePayload;

/** An effective-dated rule version as the engine consumes it. */
export interface RuleVersion<P extends RegulatoryRulePayload = RegulatoryRulePayload> {
  id: string;
  rule_key: string;
  version_number: number;
  effective_from: string;
  effective_to: string | null;
  payload: P;
  citation_ref?: string | null;
  source_url: string;
}

/** The full rule set a run pins. Every entry is nullable: a missing rule is
 *  reported as missing information, never silently replaced by a constant. */
export interface RuleSet {
  dbr: RuleVersion<DbrRulePayload> | null;
  qualifying_income: RuleVersion<QualifyingIncomeRulePayload> | null;
  credit_card: RuleVersion<CreditCardRulePayload> | null;
  ltv: RuleVersion<LtvRulePayload> | null;
  fee_cap: RuleVersion<FeeCapRulePayload> | null;
  apr_method: RuleVersion<AprMethodRulePayload> | null;
  term_limits: RuleVersion<TermLimitRulePayload> | null;
  early_settlement: RuleVersion<EarlySettlementRulePayload> | null;
}

export interface TaxRuleVersion {
  id: string;
  tax_key: string;
  effective_from: string;
  effective_to: string | null;
  rate_pct: number;
  base: 'transaction_value' | 'fair_market_value' | 'higher_of_both';
  payer: 'seller' | 'buyer' | 'either' | null;
  first_home_relief_cap: number | null;
  source_url: string;
}

export interface SupportProgramVersion {
  id: string;
  program_key: string;
  program_type: string;
  effective_from: string;
  effective_to: string | null;
  monthly_support_amount: number | null;
  support_duration_months: number | null;
  support_cap_amount: number | null;
  subsidised_principal_cap: number | null;
  down_payment_grant_amount: number | null;
  max_property_value: number | null;
  figures_verified: boolean;
  source_url: string;
}

export interface BenchmarkObservation {
  id: string;
  benchmark_key: string;
  observation_date: string;
  rate_pct: number;
  source_url: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Product reference data as the engine consumes it
// ────────────────────────────────────────────────────────────────────────────

export interface ProviderRef {
  id: string;
  provider_key: string;
  name_ar: string;
  name_en: string;
  provider_type: 'bank' | 'foreign_bank' | 'real_estate_finance_company' | 'finance_company' | 'government_fund';
}

export interface ProductVersionRef {
  id: string;
  product_id: string;
  version_number: number;
  effective_from: string;
  applies_to_saudi: boolean | null;
  applies_to_resident: boolean | null;
  applies_to_first_home: boolean | null;
  applies_to_additional_home: boolean | null;
  supported_financing: boolean | null;
  unsupported_financing: boolean | null;
  property_types: PropertyType[] | null;
  property_status: PropertyStatus[] | null;
  employment_types: EmploymentType[] | null;
  employer_sectors: EmployerSector[] | null;
  requires_approved_employer: boolean | null;
  requires_salary_transfer: boolean | null;
  min_salary: number | null;
  min_salary_no_transfer: number | null;
  min_employment_months: number | null;
  min_age_years: number | null;
  max_age_at_application: number | null;
  max_age_at_maturity: number | null;
  retiree_eligible: boolean | null;
  min_amount: number | null;
  max_amount: number | null;
  min_term_months: number | null;
  max_term_months: number | null;
  min_down_payment_pct: number | null;
  max_ltv_pct: number | null;
  max_salary_multiple: number | null;
  grace_period_months: number | null;
  calculation_method: CalculationMethod;
  collected_at: string;
  verified_at: string | null;
  confidence: 'high' | 'medium' | 'low';
  source_url: string;
  fees: FeeRuleRef[];
  /**
   * Published criteria that do not fit the flat columns — e.g. Bank Albilad's
   * subsidised product, which is capped at a salary of SAR 14,000 or LESS.
   * A salary CEILING cannot be expressed as `min_salary` without inverting its
   * meaning, so it lives here and is evaluated generically.
   */
  eligibility_rules: EligibilityRuleRef[];
}

export interface EligibilityRuleRef {
  id: string;
  rule_key: string;
  label_ar: string | null;
  label_en: string;
  operator: 'eq' | 'neq' | 'gte' | 'lte' | 'gt' | 'lt' | 'in' | 'not_in' | 'between' | 'exists' | 'boolean';
  /** Dot path into the evaluation context (see `buildRuleContext`). */
  field_path: string;
  value_numeric: number | null;
  value_numeric_2: number | null;
  value_text: string | null;
  value_list: string[] | null;
  value_boolean: boolean | null;
  is_hard_requirement: boolean;
  failure_message_ar: string | null;
  failure_message_en: string | null;
}

export interface FeeRuleRef {
  id: string;
  fee_type: 'administrative' | 'valuation' | 'insurance_life' | 'insurance_property' | 'registration' | 'early_settlement' | 'other';
  label_ar: string | null;
  label_en: string;
  amount_fixed: number | null;
  amount_pct: number | null;
  pct_base: 'finance_amount' | 'property_price' | 'outstanding_balance' | 'annual_premium' | null;
  cap_amount: number | null;
  floor_amount: number | null;
  is_mandatory: boolean;
  include_in_apr: boolean;
  payable_upfront: boolean;
}

export interface RateVersionRef {
  id: string;
  product_id: string;
  version_number: number;
  effective_from: string;
  rate_type: 'fixed' | 'variable' | 'mixed' | 'unknown';
  rate_disclosure_type: RateDisclosureType;
  contractual_rate_pct: number | null;
  contractual_rate_min_pct: number | null;
  contractual_rate_max_pct: number | null;
  published_apr_pct: number | null;
  published_apr_min_pct: number | null;
  published_apr_max_pct: number | null;
  benchmark_key: string | null;
  margin_pct: number | null;
  benchmark_reset_months: number | null;
  example_amount: number | null;
  example_term_months: number | null;
  example_property_price: number | null;
  example_ltv_pct: number | null;
  example_monthly_payment: number | null;
  campaign_end_date: string | null;
  collected_at: string;
  verified_at: string | null;
  confidence: 'high' | 'medium' | 'low';
  source_url: string;
}

export interface ProductRef {
  id: string;
  product_key: string;
  name_ar: string;
  name_en: string;
  category: string;
  structure: string | null;
  provider: ProviderRef;
  official_url: string | null;
  version: ProductVersionRef | null;
  rate: RateVersionRef | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Engine inputs
// ────────────────────────────────────────────────────────────────────────────

export interface ApplicantInput {
  role: 'primary' | 'co_borrower';
  nationality_type: NationalityType | null;
  date_of_birth: string | null;
  employment_type: EmploymentType | null;
  employer_sector: EmployerSector | null;
  service_months: number | null;
  willing_to_transfer_salary: boolean | null;
  salary_transfer_provider_key: string | null;
  expected_retirement_age: number | null;
}

export interface IncomeInput {
  id: string;
  applicant_role: 'primary' | 'co_borrower';
  income_type: IncomeType;
  declared_monthly_amount: number | null;
  verified_monthly_amount: number | null;
  documentation_status: DocumentationStatus;
  frequency: IncomeFrequency;
  averaging_period_months: number | null;
  is_fixed: boolean;
}

export interface ObligationInput {
  id: string;
  obligation_type: ObligationType;
  monthly_payment: number | null;
  outstanding_balance: number | null;
  remaining_months: number | null;
  end_date: string | null;
  card_limit: number | null;
  minimum_payment: number | null;
  balloon_payment: number | null;
  will_be_settled_before_financing: boolean;
  /** Whether this obligation is itself real-estate finance (affects which
   *  ceiling it counts against). */
  is_real_estate: boolean;
}

export interface SupportInput {
  is_first_home: boolean | null;
  sakani_eligible: boolean | null;
  redf_eligible: boolean | null;
  support_status: 'self_declared' | 'confirmed' | 'not_eligible' | 'unknown';
  monthly_support_amount: number | null;
  support_duration_months: number | null;
  financing_kind: 'supported' | 'unsupported' | 'unknown' | null;
  previously_used_first_home_tax_support: boolean | null;
}

export interface PropertyInput {
  property_price: number | null;
  property_type: PropertyType | null;
  property_status: PropertyStatus | null;
  city: string | null;
  is_first_home: boolean | null;
  available_cash: number | null;
  desired_down_payment: number | null;
  expected_valuation: number | null;
  additional_expenses: number | null;
  project_record_id: string | null;
  unit_record_id: string | null;
}

export interface PreferencesInput {
  preferred_term_months: number | null;
  min_term_months: number | null;
  max_term_months: number | null;
  rate_preference: 'fixed' | 'variable' | 'no_preference' | null;
  max_acceptable_installment: number | null;
  priority: 'lowest_monthly' | 'lowest_total_cost' | 'lowest_upfront' | 'shortest_term' | null;
  preferred_provider_keys: string[] | null;
  planned_start_date: string | null;
}

export interface EngineInput {
  as_of_date: string;
  applicants: ApplicantInput[];
  incomes: IncomeInput[];
  obligations: ObligationInput[];
  support: SupportInput;
  property: PropertyInput;
  preferences: PreferencesInput;
}

export interface EngineReference {
  rules: RuleSet;
  tax: TaxRuleVersion | null;
  supportPrograms: SupportProgramVersion[];
  benchmarks: BenchmarkObservation[];
  products: ProductRef[];
  /** Freshness policy, in days, for pricing data before it reads as stale. */
  pricing_freshness_days: number;
  /** Freshness policy for product (non-pricing) data. */
  product_freshness_days: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Engine outputs
// ────────────────────────────────────────────────────────────────────────────

export interface QualifyingIncomeBreakdown {
  declared_total: number;
  verified_total: number;
  qualifying_total: number;
  /** Gross salary of the PRIMARY applicant only — the salary-deduction ceiling
   *  is a percentage of this, not of household total income. */
  primary_gross_salary: number;
  lines: Array<{
    income_id: string;
    income_type: IncomeType;
    declared: number;
    verified: number | null;
    eligible_pct: number;
    qualifying: number;
    exclusion_reason: string | null;
    basis: string;
  }>;
  explanation: ExplanationLine[];
}

export interface ObligationsBreakdown {
  total_monthly: number;
  real_estate_monthly: number;
  non_real_estate_monthly: number;
  salary_linked_monthly: number;
  /** Obligations excluded because they end before financing starts. */
  expiring_monthly: number;
  lines: Array<{
    obligation_id: string;
    obligation_type: ObligationType;
    counted_monthly: number;
    basis: string;
    excluded: boolean;
    exclusion_reason: string | null;
  }>;
  explanation: ExplanationLine[];
}

export interface CeilingEvaluation {
  code: string;
  label_ar: string;
  label_en: string;
  /** The ceiling expressed as an absolute monthly SAR amount. */
  ceiling_amount: number | null;
  /** Room left after existing obligations. */
  available_amount: number | null;
  pct: number | null;
  basis: string;
  rule_version_id: string | null;
  /** True when the rule defers to the creditor's own policy (SAMA Art. 17). */
  defers_to_creditor: boolean;
}

export interface CapacityResult {
  income: QualifyingIncomeBreakdown;
  obligations: ObligationsBreakdown;
  ceilings: CeilingEvaluation[];
  /** The most restrictive applicable ceiling. */
  max_installment: number | null;
  binding_constraint: string | null;
  current_dbr_pct: number | null;
  /** Scenarios: today, and after a soon-expiring obligation ends. */
  after_expiry?: {
    expiring_obligation_ids: string[];
    max_installment: number | null;
    earliest_expiry_date: string | null;
  } | null;
  missing: MissingInformation[];
  assumptions: Assumption[];
  capacity_reducers: ExplanationLine[];
}

export interface CashFlow {
  sequence: number;
  date: string;
  type: 'disbursement' | 'installment' | 'fee' | 'insurance' | 'balloon' | 'down_payment' | 'tax';
  amount: number;
  direction: 'to_borrower' | 'from_borrower';
  principal_component: number | null;
  profit_component: number | null;
  outstanding_balance: number | null;
  included_in_apr: boolean;
  label: string;
}

export interface UpfrontCash {
  down_payment: number;
  valuation_gap: number;
  administrative_fee: number | null;
  valuation_fee: number | null;
  insurance: number | null;
  transaction_tax: number | null;
  tax_relief: number | null;
  other_expenses: number;
  total: number;
  /** Portion the customer cannot cover from stated available cash. */
  shortfall: number | null;
  lines: ExplanationLine[];
}

export interface RateSensitivity {
  shock_pct: number;
  rate_pct: number;
  monthly_payment: number;
}

export interface ProductMatch {
  product: ProductRef;
  status: MatchStatus;
  confidence: Confidence;
  match_reasons: ExplanationLine[];
  exclusion_reasons: ExplanationLine[];
  unknown_criteria: MissingInformation[];
  financing_amount: number | null;
  down_payment: number | null;
  term_months: number | null;
  applied_rate_pct: number | null;
  rate_basis: RateBasis;
  monthly_payment: number | null;
  total_repayment: number | null;
  financing_cost: number | null;
  published_apr_pct: number | null;
  calculated_apr_pct: number | null;
  apr_basis: 'calculated' | 'published' | 'unavailable';
  max_ltv_pct: number | null;
  ltv_pct: number | null;
  upfront: UpfrontCash | null;
  projected_dbr_pct: number | null;
  cash_flows: CashFlow[];
  sensitivity: RateSensitivity[];
  data_age_days: number | null;
  is_stale: boolean;
  /** Set when the product's own affordability ceiling beat the regulatory one. */
  binding_constraint: string | null;
}

export interface TermOption {
  term_months: number;
  monthly_payment: number | null;
  total_repayment: number | null;
  financing_amount: number | null;
}

export interface DownPaymentOption {
  down_payment_pct: number;
  down_payment: number;
  financing_amount: number;
  monthly_payment: number | null;
  ltv_pct: number;
}

export interface EngineResult {
  engine_version: string;
  as_of_date: string;
  status: ResultStatus;
  confidence: Confidence;
  capacity: CapacityResult;
  /** Maximum financing the qualifying income supports, before property limits. */
  max_financing_from_income: number | null;
  /** Maximum property value after LTV + down-payment constraints. */
  max_property_value: number | null;
  /** Present only when a property was supplied. */
  selected: ProductMatch | null;
  matches: ProductMatch[];
  term_options: TermOption[];
  down_payment_options: DownPaymentOption[];
  missing: MissingInformation[];
  assumptions: Assumption[];
  /** Every reference version this run read, for reproducibility. */
  pinned: {
    regulatory_rule_version_ids: string[];
    tax_rule_version_ids: string[];
    support_program_version_ids: string[];
    product_version_ids: string[];
    rate_version_ids: string[];
    benchmark_observation_ids: string[];
  };
  disclaimer_ar: string;
  disclaimer_en: string;
}
