import { describe, it, expect } from 'vitest';
import { runFinancingEngine } from '../engine';
import { applyFeeCap, calculateUpfrontCash, maxPropertyValue, regulatoryLtvCeiling, resolveFee } from '../ltv';
import { dataAgeDays, evaluateEligibility, isPricingStale, resolveRate } from '../matching';
import {
  LTV_PAYLOAD,
  LTV_PAYLOAD_2017,
  RETT,
  makeApplicant,
  makeInput,
  makeProduct,
  makeReference,
  makeRuleSet,
  ruleVersion,
} from './fixtures';
import type { LtvRulePayload, ProviderRef, RateVersionRef, RuleVersion } from '../types';

const BANK: ProviderRef = { id: 'p1', provider_key: 'b', name_ar: 'بنك', name_en: 'Bank', provider_type: 'bank' };
const FINCO: ProviderRef = {
  id: 'p2', provider_key: 'f', name_ar: 'شركة', name_en: 'Finance Co',
  provider_type: 'real_estate_finance_company',
};
const ltvRule = ruleVersion('rule-ltv', 'sama_ltv_ceilings', LTV_PAYLOAD, '2018-01-14') as RuleVersion<LtvRulePayload>;

describe('regulatoryLtvCeiling — the provider × first-home × citizenship matrix', () => {
  it('bank + first home + Saudi = 90%', () => {
    expect(regulatoryLtvCeiling({ rule: ltvRule, provider: BANK, isFirstHome: true, isSaudi: true }).ceiling_pct).toBe(90);
  });

  it('bank + additional home = 70%', () => {
    expect(regulatoryLtvCeiling({ rule: ltvRule, provider: BANK, isFirstHome: false, isSaudi: true }).ceiling_pct).toBe(70);
  });

  it('finance company + additional home = 85%, NOT the bank’s 70%', () => {
    // The 2016 circular raised finance companies only. Applying one blanket
    // ceiling would understate every finance-company option.
    expect(regulatoryLtvCeiling({ rule: ltvRule, provider: FINCO, isFirstHome: false, isSaudi: true }).ceiling_pct).toBe(85);
  });

  it('a RESIDENT cannot have the 90% first-home ceiling (citizens only)', () => {
    const r = regulatoryLtvCeiling({ rule: ltvRule, provider: BANK, isFirstHome: true, isSaudi: false });
    expect(r.ceiling_pct).toBe(70);
    expect(r.note).toContain('Saudi citizens only');
  });

  it('unknown first-home status falls back to the CONSERVATIVE ceiling and says so', () => {
    const r = regulatoryLtvCeiling({ rule: ltvRule, provider: BANK, isFirstHome: null, isSaudi: true });
    expect(r.ceiling_pct).toBe(70);
    expect(r.note).toContain('conservative');
  });

  it('returns null rather than a default when the rule is missing', () => {
    const r = regulatoryLtvCeiling({ rule: null, provider: BANK, isFirstHome: true, isSaudi: true });
    expect(r.ceiling_pct).toBeNull();
    expect(r.basis).toBe('ltv_rule_missing');
  });
});

describe('effective-dated rule selection', () => {
  it('the 2017 rule window gives 85%, the 2018 window gives 90% — same inputs', () => {
    // Reproducibility in one assertion: a calculation dated before the 2018
    // circular must still replay against the ceiling that was in force.
    const old = ruleVersion('rule-ltv-2017', 'sama_ltv_ceilings', LTV_PAYLOAD_2017, '2017-01-05', '2018-01-14') as RuleVersion<LtvRulePayload>;
    expect(regulatoryLtvCeiling({ rule: old, provider: BANK, isFirstHome: true, isSaudi: true }).ceiling_pct).toBe(85);
    expect(regulatoryLtvCeiling({ rule: ltvRule, provider: BANK, isFirstHome: true, isSaudi: true }).ceiling_pct).toBe(90);
  });

  it('an engine run pins the rule version ids it used', () => {
    const result = runFinancingEngine(makeInput(), makeReference());
    expect(result.pinned.regulatory_rule_version_ids).toContain('rule-ltv');
    expect(result.pinned.regulatory_rule_version_ids).toContain('rule-dbr');
    expect(result.pinned.tax_rule_version_ids).toContain('tax-rett');
  });
});

