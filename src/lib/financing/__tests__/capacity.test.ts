import { describe, it, expect } from 'vitest';
import { calculateCapacity, calculateObligations, calculateQualifyingIncome, selectDbrBand } from '../capacity';
import { DBR_PAYLOAD, makeApplicant, makeRuleSet } from './fixtures';
import type { IncomeInput, ObligationInput, RuleSet, SupportInput } from '../types';

const UNSUPPORTED: SupportInput = {
  is_first_home: true,
  sakani_eligible: false,
  redf_eligible: false,
  support_status: 'unknown',
  monthly_support_amount: null,
  support_duration_months: null,
  financing_kind: 'unsupported',
  previously_used_first_home_tax_support: false,
};

function salary(amount: number, verified = true): IncomeInput {
  return {
    id: 'inc-salary',
    applicant_role: 'primary',
    income_type: 'basic_salary',
    declared_monthly_amount: amount,
    verified_monthly_amount: verified ? amount : null,
    documentation_status: verified ? 'payslip' : 'self_declared',
    frequency: 'monthly',
    averaging_period_months: null,
    is_fixed: true,
  };
}

describe('selectDbrBand — SAMA Arts. 15/16/17 boundaries', () => {
  it('puts SAR 15,000 in the LOWEST band (Art. 15 is "15,000 and less")', () => {
    expect(selectDbrBand(DBR_PAYLOAD.bands, 15000)?.total_obligations_pct).toBe(55);
  });

  it('puts SAR 20,000 in the middle band', () => {
    expect(selectDbrBand(DBR_PAYLOAD.bands, 20000)?.total_obligations_pct).toBe(65);
  });

  it('puts SAR 25,000 in the top band, which defers to the creditor', () => {
    const band = selectDbrBand(DBR_PAYLOAD.bands, 25000);
    expect(band?.real_estate_per_creditor_policy).toBe(true);
    expect(band?.total_obligations_pct).toBeNull();
  });

  it('handles a zero income', () => {
    expect(selectDbrBand(DBR_PAYLOAD.bands, 0)?.total_obligations_pct).toBe(55);
  });
});

