/**
 * The financing engine's orchestration layer.
 *
 * Deterministic and side-effect free: same (input, reference) → same output,
 * byte for byte. No clock reads (the caller supplies `as_of_date`), no random
 * ids, no network, no LLM. That is what makes a calculation reproducible months
 * later from the pinned version ids stored alongside it.
 */
import { calculateApr, canCalculateCompliantApr } from './apr';
import { calculateCapacity } from './capacity';
import { calculateUpfrontCash, maxPropertyValue, regulatoryLtvCeiling, resolveFee } from './ltv';
import { dataAgeDays, evaluateEligibility, isPricingStale, resolveRate } from './matching';
import { minOrNull, round2 } from './money';
import { buildSchedule, monthlyPayment, principalFromCapacity } from './payment';
import type {
  Confidence,
  DownPaymentOption,
  EngineInput,
  EngineReference,
  EngineResult,
  MissingInformation,
  ProductMatch,
  ProductRef,
  RateSensitivity,
  ResultStatus,
  TermOption,
} from './types';

/**
 * Bumped whenever a change could move a number. Stored on every run so a
 * historical result is always attributable to the code that produced it — and
 * so a replay that disagrees is immediately explainable rather than mysterious.
 */
export const ENGINE_VERSION = '1.0.0';

const DISCLAIMER_AR =
  'هذه نتيجة استرشادية مبنية على البيانات المنشورة رسميًا والمعلومات المدخلة، وليست موافقة تمويلية. ' +
  'التمويل الفعلي يخضع لدراسة البنك وسجل سمة وتقييم العقار واعتماد المشروع والمستندات النهائية.';

const DISCLAIMER_EN =
  'This is an indicative estimate based on officially published data and the information entered. It is not a financing approval. ' +
  'Actual financing is subject to the bank’s underwriting, SIMAH review, property valuation, project approval and final documentation.';

/** Terms the comparison grid always evaluates, filtered to what a product allows. */
const STANDARD_TERM_YEARS = [5, 10, 15, 20, 25, 30];
/** Down-payment percentages the comparison grid always evaluates. */
const STANDARD_DOWN_PAYMENT_PCTS = [10, 15, 20, 25, 30];
/** Benchmark shocks for variable-rate sensitivity. Scenarios, not forecasts. */
const RATE_SHOCKS = [1, 2, 3];

function worstConfidence(values: Confidence[]): Confidence {
  const order: Confidence[] = ['unavailable', 'low', 'medium', 'high'];
  let worst: Confidence = 'high';
  for (const v of values) {
    if (order.indexOf(v) < order.indexOf(worst)) worst = v;
  }
  return worst;
}

/** Latest observation for a benchmark key, or null. */
function latestBenchmark(reference: EngineReference, key: string | null): { rate: number; id: string } | null {
  if (!key) return null;
  const rows = reference.benchmarks
    .filter((b) => b.benchmark_key === key)
    .sort((a, b) => (a.observation_date < b.observation_date ? 1 : -1));
  const top = rows[0];
  return top ? { rate: top.rate_pct, id: top.id } : null;
}

/**
 * Price one product for this customer: eligibility → rate → amount → schedule →
 * APR → upfront cash → sensitivity.
 */