describe('fee cap — Consumer Financing Art. 9', () => {
  it('caps at 1% when 1% is lower than SAR 5,000', () => {
    // 1% of 300,000 = 3,000 < 5,000 → 3,000 wins.
    expect(applyFeeCap(9999, 300_000, { pct_of_finance_amount: 1, absolute_cap: 5000 })).toEqual({ amount: 3000, capped: true });
  });

  it('caps at SAR 5,000 when 1% exceeds it', () => {
    // 1% of 1,000,000 = 10,000 > 5,000 → 5,000 wins.
    expect(applyFeeCap(9999, 1_000_000, { pct_of_finance_amount: 1, absolute_cap: 5000 })).toEqual({ amount: 5000, capped: true });
  });

  it('leaves a compliant fee alone', () => {
    expect(applyFeeCap(2000, 1_000_000, { pct_of_finance_amount: 1, absolute_cap: 5000 })).toEqual({ amount: 2000, capped: false });
  });
});

describe('resolveFee', () => {
  const ctx = { financeAmount: 800_000, propertyPrice: 1_000_000 };
  it('takes the LOWER of a fixed and a percentage figure', () => {
    const fee = {
      id: 'f', fee_type: 'administrative' as const, label_ar: null, label_en: 'Admin',
      amount_fixed: 5000, amount_pct: 1, pct_base: 'finance_amount' as const,
      cap_amount: null, floor_amount: null, is_mandatory: true, include_in_apr: true, payable_upfront: true,
    };
    // 1% of 800,000 = 8,000 vs fixed 5,000 → 5,000.
    expect(resolveFee(fee, ctx)).toBe(5000);
  });

  it('applies a cap', () => {
    const fee = {
      id: 'f', fee_type: 'administrative' as const, label_ar: null, label_en: 'Admin',
      amount_fixed: null, amount_pct: 1, pct_base: 'finance_amount' as const,
      cap_amount: 5000, floor_amount: null, is_mandatory: true, include_in_apr: true, payable_upfront: true,
    };
    expect(resolveFee(fee, ctx)).toBe(5000);
  });

  it('returns null when nothing is published rather than 0', () => {
    const fee = {
      id: 'f', fee_type: 'valuation' as const, label_ar: null, label_en: 'Valuation',
      amount_fixed: null, amount_pct: null, pct_base: null,
      cap_amount: null, floor_amount: null, is_mandatory: true, include_in_apr: true, payable_upfront: true,
    };
    expect(resolveFee(fee, ctx)).toBeNull();
  });
});

describe('calculateUpfrontCash', () => {
  const base = {
    propertyPrice: 1_000_000,
    financeAmount: 900_000,
    expectedValuation: null,
    additionalExpenses: null,
    availableCash: 200_000,
    fees: [],
    feeCap: { pct_of_finance_amount: 1, absolute_cap: 5000 },
    tax: null,
    support: makeInput().support,
  };

  it('down payment is price minus financing', () => {
    expect(calculateUpfrontCash(base).down_payment).toBe(100_000);
  });

  it('a valuation BELOW the sale price becomes extra cash the customer must find', () => {
    const r = calculateUpfrontCash({ ...base, expectedValuation: 950_000 });
    expect(r.valuation_gap).toBe(50_000);
    expect(r.total).toBe(150_000);
  });

  it('ignores a valuation ABOVE the sale price', () => {
    expect(calculateUpfrontCash({ ...base, expectedValuation: 1_100_000 }).valuation_gap).toBe(0);
  });

  it('applies RETT and the first-home relief up to the cap', () => {
    const r = calculateUpfrontCash({
      ...base,
      tax: RETT,
      support: { ...base.support, is_first_home: true, previously_used_first_home_tax_support: false },
    });
    expect(r.transaction_tax).toBe(50_000); // 5% of 1,000,000
    expect(r.tax_relief).toBe(50_000); // relief on the first 1,000,000 → full
  });

  it('relieves only the CAPPED portion on a property above SAR 1,000,000', () => {
    const r = calculateUpfrontCash({
      ...base,
      propertyPrice: 1_500_000,
      tax: RETT,
      support: { ...base.support, is_first_home: true, previously_used_first_home_tax_support: false },
    });
    expect(r.transaction_tax).toBe(75_000); // 5% of 1.5m
    expect(r.tax_relief).toBe(50_000); // 5% of the 1m cap only
  });

  it('gives NO relief when the benefit was already used', () => {
    const r = calculateUpfrontCash({
      ...base,
      tax: RETT,
      support: { ...base.support, is_first_home: true, previously_used_first_home_tax_support: true },
    });
    expect(r.tax_relief).toBeNull();
  });

  it('reports a shortfall against available cash', () => {
    const r = calculateUpfrontCash({ ...base, financeAmount: 700_000, availableCash: 100_000 });
    expect(r.total).toBe(300_000);
    expect(r.shortfall).toBe(200_000);
  });

  it('leaves shortfall null (not zero) when available cash is unknown', () => {
    expect(calculateUpfrontCash({ ...base, availableCash: null }).shortfall).toBeNull();
  });
});

