/**
 * Test fixtures mirroring the REAL seeded rule versions.
 *
 * The percentages here are the ones actually stored in `fin_regulatory_rules`
 * after `scripts/financing/seed.mjs` runs, so a test that passes against these
 * fixtures is exercising the same numbers production reads. If SAMA changes a
 * ratio, the seed changes and these fixtures must change with it — which is the
 * intended coupling.
 */
import type {
  ApplicantInput,
  CreditCardRulePayload,
  DbrRulePayload,
  EngineInput,
  EngineReference,
  FeeCapRulePayload,
  LtvRulePayload,
  ProductRef,
  QualifyingIncomeRulePayload,
  RuleSet,
  RuleVersion,
  TaxRuleVersion,
} from '../types';

export function ruleVersion<P>(
  id: string,
  rule_key: string,
  payload: P,
  effective_from = '2018-05-17',
  effective_to: string | null = null,
): RuleVersion<never> {
  return {
    id,
    rule_key,
    version_number: 1,
    effective_from,
    effective_to,
    payload: payload as never,
    source_url: 'https://rulebook.sama.gov.sa/en/chapter-iv-quantitative-principles-responsible-lending',
  };
}

export const DBR_PAYLOAD: DbrRulePayload = {
  kind: 'dbr_bands',
  bands: [
    {
      income_from: 0,
      income_to: 15000.01,
      salary_deduction_employee_pct: 33.33,
      salary_deduction_retiree_pct: 25,
      excluding_real_estate_pct: 45,
      total_obligations_pct: 55,
      total_obligations_supported_pct: 65,
      real_estate_per_creditor_policy: false,
    },
    {
      income_from: 15000.01,
      income_to: 25000,
      salary_deduction_employee_pct: 33.33,
      salary_deduction_retiree_pct: 25,
      excluding_real_estate_pct: 45,
      total_obligations_pct: 65,
      total_obligations_supported_pct: 65,
      real_estate_per_creditor_policy: false,
    },
    {
      income_from: 25000,
      income_to: null,
      salary_deduction_employee_pct: 33.33,
      salary_deduction_retiree_pct: 25,
      excluding_real_estate_pct: null,
      total_obligations_pct: null,
      total_obligations_supported_pct: null,
      real_estate_per_creditor_policy: true,
    },
  ],
};

export const INCOME_PAYLOAD: QualifyingIncomeRulePayload = {
  kind: 'qualifying_income',
  gross_salary_pct: 100,
  other_periodic_income_pct: 50,
  other_periodic_income_types: [
    'other_allowance',
    'commission',
    'bonus',
    'rental',
    'investment',
    'business',
    'other_recurring',
    'pension',
  ],
  other_income_min_history_months: 24,
  government_subsidy_excluded: true,
  housing_support_included_in_real_estate: true,
};

export const CARD_PAYLOAD: CreditCardRulePayload = {
  kind: 'credit_card_obligation',
  basis: 'minimum_repayment_of_ceiling',
  minimum_repayment_pct: 5,
};

export const LTV_PAYLOAD: LtvRulePayload = {
  kind: 'ltv',
  bank_first_home_pct: 90,
  bank_additional_home_pct: 70,
  finance_company_first_home_pct: 90,
  finance_company_additional_home_pct: 85,
  first_home_citizens_only: true,
};

/** The pre-2018 window, for the effective-dating tests. */
export const LTV_PAYLOAD_2017: LtvRulePayload = {
  kind: 'ltv',
  bank_first_home_pct: 85,
  bank_additional_home_pct: 70,
  finance_company_first_home_pct: 85,
  finance_company_additional_home_pct: 85,
  first_home_citizens_only: true,
};

export const FEE_CAP_PAYLOAD: FeeCapRulePayload = {
  kind: 'fee_cap',
  pct_of_finance_amount: 1,
  absolute_cap: 5000,
};

export function makeRuleSet(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    dbr: ruleVersion('rule-dbr', 'sama_dbr_bands', DBR_PAYLOAD) as RuleVersion<DbrRulePayload>,
    qualifying_income: ruleVersion('rule-income', 'sama_qualifying_income', INCOME_PAYLOAD) as RuleVersion<QualifyingIncomeRulePayload>,
    credit_card: ruleVersion('rule-card', 'sama_credit_card_obligation', CARD_PAYLOAD) as RuleVersion<CreditCardRulePayload>,
    ltv: ruleVersion('rule-ltv', 'sama_ltv_ceilings', LTV_PAYLOAD, '2018-01-14') as RuleVersion<LtvRulePayload>,
    fee_cap: ruleVersion('rule-fee', 'sama_fee_cap', FEE_CAP_PAYLOAD, '2014-07-07') as RuleVersion<FeeCapRulePayload>,
    apr_method: ruleVersion('rule-apr', 'sama_apr_method', {
      kind: 'apr_method',
      method: 'cash_flow_irr',
      day_count: 'twelve_equal_months',
      precision_basis_points: 2,
      include_unavoidable_fees: true,
    }, '2023-10-31') as never,
    term_limits: ruleVersion('rule-term', 'sama_term_limits', {
      kind: 'term_limits',
      max_term_months: 60,
      exempt_categories: ['residential_purchase', 'off_plan'],
    }) as never,
    early_settlement: ruleVersion('rule-early', 'sama_early_settlement', {
      kind: 'early_settlement',
      max_reinvestment_months: 3,
      basis: 'declining_balance',
    }, '2014-07-07') as never,
    ...overrides,
  };
}