describe('calculateQualifyingIncome — SAMA Art. 14', () => {
  const rules = makeRuleSet();

  it('counts gross salary in full', () => {
    const r = calculateQualifyingIncome([salary(20000)], rules, UNSUPPORTED, []);
    expect(r.qualifying_total).toBe(20000);
    expect(r.primary_gross_salary).toBe(20000);
  });

  it('counts documented other periodic income at HALF', () => {
    const rental: IncomeInput = {
      id: 'inc-rent', applicant_role: 'primary', income_type: 'rental',
      declared_monthly_amount: 4000, verified_monthly_amount: 4000,
      documentation_status: 'bank_statement', frequency: 'monthly',
      averaging_period_months: 24, is_fixed: false,
    };
    const r = calculateQualifyingIncome([salary(20000), rental], rules, UNSUPPORTED, []);
    expect(r.declared_total).toBe(24000);
    expect(r.qualifying_total).toBe(22000); // 20,000 + 50% of 4,000
  });

  it('EXCLUDES other income without the two-year documented history', () => {
    const rental: IncomeInput = {
      id: 'inc-rent', applicant_role: 'primary', income_type: 'rental',
      declared_monthly_amount: 4000, verified_monthly_amount: null,
      documentation_status: 'self_declared', frequency: 'monthly',
      averaging_period_months: 6, is_fixed: false,
    };
    const r = calculateQualifyingIncome([salary(20000), rental], rules, UNSUPPORTED, []);
    expect(r.qualifying_total).toBe(20000);
    expect(r.lines.find((l) => l.income_id === 'inc-rent')?.exclusion_reason).toContain('documentary evidence');
  });

  it('EXCLUDES a general government subsidy', () => {
    const subsidy: IncomeInput = {
      id: 'inc-sub', applicant_role: 'primary', income_type: 'government_support',
      declared_monthly_amount: 2000, verified_monthly_amount: 2000,
      documentation_status: 'contract', frequency: 'monthly',
      averaging_period_months: null, is_fixed: true,
    };
    const r = calculateQualifyingIncome([salary(20000), subsidy], rules, UNSUPPORTED, []);
    expect(r.qualifying_total).toBe(20000);
  });

  it('INCLUDES REDF/Sakani housing support in a real-estate product (Art. 14c exception)', () => {
    const subsidy: IncomeInput = {
      id: 'inc-sub', applicant_role: 'primary', income_type: 'government_support',
      declared_monthly_amount: 2000, verified_monthly_amount: 2000,
      documentation_status: 'contract', frequency: 'monthly',
      averaging_period_months: null, is_fixed: true,
    };
    const supported: SupportInput = { ...UNSUPPORTED, redf_eligible: true, financing_kind: 'supported', support_status: 'confirmed' };
    const r = calculateQualifyingIncome([salary(20000), subsidy], rules, supported, []);
    expect(r.qualifying_total).toBe(22000);
  });

  it('normalises an annual figure to monthly', () => {
    const bonus: IncomeInput = {
      id: 'inc-bonus', applicant_role: 'primary', income_type: 'bonus',
      declared_monthly_amount: 120000, verified_monthly_amount: 120000,
      documentation_status: 'bank_statement', frequency: 'annual',
      averaging_period_months: 24, is_fixed: false,
    };
    const r = calculateQualifyingIncome([bonus], rules, UNSUPPORTED, []);
    // 120,000/yr = 10,000/mo, counted at 50% = 5,000
    expect(r.qualifying_total).toBe(5000);
  });

  it('keeps declared / verified / qualifying as THREE distinct numbers', () => {
    const r = calculateQualifyingIncome([salary(20000, false)], rules, UNSUPPORTED, []);
    expect(r.declared_total).toBe(20000);
    expect(r.verified_total).toBe(0);
    expect(r.qualifying_total).toBe(20000);
  });

  it('reports a blocking gap rather than guessing when the rule is missing', () => {
    const missing: Array<{ impact: string }> = [];
    const noRule = makeRuleSet({ qualifying_income: null }) as RuleSet;
    const r = calculateQualifyingIncome([salary(20000)], noRule, UNSUPPORTED, missing as never);
    expect(r.qualifying_total).toBe(0);
    expect(missing.some((m) => m.impact === 'blocks_calculation')).toBe(true);
  });

  it('co-borrower salary counts toward qualifying income but NOT the primary gross salary base', () => {
    const co: IncomeInput = { ...salary(8000), id: 'inc-co', applicant_role: 'co_borrower' };
    const r = calculateQualifyingIncome([salary(20000), co], makeRuleSet(), UNSUPPORTED, []);
    expect(r.qualifying_total).toBe(28000);
    // The salary-deduction ceiling is a % of the PRIMARY's gross salary.
    expect(r.primary_gross_salary).toBe(20000);
  });
});

