/**
 * Financing V2 — the focused suite.
 *
 * One file, covering exactly the behaviours the spec names. V1 had 160 tests,
 * many of them for balloon / step-up / staged / IRR machinery that no longer
 * exists. Testing removed code is worse than not testing it: it implies support.
 */
import { describe, it, expect } from 'vitest';
import { calculateCapacity, existingObligations, qualifyingIncome, selectBand } from '../capacity';
import { monthlyPayment, principalFromPayment, upfrontCash } from '../payment';
import { isRateStale, matchProduct, regulatoryLtv, resolveRate } from '../matching';
import { runFinancing } from '../engine';
import type { FinancingInput, FinancingProduct, Note, RuleSet } from '../types';

// ── Fixtures: the values actually stored in `financing_rules` ──────────────
const RULES: RuleSet = {
  dbr: {
    source_url: 'https://rulebook.sama.gov.sa/x', effective_from: '2018-05-17',
    bands: [
      { income_from: 0, income_to: 15000.01, salary_deduction_employee_pct: 33.33, salary_deduction_retiree_pct: 25, excluding_real_estate_pct: 45, total_obligations_pct: 55, total_obligations_supported_pct: 65, real_estate_per_creditor_policy: false },
      { income_from: 15000.01, income_to: 25000, salary_deduction_employee_pct: 33.33, salary_deduction_retiree_pct: 25, excluding_real_estate_pct: 45, total_obligations_pct: 65, total_obligations_supported_pct: 65, real_estate_per_creditor_policy: false },
      { income_from: 25000, income_to: null, salary_deduction_employee_pct: 33.33, salary_deduction_retiree_pct: 25, excluding_real_estate_pct: null, total_obligations_pct: null, total_obligations_supported_pct: null, real_estate_per_creditor_policy: true },
    ],
  },
  income: { gross_salary_pct: 100, other_periodic_income_pct: 50, source_url: 'https://x', effective_from: '2018-05-17' },
  credit_card: { minimum_repayment_pct: 5, source_url: 'https://x', effective_from: '2018-05-17' },
  ltv: {
    bank_first_home_pct: 90, bank_additional_home_pct: 70,
    finance_company_first_home_pct: 90, finance_company_additional_home_pct: 85,
    first_home_citizens_only: true, source_url: 'https://x', effective_from: '2018-01-14',
  },
  rett: { rate_pct: 5, first_home_relief_cap: 1_000_000, source_url: 'https://x', effective_from: '2025-04-09' },
  support: { housing_support_counts_as_income: true, source_url: 'https://x', effective_from: '2018-05-17' },
};

function input(over: Partial<FinancingInput> = {}): FinancingInput {
  return {
    as_of_date: '2026-08-30',
    nationality: 'saudi', date_of_birth: '1990-01-15', age: null,
    employment_type: 'employee', employment_sector: 'private', employer_name: null,
    willing_to_transfer_salary: true,
    gross_monthly_salary: 20000, other_income: [], obligations: [],
    is_first_home: true, sakani_redf_status: 'unknown', confirmed_support_amount: null,
    property_price: 1_000_000, property_type: 'apartment', project_record_id: null, unit_record_id: null,
    available_down_payment: 200_000, term_months: 240,
    preferred_provider_keys: null, max_comfortable_installment: null,
    quoted_rate_pct: null, quoted_rate_provider_key: null,
    ...over,
  };
}

function product(over: Partial<FinancingProduct> = {}): FinancingProduct {
  return {
    id: 'p1', provider_key: 'testbank', provider_name_ar: 'بنك', provider_name_en: 'Test Bank',
    provider_type: 'bank', product_key: 'home', name_ar: 'تمويل', name_en: 'Home Finance',
    supported_financing: 'both', property_types: null, nationality: ['saudi', 'resident'],
    employment_sectors: null, employment_types: null,
    min_salary: 5000, min_salary_no_transfer: null, min_age: 18, max_age_at_maturity: 70,
    requires_salary_transfer: false, first_home_applicable: true, additional_home_applicable: true,
    min_down_payment_pct: null, max_ltv_pct: null, max_term_months: 360, max_amount: 5_000_000,
    criteria: {}, official_url: 'https://bank.sa', last_verified_at: '2026-08-25',
    notes: null, confidence: 'high',
    rate: {
      id: 'r1', disclosure_type: 'exact_rate', rate_type: 'fixed',
      contractual_rate_pct: 5, published_apr_pct: null, starting_apr_pct: null, example: null,
      effective_from: '2026-01-01', expires_at: null, source_url: 'https://bank.sa/rates',
      last_verified_at: '2026-08-25', confidence: 'high', marked_stale: false, notes: null,
    },
    ...over,
  };
}

