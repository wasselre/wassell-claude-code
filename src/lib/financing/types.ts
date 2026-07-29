/**
 * Financing V2 — domain types.
 *
 * Deliberately small. V1 modelled a regulatory archive; this models an
 * indicative prequalification tool. Inputs and outputs are plain shapes that
 * round-trip through the two JSON snapshot columns on `financing_scenarios`.
 */

// ── Result vocabulary ──────────────────────────────────────────────────────
// 'approved' is absent and must stay absent. It cannot be typed, stored (the DB
// CHECK omits it) or rendered.
export type MatchStatus =
  | 'meets_published_criteria'
  | 'does_not_meet_published_criteria'
  | 'requires_bank_review'
  | 'pricing_unavailable'
  | 'rate_stale';

export type ResultStatus = MatchStatus | 'insufficient_information';

export type Confidence = 'high' | 'medium' | 'low' | 'unavailable';

/** How the rate behind a payment was obtained. Anything other than
 *  'contractual' or 'quotation' means we must NOT print an exact payment. */
export type RateBasis = 'contractual' | 'quotation' | 'starting_from' | 'example' | 'unavailable';

export type Nationality = 'saudi' | 'resident';
export type EmploymentType = 'employee' | 'military' | 'retiree' | 'self_employed' | 'business_owner';
export type EmployerSector = 'government' | 'semi_government' | 'military' | 'private';

// ── Reference data ─────────────────────────────────────────────────────────

export interface FinancingRate {
  id: string;
  disclosure_type: 'exact_rate' | 'starting_from' | 'representative_example' | 'quotation_required';
  rate_type: 'fixed' | 'variable';
  contractual_rate_pct: number | null;
  published_apr_pct: number | null;
  starting_apr_pct: number | null;
  example: { property_price?: number; ltv_pct?: number; term_months?: number; monthly_payment?: number; note?: string } | null;
  effective_from: string;
  expires_at: string | null;
  source_url: string;
  last_verified_at: string;
  confidence: 'high' | 'medium' | 'low';
  marked_stale: boolean;
  notes: string | null;
}

export interface FinancingProduct {
  id: string;
  provider_key: string;
  provider_name_ar: string;
  provider_name_en: string;
  provider_type: 'bank' | 'real_estate_finance_company';
  product_key: string;
  name_ar: string;
  name_en: string;
  supported_financing: 'supported' | 'unsupported' | 'both' | null;
  property_types: string[] | null;
  nationality: Nationality[] | null;
  employment_sectors: EmployerSector[] | null;
  employment_types: EmploymentType[] | null;
  min_salary: number | null;
  min_salary_no_transfer: number | null;
  min_age: number | null;
  max_age_at_maturity: number | null;
  requires_salary_transfer: boolean | null;
  first_home_applicable: boolean | null;
  additional_home_applicable: boolean | null;
  min_down_payment_pct: number | null;
  max_ltv_pct: number | null;
  max_term_months: number | null;
  max_amount: number | null;
  criteria: Record<string, unknown>;
  official_url: string | null;
  last_verified_at: string | null;
  notes: string | null;
  confidence: 'high' | 'medium' | 'low';
  rate: FinancingRate | null;
}

/** The rule payloads the engine reads. One row per key in `financing_rules`. */
export interface DbrBand {
  income_from: number;
  income_to: number | null;
  salary_deduction_employee_pct: number;
  salary_deduction_retiree_pct: number;
  excluding_real_estate_pct: number | null;
  total_obligations_pct: number | null;
  total_obligations_supported_pct: number | null;
  real_estate_per_creditor_policy?: boolean;
}

export interface RuleSet {
  dbr: { bands: DbrBand[]; source_url: string; effective_from: string } | null;
  income: {
    gross_salary_pct: number;
    other_periodic_income_pct: number;
    source_url: string;
    effective_from: string;
  } | null;
  credit_card: { minimum_repayment_pct: number; source_url: string; effective_from: string } | null;
  ltv: {
    bank_first_home_pct: number;
    bank_additional_home_pct: number;
    finance_company_first_home_pct: number;
    finance_company_additional_home_pct: number;
    first_home_citizens_only: boolean;
    source_url: string;
    effective_from: string;
  } | null;
  rett: { rate_pct: number; first_home_relief_cap: number | null; source_url: string; effective_from: string } | null;
  support: { housing_support_counts_as_income: boolean; source_url: string; effective_from: string } | null;
}

