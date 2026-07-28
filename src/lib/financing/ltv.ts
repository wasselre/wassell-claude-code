/**
 * LTV ceilings, down payment, and the upfront cash a customer actually needs.
 *
 * Regulatory basis (versioned, never literal):
 *   - Article 11 of the Implementing Regulation of the Real Estate Finance Law
 *     sets the base ceiling at 70% and lets SAMA vary it.
 *   - Circular 371000064087 (6/6/1437H) raised REAL ESTATE FINANCE COMPANIES
 *     (banks excluded) to 85%.
 *   - Circular 391000048362 (27/4/1439H) raised the FIRST HOME of CITIZENS to
 *     90%, leaving banks at 70% and finance companies at 85% for the second
 *     home and beyond.
 *
 * So the ceiling depends on THREE things at once — provider type, first-home
 * status, and citizenship. A single "max LTV" constant would be wrong for most
 * of the matrix, which is why the rule payload carries all four cells.
 */
import { round2 } from './money';
import type {
  ExplanationLine,
  FeeRuleRef,
  LtvRulePayload,
  ProviderRef,
  RuleVersion,
  SupportInput,
  TaxRuleVersion,
  UpfrontCash,
} from './types';

export interface LtvCeilingResult {
  ceiling_pct: number | null;
  basis: string;
  rule_version_id: string | null;
  /** Set when the customer's citizenship makes the first-home cell unavailable. */
  note: string | null;
}

/**
 * The regulatory LTV ceiling for this (provider type × first-home × citizenship)
 * combination.
 */
export function regulatoryLtvCeiling(params: {
  rule: RuleVersion<LtvRulePayload> | null;
  provider: ProviderRef;
  isFirstHome: boolean | null;
  isSaudi: boolean | null;
}): LtvCeilingResult {
  const { rule, provider, isFirstHome, isSaudi } = params;
  if (!rule) {
    return { ceiling_pct: null, basis: 'ltv_rule_missing', rule_version_id: null, note: null };
  }
  const p = rule.payload;
  const isFinanceCompany =
    provider.provider_type === 'real_estate_finance_company' || provider.provider_type === 'finance_company';

  // Unknown first-home status must NOT default to the generous cell. Falling
  // back to the additional-home ceiling is the conservative direction: it can
  // only understate capacity, never overstate it.
  if (isFirstHome !== true) {
    const pct = isFinanceCompany ? p.finance_company_additional_home_pct : p.bank_additional_home_pct;
    return {
      ceiling_pct: pct,
      basis: isFinanceCompany ? 'ltv_finance_company_additional_home' : 'ltv_bank_additional_home',
      rule_version_id: rule.id,
      note:
        isFirstHome === null
          ? 'First-home status was not stated; the additional-home ceiling was applied as the conservative assumption.'
          : null,
    };
  }

  // First home — but the higher ceiling is citizens-only.
  if (p.first_home_citizens_only && isSaudi !== true) {
    const pct = isFinanceCompany ? p.finance_company_additional_home_pct : p.bank_additional_home_pct;
    return {
      ceiling_pct: pct,
      basis: isFinanceCompany ? 'ltv_finance_company_additional_home' : 'ltv_bank_additional_home',
      rule_version_id: rule.id,
      note:
        isSaudi === null
          ? 'Nationality was not stated; the first-home ceiling applies to citizens only, so the lower ceiling was used.'
          : 'The 90% first-home ceiling applies to Saudi citizens only.',
    };
  }

  const pct = isFinanceCompany ? p.finance_company_first_home_pct : p.bank_first_home_pct;
  return {
    ceiling_pct: pct,
    basis: isFinanceCompany ? 'ltv_finance_company_first_home' : 'ltv_bank_first_home',
    rule_version_id: rule.id,
    note: null,
  };
}

/** Resolve a fee rule to an actual SAR amount for this deal. */
export function resolveFee(
  fee: FeeRuleRef,
  ctx: { financeAmount: number; propertyPrice: number },
): number | null {
  let amount: number | null = null;
  if (fee.amount_fixed !== null && fee.amount_fixed !== undefined) {
    amount = fee.amount_fixed;
  }
  if (fee.amount_pct !== null && fee.amount_pct !== undefined) {
    const base =
      fee.pct_base === 'property_price'
        ? ctx.propertyPrice
        : fee.pct_base === 'finance_amount' || fee.pct_base === 'outstanding_balance'
          ? ctx.financeAmount
          : null;
    if (base !== null) {
      const pctAmount = (base * fee.amount_pct) / 100;
      // When BOTH a fixed and a percentage figure are published, the published
      // wording is invariably "the lower of" (see the SAMA fee cap: 1% or SAR
      // 5,000, whichever is lower).
      amount = amount === null ? pctAmount : Math.min(amount, pctAmount);
    }
  }
  if (amount === null) return null;
  if (fee.cap_amount !== null && fee.cap_amount !== undefined) amount = Math.min(amount, fee.cap_amount);
  if (fee.floor_amount !== null && fee.floor_amount !== undefined) amount = Math.max(amount, fee.floor_amount);
  return round2(amount);
}