// ── Income qualification ───────────────────────────────────────────────────
describe('income qualification', () => {
  it('counts gross salary in full', () => {
    const r = qualifyingIncome(input(), RULES, []);
    expect(r.qualifying).toBe(20000);
  });

  it('counts VERIFIED other income at half', () => {
    const r = qualifyingIncome(input({ other_income: [{ kind: 'other', monthly_amount: 4000, verified: true }] }), RULES, []);
    expect(r.declared).toBe(24000);
    expect(r.qualifying).toBe(22000);
  });

  it('counts UNVERIFIED other income as zero, not a reduced share', () => {
    const missing: Note[] = [];
    const r = qualifyingIncome(input({ other_income: [{ kind: 'other', monthly_amount: 4000, verified: false }] }), RULES, missing);
    expect(r.qualifying).toBe(20000);
    expect(missing.some((m) => m.code === 'unverified_other_income')).toBe(true);
  });

  it('counts CONFIRMED housing support as income', () => {
    const r = qualifyingIncome(input({ sakani_redf_status: 'confirmed', confirmed_support_amount: 2000 }), RULES, []);
    expect(r.qualifying).toBe(22000);
  });

  it('does NOT count self-declared housing support', () => {
    const missing: Note[] = [];
    const r = qualifyingIncome(input({ sakani_redf_status: 'self_declared', confirmed_support_amount: 2000 }), RULES, missing);
    expect(r.qualifying).toBe(20000);
    expect(missing.some((m) => m.code === 'support_not_confirmed')).toBe(true);
  });

  it('reports a missing salary rather than assuming zero silently', () => {
    const missing: Note[] = [];
    qualifyingIncome(input({ gross_monthly_salary: null }), RULES, missing);
    expect(missing.some((m) => m.code === 'no_salary')).toBe(true);
  });
});

// ── Existing obligations ───────────────────────────────────────────────────
describe('existing obligations', () => {
  it('charges a credit card on its LIMIT, not its balance', () => {
    const r = existingObligations(input({ obligations: [{ kind: 'credit_card', card_limit: 50_000 }] }), RULES, []);
    expect(r.total).toBe(2500); // 5% of the ceiling
  });

  it('sums ordinary instalments', () => {
    const r = existingObligations(input({ obligations: [{ kind: 'other', monthly_payment: 1800 }, { kind: 'other', monthly_payment: 700 }] }), RULES, []);
    expect(r.total).toBe(2500);
  });

  it('flags a card with no limit instead of silently charging zero', () => {
    const missing: Note[] = [];
    const r = existingObligations(input({ obligations: [{ kind: 'credit_card', monthly_payment: 500 }] }), RULES, missing);
    expect(r.total).toBe(500);
    expect(missing.some((m) => m.code === 'card_limit_missing')).toBe(true);
  });
});