describe('calculateObligations — SAMA Art. 13', () => {
  const rules = makeRuleSet();

  it('charges a credit card at a % of its CEILING, not its balance', () => {
    const card: ObligationInput = {
      id: 'ob-card', obligation_type: 'credit_card', monthly_payment: null,
      outstanding_balance: 0, remaining_months: null, end_date: null,
      card_limit: 50000, minimum_payment: null, balloon_payment: null,
      will_be_settled_before_financing: false, is_real_estate: false,
    };
    const r = calculateObligations([card], rules, '2026-08-01', []);
    // 5% of the 50,000 LIMIT = 2,500 — even with a zero balance.
    expect(r.total_monthly).toBe(2500);
    expect(r.lines[0]!.basis).toBe('rlp_art_13a_minimum_repayment_of_ceiling');
  });

  it('averages an uneven obligation including its balloon (Art. 13e)', () => {
    const auto: ObligationInput = {
      id: 'ob-auto', obligation_type: 'auto_lease', monthly_payment: 2000,
      outstanding_balance: null, remaining_months: 24, end_date: null,
      card_limit: null, minimum_payment: null, balloon_payment: 24000,
      will_be_settled_before_financing: false, is_real_estate: false,
    };
    const r = calculateObligations([auto], rules, '2026-08-01', []);
    // (2,000 × 24 + 24,000) / 24 = 3,000
    expect(r.total_monthly).toBe(3000);
  });

  it('separates real-estate from non-real-estate obligations', () => {
    const mortgage: ObligationInput = {
      id: 'ob-m', obligation_type: 'mortgage', monthly_payment: 5000,
      outstanding_balance: null, remaining_months: null, end_date: null,
      card_limit: null, minimum_payment: null, balloon_payment: null,
      will_be_settled_before_financing: false, is_real_estate: true,
    };
    const personal: ObligationInput = { ...mortgage, id: 'ob-p', obligation_type: 'personal_finance', monthly_payment: 1500, is_real_estate: false };
    const r = calculateObligations([mortgage, personal], rules, '2026-08-01', []);
    expect(r.real_estate_monthly).toBe(5000);
    expect(r.non_real_estate_monthly).toBe(1500);
    expect(r.total_monthly).toBe(6500);
  });

  it('excludes an obligation that ends before financing starts — but REPORTS it', () => {
    const ending: ObligationInput = {
      id: 'ob-end', obligation_type: 'personal_finance', monthly_payment: 3000,
      outstanding_balance: null, remaining_months: 2, end_date: '2026-06-01',
      card_limit: null, minimum_payment: null, balloon_payment: null,
      will_be_settled_before_financing: false, is_real_estate: false,
    };
    const r = calculateObligations([ending], rules, '2026-08-01', []);
    expect(r.total_monthly).toBe(0);
    // Never silently dropped: it appears with an explicit reason.
    expect(r.expiring_monthly).toBe(3000);
    expect(r.lines[0]!.excluded).toBe(true);
    expect(r.lines[0]!.exclusion_reason).toContain('Ends before');
  });

  it('flags a card whose limit is unknown instead of charging zero', () => {
    const missing: Array<{ code: string }> = [];
    const card: ObligationInput = {
      id: 'ob-card', obligation_type: 'credit_card', monthly_payment: 500,
      outstanding_balance: null, remaining_months: null, end_date: null,
      card_limit: null, minimum_payment: 500, balloon_payment: null,
      will_be_settled_before_financing: false, is_real_estate: false,
    };
    const r = calculateObligations([card], rules, '2026-08-01', missing as never);
    expect(r.total_monthly).toBe(500);
    expect(missing.some((m) => m.code.startsWith('card_limit_missing'))).toBe(true);
  });
});

