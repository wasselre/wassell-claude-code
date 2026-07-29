/**
 * The orchestrator — thin on purpose.
 *
 * capacity → match every product → pick the headline figures → freeze the rule
 * values that produced them. Deterministic: no clock reads (`as_of_date` is an
 * input), no randomness, no network, no LLM. Same inputs → identical output.
 */
import { calculateCapacity } from './capacity';
import { matchProduct, sortMatches } from './matching';
import { principalFromPayment } from './payment';
import { round2 } from './money';
import type {
  Confidence,
  FinancingInput,
  FinancingProduct,
  FinancingResult,
  Note,
  ResultStatus,
  RuleSet,
} from './types';

/** Bumped whenever a change could move a number. Stored on every scenario. */
export const CALCULATION_VERSION = '2.0.0';

const DISCLAIMER_AR =
  'هذه نتيجة استرشادية مبنية على البيانات المنشورة رسميًا والمعلومات المدخلة، وليست موافقة تمويلية. ' +
  'التمويل الفعلي يخضع لدراسة البنك وسجل سمة وتقييم العقار واعتماد المشروع والمستندات النهائية.';
const DISCLAIMER_EN =
  'This is an indicative estimate based on officially published data and the information entered. It is not a financing approval. ' +
  'Actual financing is subject to the bank’s underwriting, SIMAH review, property valuation, project approval and final documentation.';

/**
 * Freeze the rule values actually used.
 *
 * This is what replaces V1's effective-dated version graph: a scenario's
 * snapshot carries the numbers and their sources inline, so a result from six
 * months ago stays readable without reconstructing anything.
 */
function rulesUsed(rules: RuleSet): FinancingResult['rules_used'] {
  const out: FinancingResult['rules_used'] = {};
  const add = (key: string, r: { source_url: string; effective_from: string } | null, values: unknown) => {
    if (r) out[key] = { source_url: r.source_url, effective_from: r.effective_from, values };
  };
  add('dbr', rules.dbr, rules.dbr?.bands);
  add('income', rules.income, { gross_salary_pct: rules.income?.gross_salary_pct, other_periodic_income_pct: rules.income?.other_periodic_income_pct });
  add('credit_card', rules.credit_card, { minimum_repayment_pct: rules.credit_card?.minimum_repayment_pct });
  add('ltv', rules.ltv, rules.ltv);
  add('rett', rules.rett, rules.rett);
  add('support', rules.support, rules.support);
  return out;
}

export function runFinancing(
  input: FinancingInput,
  products: FinancingProduct[],
  rules: RuleSet,
): FinancingResult {
  const missing: Note[] = [];
  const assumptions: Note[] = [];

  const capacity = calculateCapacity(input, rules, missing, assumptions);

  // Preferred-bank filter is a narrowing, not a hard requirement: if the rep
  // named banks, show those; otherwise show everything active.
  const pool = input.preferred_provider_keys?.length
    ? products.filter((p) => input.preferred_provider_keys!.includes(p.provider_key))
    : products;

  const matches = sortMatches(pool.map((p) => matchProduct(p, input, rules, capacity)));

  // Headline figures come from the best-evidenced VIABLE product, so the summary
  // and the comparison table cannot disagree.
  const viable = matches.filter(
    (m) => m.status === 'meets_published_criteria' || m.status === 'requires_bank_review' || m.status === 'rate_stale',
  );
  const lead = viable[0] ?? null;

  let maxFinancing = lead?.financing_amount ?? null;
  // With no priceable product we can still bound financing IF a rate exists
  // anywhere; otherwise the honest answer is null.
  if (maxFinancing === null && capacity.max_installment !== null) {
    const priceable = matches.find((m) => m.applied_rate_pct !== null);
    if (priceable && input.term_months) {
      maxFinancing = principalFromPayment(capacity.max_installment, priceable.applied_rate_pct!, input.term_months);
    }
  }

  const leadLtv = lead?.max_ltv_pct ?? null;
  let maxProperty: number | null = null;
  if (maxFinancing !== null && leadLtv !== null && leadLtv > 0) {
    const byLtv = round2(maxFinancing / (leadLtv / 100));
    const byCash = input.available_down_payment !== null ? round2(maxFinancing + input.available_down_payment) : null;
    maxProperty = byCash !== null ? Math.min(byLtv, byCash) : byLtv;
  }

  // ── Overall status ───────────────────────────────────────────────────────
  let status: ResultStatus;
  let confidence: Confidence;
  const defers = capacity.ceilings.some((c) => c.defers_to_bank);

  // Zero qualifying income is INSUFFICIENT INFORMATION, not a bank-review case.
  // Note the ceilings still compute to 0 here rather than null (0 × 55% = 0), so
  // this must key off the income itself — checking max_installment would let a
  // salary-less scenario present as though a bank merely needed to look at it.
  if (capacity.qualifying_income <= 0) {
    status = 'insufficient_information';
    confidence = 'unavailable';
  } else if (matches.length === 0) {
    status = 'pricing_unavailable';
    confidence = 'unavailable';
  } else if (viable.length === 0) {
    status = 'does_not_meet_published_criteria';
    confidence = 'medium';
  } else if (defers) {
    status = 'requires_bank_review';
    confidence = lead?.confidence ?? 'low';
  } else {
    status = lead!.status;
    confidence = lead!.confidence;
  }

  if (lead) missing.push(...lead.unknowns);

  if (rules.rett) {
    assumptions.push({
      code: 'rett',
      ar: `ضريبة التصرفات العقارية ${rules.rett.rate_pct}% مطبقة على قيمة الصفقة`,
      en: `Real estate transaction tax of ${rules.rett.rate_pct}% applied to the transaction value`,
    });
  }

  return {
    calculation_version: CALCULATION_VERSION,
    as_of_date: input.as_of_date,
    status,
    confidence,
    capacity,
    max_financing: maxFinancing,
    max_property_value: maxProperty,
    selected: input.property_price !== null ? lead : null,
    matches,
    assumptions,
    // De-duplicate by code so the same caveat is not listed five times.
    missing: missing.filter((m, i, arr) => arr.findIndex((x) => x.code === m.code) === i),
    rules_used: rulesUsed(rules),
    disclaimer_ar: DISCLAIMER_AR,
    disclaimer_en: DISCLAIMER_EN,
  };
}