// ── SAMA DBR limits ────────────────────────────────────────────────────────
describe('SAMA DBR limits', () => {
  it('puts SAR 15,000 in the lowest band (Art. 15 is "15,000 and less")', () => {
    expect(selectBand(RULES.dbr!.bands, 15000)?.total_obligations_pct).toBe(55);
  });

  it('puts SAR 20,000 in the middle band', () => {
    expect(selectBand(RULES.dbr!.bands, 20000)?.total_obligations_pct).toBe(65);
  });

  it('a supported low-income customer gets 65% instead of 55%', () => {
    const cap = calculateCapacity(input({ gross_monthly_salary: 10000, sakani_redf_status: 'confirmed' }), RULES, [], []);
    expect(cap.ceilings.find((c) => c.code === 'total_obligations')?.pct).toBe(65);
  });

  it('income >= 25,000 defers to the bank rather than inventing a ratio', () => {
    const cap = calculateCapacity(input({ gross_monthly_salary: 40000 }), RULES, [], []);
    expect(cap.ceilings.some((c) => c.defers_to_bank)).toBe(true);
  });

  it('the most restrictive ceiling binds', () => {
    // 10,000 income: deduction 33.33% = 3,333 beats total 55% = 5,500.
    const cap = calculateCapacity(input({ gross_monthly_salary: 10000 }), RULES, [], []);
    expect(cap.binding_constraint).toBe('salary_deduction');
    expect(cap.max_installment).toBeCloseTo(3333, 0);
  });

  it('existing obligations reduce available capacity', () => {
    const withOb = calculateCapacity(input({ obligations: [{ kind: 'other', monthly_payment: 2000 }] }), RULES, [], []);
    const without = calculateCapacity(input(), RULES, [], []);
    expect(withOb.max_installment!).toBeLessThan(without.max_installment!);
  });

  it('the customer’s own stated maximum can bind', () => {
    const cap = calculateCapacity(input({ max_comfortable_installment: 2000 }), RULES, [], []);
    expect(cap.binding_constraint).toBe('customer_preference');
    expect(cap.max_installment).toBe(2000);
  });

  it('never returns a negative capacity', () => {
    const cap = calculateCapacity(input({ gross_monthly_salary: 10000, obligations: [{ kind: 'other', monthly_payment: 50_000 }] }), RULES, [], []);
    expect(cap.max_installment).toBe(0);
  });
});

// ── Employee vs retiree ────────────────────────────────────────────────────
describe('employee and retiree deduction limits', () => {
  it('an employee is held to 33.33% of gross salary', () => {
    const cap = calculateCapacity(input({ gross_monthly_salary: 10000 }), RULES, [], []);
    expect(cap.ceilings.find((c) => c.code === 'salary_deduction')?.pct).toBe(33.33);
  });

  it('a retiree is held to 25%', () => {
    const cap = calculateCapacity(input({ gross_monthly_salary: 10000, employment_type: 'retiree' }), RULES, [], []);
    const d = cap.ceilings.find((c) => c.code === 'salary_deduction');
    expect(d?.pct).toBe(25);
    expect(d?.ceiling_amount).toBe(2500);
  });
});

// ── LTV ────────────────────────────────────────────────────────────────────
describe('LTV ceilings', () => {
  it('bank + first home + Saudi = 90%', () => {
    expect(regulatoryLtv(product(), input(), RULES).pct).toBe(90);
  });

  it('bank + additional home = 70%', () => {
    expect(regulatoryLtv(product(), input({ is_first_home: false }), RULES).pct).toBe(70);
  });

  it('finance company + additional home = 85%, not the bank’s 70%', () => {
    expect(regulatoryLtv(product({ provider_type: 'real_estate_finance_company' }), input({ is_first_home: false }), RULES).pct).toBe(85);
  });

  it('a resident cannot have the citizens-only 90% cell', () => {
    const r = regulatoryLtv(product(), input({ nationality: 'resident' }), RULES);
    expect(r.pct).toBe(70);
    expect(r.note?.code).toBe('first_home_citizens_only');
  });

  it('unknown first-home status falls to the conservative ceiling and says so', () => {
    const r = regulatoryLtv(product(), input({ is_first_home: null }), RULES);
    expect(r.pct).toBe(70);
    expect(r.note?.code).toBe('first_home_unknown');
  });
});

