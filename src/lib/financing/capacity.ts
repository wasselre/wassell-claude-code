/**
 * Service 1 of 3 — affordability capacity.
 *
 * Qualifying income → existing obligations → the tightest applicable ceiling.
 *
 * Every percentage comes from a `financing_rules` payload. There is no
 * regulatory numeric literal in this file, and there must not be: SAMA can move
 * a ratio and the rule row changes, not the code.
 */
import { round2 } from './money';
import type { Capacity, Ceiling, DbrBand, FinancingInput, Note, RuleSet } from './types';

/** Pick the income band containing this income. */
export function selectBand(bands: DbrBand[], monthlyIncome: number): DbrBand | null {
  for (const b of bands) {
    if (monthlyIncome >= b.income_from && (b.income_to === null || monthlyIncome < b.income_to)) return b;
  }
  return null;
}

/**
 * Qualifying income (SAMA Responsible Lending, Art. 14).
 *
 * Gross salary counts in full. Other periodic income counts at the rule's
 * percentage AND only when verified — unverified extra income counts zero, not
 * a reduced share, which is the part reps most often get wrong.
 *
 * Confirmed Sakani/REDF support is the documented exception: it may be counted
 * in a real-estate product. Self-declared support is not.
 */
export function qualifyingIncome(
  input: FinancingInput,
  rules: RuleSet,
  missing: Note[],
): { declared: number; qualifying: number } {
  const rule = rules.income;
  const salary = input.gross_monthly_salary ?? 0;

  let declared = salary;
  let qualifying = 0;

  if (!rule) {
    missing.push({ code: 'income_rule_missing', ar: 'قاعدة احتساب الدخل غير متوفرة', en: 'The income-qualification rule is unavailable' });
    return { declared: round2(declared), qualifying: 0 };
  }

  qualifying += (salary * rule.gross_salary_pct) / 100;

  for (const item of input.other_income) {
    const amount = item.monthly_amount ?? 0;
    declared += amount;
    if (item.kind === 'salary') {
      qualifying += (amount * rule.gross_salary_pct) / 100;
      continue;
    }
    if (!item.verified) {
      missing.push({
        code: 'unverified_other_income',
        ar: 'دخل إضافي غير موثق — لم يُحتسب',
        en: 'Unverified additional income was not counted',
      });
      continue;
    }
    qualifying += (amount * rule.other_periodic_income_pct) / 100;
  }

  // Housing support: counted only when the rep has seen the certificate.
  if (input.confirmed_support_amount && input.confirmed_support_amount > 0) {
    declared += input.confirmed_support_amount;
    if (input.sakani_redf_status === 'confirmed' && rules.support?.housing_support_counts_as_income) {
      qualifying += input.confirmed_support_amount;
    } else {
      missing.push({
        code: 'support_not_confirmed',
        ar: 'الدعم السكني غير مؤكد بشهادة — لم يُحتسب ضمن الدخل',
        en: 'Housing support is not certificate-confirmed, so it was not counted as income',
      });
    }
  }

  if (salary <= 0) {
    missing.push({ code: 'no_salary', ar: 'الراتب الشهري غير محدد', en: 'No gross monthly salary was entered' });
  }

  return { declared: round2(declared), qualifying: round2(qualifying) };
}

/**
 * Existing monthly obligations.
 *
 * A credit card is charged as a percentage of its LIMIT (SAMA Art. 13a) — not
 * its balance, and not what the customer says they pay. A SAR 50,000 limit at a
 * zero balance still carries an obligation.
 */
export function existingObligations(
  input: FinancingInput,
  rules: RuleSet,
  missing: Note[],
): { total: number; nonRealEstate: number } {
  let total = 0;
  let nonRealEstate = 0;

  for (const o of input.obligations) {
    let counted = 0;
    if (o.kind === 'credit_card') {
      const limit = o.card_limit ?? null;
      if (limit !== null && rules.credit_card) {
        counted = (limit * rules.credit_card.minimum_repayment_pct) / 100;
      } else if (o.monthly_payment) {
        counted = o.monthly_payment;
        missing.push({
          code: 'card_limit_missing',
          ar: 'حد البطاقة غير معروف — استُخدم القسط المُدخل',
          en: 'Credit-card limit unknown; the entered payment was used instead',
        });
      }
    } else {
      counted = o.monthly_payment ?? 0;
    }
    total += counted;
    if (!o.is_real_estate) nonRealEstate += counted;
  }

  return { total: round2(total), nonRealEstate: round2(nonRealEstate) };
}

/**
 * Evaluate every applicable ceiling and take the most restrictive.
 *
 * Reporting only the tightest one without showing the others makes an estimate
 * impossible to defend when the bank disagrees, so all of them are returned.
 */