function buildMatch(params: {
  product: ProductRef;
  input: EngineInput;
  reference: EngineReference;
  maxInstallment: number | null;
  /** Qualifying income from the capacity pass — the DBR denominator. */
  qualifyingIncome: number;
  /** Existing obligations that survive to the financing start date. */
  existingObligationsMonthly: number;
  pinned: EngineResult['pinned'];
}): ProductMatch {
  const { product, input, reference, maxInstallment, pinned } = params;
  const version = product.version;
  const rateVersion = product.rate;
  const asOf = input.as_of_date;
  const primary = input.applicants.find((a) => a.role === 'primary') ?? null;

  if (version) pinned.product_version_ids.push(version.id);
  if (rateVersion) pinned.rate_version_ids.push(rateVersion.id);

  // ── Term: customer preference, clamped to what the product publishes ──────
  const preferredTerm = input.preferences.preferred_term_months ?? 240;
  const termMonths = Math.max(
    version?.min_term_months ?? 12,
    Math.min(preferredTerm, version?.max_term_months ?? preferredTerm),
  );

  const propertyPrice = input.property.property_price;

  // ── LTV ceiling: the tighter of the regulator's and the product's ────────
  const regulatory = regulatoryLtvCeiling({
    rule: reference.rules.ltv,
    provider: product.provider,
    isFirstHome: input.property.is_first_home ?? input.support.is_first_home,
    isSaudi: primary?.nationality_type === 'saudi' ? true : primary?.nationality_type === 'resident' ? false : null,
  });
  if (regulatory.rule_version_id) pinned.regulatory_rule_version_ids.push(regulatory.rule_version_id);
  const effectiveLtv = minOrNull([regulatory.ceiling_pct, version?.max_ltv_pct ?? null]);

  // ── Requested financing amount ───────────────────────────────────────────
  let requestedAmount: number | null = null;
  if (propertyPrice !== null && propertyPrice > 0) {
    const desiredDown = input.property.desired_down_payment;
    const byDownPayment = desiredDown !== null ? propertyPrice - desiredDown : null;
    const byLtv = effectiveLtv !== null ? (propertyPrice * effectiveLtv) / 100 : null;
    requestedAmount = minOrNull([byDownPayment, byLtv, version?.max_amount ?? null]);
    if (requestedAmount !== null) requestedAmount = round2(Math.max(0, requestedAmount));
  }

  const eligibility = evaluateEligibility({
    input,
    primary,
    product,
    requestedAmount,
    termMonths,
  });

  const benchmark = latestBenchmark(reference, rateVersion?.benchmark_key ?? null);
  if (benchmark) pinned.benchmark_observation_ids.push(benchmark.id);
  const resolvedRate = resolveRate(rateVersion, benchmark?.rate ?? null);

  const stale = isPricingStale(rateVersion, asOf, reference.pricing_freshness_days);
  const ageDays = dataAgeDays(rateVersion, asOf);

  let status = eligibility.status;
  if (stale && status !== 'appears_outside_published_criteria' && status !== 'product_data_unavailable') {
    status = 'product_data_stale';
  }

  const base: ProductMatch = {
    product,
    status,
    confidence: 'unavailable',
    match_reasons: eligibility.match_reasons,
    exclusion_reasons: eligibility.exclusion_reasons,
    unknown_criteria: eligibility.unknown_criteria,
    financing_amount: null,
    down_payment: null,
    term_months: termMonths,
    applied_rate_pct: resolvedRate.rate_pct,
    rate_basis: resolvedRate.basis,
    monthly_payment: null,
    total_repayment: null,
    financing_cost: null,
    published_apr_pct: rateVersion?.published_apr_pct ?? rateVersion?.published_apr_min_pct ?? null,
    calculated_apr_pct: null,
    apr_basis: 'unavailable',
    max_ltv_pct: effectiveLtv,
    ltv_pct: null,
    upfront: null,
    projected_dbr_pct: null,
    cash_flows: [],
    sensitivity: [],
    data_age_days: ageDays,
    is_stale: stale,
    binding_constraint: null,
  };

  // Without a usable rate we stop here and say so. We do NOT fabricate an
  // installment from an APR that was never a contractual rate.
  if (resolvedRate.rate_pct === null || !version) {
    return {
      ...base,
      status: version ? 'product_data_unavailable' : 'product_data_unavailable',
      confidence: 'unavailable',
      unknown_criteria: [
        ...base.unknown_criteria,
        {
          code: 'pricing_unavailable',
          label_ar: resolvedRate.note_ar ?? 'لا تتوفر بيانات تسعير',
          label_en: resolvedRate.note_en ?? 'No pricing data available',
          impact: 'requires_bank_confirmation',
        },
      ],
    };
  }

  // Hard-excluded products still show WHY, but carry no numbers — a payment on
  // a product the customer cannot have is noise at best.
  if (eligibility.status === 'appears_outside_published_criteria') {
    return { ...base, confidence: 'medium' };
  }

  const method = version.calculation_method;

  // ── Amount actually financeable ──────────────────────────────────────────
  // Two paths: with a property, the price and LTV drive it; without one, the
  // customer's monthly capacity does (the affordability question).
  let financingAmount: number | null = requestedAmount;
  let bindingConstraint: string | null = null;

  const capacityAmount =
    maxInstallment !== null && maxInstallment > 0
      ? round2(principalFromCapacity(maxInstallment, resolvedRate.rate_pct, termMonths, method))
      : null;

  if (financingAmount === null) {
    financingAmount = capacityAmount;
    bindingConstraint = 'income_capacity';
  } else if (capacityAmount !== null && capacityAmount < financingAmount) {
    financingAmount = capacityAmount;
    bindingConstraint = 'income_capacity';
  } else if (effectiveLtv !== null && propertyPrice !== null && financingAmount === round2((propertyPrice * effectiveLtv) / 100)) {
    bindingConstraint = 'ltv_ceiling';
  } else if (version.max_amount !== null && financingAmount === version.max_amount) {
    bindingConstraint = 'product_maximum';
  } else {
    bindingConstraint = 'requested_amount';
  }

  // A product minimum the customer falls under is a real exclusion.
  if (financingAmount !== null && version.min_amount !== null && financingAmount < version.min_amount) {
    return {
      ...base,
      status: 'appears_outside_published_criteria',
      confidence: 'medium',
      financing_amount: financingAmount,
      exclusion_reasons: [
        ...base.exclusion_reasons,
        {
          code: 'affordable_amount_below_product_minimum',
          label_ar: `المبلغ الذي يتحمله العميل أقل من الحد الأدنى للمنتج (${version.min_amount})`,
          label_en: `The affordable amount is below this product’s published minimum of SAR ${version.min_amount}`,
          value: version.min_amount,
          basis: 'min_amount',
        },
      ],
    };
  }

  if (financingAmount === null || financingAmount <= 0) {
    return {
      ...base,
      status: 'insufficient_information',
      confidence: 'unavailable',
      unknown_criteria: [
        ...base.unknown_criteria,
        {
          code: 'no_amount_derivable',
          label_ar: 'لا يمكن اشتقاق مبلغ التمويل من المعلومات المتاحة',
          label_en: 'A financing amount could not be derived from the information available',
          impact: 'blocks_calculation',
        },
      ],
    };
  }

  const effectivePropertyPrice = propertyPrice ?? round2(financingAmount / ((effectiveLtv ?? 100) / 100));
  const downPayment = round2(Math.max(0, effectivePropertyPrice - financingAmount));
  const ltvPct = effectivePropertyPrice > 0 ? round2((financingAmount / effectivePropertyPrice) * 100) : null;

  // ── Fees → upfront cash ──────────────────────────────────────────────────
  const feeCtx = { financeAmount: financingAmount, propertyPrice: effectivePropertyPrice };
  const upfrontFeeFlows = version.fees
    .filter((f) => f.payable_upfront && f.is_mandatory)
    .map((f) => ({ label: f.label_en, amount: resolveFee(f, feeCtx) ?? 0, includeInApr: f.include_in_apr }))
    .filter((f) => f.amount > 0);

  const startDate = input.preferences.planned_start_date ?? asOf;

  const schedule = buildSchedule({
    principal: financingAmount,
    annualRatePct: resolvedRate.rate_pct,
    termMonths,
    startDate,
    method,
    gracePeriodMonths: version.grace_period_months ?? 0,
    upfrontFees: upfrontFeeFlows,
    downPayment,
  });

  // ── APR ──────────────────────────────────────────────────────────────────
  const aprGate = canCalculateCompliantApr({
    hasContractualRate: resolvedRate.basis === 'contractual',
    hasFeeData: version.fees.length > 0,
    methodKnown: method !== 'unknown' && method !== 'manual_quotation',
  });
  let calculatedApr: number | null = null;
  let aprBasis: ProductMatch['apr_basis'] = 'unavailable';
  if (aprGate.ok) {
    const apr = calculateApr({ flows: schedule.cashFlows });
    if (apr.apr_pct !== null) {
      calculatedApr = apr.apr_pct;
      aprBasis = 'calculated';
    }
  }
  if (calculatedApr === null && base.published_apr_pct !== null) {
    // Fall back to what the provider published, labelled as PUBLISHED — never
    // presented as something we computed for this customer.
    aprBasis = 'published';
  }

  const upfront = calculateUpfrontCash({
    propertyPrice: effectivePropertyPrice,
    financeAmount: financingAmount,
    expectedValuation: input.property.expected_valuation,
    additionalExpenses: input.property.additional_expenses,
    availableCash: input.property.available_cash,
    fees: version.fees,
    feeCap: reference.rules.fee_cap?.payload ?? null,
    tax: reference.tax,
    support: input.support,
  });
  if (reference.rules.fee_cap) pinned.regulatory_rule_version_ids.push(reference.rules.fee_cap.id);
  if (reference.tax) pinned.tax_rule_version_ids.push(reference.tax.id);

  // ── Variable-rate sensitivity: scenarios, explicitly not forecasts ───────
  const sensitivity: RateSensitivity[] = [];
  if (rateVersion?.rate_type === 'variable') {
    for (const shock of RATE_SHOCKS) {
      const shocked = round2(resolvedRate.rate_pct + shock);
      sensitivity.push({
        shock_pct: shock,
        rate_pct: shocked,
        monthly_payment: monthlyPayment(financingAmount, shocked, termMonths),
      });
    }
  }

  // ── Projected DBR after this financing ───────────────────────────────────
  // The ratio the bank will look at: EXISTING obligations plus the new
  // instalment, over qualifying income. Using the new instalment alone would
  // understate it for exactly the customers who are closest to the ceiling.
  const projectedDbr =
    params.qualifyingIncome > 0
      ? round2(
          ((params.existingObligationsMonthly + schedule.monthlyPayment) / params.qualifyingIncome) * 100,
        )
      : null;

  // Confidence is the WORST of its parts. A perfect eligibility match priced off
  // a "starting from" figure is still a low-confidence number, and saying
  // otherwise is the exact overstatement this system exists to prevent.
  const confidence = worstConfidence([
    resolvedRate.confidence,
    version.confidence as Confidence,
    schedule.isApproximation ? 'low' : 'high',
    stale ? 'low' : 'high',
    eligibility.unknown_criteria.length > 0 ? 'medium' : 'high',
  ]);

  const unknowns: MissingInformation[] = [...eligibility.unknown_criteria];
  if (resolvedRate.note_en) {
    unknowns.push({
      code: `rate_basis_${resolvedRate.basis}`,
      label_ar: resolvedRate.note_ar ?? '',
      label_en: resolvedRate.note_en,
      impact: 'lowers_confidence',
    });
  }
  if (schedule.approximationNote) {
    unknowns.push({
      code: 'schedule_approximated',
      label_ar: 'تم افتراض جدول سداد قياسي لعدم نشر آلية الاحتساب',
      label_en: schedule.approximationNote,
      impact: 'lowers_confidence',
    });
  }
  if (aprGate.reason === 'fees_unknown_apr_may_be_understated') {
    unknowns.push({
      code: 'apr_fees_unknown',
      label_ar: 'الرسوم غير منشورة — معدل النسبة السنوية المحتسب قد يكون أقل من الفعلي',
      label_en: 'Fees are not published, so the calculated APR may be understated',
      impact: 'lowers_confidence',
    });
  }

  return {
    ...base,
    status,
    confidence,
    unknown_criteria: unknowns,
    financing_amount: financingAmount,
    down_payment: downPayment,
    term_months: termMonths,
    monthly_payment: schedule.monthlyPayment,
    total_repayment: schedule.totalRepayment,
    financing_cost: schedule.financingCost,
    calculated_apr_pct: calculatedApr,
    apr_basis: aprBasis,
    ltv_pct: ltvPct,
    upfront,
    projected_dbr_pct: projectedDbr,
    cash_flows: schedule.cashFlows,
    sensitivity,
    binding_constraint: bindingConstraint,
  };
}