// ── Down payment and upfront cash ──────────────────────────────────────────
describe('the shortfall a rep would otherwise have to infer', () => {
  it('flags when the cash needed exceeds what the customer said they have', () => {
    // Capacity-limited financing on an expensive property implies a down payment
    // far above the stated cash. Reporting the big number without the gap is the
    // bug this guards.
    const r = runFinancing(
      { ...input(), gross_monthly_salary: 18_000, property_price: 1_200_000, available_down_payment: 250_000 },
      [product()],
      RULES,
    );
    const m = r.matches[0];
    expect(m.upfront_cash).not.toBeNull();
    expect(m.cash_shortfall).not.toBeNull();
    expect(m.cash_shortfall!).toBeGreaterThan(0);
    expect(m.unknowns.some((u) => u.code === 'cash_shortfall')).toBe(true);
  });

  it('reports no shortfall when the customer has enough', () => {
    const r = runFinancing(
      { ...input(), gross_monthly_salary: 40_000, property_price: 400_000, available_down_payment: 400_000 },
      [product()],
      RULES,
    );
    expect(r.matches[0].cash_shortfall).toBe(0);
    expect(r.matches[0].unknowns.some((u) => u.code === 'cash_shortfall')).toBe(false);
  });

  it('marks an unpriced product financing amount as NOT capacity-tested', () => {
    // Without a rate there is no way to convert a monthly ceiling into a
    // principal, so the amount reflects only down payment and LTV. Saying so
    // stops a rep comparing it like-for-like against a priced product.
    const r = runFinancing(
      { ...input(), gross_monthly_salary: 8_000, property_price: 1_200_000, available_down_payment: 250_000 },
      [product({ rate: null })],
      RULES,
    );
    const m = r.matches[0];
    expect(m.monthly_payment).toBeNull();
    expect(m.financing_not_capacity_tested).toBe(true);
    expect(m.unknowns.some((u) => u.code === 'financing_not_capacity_tested')).toBe(true);
  });

  it('a priced product IS capacity-tested', () => {
    const r = runFinancing(
      { ...input(), gross_monthly_salary: 18_000, property_price: 1_200_000, available_down_payment: 250_000 },
      [product()],
      RULES,
    );
    expect(r.matches[0].financing_not_capacity_tested).toBe(false);
  });
});

describe('down payment and upfront cash', () => {
  it('down payment is price minus financing', () => {
    const u = upfrontCash({ propertyPrice: 1_000_000, financingAmount: 900_000, availableCash: 200_000, isFirstHome: false, rett: null });
    expect(u.down_payment).toBe(100_000);
  });

  it('applies first-home RETT relief up to the cap', () => {
    const u = upfrontCash({ propertyPrice: 1_000_000, financingAmount: 900_000, availableCash: null, isFirstHome: true, rett: RULES.rett });
    expect(u.transaction_tax).toBe(50_000);
    expect(u.tax_relief).toBe(50_000);
    expect(u.total).toBe(100_000);
  });

  it('relieves only the capped portion above SAR 1,000,000', () => {
    const u = upfrontCash({ propertyPrice: 1_500_000, financingAmount: 1_350_000, availableCash: null, isFirstHome: true, rett: RULES.rett });
    expect(u.transaction_tax).toBe(75_000);
    expect(u.tax_relief).toBe(50_000);
  });

  it('reports a shortfall against available cash', () => {
    const u = upfrontCash({ propertyPrice: 1_000_000, financingAmount: 700_000, availableCash: 100_000, isFirstHome: false, rett: null });
    expect(u.shortfall).toBe(200_000);
  });

  it('leaves shortfall null when available cash is unknown', () => {
    const u = upfrontCash({ propertyPrice: 1_000_000, financingAmount: 900_000, availableCash: null, isFirstHome: false, rett: null });
    expect(u.shortfall).toBeNull();
  });
});

// ── Fixed-rate payment + reverse principal ─────────────────────────────────
describe('fixed-rate payment', () => {
  it('matches the closed-form annuity', () => {
    expect(monthlyPayment(500_000, 5, 240)).toBeCloseTo(3299.78, 2);
  });

  it('handles a 0% product without dividing by zero', () => {
    // Real: Bank Albilad publishes 0% on the subsidised tier.
    expect(monthlyPayment(600_000, 0, 300)).toBe(2000);
  });

  it('is monotonic in rate and term', () => {
    expect(monthlyPayment(500_000, 6, 240)).toBeGreaterThan(monthlyPayment(500_000, 5, 240));
    expect(monthlyPayment(500_000, 5, 180)).toBeGreaterThan(monthlyPayment(500_000, 5, 360));
  });

  it('reverse principal round-trips to within a riyal', () => {
    const pay = monthlyPayment(750_000, 4.5, 300);
    expect(Math.abs(principalFromPayment(pay, 4.5, 300) - 750_000)).toBeLessThan(1);
  });

  it('reverse principal round-trips at 0%', () => {
    expect(principalFromPayment(monthlyPayment(600_000, 0, 300), 0, 300)).toBeCloseTo(600_000, 2);
  });
});