/**
 * Apply the regulator's cap on fees, whatever the provider published.
 * Consumer Financing Regulations, Art. 9: "All fees, costs and administrative
 * services charges … must not exceed the equivalent of (1%) of the Amount of
 * Financing or (5,000) five thousand Saudi riyals, whichever is lower."
 */
export function applyFeeCap(
  totalFees: number,
  financeAmount: number,
  cap: { pct_of_finance_amount: number; absolute_cap: number } | null,
): { amount: number; capped: boolean } {
  if (!cap) return { amount: round2(totalFees), capped: false };
  const pctCap = (financeAmount * cap.pct_of_finance_amount) / 100;
  const effectiveCap = Math.min(pctCap, cap.absolute_cap);
  if (totalFees > effectiveCap) return { amount: round2(effectiveCap), capped: true };
  return { amount: round2(totalFees), capped: false };
}

export interface UpfrontCashParams {
  propertyPrice: number;
  financeAmount: number;
  expectedValuation: number | null;
  additionalExpenses: number | null;
  availableCash: number | null;
  fees: FeeRuleRef[];
  feeCap: { pct_of_finance_amount: number; absolute_cap: number } | null;
  tax: TaxRuleVersion | null;
  support: SupportInput;
}

/**
 * Everything the customer must produce in cash at closing.
 *
 * The valuation gap is modelled explicitly because it is the classic surprise:
 * a bank lends against ITS valuation, so when the sale price exceeds the
 * valuation the customer covers the difference on top of the down payment.
 */