/** Rank matches by the customer's stated priority. */
function sortMatches(matches: ProductMatch[], priority: EngineInput['preferences']['priority']): ProductMatch[] {
  const statusRank: Record<string, number> = {
    indicative_match: 0,
    potentially_suitable: 1,
    requires_bank_review: 2,
    product_data_stale: 3,
    insufficient_information: 4,
    product_data_unavailable: 5,
    appears_outside_published_criteria: 6,
  };
  const value = (m: ProductMatch): number => {
    switch (priority) {
      case 'lowest_total_cost':
        return m.total_repayment ?? Number.POSITIVE_INFINITY;
      case 'lowest_upfront':
        return m.upfront?.total ?? Number.POSITIVE_INFINITY;
      case 'shortest_term':
        return m.term_months ?? Number.POSITIVE_INFINITY;
      case 'lowest_monthly':
      default:
        return m.monthly_payment ?? Number.POSITIVE_INFINITY;
    }
  };
  return matches.slice().sort((a, b) => {
    const sr = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
    if (sr !== 0) return sr;
    // Within the same status, a better-evidenced number outranks a cheaper
    // guess — otherwise the top of the table is always the least reliable row.
    const confOrder: Confidence[] = ['high', 'medium', 'low', 'unavailable'];
    const cr = confOrder.indexOf(a.confidence) - confOrder.indexOf(b.confidence);
    if (cr !== 0) return cr;
    return value(a) - value(b);
  });
}