// ── Rate behaviour: the honesty safeguards ─────────────────────────────────
describe('rate resolution', () => {
  it('an exact contractual rate prices the product', () => {
    const r = resolveRate(product(), input());
    expect(r.basis).toBe('contractual');
    expect(r.rate_pct).toBe(5);
  });

  it('a "starting from" APR yields NO rate and says an exact payment needs a quotation', () => {
    const p = product({ rate: { ...product().rate!, disclosure_type: 'starting_from', contractual_rate_pct: null, starting_apr_pct: 5.96 } });
    const r = resolveRate(p, input());
    expect(r.rate_pct).toBeNull();
    expect(r.basis).toBe('starting_from');
    expect(r.note?.en).toContain('bank quotation');
  });

  it('a representative example yields NO rate', () => {
    const p = product({ rate: { ...product().rate!, disclosure_type: 'representative_example', contractual_rate_pct: null, published_apr_pct: 6.9, example: { property_price: 850_000, term_months: 300, ltv_pct: 90 } } });
    const r = resolveRate(p, input());
    expect(r.rate_pct).toBeNull();
    expect(r.basis).toBe('example');
  });

  it('a missing rate yields NO rate', () => {
    expect(resolveRate(product({ rate: null }), input()).rate_pct).toBeNull();
  });

  it('a rep-entered quotation for THAT provider prices the product', () => {
    const p = product({ rate: { ...product().rate!, disclosure_type: 'starting_from', contractual_rate_pct: null } });
    const r = resolveRate(p, input({ quoted_rate_pct: 6.4, quoted_rate_provider_key: 'testbank' }));
    expect(r.basis).toBe('quotation');
    expect(r.rate_pct).toBe(6.4);
  });

  it('a quotation for a DIFFERENT provider does not leak across', () => {
    const p = product({ rate: { ...product().rate!, disclosure_type: 'starting_from', contractual_rate_pct: null } });
    expect(resolveRate(p, input({ quoted_rate_pct: 6.4, quoted_rate_provider_key: 'otherbank' })).basis).toBe('starting_from');
  });

  it('detects a stale rate by age and by explicit mark', () => {
    expect(isRateStale(product({ rate: { ...product().rate!, last_verified_at: '2026-01-01' } }), '2026-08-30')).toBe(true);
    expect(isRateStale(product({ rate: { ...product().rate!, marked_stale: true } }), '2026-08-30')).toBe(true);
    expect(isRateStale(product(), '2026-08-30')).toBe(false);
  });
});

// ── Product matching ───────────────────────────────────────────────────────
describe('product matching', () => {
  const cap = calculateCapacity(input(), RULES, [], []);

  it('a clean profile meets published criteria — and never says "approved"', () => {
    const m = matchProduct(product(), input(), RULES, cap);
    expect(m.status).toBe('meets_published_criteria');
    expect(JSON.stringify(m)).not.toContain('approved');
  });

  it('below the minimum salary does not meet published criteria', () => {
    const m = matchProduct(product({ min_salary: 30_000 }), input(), RULES, cap);
    expect(m.status).toBe('does_not_meet_published_criteria');
    expect(m.reasons.some((r) => r.code === 'below_min_salary')).toBe(true);
  });

  it('uses the no-transfer threshold when the customer declines transfer', () => {
    const m = matchProduct(product({ min_salary: 7000, min_salary_no_transfer: 25_000 }), input({ willing_to_transfer_salary: false }), RULES, cap);
    expect(m.status).toBe('does_not_meet_published_criteria');
  });

  it('a mandatory salary transfer the customer declined excludes the product', () => {
    const m = matchProduct(product({ requires_salary_transfer: true }), input({ willing_to_transfer_salary: false }), RULES, cap);
    expect(m.reasons.some((r) => r.code === 'transfer_required')).toBe(true);
  });

  it('age at maturity beyond the limit excludes the product', () => {
    const m = matchProduct(product({ max_age_at_maturity: 60 }), input({ term_months: 360 }), RULES, cap);
    expect(m.reasons.some((r) => r.code === 'age_at_maturity')).toBe(true);
  });

  it('a product with no published rate reports pricing_unavailable and NO payment', () => {
    const m = matchProduct(product({ rate: null }), input(), RULES, cap);
    expect(m.status).toBe('pricing_unavailable');
    expect(m.monthly_payment).toBeNull();
  });

  it('a stale rate reports rate_stale', () => {
    const m = matchProduct(product({ rate: { ...product().rate!, last_verified_at: '2026-01-01' } }), input(), RULES, cap);
    expect(m.status).toBe('rate_stale');
  });

  it('prices an exact-rate product and shows its source and verification date', () => {
    const m = matchProduct(product(), input(), RULES, cap);
    expect(m.monthly_payment).toBeGreaterThan(0);
    expect(m.rate_source_url).toBe('https://bank.sa/rates');
    expect(m.rate_verified_at).toBe('2026-08-25');
  });

  it('never prices from a starting-from figure', () => {
    const p = product({ rate: { ...product().rate!, disclosure_type: 'starting_from', contractual_rate_pct: null, starting_apr_pct: 5.96 } });
    const m = matchProduct(p, input(), RULES, cap);
    expect(m.monthly_payment).toBeNull();
    expect(m.rate_basis).toBe('starting_from');
  });
});