export const RETT: TaxRuleVersion = {
  id: 'tax-rett',
  tax_key: 'rett',
  effective_from: '2025-04-09',
  effective_to: null,
  rate_pct: 5,
  base: 'higher_of_both',
  payer: 'seller',
  first_home_relief_cap: 1000000,
  source_url: 'https://zatca.gov.sa',
};

export function makeApplicant(overrides: Partial<ApplicantInput> = {}): ApplicantInput {
  return {
    role: 'primary',
    nationality_type: 'saudi',
    date_of_birth: '1990-01-15',
    employment_type: 'employee',
    employer_sector: 'private',
    service_months: 48,
    willing_to_transfer_salary: true,
    salary_transfer_provider_key: null,
    expected_retirement_age: null,
    ...overrides,
  };
}

/** A fixed-rate, fully-specified product — the "everything published" case. */
export function makeProduct(overrides: Partial<ProductRef> = {}): ProductRef {
  const base: ProductRef = {
    id: 'prod-1',
    product_key: 'test_home_finance',
    name_ar: 'تمويل عقاري',
    name_en: 'Test Home Finance',
    category: 'residential_purchase',
    structure: 'murabaha',
    official_url: 'https://example.sa/product',
    provider: {
      id: 'prov-1',
      provider_key: 'testbank',
      name_ar: 'بنك الاختبار',
      name_en: 'Test Bank',
      provider_type: 'bank',
    },
    version: {
      id: 'pv-1',
      product_id: 'prod-1',
      version_number: 1,
      effective_from: '2026-01-01',
      applies_to_saudi: true,
      applies_to_resident: true,
      applies_to_first_home: true,
      applies_to_additional_home: true,
      supported_financing: null,
      unsupported_financing: null,
      property_types: null,
      property_status: null,
      employment_types: null,
      employer_sectors: null,
      requires_approved_employer: null,
      requires_salary_transfer: false,
      min_salary: 5000,
      min_salary_no_transfer: null,
      min_employment_months: 3,
      min_age_years: 18,
      max_age_at_application: null,
      max_age_at_maturity: 70,
      retiree_eligible: true,
      min_amount: 100000,
      max_amount: 5000000,
      min_term_months: 60,
      max_term_months: 360,
      min_down_payment_pct: null,
      max_ltv_pct: null,
      max_salary_multiple: null,
      grace_period_months: 0,
      calculation_method: 'fixed_amortizing',
      collected_at: '2026-07-20T00:00:00Z',
      verified_at: '2026-07-20T00:00:00Z',
      confidence: 'high',
      source_url: 'https://example.sa/product',
      fees: [
        {
          id: 'fee-1',
          fee_type: 'administrative',
          label_ar: 'رسوم إدارية',
          label_en: 'Administrative fee',
          amount_fixed: null,
          amount_pct: 1,
          pct_base: 'finance_amount',
          cap_amount: 5000,
          floor_amount: null,
          is_mandatory: true,
          include_in_apr: true,
          payable_upfront: true,
        },
      ],
      eligibility_rules: [],
    },
    rate: {
      id: 'rv-1',
      product_id: 'prod-1',
      version_number: 1,
      effective_from: '2026-01-01',
      rate_type: 'fixed',
      rate_disclosure_type: 'exact_rate',
      contractual_rate_pct: 5,
      contractual_rate_min_pct: null,
      contractual_rate_max_pct: null,
      published_apr_pct: null,
      published_apr_min_pct: null,
      published_apr_max_pct: null,
      benchmark_key: null,
      margin_pct: null,
      benchmark_reset_months: null,
      example_amount: null,
      example_term_months: null,
      example_property_price: null,
      example_ltv_pct: null,
      example_monthly_payment: null,
      campaign_end_date: null,
      collected_at: '2026-07-20T00:00:00Z',
      verified_at: '2026-07-20T00:00:00Z',
      confidence: 'high',
      source_url: 'https://example.sa/product',
    },
  };
  return { ...base, ...overrides };
}

export function makeReference(overrides: Partial<EngineReference> = {}): EngineReference {
  return {
    rules: makeRuleSet(),
    tax: RETT,
    supportPrograms: [],
    benchmarks: [],
    products: [makeProduct()],
    pricing_freshness_days: 90,
    product_freshness_days: 365,
    ...overrides,
  };
}

export function makeInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    as_of_date: '2026-07-28',
    applicants: [makeApplicant()],
    incomes: [
      {
        id: 'inc-1',
        applicant_role: 'primary',
        income_type: 'basic_salary',
        declared_monthly_amount: 20000,
        verified_monthly_amount: 20000,
        documentation_status: 'payslip',
        frequency: 'monthly',
        averaging_period_months: null,
        is_fixed: true,
      },
    ],
    obligations: [],
    support: {
      is_first_home: true,
      sakani_eligible: false,
      redf_eligible: false,
      support_status: 'unknown',
      monthly_support_amount: null,
      support_duration_months: null,
      financing_kind: 'unsupported',
      previously_used_first_home_tax_support: false,
    },
    property: {
      property_price: 1000000,
      property_type: 'apartment',
      property_status: 'completed',
      city: 'Riyadh',
      is_first_home: true,
      available_cash: 200000,
      desired_down_payment: null,
      expected_valuation: null,
      additional_expenses: null,
      project_record_id: null,
      unit_record_id: null,
    },
    preferences: {
      preferred_term_months: 240,
      min_term_months: null,
      max_term_months: null,
      rate_preference: 'fixed',
      max_acceptable_installment: null,
      priority: 'lowest_monthly',
      preferred_provider_keys: null,
      planned_start_date: '2026-08-01',
    },
    ...overrides,
  };
}