/**
 * Run the engine.
 *
 * `mode` only affects which optional sections are computed; the capacity
 * calculation is always performed because every other number depends on it.
 */
export function runFinancingEngine(
  input: EngineInput,
  reference: EngineReference,
  mode: 'affordability' | 'property_payment' | 'comparison' | 'full' = 'full',
): EngineResult {
  const pinned: EngineResult['pinned'] = {
    regulatory_rule_version_ids: [],
    tax_rule_version_ids: [],
    support_program_version_ids: [],
    product_version_ids: [],
    rate_version_ids: [],
    benchmark_observation_ids: [],
  };

  const capacity = calculateCapacity({
    applicants: input.applicants,
    incomes: input.incomes,
    obligations: input.obligations,
    support: input.support,
    rules: reference.rules,
    plannedStartDate: input.preferences.planned_start_date ?? input.as_of_date,
    maxAcceptableInstallment: input.preferences.max_acceptable_installment,
  });

  for (const rule of Object.values(reference.rules)) {
    if (rule) pinned.regulatory_rule_version_ids.push(rule.id);
  }
  for (const program of reference.supportPrograms) pinned.support_program_version_ids.push(program.id);

  const matches: ProductMatch[] = [];
  if (mode !== 'affordability') {
    for (const product of reference.products) {
      matches.push(
        buildMatch({
          product,
          input,
          reference,
          maxInstallment: capacity.max_installment,
          qualifyingIncome: capacity.income.qualifying_total,
          existingObligationsMonthly: capacity.obligations.total_monthly,
          pinned,
        }),
      );
    }
  }

  const ranked = sortMatches(matches, input.preferences.priority);
  const viable = ranked.filter(
    (m) => m.status === 'indicative_match' || m.status === 'requires_bank_review' || m.status === 'product_data_stale',
  );

  // ── Headline affordability numbers ───────────────────────────────────────
  // Derived from the BEST-EVIDENCED viable product rather than an invented
  // "market average" rate, so the headline and the comparison table agree.
  const reference_match = viable[0] ?? null;
  const maxFinancingFromIncome = reference_match?.financing_amount ?? null;
  const ltvForMax = reference_match?.max_ltv_pct ?? null;
  const maxProperty = maxPropertyValue({
    maxFinancing: maxFinancingFromIncome,
    ltvCeilingPct: ltvForMax,
    availableCash: input.property.available_cash,
  });

  // ── Term and down-payment comparisons ────────────────────────────────────
  const termOptions: TermOption[] = [];
  const downPaymentOptions: DownPaymentOption[] = [];
  if (reference_match && reference_match.applied_rate_pct !== null && mode !== 'affordability') {
    const rate = reference_match.applied_rate_pct;
    const maxTerm = reference_match.product.version?.max_term_months ?? 360;
    for (const years of STANDARD_TERM_YEARS) {
      const months = years * 12;
      if (months > maxTerm) continue;
      const amount =
        input.property.property_price !== null
          ? reference_match.financing_amount
          : capacity.max_installment !== null
            ? round2(
                principalFromCapacity(
                  capacity.max_installment,
                  rate,
                  months,
                  reference_match.product.version?.calculation_method ?? 'fixed_amortizing',
                ),
              )
            : null;
      if (amount === null) continue;
      const pay = monthlyPayment(amount, rate, months);
      termOptions.push({
        term_months: months,
        monthly_payment: pay,
        total_repayment: round2(pay * months),
        financing_amount: amount,
      });
    }

    const price = input.property.property_price;
    if (price !== null && price > 0) {
      for (const pct of STANDARD_DOWN_PAYMENT_PCTS) {
        const maxLtv = reference_match.max_ltv_pct;
        // Skip a down payment the LTV ceiling forbids — offering "10% down" on a
        // product capped at 70% LTV would be an option that does not exist.
        if (maxLtv !== null && 100 - pct > maxLtv) continue;
        const down = round2((price * pct) / 100);
        const amount = round2(price - down);
        downPaymentOptions.push({
          down_payment_pct: pct,
          down_payment: down,
          financing_amount: amount,
          monthly_payment: monthlyPayment(amount, rate, reference_match.term_months ?? 240),
          ltv_pct: round2((amount / price) * 100),
        });
      }
    }
  }

  // ── Overall status + confidence ──────────────────────────────────────────
  const missing: MissingInformation[] = [...capacity.missing];
  let status: ResultStatus;
  let confidence: Confidence;

  const blocking = missing.some((m) => m.impact === 'blocks_calculation');
  const defersToCreditor = capacity.ceilings.some((c) => c.defers_to_creditor);

  if (blocking) {
    status = 'insufficient_information';
    confidence = 'unavailable';
  } else if (mode === 'affordability') {
    status = capacity.max_installment !== null ? 'indicative_match' : 'insufficient_information';
    confidence = capacity.max_installment !== null ? 'medium' : 'unavailable';
  } else if (viable.length === 0) {
    status = matches.length === 0 ? 'product_data_unavailable' : 'appears_outside_published_criteria';
    confidence = 'unavailable';
  } else if (defersToCreditor) {
    // SAMA Art. 17 high-income case: no published ceiling exists to compute
    // against, so the honest answer is that the bank must decide.
    status = 'requires_bank_review';
    confidence = reference_match?.confidence ?? 'low';
  } else {
    status = reference_match?.status ?? 'requires_bank_review';
    confidence = reference_match?.confidence ?? 'low';
  }

  if (reference_match) missing.push(...reference_match.unknown_criteria);

  const assumptions = [...capacity.assumptions];
  if (reference.tax) {
    assumptions.push({
      code: 'rett_applied',
      label_ar: `ضريبة التصرفات العقارية ${reference.tax.rate_pct}% مطبقة على قيمة الصفقة`,
      label_en: `Real estate transaction tax of ${reference.tax.rate_pct}% applied to the transaction value`,
      value: reference.tax.rate_pct,
    });
  }

  // De-duplicate pinned ids so a run's provenance list is a clean set.
  const dedupe = (arr: string[]): string[] => Array.from(new Set(arr));

  return {
    engine_version: ENGINE_VERSION,
    as_of_date: input.as_of_date,
    status,
    confidence,
    capacity,
    max_financing_from_income: maxFinancingFromIncome,
    max_property_value: maxProperty.value,
    selected: input.property.property_price !== null ? reference_match : null,
    matches: ranked,
    term_options: termOptions,
    down_payment_options: downPaymentOptions,
    missing,
    assumptions,
    pinned: {
      regulatory_rule_version_ids: dedupe(pinned.regulatory_rule_version_ids),
      tax_rule_version_ids: dedupe(pinned.tax_rule_version_ids),
      support_program_version_ids: dedupe(pinned.support_program_version_ids),
      product_version_ids: dedupe(pinned.product_version_ids),
      rate_version_ids: dedupe(pinned.rate_version_ids),
      benchmark_observation_ids: dedupe(pinned.benchmark_observation_ids),
    },
    disclaimer_ar: DISCLAIMER_AR,
    disclaimer_en: DISCLAIMER_EN,
  };
}