export function calculateUpfrontCash(params: UpfrontCashParams): UpfrontCash {
  const lines: ExplanationLine[] = [];
  const downPayment = round2(Math.max(0, params.propertyPrice - params.financeAmount));

  lines.push({
    code: 'down_payment',
    label_ar: 'الدفعة الأولى',
    label_en: 'Down payment',
    value: downPayment,
    basis: 'property_price_minus_finance_amount',
  });

  // Valuation below the sale price → the shortfall is unfinanceable cash.
  let valuationGap = 0;
  if (params.expectedValuation !== null && params.expectedValuation < params.propertyPrice) {
    valuationGap = round2(params.propertyPrice - params.expectedValuation);
    lines.push({
      code: 'valuation_gap',
      label_ar: 'الفرق بين سعر البيع وتقييم البنك',
      label_en: 'Gap between the sale price and the bank’s valuation',
      value: valuationGap,
      basis: 'sale_price_minus_valuation',
    });
  }

  const feeCtx = { financeAmount: params.financeAmount, propertyPrice: params.propertyPrice };
  let administrative: number | null = null;
  let valuation: number | null = null;
  let insurance: number | null = null;
  let otherMandatory = 0;

  for (const fee of params.fees) {
    if (!fee.payable_upfront) continue;
    const amount = resolveFee(fee, feeCtx);
    if (amount === null) continue;
    if (fee.fee_type === 'administrative') administrative = round2((administrative ?? 0) + amount);
    else if (fee.fee_type === 'valuation') valuation = round2((valuation ?? 0) + amount);
    else if (fee.fee_type === 'insurance_life' || fee.fee_type === 'insurance_property')
      insurance = round2((insurance ?? 0) + amount);
    else otherMandatory += amount;
  }

  // Regulatory cap applies to the aggregate of fees/costs/administrative charges.
  if (administrative !== null) {
    const capped = applyFeeCap(administrative, params.financeAmount, params.feeCap);
    if (capped.capped) {
      lines.push({
        code: 'fee_cap_applied',
        label_ar: 'تم تطبيق سقف الرسوم النظامي',
        label_en: 'The regulatory fee cap was applied (1% of the finance amount or SAR 5,000, whichever is lower)',
        value: capped.amount,
        basis: 'consumer_financing_art_9',
      });
    }
    administrative = capped.amount;
    lines.push({
      code: 'administrative_fee',
      label_ar: 'رسوم إدارية',
      label_en: 'Administrative fee',
      value: administrative,
      basis: 'product_fee_rule',
    });
  }
  if (valuation !== null) {
    lines.push({
      code: 'valuation_fee',
      label_ar: 'رسوم التقييم',
      label_en: 'Valuation fee',
      value: valuation,
      basis: 'product_fee_rule',
    });
  }
  if (insurance !== null) {
    lines.push({
      code: 'insurance',
      label_ar: 'التأمين',
      label_en: 'Insurance',
      value: insurance,
      basis: 'product_fee_rule',
    });
  }

  // ── Real Estate Transaction Tax ──────────────────────────────────────────
  // The tax is on the transaction, and by default the SELLER bears it. It only
  // becomes the buyer's upfront cash when the deal puts it there, so it is
  // reported as a separate line the rep can see rather than silently folded in.
  let transactionTax: number | null = null;
  let taxRelief: number | null = null;
  if (params.tax) {
    const base = params.propertyPrice;
    const gross = round2((base * params.tax.rate_pct) / 100);
    transactionTax = gross;
    lines.push({
      code: 'transaction_tax',
      label_ar: 'ضريبة التصرفات العقارية',
      label_en: 'Real estate transaction tax',
      value: gross,
      basis: `rett_${params.tax.rate_pct}pct`,
      version_id: params.tax.id,
    });

    // First-home relief: the State bears the tax up to a published cap.
    const eligibleForRelief =
      params.support.is_first_home === true &&
      params.support.previously_used_first_home_tax_support !== true &&
      params.tax.first_home_relief_cap !== null;
    if (eligibleForRelief && params.tax.first_home_relief_cap !== null) {
      const reliefBase = Math.min(base, params.tax.first_home_relief_cap);
      taxRelief = round2((reliefBase * params.tax.rate_pct) / 100);
      lines.push({
        code: 'first_home_tax_relief',
        label_ar: 'تحمل الدولة ضريبة التصرفات العقارية للمسكن الأول',
        label_en: 'State-borne first-home transaction tax',
        value: taxRelief,
        basis: `first_home_relief_cap_${params.tax.first_home_relief_cap}`,
        version_id: params.tax.id,
      });
    }
  }

  const other = round2((params.additionalExpenses ?? 0) + otherMandatory);
  if (other > 0) {
    lines.push({
      code: 'other_expenses',
      label_ar: 'مصاريف أخرى',
      label_en: 'Other transaction expenses',
      value: other,
      basis: 'entered_by_user',
    });
  }

  const total = round2(
    downPayment +
      valuationGap +
      (administrative ?? 0) +
      (valuation ?? 0) +
      (insurance ?? 0) +
      other +
      (transactionTax ?? 0) -
      (taxRelief ?? 0),
  );

  const shortfall =
    params.availableCash === null ? null : round2(Math.max(0, total - params.availableCash));

  return {
    down_payment: downPayment,
    valuation_gap: valuationGap,
    administrative_fee: administrative,
    valuation_fee: valuation,
    insurance,
    transaction_tax: transactionTax,
    tax_relief: taxRelief,
    other_expenses: other,
    total,
    shortfall,
    lines,
  };
}

/**
 * Maximum property value the customer can reach, given the financing their
 * income supports and the applicable LTV ceiling.
 *
 *   value ≤ financing / (LTV/100)      — the LTV constraint
 *   value ≤ financing + available cash — the cash constraint
 *
 * Whichever binds first is the honest answer.
 */
export function maxPropertyValue(params: {
  maxFinancing: number | null;
  ltvCeilingPct: number | null;
  availableCash: number | null;
}): { value: number | null; binding: string | null } {
  const { maxFinancing, ltvCeilingPct, availableCash } = params;
  if (maxFinancing === null || maxFinancing <= 0) return { value: null, binding: null };

  const candidates: Array<{ value: number; binding: string }> = [];
  if (ltvCeilingPct !== null && ltvCeilingPct > 0) {
    candidates.push({ value: round2(maxFinancing / (ltvCeilingPct / 100)), binding: 'ltv_ceiling' });
  }
  if (availableCash !== null) {
    candidates.push({ value: round2(maxFinancing + availableCash), binding: 'available_cash' });
  }
  if (candidates.length === 0) return { value: null, binding: null };

  let best = candidates[0]!;
  for (const c of candidates) if (c.value < best.value) best = c;
  return { value: best.value, binding: best.binding };
}