// ── Inputs ─────────────────────────────────────────────────────────────────

export interface IncomeInput {
  /** 'salary' counts in full; everything else is "other periodic income". */
  kind: 'salary' | 'other';
  label?: string;
  monthly_amount: number;
  /** Only verified other-income counts. Salary counts either way. */
  verified: boolean;
}

export interface ObligationInput {
  kind: 'credit_card' | 'other';
  label?: string;
  /** Credit cards: the LIMIT (SAMA charges a % of the ceiling, not the balance). */
  card_limit?: number | null;
  monthly_payment?: number | null;
  is_real_estate?: boolean;
}

export interface FinancingInput {
  as_of_date: string;
  nationality: Nationality | null;
  date_of_birth: string | null;
  age: number | null;
  employment_type: EmploymentType | null;
  employment_sector: EmployerSector | null;
  employer_name: string | null;
  willing_to_transfer_salary: boolean | null;

  gross_monthly_salary: number | null;
  other_income: IncomeInput[];
  obligations: ObligationInput[];

  is_first_home: boolean | null;
  sakani_redf_status: 'confirmed' | 'self_declared' | 'not_eligible' | 'unknown';
  confirmed_support_amount: number | null;

  property_price: number | null;
  property_type: string | null;
  project_record_id: string | null;
  unit_record_id: string | null;

  available_down_payment: number | null;
  term_months: number | null;
  preferred_provider_keys: string[] | null;
  max_comfortable_installment: number | null;

  /** A rate the rep was quoted by a bank. Turns an estimate into a real
   *  calculation for that product — the only other way to get an exact payment. */
  quoted_rate_pct: number | null;
  quoted_rate_provider_key: string | null;
}

// ── Outputs ────────────────────────────────────────────────────────────────

export interface Note {
  code: string;
  ar: string;
  en: string;
}

export interface Ceiling {
  code: string;
  label_ar: string;
  label_en: string;
  pct: number | null;
  ceiling_amount: number | null;
  available_amount: number | null;
  /** SAMA Art. 17: income >= 25,000 leaves the real-estate ceiling to the bank. */
  defers_to_bank: boolean;
}

export interface Capacity {
  declared_income: number;
  qualifying_income: number;
  existing_obligations: number;
  current_dbr_pct: number | null;
  ceilings: Ceiling[];
  max_installment: number | null;
  binding_constraint: string | null;
}

export interface ProductMatch {
  product: FinancingProduct;
  status: MatchStatus;
  confidence: Confidence;
  reasons: Note[];
  unknowns: Note[];

  max_ltv_pct: number | null;
  financing_amount: number | null;
  down_payment: number | null;
  ltv_pct: number | null;
  upfront_cash: number | null;
  /**
   * How much MORE cash the customer needs than they said they had. Computed but
   * previously discarded — a rep could see "upfront cash SAR 912,662" next to a
   * stated SAR 250,000 and never be told about the gap.
   */
  cash_shortfall: number | null;
  /**
   * True when `financing_amount` reflects only the down payment and LTV ceilings
   * because there is no rate to convert the customer's payment capacity into a
   * principal. Such a figure is NOT affordability-tested and must not be compared
   * like-for-like against a priced product's amount.
   */
  financing_not_capacity_tested: boolean;

  /** Present only with a contractual or quoted rate. */
  monthly_payment: number | null;
  total_repayment: number | null;
  applied_rate_pct: number | null;
  rate_basis: RateBasis;
  published_apr_pct: number | null;
  rate_source_url: string | null;
  rate_verified_at: string | null;
  is_stale: boolean;
}

export interface FinancingResult {
  calculation_version: string;
  as_of_date: string;
  status: ResultStatus;
  confidence: Confidence;

  capacity: Capacity;
  max_financing: number | null;
  max_property_value: number | null;

  selected: ProductMatch | null;
  matches: ProductMatch[];

  assumptions: Note[];
  missing: Note[];

  /** The exact rule values used, so a historical snapshot is readable without
   *  a version graph. This is what replaces V1's pinned-version machinery. */
  rules_used: Record<string, { source_url: string; effective_from: string; values: unknown }>;

  disclaimer_ar: string;
  disclaimer_en: string;
}
