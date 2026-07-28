/**
 * Qualifying income, existing obligations, and affordability ceilings.
 *
 * EVERY percentage in here comes from a RuleVersion payload. There is not one
 * numeric literal representing a regulatory threshold in this file, and there
 * must never be — the whole point of the versioned rule tables is that SAMA can
 * move 65% to 60% and the engine follows without a redeploy, while a
 * calculation from last year still replays against the rule that was live then.
 *
 * Regulatory basis (verbatim references, stored with each rule version):
 *   - Qualifying income  → Responsible Lending Principles, Art. 14
 *   - Credit-card charge → Art. 13(a)
 *   - Uneven instalments → Art. 13(e)
 *   - DBR bands          → Arts. 15, 16, 17
 */
import { minOrNull, monthsBetween, round2 } from './money';
import type {
  Assumption,
  CapacityResult,
  CeilingEvaluation,
  ExplanationLine,
  IncomeInput,
  MissingInformation,
  ObligationInput,
  ObligationsBreakdown,
  QualifyingIncomeBreakdown,
  RuleSet,
  SupportInput,
  ApplicantInput,
  DbrBand,
} from './types';

/** Income types that are salary-like for the salary-deduction ceiling. */
const SALARY_LIKE: ReadonlySet<string> = new Set(['basic_salary', 'housing_allowance', 'other_allowance']);

/** Convert any declared frequency to a monthly figure. */
function toMonthly(amount: number, frequency: IncomeInput['frequency']): number {
  switch (frequency) {
    case 'monthly':
      return amount;
    case 'quarterly':
      return amount / 3;
    case 'semi_annual':
      return amount / 6;
    case 'annual':
      return amount / 12;
    case 'irregular':
      return amount; // caller supplies a monthly average for irregular income
    default:
      return amount;
  }
}

/**
 * Qualifying income.
 *
 * Three DIFFERENT totals come out of here and the UI shows all three, because
 * collapsing them is how a rep ends up promising capacity the bank will not
 * recognise:
 *   declared   — what the customer said
 *   verified   — what a document supports
 *   qualifying — what the regulator's rule actually lets a creditor count
 */