describe('maxPropertyValue', () => {
  it('is bounded by the LTV ceiling', () => {
    const r = maxPropertyValue({ maxFinancing: 900_000, ltvCeilingPct: 90, availableCash: 500_000 });
    expect(r.value).toBe(1_000_000);
    expect(r.binding).toBe('ltv_ceiling');
  });

  it('is bounded by available cash when that binds first', () => {
    const r = maxPropertyValue({ maxFinancing: 900_000, ltvCeilingPct: 90, availableCash: 50_000 });
    expect(r.value).toBe(950_000);
    expect(r.binding).toBe('available_cash');
  });

  it('returns null without a financing figure', () => {
    expect(maxPropertyValue({ maxFinancing: null, ltvCeilingPct: 90, availableCash: 100_000 }).value).toBeNull();
  });
});

describe('resolveRate — honest labelling of published pricing', () => {
  const base: RateVersionRef = {
    id: 'r', product_id: 'p', version_number: 1, effective_from: '2026-01-01',
    rate_type: 'fixed', rate_disclosure_type: 'exact_rate',
    contractual_rate_pct: 5, contractual_rate_min_pct: null, contractual_rate_max_pct: null,
    published_apr_pct: null, published_apr_min_pct: null, published_apr_max_pct: null,
    benchmark_key: null, margin_pct: null, benchmark_reset_months: null,
    example_amount: null, example_term_months: null, example_property_price: null,
    example_ltv_pct: null, example_monthly_payment: null, campaign_end_date: null,
    collected_at: '2026-07-20T00:00:00Z', verified_at: '2026-07-20T00:00:00Z',
    confidence: 'high', source_url: 'https://x',
  };

  it('an exact contractual rate is HIGH confidence', () => {
    const r = resolveRate(base, null);
    expect(r.rate_pct).toBe(5);
    expect(r.basis).toBe('contractual');
    expect(r.confidence).toBe('high');
  });

  it('a "starting from" rate is LOW confidence and says it is not customer-specific', () => {
    // Al Rajhi Flexible: "Annual Profit Rate starts from 7.75%".
    const r = resolveRate({ ...base, rate_disclosure_type: 'starting_from', contractual_rate_pct: 7.75 }, null);
    expect(r.rate_pct).toBe(7.75);
    expect(r.basis).toBe('starting_from');
    expect(r.confidence).toBe('low');
    expect(r.note_en).toContain('not a customer-specific rate');
  });

  it('a "starting from" APR with NO contractual rate is used only as a labelled approximation', () => {
    // Al Rajhi Off-Plan: "APR starts from 5.96%" — an APR floor, not a profit rate.
    const r = resolveRate(
      { ...base, rate_disclosure_type: 'starting_from', contractual_rate_pct: null, published_apr_pct: 5.96 },
      null,
    );
    expect(r.rate_pct).toBe(5.96);
    expect(r.confidence).toBe('low');
    expect(r.note_en).toContain('requires a bank quotation');
  });

  it('a representative example carries its assumptions into the note', () => {
    // SAB REDF-subsidised: APR 6.78% on a 500k / 25-year / 90% LTV example.
    const r = resolveRate(
      {
        ...base, rate_disclosure_type: 'representative_example', contractual_rate_pct: null,
        published_apr_pct: 6.78, example_property_price: 500_000, example_term_months: 300, example_ltv_pct: 90,
      },
      null,
    );
    expect(r.rate_pct).toBe(6.78);
    expect(r.basis).toBe('example');
    expect(r.confidence).toBe('low');
    expect(r.note_en).toContain('500000');
    expect(r.note_en).toContain('25 years');
  });

  it('a published range uses the midpoint and flags it', () => {
    const r = resolveRate(
      { ...base, rate_disclosure_type: 'published_range', contractual_rate_pct: null, contractual_rate_min_pct: 4, contractual_rate_max_pct: 6 },
      null,
    );
    expect(r.rate_pct).toBe(5);
    expect(r.basis).toBe('range_midpoint');
    expect(r.confidence).toBe('low');
  });

  it('quotation_required yields NO number', () => {
    const r = resolveRate({ ...base, rate_disclosure_type: 'quotation_required', contractual_rate_pct: null }, null);
    expect(r.rate_pct).toBeNull();
    expect(r.basis).toBe('unavailable');
  });

  it('a variable product prices off benchmark + margin', () => {
    const r = resolveRate({ ...base, rate_type: 'variable', margin_pct: 2, benchmark_key: 'saibor_2y' }, 5.5);
    expect(r.rate_pct).toBe(7.5);
  });

  it('a variable product with NO benchmark observation yields no number', () => {
    const r = resolveRate({ ...base, rate_type: 'variable', margin_pct: 2, benchmark_key: 'saibor_2y' }, null);
    expect(r.rate_pct).toBeNull();
    expect(r.note_en).toContain('benchmark');
  });

  it('a missing rate version yields no number at all', () => {
    expect(resolveRate(null, null).rate_pct).toBeNull();
  });
});