describe('calculateCapacity — every ceiling evaluated, most restrictive wins', () => {
  const common = {
    applicants: [makeApplicant()],
    support: UNSUPPORTED,
    rules: makeRuleSet(),
    plannedStartDate: '2026-08-01',
    maxAcceptableInstallment: null,
  };

  it('low-income unsupported customer is bound by the 55% total ceiling', () => {
    const r = calculateCapacity({ ...common, incomes: [salary(10000)], obligations: [] });
    const total = r.ceilings.find((c) => c.code === 'total_obligations')!;
    expect(total.pct).toBe(55);
    // Salary deduction (33.33% of 10,000 = 3,333) is TIGHTER than 55% (5,500),
    // so it must be the binding one.
    expect(r.binding_constraint).toBe('salary_deduction');
    expect(r.max_installment).toBeCloseTo(3333, 0);
  });

  it('a SUPPORTED low-income customer gets the 65% ceiling instead of 55%', () => {
    const supported: SupportInput = { ...UNSUPPORTED, redf_eligible: true, financing_kind: 'supported' };
    const r = calculateCapacity({ ...common, support: supported, incomes: [salary(10000)], obligations: [] });
    expect(r.ceilings.find((c) => c.code === 'total_obligations')!.pct).toBe(65);
  });

  it('a RETIREE is held to 25% rather than 33.33%', () => {
    const r = calculateCapacity({
      ...common,
      applicants: [makeApplicant({ employment_type: 'retiree' })],
      incomes: [salary(10000)],
      obligations: [],
    });
    const deduction = r.ceilings.find((c) => c.code === 'salary_deduction')!;
    expect(deduction.pct).toBe(25);
    expect(deduction.label_en).toContain('Pension');
  });

  it('a high-income customer DEFERS to the creditor rather than getting an invented ratio', () => {
    const r = calculateCapacity({ ...common, incomes: [salary(40000)], obligations: [] });
    expect(r.ceilings.some((c) => c.defers_to_creditor)).toBe(true);
    expect(r.assumptions.some((a) => a.code === 'high_income_creditor_policy')).toBe(true);
  });

  it('existing obligations reduce the available room', () => {
    const ob: ObligationInput = {
      id: 'ob-1', obligation_type: 'personal_finance', monthly_payment: 2000,
      outstanding_balance: null, remaining_months: null, end_date: null,
      card_limit: null, minimum_payment: null, balloon_payment: null,
      will_be_settled_before_financing: false, is_real_estate: false,
    };
    const without = calculateCapacity({ ...common, incomes: [salary(20000)], obligations: [] });
    const withOb = calculateCapacity({ ...common, incomes: [salary(20000)], obligations: [ob] });
    expect(withOb.max_installment!).toBeLessThan(without.max_installment!);
    expect(withOb.capacity_reducers.some((c) => c.code === 'existing_obligations')).toBe(true);
  });

  it('the customer’s own stated maximum can be the binding constraint', () => {
    const r = calculateCapacity({ ...common, incomes: [salary(20000)], obligations: [], maxAcceptableInstallment: 2000 });
    expect(r.binding_constraint).toBe('customer_preference');
    expect(r.max_installment).toBe(2000);
  });

  it('produces the SECOND scenario for an obligation that expires later', () => {
    const expiring: ObligationInput = {
      id: 'ob-exp', obligation_type: 'auto_finance', monthly_payment: 2500,
      outstanding_balance: null, remaining_months: 8, end_date: '2027-04-01',
      card_limit: null, minimum_payment: null, balloon_payment: null,
      will_be_settled_before_financing: false, is_real_estate: false,
    };
    const r = calculateCapacity({ ...common, incomes: [salary(20000)], obligations: [expiring] });
    // Counted today...
    expect(r.obligations.total_monthly).toBe(2500);
    // ...AND a second scenario showing capacity once it ends.
    expect(r.after_expiry).not.toBeNull();
    expect(r.after_expiry!.max_installment!).toBeGreaterThan(r.max_installment!);
    expect(r.after_expiry!.earliest_expiry_date).toBe('2027-04-01');
  });

  it('flags when non-real-estate debt already exceeds its 45% ceiling', () => {
    const heavy: ObligationInput = {
      id: 'ob-heavy', obligation_type: 'personal_finance', monthly_payment: 6000,
      outstanding_balance: null, remaining_months: null, end_date: null,
      card_limit: null, minimum_payment: null, balloon_payment: null,
      will_be_settled_before_financing: false, is_real_estate: false,
    };
    const r = calculateCapacity({ ...common, incomes: [salary(10000)], obligations: [heavy] });
    expect(r.capacity_reducers.some((c) => c.code === 'non_real_estate_over_ceiling')).toBe(true);
  });

  it('reports current DBR', () => {
    const ob: ObligationInput = {
      id: 'ob-1', obligation_type: 'personal_finance', monthly_payment: 2000,
      outstanding_balance: null, remaining_months: null, end_date: null,
      card_limit: null, minimum_payment: null, balloon_payment: null,
      will_be_settled_before_financing: false, is_real_estate: false,
    };
    const r = calculateCapacity({ ...common, incomes: [salary(20000)], obligations: [ob] });
    expect(r.current_dbr_pct).toBe(10);
  });

  it('never returns a negative available amount', () => {
    const crushing: ObligationInput = {
      id: 'ob-x', obligation_type: 'personal_finance', monthly_payment: 50000,
      outstanding_balance: null, remaining_months: null, end_date: null,
      card_limit: null, minimum_payment: null, balloon_payment: null,
      will_be_settled_before_financing: false, is_real_estate: false,
    };
    const r = calculateCapacity({ ...common, incomes: [salary(10000)], obligations: [crushing] });
    expect(r.max_installment).toBe(0);
  });
});