export function calculateCapacity(input: FinancingInput, rules: RuleSet, missing: Note[], assumptions: Note[]): Capacity {
  const income = qualifyingIncome(input, rules, missing);
  const obligations = existingObligations(input, rules, missing);
  const ceilings: Ceiling[] = [];

  const isSupported = input.sakani_redf_status === 'confirmed' || input.sakani_redf_status === 'self_declared';
  const isRetiree = input.employment_type === 'retiree';

  if (!rules.dbr) {
    missing.push({ code: 'dbr_rule_missing', ar: 'قاعدة نسبة الاستقطاع غير متوفرة', en: 'The debt-burden rule is unavailable' });
    return {
      declared_income: income.declared,
      qualifying_income: income.qualifying,
      existing_obligations: obligations.total,
      current_dbr_pct: null,
      ceilings,
      max_installment: null,
      binding_constraint: null,
    };
  }

  const band = selectBand(rules.dbr.bands, income.qualifying);

  if (band) {
    // Total obligations, as a % of total monthly income.
    const totalPct = isSupported
      ? band.total_obligations_supported_pct ?? band.total_obligations_pct
      : band.total_obligations_pct;

    if (totalPct !== null && totalPct !== undefined) {
      const amount = round2((income.qualifying * totalPct) / 100);
      ceilings.push({
        code: 'total_obligations',
        label_ar: 'سقف إجمالي الالتزامات',
        label_en: 'Total obligations ceiling',
        pct: totalPct,
        ceiling_amount: amount,
        available_amount: round2(Math.max(0, amount - obligations.total)),
        defers_to_bank: false,
      });
    } else if (band.real_estate_per_creditor_policy) {
      // SAMA Art. 17(b): for income >= SAR 25,000 the real-estate decision is
      // the bank's. We do not invent a ratio.
      ceilings.push({
        code: 'total_obligations',
        label_ar: 'يخضع للسياسة الائتمانية للبنك',
        label_en: 'Subject to the bank’s own credit policy',
        pct: null,
        ceiling_amount: null,
        available_amount: null,
        defers_to_bank: true,
      });
      assumptions.push({
        code: 'high_income_bank_policy',
        ar: 'الدخل ٢٥٬٠٠٠ ريال فأكثر: سقف التمويل العقاري يحدده البنك وليس نسبة منشورة',
        en: 'Income of SAR 25,000+: the real-estate ceiling is set by the bank, not by a published ratio',
      });
    }

    // Salary deduction — a % of GROSS SALARY, a different base from the above.
    const deductionPct = isRetiree ? band.salary_deduction_retiree_pct : band.salary_deduction_employee_pct;
    const salaryBase = input.gross_monthly_salary ?? 0;
    if (deductionPct && salaryBase > 0) {
      const amount = round2((salaryBase * deductionPct) / 100);
      ceilings.push({
        code: 'salary_deduction',
        label_ar: isRetiree ? 'سقف الاستقطاع من المعاش' : 'سقف الاستقطاع من الراتب',
        label_en: isRetiree ? 'Pension deduction ceiling' : 'Salary deduction ceiling',
        pct: deductionPct,
        ceiling_amount: amount,
        available_amount: round2(Math.max(0, amount - obligations.total)),
        defers_to_bank: false,
      });
    }

    // Non-real-estate ceiling: does not cap the mortgage, but a breach explains
    // why capacity is low, so it is shown.
    if (band.excluding_real_estate_pct) {
      const amount = round2((income.qualifying * band.excluding_real_estate_pct) / 100);
      ceilings.push({
        code: 'non_real_estate',
        label_ar: 'سقف الالتزامات غير العقارية',
        label_en: 'Non-real-estate obligations ceiling',
        pct: band.excluding_real_estate_pct,
        ceiling_amount: amount,
        available_amount: round2(Math.max(0, amount - obligations.nonRealEstate)),
        defers_to_bank: false,
      });
    }
  } else {
    missing.push({ code: 'no_dbr_band', ar: 'لم يتم العثور على شريحة دخل مطابقة', en: 'No debt-burden income band matched' });
  }

  // The customer's own stated limit is a real constraint and can bind.
  if (input.max_comfortable_installment && input.max_comfortable_installment > 0) {
    ceilings.push({
      code: 'customer_preference',
      label_ar: 'أقصى قسط يقبله العميل',
      label_en: 'Customer’s stated maximum installment',
      pct: null,
      ceiling_amount: input.max_comfortable_installment,
      available_amount: input.max_comfortable_installment,
      defers_to_bank: false,
    });
  }

  // Most restrictive wins. Ceilings that defer to the bank contribute a STATUS,
  // not a number, so they are excluded from the minimum.
  const usable = ceilings.filter((c) => !c.defers_to_bank && c.available_amount !== null);
  const maxInstallment = usable.length ? Math.min(...usable.map((c) => c.available_amount!)) : null;
  const binding = maxInstallment === null
    ? null
    : usable.find((c) => c.available_amount === maxInstallment)?.code ?? null;

  return {
    declared_income: income.declared,
    qualifying_income: income.qualifying,
    existing_obligations: obligations.total,
    current_dbr_pct: income.qualifying > 0 ? round2((obligations.total / income.qualifying) * 100) : null,
    ceilings,
    max_installment: maxInstallment,
    binding_constraint: binding,
  };
}