describe('staleness', () => {
  const rate = makeProduct().rate!;
  it('fresh pricing is not stale', () => {
    expect(isPricingStale({ ...rate, verified_at: '2026-07-20T00:00:00Z' }, '2026-07-28', 90)).toBe(false);
  });
  it('old pricing IS stale', () => {
    expect(isPricingStale({ ...rate, verified_at: '2026-01-01T00:00:00Z' }, '2026-07-28', 90)).toBe(true);
  });
  it('an absent rate counts as stale, never as fresh', () => {
    expect(isPricingStale(null, '2026-07-28', 90)).toBe(true);
  });
  it('reports the age in days', () => {
    expect(dataAgeDays({ ...rate, verified_at: '2026-07-18T00:00:00Z' }, '2026-07-28')).toBe(10);
  });
});

describe('evaluateEligibility — unknowns are neither pass nor fail', () => {
  const input = makeInput();
  const primary = makeApplicant();

  it('a fully-matching profile is an INDICATIVE match, never "approved"', () => {
    const r = evaluateEligibility({ input, primary, product: makeProduct(), requestedAmount: 800_000, termMonths: 240 });
    expect(r.status).toBe('indicative_match');
  });

  it('below the minimum salary is an exclusion, hedged as "appears outside"', () => {
    const product = makeProduct();
    product.version!.min_salary = 30_000;
    const r = evaluateEligibility({ input, primary, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.status).toBe('appears_outside_published_criteria');
    expect(r.exclusion_reasons[0]!.code).toBe('below_min_salary');
  });

  it('uses the NO-TRANSFER salary threshold when the customer declines transfer', () => {
    const product = makeProduct();
    product.version!.min_salary = 7000;
    product.version!.min_salary_no_transfer = 25_000;
    const declined = makeApplicant({ willing_to_transfer_salary: false });
    const r = evaluateEligibility({ input, primary: declined, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.status).toBe('appears_outside_published_criteria');
  });

  it('an unknown criterion downgrades to requires_bank_review, not exclusion', () => {
    const product = makeProduct();
    product.version!.applies_to_saudi = null;
    product.version!.applies_to_resident = null;
    const r = evaluateEligibility({ input, primary, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.status).toBe('requires_bank_review');
    expect(r.unknown_criteria.some((u) => u.code === 'nationality_criteria_unpublished')).toBe(true);
  });

  it('an approved-employer requirement always needs bank confirmation (lists are not public)', () => {
    const product = makeProduct();
    product.version!.requires_approved_employer = true;
    const r = evaluateEligibility({ input, primary, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.unknown_criteria.some((u) => u.code === 'approved_employer_unverified')).toBe(true);
    expect(r.status).toBe('requires_bank_review');
  });

  it('age at MATURITY excludes a term that runs past the limit', () => {
    const product = makeProduct();
    product.version!.max_age_at_maturity = 60;
    // Born 1990 → 36 in 2026; a 30-year term matures at 66.
    const r = evaluateEligibility({ input, primary, product, requestedAmount: 800_000, termMonths: 360 });
    expect(r.exclusion_reasons.some((e) => e.code === 'age_at_maturity_exceeded')).toBe(true);
  });

  it('a resident is excluded from a Saudi-only product', () => {
    const product = makeProduct();
    product.version!.applies_to_resident = false;
    const resident = makeApplicant({ nationality_type: 'resident' });
    const r = evaluateEligibility({ input, primary: resident, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.exclusion_reasons.some((e) => e.code === 'not_for_resident')).toBe(true);
  });

  it('a product with no published data reports product_data_unavailable', () => {
    const product = makeProduct({ version: null });
    const r = evaluateEligibility({ input, primary, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.status).toBe('product_data_unavailable');
  });

  it('a retiree is excluded where the product says so', () => {
    const product = makeProduct();
    product.version!.retiree_eligible = false;
    const retiree = makeApplicant({ employment_type: 'retiree' });
    const r = evaluateEligibility({ input, primary: retiree, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.exclusion_reasons.some((e) => e.code === 'retiree_not_eligible')).toBe(true);
  });
});

describe('runFinancingEngine — end to end', () => {
  it('produces an indicative match with numbers for a clean profile', () => {
    const r = runFinancingEngine(makeInput(), makeReference());
    expect(r.status).toBe('indicative_match');
    expect(r.selected).not.toBeNull();
    expect(r.selected!.monthly_payment).toBeGreaterThan(0);
    expect(r.selected!.calculated_apr_pct).toBeGreaterThan(0);
    expect(r.capacity.max_installment).toBeGreaterThan(0);
  });

  it('NEVER emits an "approved" status', () => {
    const r = runFinancingEngine(makeInput(), makeReference());
    expect(JSON.stringify(r.status)).not.toContain('approved');
    expect(r.disclaimer_en).toContain('not a financing approval');
  });

  it('is reproducible — same inputs give byte-identical output', () => {
    const input = makeInput();
    const reference = makeReference();
    expect(JSON.stringify(runFinancingEngine(input, reference))).toBe(
      JSON.stringify(runFinancingEngine(input, reference)),
    );
  });

  it('a high-income customer becomes requires_bank_review, not a fabricated ratio', () => {
    const input = makeInput({
      incomes: [{
        id: 'i', applicant_role: 'primary', income_type: 'basic_salary',
        declared_monthly_amount: 60_000, verified_monthly_amount: 60_000,
        documentation_status: 'payslip', frequency: 'monthly',
        averaging_period_months: null, is_fixed: true,
      }],
    });
    const r = runFinancingEngine(input, makeReference());
    expect(r.status).toBe('requires_bank_review');
  });

  it('a product with NO published pricing cannot produce an installment', () => {
    const product = makeProduct({ rate: null });
    const r = runFinancingEngine(makeInput(), makeReference({ products: [product] }));
    expect(r.matches[0]!.status).toBe('product_data_unavailable');
    expect(r.matches[0]!.monthly_payment).toBeNull();
    expect(r.matches[0]!.rate_basis).toBe('unavailable');
  });

  it('stale pricing surfaces as product_data_stale', () => {
    const product = makeProduct();
    product.rate!.verified_at = '2025-01-01T00:00:00Z';
    product.rate!.collected_at = '2025-01-01T00:00:00Z';
    const r = runFinancingEngine(makeInput(), makeReference({ products: [product] }));
    expect(r.matches[0]!.is_stale).toBe(true);
    expect(r.matches[0]!.status).toBe('product_data_stale');
  });

  it('an LTV ceiling caps the financing below the requested amount', () => {
    // Additional home → 70% for a bank. On a 1m property that is 700k.
    const input = makeInput();
    input.property.is_first_home = false;
    input.support.is_first_home = false;
    const r = runFinancingEngine(input, makeReference());
    expect(r.selected!.max_ltv_pct).toBe(70);
    expect(r.selected!.financing_amount).toBeLessThanOrEqual(700_000);
  });

  it('income capacity binds when it is tighter than the LTV', () => {
    const input = makeInput({
      incomes: [{
        id: 'i', applicant_role: 'primary', income_type: 'basic_salary',
        declared_monthly_amount: 8000, verified_monthly_amount: 8000,
        documentation_status: 'payslip', frequency: 'monthly',
        averaging_period_months: null, is_fixed: true,
      }],
    });
    const r = runFinancingEngine(input, makeReference());
    expect(r.selected!.binding_constraint).toBe('income_capacity');
    expect(r.selected!.financing_amount).toBeLessThan(900_000);
  });

  it('affordability mode skips product matching but still yields capacity', () => {
    const r = runFinancingEngine(makeInput(), makeReference(), 'affordability');
    expect(r.matches).toHaveLength(0);
    expect(r.capacity.max_installment).toBeGreaterThan(0);
  });

  it('offers term comparisons within the product’s published envelope', () => {
    const r = runFinancingEngine(makeInput(), makeReference());
    expect(r.term_options.length).toBeGreaterThan(0);
    // The fixture product publishes a 360-month maximum.
    expect(r.term_options.every((t) => t.term_months <= 360)).toBe(true);
    // Longer term → lower instalment.
    const sorted = r.term_options.slice().sort((a, b) => a.term_months - b.term_months);
    expect(sorted[0]!.monthly_payment!).toBeGreaterThan(sorted.at(-1)!.monthly_payment!);
  });

  it('never offers a down payment the LTV ceiling forbids', () => {
    const input = makeInput();
    input.property.is_first_home = false;
    input.support.is_first_home = false;
    const r = runFinancingEngine(input, makeReference());
    // 70% ceiling means a 10% down payment (90% LTV) cannot be offered.
    expect(r.down_payment_options.every((o) => o.ltv_pct <= 70)).toBe(true);
  });

  it('reports missing information rather than silently defaulting', () => {
    const input = makeInput({
      incomes: [{
        id: 'i', applicant_role: 'primary', income_type: 'basic_salary',
        declared_monthly_amount: 20_000, verified_monthly_amount: null,
        documentation_status: 'self_declared', frequency: 'monthly',
        averaging_period_months: null, is_fixed: true,
      }],
    });
    const r = runFinancingEngine(input, makeReference());
    expect(r.missing.some((m) => m.code.startsWith('income_declared_only'))).toBe(true);
  });

  it('an unpriceable product list yields product_data_unavailable overall', () => {
    const r = runFinancingEngine(makeInput(), makeReference({ products: [] }));
    expect(r.status).toBe('product_data_unavailable');
  });

  it('ranks a higher-confidence option above a cheaper low-confidence one', () => {
    const solid = makeProduct();
    const cheapButVague = makeProduct({
      id: 'prod-2',
      product_key: 'vague',
      name_en: 'Vague Product',
    });
    cheapButVague.rate = { ...cheapButVague.rate!, id: 'rv-2', rate_disclosure_type: 'starting_from', contractual_rate_pct: 2 };
    const r = runFinancingEngine(makeInput(), makeReference({ products: [cheapButVague, solid] }));
    // The 2% "starting from" product is cheaper, but the exact-rate product is
    // better evidenced and must lead — otherwise the top row is always the
    // least reliable number on screen.
    expect(r.matches[0]!.product.id).toBe('prod-1');
  });

  it('projected DBR includes existing obligations plus the new instalment', () => {
    const input = makeInput({
      obligations: [{
        id: 'ob', obligation_type: 'personal_finance', monthly_payment: 2000,
        outstanding_balance: null, remaining_months: null, end_date: null,
        card_limit: null, minimum_payment: null, balloon_payment: null,
        will_be_settled_before_financing: false, is_real_estate: false,
      }],
    });
    const r = runFinancingEngine(input, makeReference());
    const m = r.selected!;
    const expected = ((2000 + m.monthly_payment!) / r.capacity.income.qualifying_total) * 100;
    expect(m.projected_dbr_pct!).toBeCloseTo(expected, 1);
  });

  it('emits variable-rate sensitivity as scenarios at +1/+2/+3 points', () => {
    const product = makeProduct();
    product.rate = { ...product.rate!, rate_type: 'variable', margin_pct: 2, benchmark_key: 'saibor_2y', rate_disclosure_type: 'exact_rate', contractual_rate_pct: null };
    const reference = makeReference({
      products: [product],
      benchmarks: [{ id: 'bo-1', benchmark_key: 'saibor_2y', observation_date: '2026-07-01', rate_pct: 5, source_url: 'https://x' }],
    });
    const r = runFinancingEngine(makeInput(), reference);
    const m = r.matches[0]!;
    expect(m.applied_rate_pct).toBe(7); // 5 + 2
    expect(m.sensitivity.map((s) => s.shock_pct)).toEqual([1, 2, 3]);
    expect(m.sensitivity[0]!.monthly_payment).toBeGreaterThan(m.monthly_payment!);
    expect(r.pinned.benchmark_observation_ids).toContain('bo-1');
  });

  it('a fixed product emits NO sensitivity rows', () => {
    const r = runFinancingEngine(makeInput(), makeReference());
    expect(r.selected!.sensitivity).toHaveLength(0);
  });

  it('blocks with insufficient_information when the DBR rule is missing', () => {
    const reference = makeReference({ rules: makeRuleSet({ dbr: null }) });
    const r = runFinancingEngine(makeInput(), reference);
    expect(r.status).toBe('insufficient_information');
    expect(r.confidence).toBe('unavailable');
  });

  it('a requested amount below the product minimum is excluded up front', () => {
    const product = makeProduct();
    product.version!.min_amount = 2_000_000;
    const r = runFinancingEngine(makeInput(), makeReference({ products: [product] }));
    expect(r.matches[0]!.status).toBe('appears_outside_published_criteria');
    expect(r.matches[0]!.exclusion_reasons.some((e) => e.code === 'below_min_amount')).toBe(true);
  });

  it('qualifying on paper but unable to AFFORD the product minimum is its own exclusion', () => {
    // The subtler case, and a real one: the property price clears the product's
    // minimum, so eligibility passes — but the customer's income only supports a
    // smaller amount than the product will write. Reporting a "match" here would
    // send a rep to a bank that cannot transact.
    const product = makeProduct();
    product.version!.min_amount = 800_000; // requested (90% of 1m = 900k) clears this
    const input = makeInput({
      incomes: [{
        id: 'i', applicant_role: 'primary', income_type: 'basic_salary',
        declared_monthly_amount: 6000, verified_monthly_amount: 6000,
        documentation_status: 'payslip', frequency: 'monthly',
        averaging_period_months: null, is_fixed: true,
      }],
    });
    const r = runFinancingEngine(input, makeReference({ products: [product] }));
    expect(r.matches[0]!.status).toBe('appears_outside_published_criteria');
    expect(r.matches[0]!.exclusion_reasons.some((e) => e.code === 'affordable_amount_below_product_minimum')).toBe(true);
  });

  it('carries the bilingual disclaimer on every result', () => {
    const r = runFinancingEngine(makeInput(), makeReference());
    expect(r.disclaimer_ar).toContain('استرشادية');
    expect(r.disclaimer_en).toContain('indicative');
  });
});