export function calculateQualifyingIncome(
  incomes: IncomeInput[],
  rules: RuleSet,
  support: SupportInput,
  missing: MissingInformation[],
): QualifyingIncomeBreakdown {
  const rule = rules.qualifying_income;
  const lines: QualifyingIncomeBreakdown['lines'] = [];
  const explanation: ExplanationLine[] = [];

  if (!rule) {
    missing.push({
      code: 'qualifying_income_rule_missing',
      label_ar: 'قاعدة الدخل المؤهل غير متوفرة',
      label_en: 'The qualifying-income rule could not be loaded',
      impact: 'blocks_calculation',
    });
    return {
      declared_total: 0,
      verified_total: 0,
      qualifying_total: 0,
      primary_gross_salary: 0,
      lines: [],
      explanation,
    };
  }

  const p = rule.payload;
  const otherTypes = new Set<string>(p.other_periodic_income_types);

  let declaredTotal = 0;
  let verifiedTotal = 0;
  let qualifyingTotal = 0;
  let primaryGrossSalary = 0;

  for (const income of incomes) {
    const declaredRaw = income.declared_monthly_amount ?? 0;
    const declared = round2(toMonthly(declaredRaw, income.frequency));
    const verified =
      income.verified_monthly_amount === null || income.verified_monthly_amount === undefined
        ? null
        : round2(toMonthly(income.verified_monthly_amount, income.frequency));

    declaredTotal += declared;
    if (verified !== null) verifiedTotal += verified;

    let eligiblePct = 0;
    let basis = '';
    let exclusionReason: string | null = null;

    if (income.income_type === 'government_support') {
      // Art. 14(c): government subsidies are excluded — EXCEPT documented
      // MoH/REDF housing support, which may be counted in real-estate finance.
      const isHousingSupport =
        support.redf_eligible === true || support.sakani_eligible === true || support.financing_kind === 'supported';
      if (p.housing_support_included_in_real_estate && isHousingSupport) {
        eligiblePct = 100;
        basis = 'rlp_art_14c_housing_support_included';
        if (support.support_status !== 'confirmed') {
          // Counted, but the result carries the caveat rather than silently
          // treating a self-declaration as a documented contract.
          missing.push({
            code: 'support_not_confirmed',
            label_ar: 'دعم سكني غير مؤكد — يعتمد على إقرار العميل',
            label_en: 'Housing support is self-declared, not confirmed by certificate',
            impact: 'lowers_confidence',
          });
        }
      } else {
        eligiblePct = 0;
        basis = 'rlp_art_14c_government_subsidy_excluded';
        exclusionReason = 'Government subsidies are excluded from total monthly income';
      }
    } else if (SALARY_LIKE.has(income.income_type)) {
      // Art. 14(a): gross salary counts in full, as documented by the employer.
      eligiblePct = p.gross_salary_pct;
      basis = 'rlp_art_14a_gross_salary';
    } else if (otherTypes.has(income.income_type)) {
      // Art. 14(b): HALF the monthly average of other periodic income, and only
      // when it can be reasonably verified over a documented history.
      eligiblePct = p.other_periodic_income_pct;
      basis = 'rlp_art_14b_other_periodic_income';
      const historyOk =
        p.other_income_min_history_months === null ||
        (income.averaging_period_months ?? 0) >= p.other_income_min_history_months;
      const documented = income.documentation_status !== 'undocumented' && income.documentation_status !== 'self_declared';
      if (!documented || !historyOk) {
        eligiblePct = 0;
        exclusionReason = !documented
          ? 'Other income requires documentary evidence (e.g. a two-year bank statement) before it can be counted'
          : `Other income requires at least ${p.other_income_min_history_months} months of documented history`;
        basis = 'rlp_art_14b_unverified';
        missing.push({
          code: `income_unverified_${income.id}`,
          label_ar: 'دخل إضافي غير موثق — لم يُحتسب',
          label_en: 'Additional income is undocumented and was not counted',
          impact: 'lowers_confidence',
        });
      }
    } else {
      eligiblePct = p.other_periodic_income_pct;
      basis = 'rlp_art_14b_other_periodic_income';
    }

    // The regulator's rule addresses what a creditor MAY count. Where a verified
    // figure exists it is the honest base; otherwise the declared figure is used
    // and the result says the estimate depends on a declaration.
    const base = verified !== null ? verified : declared;
    if (verified === null && declared > 0) {
      missing.push({
        code: `income_declared_only_${income.id}`,
        label_ar: 'الدخل معتمد على إقرار العميل دون إثبات',
        label_en: 'Income is based on the customer’s declaration, not verified documents',
        impact: 'lowers_confidence',
      });
    }

    const qualifying = round2((base * eligiblePct) / 100);
    qualifyingTotal += qualifying;

    if (income.applicant_role === 'primary' && SALARY_LIKE.has(income.income_type)) {
      primaryGrossSalary += base;
    }

    lines.push({
      income_id: income.id,
      income_type: income.income_type,
      declared,
      verified,
      eligible_pct: eligiblePct,
      qualifying,
      exclusion_reason: exclusionReason,
      basis,
    });
  }

  explanation.push({
    code: 'qualifying_income_total',
    label_ar: 'إجمالي الدخل المؤهل الشهري',
    label_en: 'Total qualifying monthly income',
    value: round2(qualifyingTotal),
    basis: rule.rule_key,
    version_id: rule.id,
  });

  return {
    declared_total: round2(declaredTotal),
    verified_total: round2(verifiedTotal),
    qualifying_total: round2(qualifyingTotal),
    primary_gross_salary: round2(primaryGrossSalary),
    lines,
    explanation,
  };
}

/**
 * Existing monthly obligations.
 *
 * The two rules that most often get implemented wrong, both handled explicitly:
 *
 *  - CREDIT CARDS (Art. 13a). The charge is the minimum repayment of the credit
 *    CEILING — a percentage of the limit. Not the balance, not what the customer
 *    says they pay. A customer with a SAR 50,000 limit and a zero balance still
 *    carries a monthly obligation.
 *
 *  - UNEVEN INSTALMENTS (Art. 13e). Where instalments differ, the monthly
 *    obligation is the AVERAGE across all of them — including any final/balloon
 *    payment, which is why the balloon is folded into the average rather than
 *    ignored because it "isn't monthly".
 */
