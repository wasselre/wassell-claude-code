/**
 * Service 3 of 3 — product matching.
 *
 * Five statuses, no eligibility claims:
 *   meets_published_criteria · does_not_meet_published_criteria
 *   requires_bank_review · pricing_unavailable · rate_stale
 *
 * THE CENTRAL RULE: an unpublished criterion is neither a pass nor a fail.
 * Treating null as "no restriction" recommends products the customer cannot get;
 * treating it as "excluded" empties the list. Unknowns become
 * `requires_bank_review`, which a human can act on.
 */
import { groupDigits, round2 } from './money';
import { monthlyPayment, principalFromPayment, totalRepayment, upfrontCash } from './payment';
import type {
  Capacity,
  Confidence,
  FinancingInput,
  FinancingProduct,
  MatchStatus,
  Note,
  ProductMatch,
  RateBasis,
  RuleSet,
} from './types';

/** Pricing older than this reads as stale. */
export const RATE_STALE_DAYS = 120;

function daysSince(iso: string | null, asOf: string): number | null {
  if (!iso) return null;
  const a = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${asOf.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export function isRateStale(product: FinancingProduct, asOf: string): boolean {
  if (!product.rate) return false;
  if (product.rate.marked_stale) return true;
  if (product.rate.expires_at && product.rate.expires_at < asOf.slice(0, 10)) return true;
  const age = daysSince(product.rate.last_verified_at, asOf);
  return age !== null && age > RATE_STALE_DAYS;
}

/**
 * The regulatory LTV ceiling for this provider type × first-home × citizenship.
 *
 * Three inputs, because SAMA's circulars make it three: a bank's second-home
 * ceiling differs from a finance company's, and the 90% first-home cell is
 * citizens-only.
 */
export function regulatoryLtv(
  product: FinancingProduct,
  input: FinancingInput,
  rules: RuleSet,
): { pct: number | null; note: Note | null } {
  const r = rules.ltv;
  if (!r) return { pct: null, note: null };

  const isFinCo = product.provider_type === 'real_estate_finance_company';
  const additional = isFinCo ? r.finance_company_additional_home_pct : r.bank_additional_home_pct;
  const first = isFinCo ? r.finance_company_first_home_pct : r.bank_first_home_pct;

  // Unknown first-home status falls to the CONSERVATIVE cell. It can only
  // understate capacity, never overstate it.
  if (input.is_first_home !== true) {
    return {
      pct: additional,
      note: input.is_first_home === null
        ? { code: 'first_home_unknown', ar: 'حالة المسكن الأول غير محددة — طُبّق السقف الأقل تحفظًا', en: 'First-home status not stated; the lower ceiling was applied as the conservative assumption' }
        : null,
    };
  }
  if (r.first_home_citizens_only && input.nationality !== 'saudi') {
    return {
      pct: additional,
      note: { code: 'first_home_citizens_only', ar: 'سقف ٩٠٪ للمسكن الأول للمواطنين فقط', en: 'The 90% first-home ceiling applies to Saudi citizens only' },
    };
  }
  return { pct: first, note: null };
}

/**
 * Resolve the rate to use, and record how trustworthy it is.
 *
 * Only a CONTRACTUAL published rate or a rep-entered bank QUOTATION earns an
 * exact payment. A "starting from" figure or a representative example yields a
 * rate basis that the caller must not price from — that is the safeguard V1
 * established and V2 keeps verbatim.
 */
export function resolveRate(
  product: FinancingProduct,
  input: FinancingInput,
): { rate_pct: number | null; basis: RateBasis; note: Note | null } {
  // A quotation for THIS provider always wins — it is the most specific fact.
  if (input.quoted_rate_pct !== null && input.quoted_rate_provider_key === product.provider_key) {
    return {
      rate_pct: input.quoted_rate_pct,
      basis: 'quotation',
      note: { code: 'quoted_rate', ar: 'سعر مُدخل من عرض البنك', en: 'Rate taken from a bank quotation entered by the sales rep' },
    };
  }

  const rate = product.rate;
  if (!rate) {
    return { rate_pct: null, basis: 'unavailable', note: null };
  }

  if (rate.disclosure_type === 'exact_rate' && rate.contractual_rate_pct !== null) {
    return { rate_pct: rate.contractual_rate_pct, basis: 'contractual', note: null };
  }

  if (rate.disclosure_type === 'starting_from') {
    return {
      rate_pct: null,
      basis: 'starting_from',
      note: {
        code: 'starting_from',
        ar: 'الرقم المنشور "يبدأ من" وليس سعر العميل — القسط الدقيق يتطلب عرضًا من البنك',
        en: 'The published figure is a "starting from" rate, not the customer’s rate. An exact payment requires a bank quotation.',
      },
    };
  }

  if (rate.disclosure_type === 'representative_example') {
    const assumptions: string[] = [];
    if (rate.example?.property_price) assumptions.push(`property SAR ${rate.example.property_price}`);
    if (rate.example?.term_months) assumptions.push(`${Math.round(rate.example.term_months / 12)} years`);
    if (rate.example?.ltv_pct) assumptions.push(`${rate.example.ltv_pct}% LTV`);
    return {
      rate_pct: null,
      basis: 'example',
      note: {
        code: 'representative_example',
        ar: 'السعر من مثال توضيحي منشور بافتراضات محددة — القسط الدقيق يتطلب عرضًا من البنك',
        en: `Rate is from the bank’s published example (${assumptions.join(', ') || 'assumptions not published'}). An exact payment requires a bank quotation.`,
      },
    };
  }

  return {
    rate_pct: null,
    basis: 'unavailable',
    note: { code: 'quotation_required', ar: 'يتطلب عرض سعر من البنك', en: 'Exact calculation requires a bank quotation' },
  };
}

/** Check the published criteria. Unknowns accumulate rather than deciding. */
function checkCriteria(product: FinancingProduct, input: FinancingInput): { fails: Note[]; unknowns: Note[]; passes: Note[] } {
  const fails: Note[] = [];
  const unknowns: Note[] = [];
  const passes: Note[] = [];

  // Nationality
  if (product.nationality === null) {
    unknowns.push({ code: 'nationality_unpublished', ar: 'شروط الجنسية غير منشورة', en: 'Nationality criteria are not published' });
  } else if (input.nationality === null) {
    unknowns.push({ code: 'nationality_unknown', ar: 'جنسية العميل غير محددة', en: 'Customer nationality was not stated' });
  } else if (!product.nationality.includes(input.nationality)) {
    fails.push({
      code: 'nationality_ineligible',
      ar: input.nationality === 'saudi' ? 'المنتج غير متاح للمواطنين' : 'المنتج غير متاح للمقيمين',
      en: input.nationality === 'saudi' ? 'Not available to Saudi citizens' : 'Not available to residents',
    });
  } else {
    passes.push({ code: 'nationality_ok', ar: 'الجنسية مطابقة', en: 'Nationality matches the published criteria' });
  }

  // Salary threshold — which one applies depends on salary transfer.
  const threshold = input.willing_to_transfer_salary === false && product.min_salary_no_transfer !== null
    ? product.min_salary_no_transfer
    : product.min_salary;
  const salary = input.gross_monthly_salary;
  if (threshold === null) {
    unknowns.push({ code: 'min_salary_unpublished', ar: 'الحد الأدنى للراتب غير منشور', en: 'No minimum salary is published' });
  } else if (salary === null || salary <= 0) {
    unknowns.push({ code: 'salary_unknown', ar: 'راتب العميل غير محدد', en: 'Customer salary was not recorded' });
  } else if (salary < threshold) {
    fails.push({
      code: 'below_min_salary',
      ar: `الراتب أقل من الحد الأدنى المنشور (${threshold})`,
      en: `Salary is below the published minimum of SAR ${threshold}`,
    });
  } else {
    passes.push({ code: 'min_salary_ok', ar: 'الراتب يستوفي الحد الأدنى', en: 'Salary meets the published minimum' });
  }

  // Salary transfer
  if (product.requires_salary_transfer === true) {
    if (input.willing_to_transfer_salary === false) {
      fails.push({ code: 'transfer_required', ar: 'المنتج يشترط تحويل الراتب والعميل غير موافق', en: 'This product requires salary transfer, which the customer declined' });
    } else if (input.willing_to_transfer_salary === null) {
      unknowns.push({ code: 'transfer_unknown', ar: 'موافقة تحويل الراتب غير محددة', en: 'Willingness to transfer salary was not recorded' });
    } else {
      passes.push({ code: 'transfer_ok', ar: 'العميل موافق على تحويل الراتب', en: 'The customer will transfer salary' });
    }
  }

  // Age at maturity — usually what shortens the term.
  const age = input.age ?? (input.date_of_birth ? ageFrom(input.date_of_birth, input.as_of_date) : null);
  if (product.max_age_at_maturity !== null) {
    if (age === null) {
      unknowns.push({ code: 'age_unknown', ar: 'عمر العميل غير محدد', en: 'Age was not recorded, so the maturity-age limit could not be checked' });
    } else if (input.term_months) {
      const atMaturity = age + Math.ceil(input.term_months / 12);
      if (atMaturity > product.max_age_at_maturity) {
        fails.push({
          code: 'age_at_maturity',
          ar: `العمر عند نهاية التمويل (${atMaturity}) يتجاوز ${product.max_age_at_maturity}`,
          en: `Age at maturity (${atMaturity}) exceeds the published maximum of ${product.max_age_at_maturity}`,
        });
      }
    }
  }
  if (product.min_age !== null && age !== null && age < product.min_age) {
    fails.push({ code: 'below_min_age', ar: `العمر أقل من ${product.min_age}`, en: `Age is below the published minimum of ${product.min_age}` });
  }

  // Employment sector / type
  if (product.employment_sectors && input.employment_sector && !product.employment_sectors.includes(input.employment_sector)) {
    fails.push({ code: 'sector_ineligible', ar: 'قطاع جهة العمل خارج الفئات المنشورة', en: 'Employer sector is outside the published categories' });
  }
  if (product.employment_types && input.employment_type && !product.employment_types.includes(input.employment_type)) {
    fails.push({ code: 'employment_ineligible', ar: 'نوع التوظيف خارج الفئات المنشورة', en: 'Employment type is outside the published categories' });
  }

  // Supported vs unsupported
  const supported = input.sakani_redf_status === 'confirmed' || input.sakani_redf_status === 'self_declared';
  if (product.supported_financing === 'supported' && !supported) {
    fails.push({ code: 'supported_only', ar: 'المنتج لمستفيدي الدعم فقط', en: 'This product is for supported (Sakani/REDF) beneficiaries only' });
  }
  if (product.supported_financing === 'unsupported' && supported) {
    fails.push({ code: 'unsupported_only', ar: 'المنتج غير متاح لمستفيدي الدعم', en: 'This product is not available to supported beneficiaries' });
  }

  // Property type
  if (product.property_types && input.property_type && !product.property_types.includes(input.property_type)) {
    fails.push({ code: 'property_type_ineligible', ar: 'نوع العقار غير مشمول', en: 'The property type is not covered by this product' });
  }

  // Things no bank publishes. These ALWAYS need a human, and saying so is the
  // honest outcome — V1 learned this the hard way.
  if (product.criteria?.requires_approved_employer === true) {
    unknowns.push({
      code: 'approved_employer',
      ar: 'يشترط جهة عمل معتمدة — القوائم غير منشورة ويتطلب تأكيد البنك',
      en: 'Requires an approved employer; those lists are not published and need bank confirmation',
    });
  }
  if (input.project_record_id) {
    unknowns.push({
      code: 'project_approval',
      ar: 'اعتماد البنك للمشروع غير مؤكد',
      en: 'Bank approval of this project is not verified',
    });
  }

  return { fails, unknowns, passes };
}

function ageFrom(dobIso: string, onIso: string): number | null {
  const [dy, dm, dd] = dobIso.slice(0, 10).split('-').map(Number);
  const [oy, om, od] = onIso.slice(0, 10).split('-').map(Number);
  if (!dy || !dm || !dd || !oy || !om || !od) return null;
  let years = oy - dy;
  if (om < dm || (om === dm && od < dd)) years -= 1;
  return years;
}

const CONF_ORDER: Confidence[] = ['unavailable', 'low', 'medium', 'high'];
function worst(values: Confidence[]): Confidence {
  return values.reduce((acc, v) => (CONF_ORDER.indexOf(v) < CONF_ORDER.indexOf(acc) ? v : acc), 'high' as Confidence);
}

/** Evaluate and price one product for this customer. */
export function matchProduct(
  product: FinancingProduct,
  input: FinancingInput,
  rules: RuleSet,
  capacity: Capacity,
): ProductMatch {
  const { fails, unknowns, passes } = checkCriteria(product, input);
  const ltv = regulatoryLtv(product, input, rules);
  if (ltv.note) unknowns.push(ltv.note);

  // Tighter of the regulatory ceiling and the product's own cap.
  const maxLtv = [ltv.pct, product.max_ltv_pct].filter((v): v is number => v !== null && v !== undefined);
  const effectiveLtv = maxLtv.length ? Math.min(...maxLtv) : null;

  const rate = resolveRate(product, input);
  if (rate.note) unknowns.push(rate.note);
  const stale = isRateStale(product, input.as_of_date);

  // ── Status ───────────────────────────────────────────────────────────────
  let status: MatchStatus;
  if (fails.length > 0) status = 'does_not_meet_published_criteria';
  else if (stale) status = 'rate_stale';
  else if (rate.basis === 'unavailable' && !product.rate) status = 'pricing_unavailable';
  else if (unknowns.length > 0) status = 'requires_bank_review';
  else status = 'meets_published_criteria';

  // ── Amounts ──────────────────────────────────────────────────────────────
  const term = input.term_months ?? product.max_term_months ?? 240;
  const price = input.property_price;
  let financing: number | null = null;
  let payment: number | null = null;
  let repayment: number | null = null;

  // A product the customer does not qualify for gets NO figures. A row reading
  // "does not meet published criteria — SAR 2,199/mo" invites a rep to quote the
  // 2,199 and ignore the status; suppressing the number removes the temptation.
  const eligible = fails.length === 0;
  const canPrice = eligible && rate.rate_pct !== null && (rate.basis === 'contractual' || rate.basis === 'quotation');

  if (!eligible) {
    // Leave financing / down payment / upfront null as well — a full costing for
    // an ineligible product is the same trap in a different column.
    financing = null;
  } else if (price !== null && price > 0) {
    const byLtv = effectiveLtv !== null ? (price * effectiveLtv) / 100 : null;
    const byDown = input.available_down_payment !== null ? price - input.available_down_payment : null;
    const caps = [byLtv, byDown, product.max_amount].filter((v): v is number => v !== null && v !== undefined);
    financing = caps.length ? round2(Math.max(0, Math.min(...caps))) : null;

    // Income capacity can bind tighter than the property — but only computable
    // when we have a real rate.
    if (canPrice && capacity.max_installment !== null && capacity.max_installment > 0) {
      const byCapacity = principalFromPayment(capacity.max_installment, rate.rate_pct!, term);
      if (financing === null || byCapacity < financing) financing = byCapacity;
    }
  } else if (canPrice && capacity.max_installment !== null && capacity.max_installment > 0) {
    financing = principalFromPayment(capacity.max_installment, rate.rate_pct!, term);
  }

  if (canPrice && financing !== null && financing > 0) {
    payment = monthlyPayment(financing, rate.rate_pct!, term);
    repayment = totalRepayment(payment, term);
  }

  const effectivePrice = price ?? (financing !== null && effectiveLtv ? round2(financing / (effectiveLtv / 100)) : null);
  const upfront = effectivePrice !== null && financing !== null
    ? upfrontCash({
        propertyPrice: effectivePrice,
        financingAmount: financing,
        availableCash: input.available_down_payment,
        isFirstHome: input.is_first_home,
        rett: rules.rett,
      })
    : null;

  // Surface the two facts a rep would otherwise have to infer.
  if (upfront?.shortfall !== null && upfront?.shortfall !== undefined && upfront.shortfall > 0) {
    unknowns.push({
      code: 'cash_shortfall',
      ar: `النقد المطلوب مقدمًا يتجاوز الدفعة المتاحة المعلنة بمقدار ${groupDigits(upfront.shortfall)} ريال`,
      en: `The cash needed at closing exceeds the stated available down payment by SAR ${groupDigits(upfront.shortfall)}`,
    });
  }
  if (financing !== null && !canPrice) {
    unknowns.push({
      code: 'financing_not_capacity_tested',
      ar: 'مبلغ التمويل المعروض محدود بالدفعة المقدمة ونسبة التمويل فقط — لم يُختبر مقابل القدرة الشهرية لعدم توفر سعر',
      en: 'The financing amount shown is limited only by the down payment and the LTV ceiling. With no rate available it has NOT been tested against monthly capacity, so it is not comparable to a priced product.',
    });
  }

  const confidence: Confidence = worst([
    product.confidence as Confidence,
    product.rate ? (product.rate.confidence as Confidence) : 'unavailable',
    canPrice ? 'high' : 'low',
    stale ? 'low' : 'high',
    unknowns.length > 0 ? 'medium' : 'high',
  ]);

  return {
    product,
    status,
    confidence,
    reasons: [...passes, ...fails],
    unknowns,
    max_ltv_pct: effectiveLtv,
    financing_amount: financing,
    down_payment: upfront?.down_payment ?? null,
    ltv_pct: effectivePrice && financing !== null && effectivePrice > 0 ? round2((financing / effectivePrice) * 100) : null,
    upfront_cash: upfront?.total ?? null,
    cash_shortfall: upfront?.shortfall ?? null,
    financing_not_capacity_tested: financing !== null && !canPrice,
    monthly_payment: payment,
    total_repayment: repayment,
    applied_rate_pct: canPrice ? rate.rate_pct : null,
    rate_basis: rate.basis,
    published_apr_pct: product.rate?.published_apr_pct ?? product.rate?.starting_apr_pct ?? null,
    rate_source_url: product.rate?.source_url ?? product.official_url ?? null,
    rate_verified_at: product.rate?.last_verified_at ?? null,
    is_stale: stale,
  };
}

/** Rank: viable statuses first, then better-evidenced, then cheaper. */
export function sortMatches(matches: ProductMatch[]): ProductMatch[] {
  const rank: Record<MatchStatus, number> = {
    meets_published_criteria: 0,
    requires_bank_review: 1,
    rate_stale: 2,
    pricing_unavailable: 3,
    does_not_meet_published_criteria: 4,
  };
  return matches.slice().sort((a, b) => {
    const s = rank[a.status] - rank[b.status];
    if (s !== 0) return s;
    const c = CONF_ORDER.indexOf(b.confidence) - CONF_ORDER.indexOf(a.confidence);
    if (c !== 0) return c;
    return (a.monthly_payment ?? Infinity) - (b.monthly_payment ?? Infinity);
  });
}