// ── Unknown criteria ───────────────────────────────────────────────────────
describe('unknown criteria produce requires_bank_review', () => {
  const cap = calculateCapacity(input(), RULES, [], []);

  it('unpublished nationality criteria', () => {
    const m = matchProduct(product({ nationality: null }), input(), RULES, cap);
    expect(m.status).toBe('requires_bank_review');
    expect(m.unknowns.some((u) => u.code === 'nationality_unpublished')).toBe(true);
  });

  it('an approved-employer requirement always needs a human', () => {
    const m = matchProduct(product({ criteria: { requires_approved_employer: true } }), input(), RULES, cap);
    expect(m.status).toBe('requires_bank_review');
    expect(m.unknowns.some((u) => u.code === 'approved_employer')).toBe(true);
  });

  it('an attached project means project approval is unverified', () => {
    const m = matchProduct(product(), input({ project_record_id: 'proj-1' }), RULES, cap);
    expect(m.unknowns.some((u) => u.code === 'project_approval')).toBe(true);
  });

  it('an unstated salary is unknown, not a fail', () => {
    const m = matchProduct(product(), input({ gross_monthly_salary: null }), RULES, cap);
    expect(m.status).not.toBe('does_not_meet_published_criteria');
    expect(m.unknowns.some((u) => u.code === 'salary_unknown')).toBe(true);
  });
});

// ── Engine end-to-end ──────────────────────────────────────────────────────
describe('runFinancing', () => {
  it('produces figures and a disclaimer for a clean profile', () => {
    const r = runFinancing(input(), [product()], RULES);
    expect(r.status).toBe('meets_published_criteria');
    expect(r.selected?.monthly_payment).toBeGreaterThan(0);
    expect(r.capacity.max_installment).toBeGreaterThan(0);
    expect(r.disclaimer_en).toContain('not a financing approval');
  });

  it('is deterministic — same inputs, identical output', () => {
    const i = input();
    const p = [product()];
    expect(JSON.stringify(runFinancing(i, p, RULES))).toBe(JSON.stringify(runFinancing(i, p, RULES)));
  });

  it('freezes the rule values used, so a snapshot stays readable', () => {
    const r = runFinancing(input(), [product()], RULES);
    expect(r.rules_used.ltv?.source_url).toBe('https://x');
    expect(r.rules_used.dbr?.effective_from).toBe('2018-05-17');
    expect(r.rules_used.income?.values).toMatchObject({ other_periodic_income_pct: 50 });
  });

  it('an LTV ceiling caps financing below the requested amount', () => {
    const r = runFinancing(input({ is_first_home: false, available_down_payment: null }), [product()], RULES);
    expect(r.selected!.max_ltv_pct).toBe(70);
    expect(r.selected!.financing_amount).toBeLessThanOrEqual(700_000);
  });

  it('returns insufficient_information with no income at all', () => {
    const r = runFinancing(input({ gross_monthly_salary: null }), [product()], RULES);
    expect(r.status).toBe('insufficient_information');
  });

  it('honours a preferred-bank filter', () => {
    const other = product({ id: 'p2', provider_key: 'otherbank', product_key: 'x' });
    const r = runFinancing(input({ preferred_provider_keys: ['testbank'] }), [product(), other], RULES);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.product.provider_key).toBe('testbank');
  });

  it('reports pricing_unavailable when nothing can be priced', () => {
    const r = runFinancing(input(), [product({ rate: null })], RULES);
    expect(r.matches[0]!.status).toBe('pricing_unavailable');
  });
});