export function calculateObligations(
  obligations: ObligationInput[],
  rules: RuleSet,
  plannedStartDate: string,
  missing: MissingInformation[],
): ObligationsBreakdown {
  const lines: ObligationsBreakdown['lines'] = [];
  const explanation: ExplanationLine[] = [];
  const cardRule = rules.credit_card;

  let total = 0;
  let realEstate = 0;
  let nonRealEstate = 0;
  let salaryLinked = 0;
  let expiring = 0;

  for (const o of obligations) {
    let counted: number | null = null;
    let basis = '';
    let excluded = false;
    let exclusionReason: string | null = null;

    if (o.obligation_type === 'credit_card') {
      if (!cardRule) {
        missing.push({
          code: 'credit_card_rule_missing',
          label_ar: 'قاعدة احتساب البطاقات الائتمانية غير متوفرة',
          label_en: 'The credit-card obligation rule could not be loaded',
          impact: 'lowers_confidence',
        });
        counted = o.monthly_payment ?? o.minimum_payment ?? null;
        basis = 'fallback_declared_payment';
      } else if (o.card_limit !== null && o.card_limit > 0) {
        counted = round2((o.card_limit * cardRule.payload.minimum_repayment_pct) / 100);
        basis = 'rlp_art_13a_minimum_repayment_of_ceiling';
      } else {
        counted = o.minimum_payment ?? o.monthly_payment ?? null;
        basis = 'card_limit_unknown_declared_payment_used';
        missing.push({
          code: `card_limit_missing_${o.id}`,
          label_ar: 'حد البطاقة الائتمانية غير معروف',
          label_en: 'Credit-card limit is unknown; the regulator charges a percentage of the limit',
          impact: 'lowers_confidence',
        });
      }
    } else if (o.balloon_payment && o.balloon_payment > 0 && o.remaining_months && o.remaining_months > 0) {
      // Art. 13(e): average the whole obligation across its remaining life.
      const regular = (o.monthly_payment ?? 0) * o.remaining_months;
      counted = round2((regular + o.balloon_payment) / o.remaining_months);
      basis = 'rlp_art_13e_average_of_uneven_installments';
    } else {
      counted = o.monthly_payment ?? null;
      basis = 'declared_monthly_payment';
      if (counted === null) {
        missing.push({
          code: `obligation_payment_missing_${o.id}`,
          label_ar: 'قسط التزام قائم غير معروف',
          label_en: 'An existing obligation has no stated monthly payment',
          impact: 'lowers_confidence',
        });
      }
    }

    // An obligation that ends before financing starts does not burden the new
    // instalment — but it is NEVER silently dropped: it is reported separately
    // AND drives the second "after it ends" scenario.
    const endsBeforeStart =
      o.will_be_settled_before_financing ||
      (o.end_date ? monthsBetween(plannedStartDate, o.end_date) <= 0 : false);

    if (endsBeforeStart) {
      excluded = true;
      exclusionReason = o.will_be_settled_before_financing
        ? 'Customer states this will be settled before financing starts'
        : 'Ends before the planned financing start date';
      expiring += counted ?? 0;
    } else if (counted !== null) {
      total += counted;
      if (o.is_real_estate) realEstate += counted;
      else nonRealEstate += counted;
      // Salary-linked = deducted at source. Employer loans and development-fund
      // deductions are explicitly included per SAMA circular 42049450.
      if (o.obligation_type === 'employer_loan' || o.obligation_type === 'development_fund') {
        salaryLinked += counted;
      } else {
        salaryLinked += counted;
      }
    }

    lines.push({
      obligation_id: o.id,
      obligation_type: o.obligation_type,
      counted_monthly: round2(counted ?? 0),
      basis,
      excluded,
      exclusion_reason: exclusionReason,
    });
  }

  explanation.push({
    code: 'obligations_total',
    label_ar: 'إجمالي الالتزامات الشهرية القائمة',
    label_en: 'Total existing monthly obligations',
    value: round2(total),
    basis: cardRule?.rule_key ?? 'declared',
    version_id: cardRule?.id ?? null,
  });

  return {
    total_monthly: round2(total),
    real_estate_monthly: round2(realEstate),
    non_real_estate_monthly: round2(nonRealEstate),
    salary_linked_monthly: round2(salaryLinked),
    expiring_monthly: round2(expiring),
    lines,
    explanation,
  };
}

/** Pick the DBR band whose income range contains the qualifying income. */
export function selectDbrBand(bands: DbrBand[], totalMonthlyIncome: number): DbrBand | null {
  for (const band of bands) {
    const aboveFloor = totalMonthlyIncome >= band.income_from;
    const belowCeiling = band.income_to === null || totalMonthlyIncome < band.income_to;
    if (aboveFloor && belowCeiling) return band;
  }
  return null;
}

/**
 * Evaluate every applicable ceiling SEPARATELY, then take the most restrictive.
 *
 * This is deliberately not "one DBR percentage". A real customer is bounded at
 * once by: the total-obligations ceiling, the non-real-estate ceiling, the
 * salary-deduction ceiling (a % of GROSS SALARY, a different base), the
 * product's own policy, and whatever the customer said they are willing to pay.
 * Reporting only the tightest one without showing the others is what makes an
 * estimate impossible to argue with when the bank disagrees.
 */
