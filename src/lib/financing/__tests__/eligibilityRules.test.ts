import { describe, it, expect } from 'vitest';
import { buildRuleContext, evaluateEligibilityRule, evaluateEligibility } from '../matching';
import { makeApplicant, makeInput, makeProduct } from './fixtures';
import type { EligibilityRuleRef } from '../types';

function rule(overrides: Partial<EligibilityRuleRef> = {}): EligibilityRuleRef {
  return {
    id: 'r1',
    rule_key: 'max_salary_14000',
    label_ar: 'الراتب الشهري ١٤٬٠٠٠ ريال أو أقل',
    label_en: 'Monthly salary must be SAR 14,000 or less',
    operator: 'lte',
    field_path: 'income.primary_gross_salary',
    value_numeric: 14000,
    value_numeric_2: null,
    value_text: null,
    value_list: null,
    value_boolean: null,
    is_hard_requirement: true,
    failure_message_ar: 'هذا المنتج المدعوم مخصص لمن دخلهم ١٤٬٠٠٠ أو أقل',
    failure_message_en: 'This subsidised product is limited to customers earning SAR 14,000 per month or less',
    ...overrides,
  };
}

describe('buildRuleContext', () => {
  it('exposes the primary applicant’s gross salary', () => {
    const ctx = buildRuleContext(makeInput(), makeApplicant());
    expect(ctx['income.primary_gross_salary']).toBe(20000);
  });

  it('reports an absent value as null rather than 0', () => {
    const ctx = buildRuleContext(makeInput({ incomes: [] }), makeApplicant());
    expect(ctx['income.primary_gross_salary']).toBeNull();
  });

  it('exposes property and support facts', () => {
    const ctx = buildRuleContext(makeInput(), makeApplicant());
    expect(ctx['property.price']).toBe(1000000);
    expect(ctx['support.is_first_home']).toBe(true);
  });
});

describe('evaluateEligibilityRule', () => {
  const ctx = buildRuleContext(makeInput(), makeApplicant()); // salary 20,000

  it('a salary CEILING fails a customer above it', () => {
    // The Bank Albilad case: the published criterion is "SAR 14,000 or LESS".
    // Expressing it as min_salary would invert its meaning entirely.
    expect(evaluateEligibilityRule(rule(), ctx)).toBe('fail');
  });

  it('the same ceiling passes a customer below it', () => {
    const lowCtx = buildRuleContext(
      makeInput({
        incomes: [{
          id: 'i', applicant_role: 'primary', income_type: 'basic_salary',
          declared_monthly_amount: 12000, verified_monthly_amount: 12000,
          documentation_status: 'payslip', frequency: 'monthly',
          averaging_period_months: null, is_fixed: true,
        }],
      }),
      makeApplicant(),
    );
    expect(evaluateEligibilityRule(rule(), lowCtx)).toBe('pass');
  });

  it('returns UNKNOWN — not pass, not fail — when the value is absent', () => {
    const emptyCtx = buildRuleContext(makeInput({ incomes: [] }), makeApplicant());
    expect(evaluateEligibilityRule(rule(), emptyCtx)).toBe('unknown');
  });

  it('returns UNKNOWN for a field path the context does not expose', () => {
    // A rule naming a path we do not model must not silently read `undefined`
    // and pass — that is how an unenforced criterion becomes an invisible bug.
    expect(evaluateEligibilityRule(rule({ field_path: 'customer.favourite_colour' }), ctx)).toBe('unknown');
  });

  it('handles gte / gt / lt / between', () => {
    expect(evaluateEligibilityRule(rule({ operator: 'gte', value_numeric: 20000 }), ctx)).toBe('pass');
    expect(evaluateEligibilityRule(rule({ operator: 'gt', value_numeric: 20000 }), ctx)).toBe('fail');
    expect(evaluateEligibilityRule(rule({ operator: 'lt', value_numeric: 25000 }), ctx)).toBe('pass');
    expect(evaluateEligibilityRule(rule({ operator: 'between', value_numeric: 15000, value_numeric_2: 25000 }), ctx)).toBe('pass');
    expect(evaluateEligibilityRule(rule({ operator: 'between', value_numeric: 1000, value_numeric_2: 5000 }), ctx)).toBe('fail');
  });

  it('handles in / not_in on a text field', () => {
    const r = { operator: 'in' as const, field_path: 'applicant.employment_type', value_numeric: null, value_list: ['employee', 'military'] };
    expect(evaluateEligibilityRule(rule(r), ctx)).toBe('pass');
    expect(evaluateEligibilityRule(rule({ ...r, operator: 'not_in' }), ctx)).toBe('fail');
  });

  it('handles a boolean criterion', () => {
    expect(
      evaluateEligibilityRule(
        rule({ operator: 'boolean', field_path: 'support.is_first_home', value_numeric: null, value_boolean: true }),
        ctx,
      ),
    ).toBe('pass');
  });
});

describe('evaluateEligibility with structured rules', () => {
  const input = makeInput(); // salary 20,000
  const primary = makeApplicant();

  it('a HARD rule failure excludes the product with the published message', () => {
    const product = makeProduct();
    product.version!.eligibility_rules = [rule()];
    const r = evaluateEligibility({ input, primary, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.status).toBe('appears_outside_published_criteria');
    expect(r.exclusion_reasons.some((e) => e.label_en.includes('SAR 14,000 per month or less'))).toBe(true);
  });

  it('a SOFT rule failure only lowers confidence — it does not exclude', () => {
    const product = makeProduct();
    product.version!.eligibility_rules = [rule({ is_hard_requirement: false })];
    const r = evaluateEligibility({ input, primary, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.status).toBe('requires_bank_review');
    expect(r.exclusion_reasons).toHaveLength(0);
  });

  it('an unevaluable rule becomes requires_bank_review, never a silent pass', () => {
    const product = makeProduct();
    product.version!.eligibility_rules = [rule({ field_path: 'unmodelled.path' })];
    const r = evaluateEligibility({ input, primary, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.status).toBe('requires_bank_review');
    expect(r.unknown_criteria.some((u) => u.code.startsWith('rule_unknown_'))).toBe(true);
  });

  it('a passing rule is recorded as a positive match reason', () => {
    const product = makeProduct();
    product.version!.eligibility_rules = [rule({ operator: 'gte', value_numeric: 10000 })];
    const r = evaluateEligibility({ input, primary, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.status).toBe('indicative_match');
    expect(r.match_reasons.some((m) => m.code.startsWith('rule_passed_'))).toBe(true);
  });

  it('a product with no structured rules behaves exactly as before', () => {
    const product = makeProduct();
    product.version!.eligibility_rules = [];
    const r = evaluateEligibility({ input, primary, product, requestedAmount: 800_000, termMonths: 240 });
    expect(r.status).toBe('indicative_match');
  });
});