export function calculateCapacity(params: {
  applicants: ApplicantInput[];
  incomes: IncomeInput[];
  obligations: ObligationInput[];
  support: SupportInput;
  rules: RuleSet;
  plannedStartDate: string;
  maxAcceptableInstallment: number | null;
}): CapacityResult {
  const missing: MissingInformation[] = [];
  const assumptions: Assumption[] = [];
  const capacityReducers: ExplanationLine[] = [];

  const income = calculateQualifyingIncome(params.incomes, params.rules, params.support, missing);
  const obligations = calculateObligations(params.obligations, params.rules, params.plannedStartDate, missing);

  const ceilings: CeilingEvaluation[] = [];
  const dbrRule = params.rules.dbr;
  const primary = params.applicants.find((a) => a.role === 'primary') ?? null;
  const isRetiree = primary?.employment_type === 'retiree';

  if (!dbrRule) {
    missing.push({
      code: 'dbr_rule_missing',
      label_ar: 'قاعدة نسبة الاستقطاع غير متوفرة',
      label_en: 'The debt-burden rule could not be loaded',
      impact: 'blocks_calculation',
    });
  }

  const band = dbrRule ? selectDbrBand(dbrRule.payload.bands, income.qualifying_total) : null;

  if (dbrRule && !band) {
    missing.push({
      code: 'dbr_band_not_found',
      label_ar: 'لم يتم العثور على شريحة دخل مطابقة',
      label_en: 'No debt-burden income band matched the qualifying income',
      impact: 'blocks_calculation',
    });
  }

  if (band && dbrRule) {
    // ── Ceiling 1: total obligations, % of TOTAL MONTHLY INCOME ─────────────
    const isSupported =
      params.support.financing_kind === 'supported' ||
      params.support.redf_eligible === true ||
      params.support.sakani_eligible === true;
    const totalPct = isSupported
      ? band.total_obligations_supported_pct ?? band.total_obligations_pct
      : band.total_obligations_pct;

    if (totalPct !== null && totalPct !== undefined) {
      const ceilingAmount = round2((income.qualifying_total * totalPct) / 100);
      ceilings.push({
        code: 'total_obligations',
        label_ar: 'سقف إجمالي الالتزامات',
        label_en: 'Total obligations ceiling',
        ceiling_amount: ceilingAmount,
        available_amount: round2(Math.max(0, ceilingAmount - obligations.total_monthly)),
        pct: totalPct,
        basis: isSupported ? 'rlp_total_obligations_supported' : 'rlp_total_obligations',
        rule_version_id: dbrRule.id,
        defers_to_creditor: false,
      });
    } else if (band.real_estate_per_creditor_policy) {
      // SAMA Art. 17: for income ≥ SAR 25,000 the real-estate obligation is
      // left to the creditor's own credit policy. We do NOT invent a ceiling —
      // we say so, and the result becomes 'requires_bank_review'.
      ceilings.push({
        code: 'total_obligations',
        label_ar: 'يخضع للسياسة الائتمانية للممول',
        label_en: 'Subject to the financier’s own credit policy',
        ceiling_amount: null,
        available_amount: null,
        pct: null,
        basis: 'rlp_art_17_creditor_policy',
        rule_version_id: dbrRule.id,
        defers_to_creditor: true,
      });
      assumptions.push({
        code: 'high_income_creditor_policy',
        label_ar: 'الدخل ٢٥٬٠٠٠ ريال فأكثر: سقف التمويل العقاري يحدده البنك',
        label_en: 'Income of SAR 25,000+: the real-estate ceiling is set by the bank’s own policy, not by a published ratio',
      });
    }

    // ── Ceiling 2: non-real-estate obligations ──────────────────────────────
    // Not a limit on the mortgage itself, but it constrains how much room the
    // customer's OTHER debts may occupy, so it is shown for the explanation.
    if (band.excluding_real_estate_pct !== null && band.excluding_real_estate_pct !== undefined) {
      const ceilingAmount = round2((income.qualifying_total * band.excluding_real_estate_pct) / 100);
      const breach = obligations.non_real_estate_monthly > ceilingAmount;
      ceilings.push({
        code: 'non_real_estate_obligations',
        label_ar: 'سقف الالتزامات غير العقارية',
        label_en: 'Non-real-estate obligations ceiling',
        ceiling_amount: ceilingAmount,
        available_amount: round2(Math.max(0, ceilingAmount - obligations.non_real_estate_monthly)),
        pct: band.excluding_real_estate_pct,
        basis: 'rlp_excluding_real_estate',
        rule_version_id: dbrRule.id,
        defers_to_creditor: false,
      });
      if (breach) {
        capacityReducers.push({
          code: 'non_real_estate_over_ceiling',
          label_ar: 'الالتزامات غير العقارية تتجاوز السقف النظامي',
          label_en: 'Existing non-real-estate obligations already exceed the published ceiling',
          value: round2(obligations.non_real_estate_monthly - ceilingAmount),
          basis: 'rlp_excluding_real_estate',
          version_id: dbrRule.id,
        });
      }
    }

    // ── Ceiling 3: salary deduction — a % of GROSS SALARY, not total income ──
    const deductionPct = isRetiree ? band.salary_deduction_retiree_pct : band.salary_deduction_employee_pct;
    if (deductionPct !== null && deductionPct !== undefined && income.primary_gross_salary > 0) {
      const ceilingAmount = round2((income.primary_gross_salary * deductionPct) / 100);
      ceilings.push({
        code: 'salary_deduction',
        label_ar: isRetiree ? 'سقف الاستقطاع من المعاش' : 'سقف الاستقطاع من الراتب',
        label_en: isRetiree ? 'Pension deduction ceiling' : 'Salary deduction ceiling',
        ceiling_amount: ceilingAmount,
        available_amount: round2(Math.max(0, ceilingAmount - obligations.salary_linked_monthly)),
        pct: deductionPct,
        basis: isRetiree ? 'rlp_salary_deduction_retiree' : 'rlp_salary_deduction_employee',
        rule_version_id: dbrRule.id,
        defers_to_creditor: false,
      });
    } else if (income.primary_gross_salary <= 0) {
      missing.push({
        code: 'gross_salary_missing',
        label_ar: 'الراتب الأساسي غير محدد — تعذر تطبيق سقف الاستقطاع',
        label_en: 'No gross salary recorded, so the salary-deduction ceiling could not be applied',
        impact: 'lowers_confidence',
      });
    }
  }

  // ── Ceiling 4: what the customer says they will accept ────────────────────
  if (params.maxAcceptableInstallment !== null && params.maxAcceptableInstallment > 0) {
    ceilings.push({
      code: 'customer_preference',
      label_ar: 'الحد الأقصى للقسط حسب رغبة العميل',
      label_en: 'Customer’s stated maximum installment',
      ceiling_amount: params.maxAcceptableInstallment,
      available_amount: params.maxAcceptableInstallment,
      pct: null,
      basis: 'customer_preference',
      rule_version_id: null,
      defers_to_creditor: false,
    });
  }

  // Most restrictive wins. Ceilings that defer to the creditor contribute no
  // number — they contribute a STATUS, handled by the caller.
  const availables = ceilings.filter((c) => !c.defers_to_creditor).map((c) => c.available_amount);
  const maxInstallment = minOrNull(availables);
  const binding =
    maxInstallment === null
      ? null
      : ceilings.find((c) => !c.defers_to_creditor && c.available_amount === maxInstallment)?.code ?? null;

  const currentDbr =
    income.qualifying_total > 0 ? round2((obligations.total_monthly / income.qualifying_total) * 100) : null;

  if (obligations.total_monthly > 0) {
    capacityReducers.push({
      code: 'existing_obligations',
      label_ar: 'الالتزامات القائمة تخفض القدرة الشهرية',
      label_en: 'Existing obligations reduce available monthly capacity',
      value: obligations.total_monthly,
      basis: 'obligations_total',
    });
  }

  // Second scenario: capacity once a soon-expiring obligation actually ends.
  // Required by policy — an obligation that expires is never silently dropped,
  // but nor is the customer told to ignore an extra year of payments.
  let afterExpiry: CapacityResult['after_expiry'] = null;
  const expiringSoon = params.obligations.filter(
    (o) => !o.will_be_settled_before_financing && o.end_date && monthsBetween(params.plannedStartDate, o.end_date) > 0,
  );
  if (expiringSoon.length > 0 && maxInstallment !== null) {
    const freed = expiringSoon.reduce((sum, o) => sum + (o.monthly_payment ?? 0), 0);
    const dates = expiringSoon.map((o) => o.end_date!).sort();
    afterExpiry = {
      expiring_obligation_ids: expiringSoon.map((o) => o.id),
      max_installment: round2(maxInstallment + freed),
      earliest_expiry_date: dates[0] ?? null,
    };
  }

  return {
    income,
    obligations,
    ceilings,
    max_installment: maxInstallment,
    binding_constraint: binding,
    current_dbr_pct: currentDbr,
    after_expiry: afterExpiry,
    missing,
    assumptions,
    capacity_reducers: capacityReducers,
  };
}
