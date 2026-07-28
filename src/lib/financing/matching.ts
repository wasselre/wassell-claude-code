/**
 * Product eligibility matching and rate resolution.
 *
 * THE CENTRAL RULE OF THIS FILE: an unknown criterion is NOT a pass and NOT a
 * fail. Saudi banks publish a fraction of their eligibility grid, so a matcher
 * that treats `null` as "no restriction" will confidently recommend products
 * the customer cannot get, and one that treats `null` as "excluded" will show
 * an empty list. Both are wrong. Unknowns are collected into
 * `unknown_criteria`, and their presence downgrades the match to
 * `requires_bank_review` — a status a human can act on.
 */
import { ageOn, daysBetween, round2 } from './money';
import type {
  ApplicantInput,
  Confidence,
  EligibilityRuleRef,
  EngineInput,
  ExplanationLine,
  MatchStatus,
  MissingInformation,
  ProductRef,
  RateBasis,
  RateVersionRef,
} from './types';

export interface EligibilityOutcome {
  status: MatchStatus;
  match_reasons: ExplanationLine[];
  exclusion_reasons: ExplanationLine[];
  unknown_criteria: MissingInformation[];
}

interface CheckCtx {
  input: EngineInput;
  primary: ApplicantInput | null;
  product: ProductRef;
  requestedAmount: number | null;
  termMonths: number | null;
}

function unknown(code: string, ar: string, en: string): MissingInformation {
  return { code, label_ar: ar, label_en: en, impact: 'requires_bank_confirmation' };
}

/**
 * Evaluate one product against the customer profile.
 *
 * Hard exclusions (published criterion the customer demonstrably fails) end the
 * evaluation with `appears_outside_published_criteria` — deliberately hedged
 * wording, because our copy of the criteria may be incomplete or stale and the
 * bank is the authority, not us.
 */
export function evaluateEligibility(ctx: CheckCtx): EligibilityOutcome {
  const { input, primary, product } = ctx;
  const match: ExplanationLine[] = [];
  const exclude: ExplanationLine[] = [];
  const unknowns: MissingInformation[] = [];
  const version = product.version;

  if (!version) {
    return {
      status: 'product_data_unavailable',
      match_reasons: [],
      exclusion_reasons: [
        {
          code: 'no_product_version',
          label_ar: 'لا تتوفر بيانات منشورة لهذا المنتج',
          label_en: 'No published product data is available for this product',
          basis: 'product_version_missing',
        },
      ],
      unknown_criteria: [],
    };
  }

  // ── Nationality ──────────────────────────────────────────────────────────
  const nationality = primary?.nationality_type ?? null;
  if (nationality === null) {
    unknowns.push(unknown('nationality_unknown', 'جنسية العميل غير محددة', 'Customer nationality was not stated'));
  } else if (nationality === 'saudi' && version.applies_to_saudi === false) {
    exclude.push({
      code: 'not_for_saudi',
      label_ar: 'المنتج غير متاح للمواطنين',
      label_en: 'This product is not available to Saudi citizens',
      basis: 'applies_to_saudi',
    });
  } else if (nationality === 'resident' && version.applies_to_resident === false) {
    exclude.push({
      code: 'not_for_resident',
      label_ar: 'المنتج غير متاح للمقيمين',
      label_en: 'This product is not available to residents',
      basis: 'applies_to_resident',
    });
  } else if (
    (nationality === 'saudi' && version.applies_to_saudi === true) ||
    (nationality === 'resident' && version.applies_to_resident === true)
  ) {
    match.push({
      code: 'nationality_ok',
      label_ar: 'الجنسية مطابقة لشروط المنتج',
      label_en: 'Nationality matches the product’s published criteria',
      basis: 'applies_to_saudi/resident',
    });
  } else {
    unknowns.push(
      unknown('nationality_criteria_unpublished', 'شروط الجنسية غير منشورة', 'The product does not publish its nationality criteria'),
    );
  }

  // ── Salary threshold ─────────────────────────────────────────────────────
  // Which threshold applies depends on salary transfer, and banks publish two
  // different numbers for exactly that reason (Al Rajhi: 7,000 with transfer,
  // 10,000 without).
  const willTransfer = primary?.willing_to_transfer_salary ?? null;
  const grossSalary = input.incomes
    .filter((i) => i.applicant_role === 'primary' && i.income_type === 'basic_salary')
    .reduce((sum, i) => sum + (i.verified_monthly_amount ?? i.declared_monthly_amount ?? 0), 0);

  const applicableMinSalary =
    willTransfer === false && version.min_salary_no_transfer !== null
      ? version.min_salary_no_transfer
      : version.min_salary;

  if (applicableMinSalary === null) {
    unknowns.push(
      unknown('min_salary_unpublished', 'الحد الأدنى للراتب غير منشور', 'The product does not publish a minimum salary'),
    );
  } else if (grossSalary <= 0) {
    unknowns.push(unknown('salary_unknown', 'راتب العميل غير محدد', 'The customer’s salary was not recorded'));
  } else if (grossSalary < applicableMinSalary) {
    exclude.push({
      code: 'below_min_salary',
      label_ar: `الراتب أقل من الحد الأدنى (${applicableMinSalary})`,
      label_en: `Salary is below the published minimum of SAR ${applicableMinSalary}`,
      value: applicableMinSalary,
      basis: willTransfer === false ? 'min_salary_no_transfer' : 'min_salary',
    });
  } else {
    match.push({
      code: 'min_salary_ok',
      label_ar: 'الراتب يستوفي الحد الأدنى المنشور',
      label_en: 'Salary meets the published minimum',
      value: applicableMinSalary,
      basis: willTransfer === false ? 'min_salary_no_transfer' : 'min_salary',
    });
  }

  // ── Salary transfer requirement ──────────────────────────────────────────
  if (version.requires_salary_transfer === true) {
    if (willTransfer === false) {
      exclude.push({
        code: 'salary_transfer_required',
        label_ar: 'المنتج يشترط تحويل الراتب والعميل غير موافق',
        label_en: 'This product requires salary transfer, which the customer declined',
        basis: 'requires_salary_transfer',
      });
    } else if (willTransfer === null) {
      unknowns.push(
        unknown('salary_transfer_unknown', 'موافقة تحويل الراتب غير محددة', 'Willingness to transfer salary was not recorded'),
      );
    } else {
      match.push({
        code: 'salary_transfer_ok',
        label_ar: 'العميل موافق على تحويل الراتب',
        label_en: 'The customer is willing to transfer salary',
        basis: 'requires_salary_transfer',
      });
    }
  }

  // ── Age at application and at maturity ───────────────────────────────────
  const dob = primary?.date_of_birth ?? null;
  const age = dob ? ageOn(dob, input.as_of_date) : null;
  if (age === null) {
    if (version.min_age_years !== null || version.max_age_at_maturity !== null) {
      unknowns.push(unknown('age_unknown', 'تاريخ ميلاد العميل غير محدد', 'Date of birth was not recorded, so age limits could not be checked'));
    }
  } else {
    if (version.min_age_years !== null && age < version.min_age_years) {
      exclude.push({
        code: 'below_min_age',
        label_ar: `العمر أقل من الحد الأدنى (${version.min_age_years})`,
        label_en: `Age is below the published minimum of ${version.min_age_years}`,
        value: version.min_age_years,
        basis: 'min_age_years',
      });
    }
    if (version.max_age_at_application !== null && age > version.max_age_at_application) {
      exclude.push({
        code: 'above_max_age',
        label_ar: `العمر يتجاوز الحد الأقصى عند التقديم (${version.max_age_at_application})`,
        label_en: `Age exceeds the published maximum at application (${version.max_age_at_application})`,
        value: version.max_age_at_application,
        basis: 'max_age_at_application',
      });
    }
    // Maturity age is what usually shortens the term, so it is checked against
    // the REQUESTED term rather than treated as a pass/fail on age alone.
    if (version.max_age_at_maturity !== null && ctx.termMonths !== null) {
      const ageAtMaturity = age + Math.ceil(ctx.termMonths / 12);
      if (ageAtMaturity > version.max_age_at_maturity) {
        exclude.push({
          code: 'age_at_maturity_exceeded',
          label_ar: `العمر عند نهاية التمويل يتجاوز ${version.max_age_at_maturity}`,
          label_en: `Age at maturity (${ageAtMaturity}) exceeds the published maximum of ${version.max_age_at_maturity}`,
          value: version.max_age_at_maturity,
          basis: 'max_age_at_maturity',
        });
      }
    }
  }

  // ── Employment ───────────────────────────────────────────────────────────
  const employment = primary?.employment_type ?? null;
  if (version.employment_types && version.employment_types.length > 0) {
    if (employment === null) {
      unknowns.push(unknown('employment_unknown', 'نوع التوظيف غير محدد', 'Employment type was not recorded'));
    } else if (!version.employment_types.includes(employment)) {
      exclude.push({
        code: 'employment_not_eligible',
        label_ar: 'نوع التوظيف خارج الفئات المنشورة',
        label_en: 'Employment type is outside the published eligible categories',
        basis: 'employment_types',
      });
    }
  }
  if (employment === 'retiree' && version.retiree_eligible === false) {
    exclude.push({
      code: 'retiree_not_eligible',
      label_ar: 'المنتج غير متاح للمتقاعدين',
      label_en: 'This product is not available to retirees',
      basis: 'retiree_eligible',
    });
  }

  // ── Employer sector / approved-employer list ─────────────────────────────
  if (version.requires_approved_employer === true) {
    // We do not hold banks' approved-employer lists — they are not published.
    // Saying so is the honest outcome; guessing would be a fabricated approval.
    unknowns.push(
      unknown(
        'approved_employer_unverified',
        'يشترط أن يكون جهة العمل معتمدة لدى الممول — يتطلب تأكيد البنك',
        'The product requires an approved employer; approved-employer lists are not published and require bank confirmation',
      ),
    );
  }
  if (version.employer_sectors && version.employer_sectors.length > 0) {
    const sector = primary?.employer_sector ?? null;
    if (sector === null) {
      unknowns.push(unknown('employer_sector_unknown', 'قطاع جهة العمل غير محدد', 'Employer sector was not recorded'));
    } else if (!version.employer_sectors.includes(sector)) {
      exclude.push({
        code: 'employer_sector_not_eligible',
        label_ar: 'قطاع جهة العمل خارج الفئات المنشورة',
        label_en: 'Employer sector is outside the published eligible categories',
        basis: 'employer_sectors',
      });
    }
  }

  // ── Service length ───────────────────────────────────────────────────────
  if (version.min_employment_months !== null) {
    const service = primary?.service_months ?? null;
    if (service === null) {
      unknowns.push(unknown('service_months_unknown', 'مدة الخدمة غير محددة', 'Length of service was not recorded'));
    } else if (service < version.min_employment_months) {
      exclude.push({
        code: 'below_min_service',
        label_ar: `مدة الخدمة أقل من ${version.min_employment_months} شهرًا`,
        label_en: `Length of service is below the published minimum of ${version.min_employment_months} months`,
        value: version.min_employment_months,
        basis: 'min_employment_months',
      });
    }
  }

  // ── Property type / status ───────────────────────────────────────────────
  const propType = input.property.property_type;
  const propStatus = input.property.property_status;
  if (version.property_types && version.property_types.length > 0 && propType !== null) {
    if (!version.property_types.includes(propType)) {
      exclude.push({
        code: 'property_type_not_eligible',
        label_ar: 'نوع العقار غير مشمول بالمنتج',
        label_en: 'The property type is not covered by this product',
        basis: 'property_types',
      });
    }
  }
  if (version.property_status && version.property_status.length > 0 && propStatus !== null) {
    if (!version.property_status.includes(propStatus)) {
      exclude.push({
        code: 'property_status_not_eligible',
        label_ar: 'حالة العقار غير مشمولة بالمنتج',
        label_en: 'The property status is not covered by this product',
        basis: 'property_status',
      });
    }
  }

  // ── Supported vs unsupported financing ───────────────────────────────────
  const kind = input.support.financing_kind;
  if (kind === 'supported' && version.supported_financing === false) {
    exclude.push({
      code: 'not_for_supported',
      label_ar: 'المنتج غير متاح لمستفيدي الدعم',
      label_en: 'This product is not available to supported (REDF/Sakani) beneficiaries',
      basis: 'supported_financing',
    });
  }
  if (kind === 'unsupported' && version.unsupported_financing === false) {
    exclude.push({
      code: 'not_for_unsupported',
      label_ar: 'المنتج مخصص لمستفيدي الدعم فقط',
      label_en: 'This product is for supported beneficiaries only',
      basis: 'unsupported_financing',
    });
  }

  // ── Amount and term envelopes ────────────────────────────────────────────
  if (ctx.requestedAmount !== null) {
    if (version.min_amount !== null && ctx.requestedAmount < version.min_amount) {
      exclude.push({
        code: 'below_min_amount',
        label_ar: `مبلغ التمويل أقل من الحد الأدنى (${version.min_amount})`,
        label_en: `Requested amount is below the product minimum of SAR ${version.min_amount}`,
        value: version.min_amount,
        basis: 'min_amount',
      });
    }
    if (version.max_amount !== null && ctx.requestedAmount > version.max_amount) {
      exclude.push({
        code: 'above_max_amount',
        label_ar: `مبلغ التمويل يتجاوز الحد الأقصى (${version.max_amount})`,
        label_en: `Requested amount exceeds the product maximum of SAR ${version.max_amount}`,
        value: version.max_amount,
        basis: 'max_amount',
      });
    }
  }
  if (ctx.termMonths !== null) {
    if (version.min_term_months !== null && ctx.termMonths < version.min_term_months) {
      exclude.push({
        code: 'below_min_term',
        label_ar: 'مدة التمويل أقل من الحد الأدنى',
        label_en: `Term is below the product minimum of ${version.min_term_months} months`,
        value: version.min_term_months,
        basis: 'min_term_months',
      });
    }
    if (version.max_term_months !== null && ctx.termMonths > version.max_term_months) {
      exclude.push({
        code: 'above_max_term',
        label_ar: 'مدة التمويل تتجاوز الحد الأقصى',
        label_en: `Term exceeds the product maximum of ${version.max_term_months} months`,
        value: version.max_term_months,
        basis: 'max_term_months',
      });
    }
  }

  // ── Structured eligibility rules ─────────────────────────────────────────
  // Criteria that cannot be expressed as a flat column. Evaluated generically
  // so adding a new published criterion is a DATA change, not a code change.
  for (const rule of version.eligibility_rules ?? []) {
    const outcome = evaluateEligibilityRule(rule, buildRuleContext(input, primary));
    if (outcome === 'unknown') {
      unknowns.push(
        unknown(
          `rule_unknown_${rule.rule_key}`,
          rule.label_ar ?? rule.label_en,
          `Could not evaluate the published criterion: ${rule.label_en}`,
        ),
      );
    } else if (outcome === 'fail') {
      const line = {
        code: `rule_failed_${rule.rule_key}`,
        label_ar: rule.failure_message_ar ?? rule.label_ar ?? rule.label_en,
        label_en: rule.failure_message_en ?? rule.label_en,
        basis: rule.rule_key,
      };
      // A soft rule lowers confidence; a hard one excludes the product.
      if (rule.is_hard_requirement) exclude.push(line);
      else unknowns.push(unknown(line.code, line.label_ar, line.label_en));
    } else {
      match.push({
        code: `rule_passed_${rule.rule_key}`,
        label_ar: rule.label_ar ?? rule.label_en,
        label_en: rule.label_en,
        basis: rule.rule_key,
      });
    }
  }

  // ── Verdict ──────────────────────────────────────────────────────────────
  if (exclude.length > 0) {
    return {
      status: 'appears_outside_published_criteria',
      match_reasons: match,
      exclusion_reasons: exclude,
      unknown_criteria: unknowns,
    };
  }
  if (!product.rate) {
    return { status: 'product_data_unavailable', match_reasons: match, exclusion_reasons: [], unknown_criteria: unknowns };
  }
  if (unknowns.length > 0) {
    return { status: 'requires_bank_review', match_reasons: match, exclusion_reasons: [], unknown_criteria: unknowns };
  }
  // Everything published was checked and passed. Still only "indicative".
  return { status: 'indicative_match', match_reasons: match, exclusion_reasons: [], unknown_criteria: [] };
}

/**
 * The value space a structured eligibility rule may address.
 *
 * Deliberately a FLAT, explicitly-built map rather than reflection over the raw
 * input: a rule that names a path we do not expose evaluates to 'unknown' and
 * says so, instead of silently reading `undefined` and passing.
 */
export function buildRuleContext(input: EngineInput, primary: ApplicantInput | null): Record<string, unknown> {
  const primaryGrossSalary = input.incomes
    .filter((i) => i.applicant_role === 'primary' && (i.income_type === 'basic_salary' || i.income_type === 'housing_allowance'))
    .reduce((sum, i) => sum + (i.verified_monthly_amount ?? i.declared_monthly_amount ?? 0), 0);
  const totalDeclaredIncome = input.incomes.reduce(
    (sum, i) => sum + (i.verified_monthly_amount ?? i.declared_monthly_amount ?? 0),
    0,
  );
  return {
    'income.primary_gross_salary': primaryGrossSalary > 0 ? primaryGrossSalary : null,
    'income.total_declared': totalDeclaredIncome > 0 ? totalDeclaredIncome : null,
    'applicant.nationality_type': primary?.nationality_type ?? null,
    'applicant.employment_type': primary?.employment_type ?? null,
    'applicant.employer_sector': primary?.employer_sector ?? null,
    'applicant.service_months': primary?.service_months ?? null,
    'applicant.willing_to_transfer_salary': primary?.willing_to_transfer_salary ?? null,
    'applicant.age': primary?.date_of_birth ? ageOn(primary.date_of_birth, input.as_of_date) : null,
    'property.price': input.property.property_price,
    'property.type': input.property.property_type,
    'property.status': input.property.property_status,
    'property.city': input.property.city,
    'support.is_first_home': input.support.is_first_home,
    'support.financing_kind': input.support.financing_kind,
    'support.redf_eligible': input.support.redf_eligible,
  };
}

/** Evaluate one structured rule. 'unknown' when the customer's value is absent. */
export function evaluateEligibilityRule(
  rule: EligibilityRuleRef,
  ctx: Record<string, unknown>,
): 'pass' | 'fail' | 'unknown' {
  if (!(rule.field_path in ctx)) return 'unknown';
  const actual = ctx[rule.field_path];
  if (actual === null || actual === undefined) return 'unknown';

  const n = typeof actual === 'number' ? actual : null;
  const s = typeof actual === 'string' ? actual : null;
  const b = typeof actual === 'boolean' ? actual : null;

  switch (rule.operator) {
    case 'gte': return n !== null && rule.value_numeric !== null ? (n >= rule.value_numeric ? 'pass' : 'fail') : 'unknown';
    case 'lte': return n !== null && rule.value_numeric !== null ? (n <= rule.value_numeric ? 'pass' : 'fail') : 'unknown';
    case 'gt':  return n !== null && rule.value_numeric !== null ? (n > rule.value_numeric ? 'pass' : 'fail') : 'unknown';
    case 'lt':  return n !== null && rule.value_numeric !== null ? (n < rule.value_numeric ? 'pass' : 'fail') : 'unknown';
    case 'between':
      return n !== null && rule.value_numeric !== null && rule.value_numeric_2 !== null
        ? (n >= rule.value_numeric && n <= rule.value_numeric_2 ? 'pass' : 'fail')
        : 'unknown';
    case 'eq':
      if (rule.value_numeric !== null && n !== null) return n === rule.value_numeric ? 'pass' : 'fail';
      if (rule.value_text !== null && s !== null) return s === rule.value_text ? 'pass' : 'fail';
      if (rule.value_boolean !== null && b !== null) return b === rule.value_boolean ? 'pass' : 'fail';
      return 'unknown';
    case 'neq':
      if (rule.value_numeric !== null && n !== null) return n !== rule.value_numeric ? 'pass' : 'fail';
      if (rule.value_text !== null && s !== null) return s !== rule.value_text ? 'pass' : 'fail';
      if (rule.value_boolean !== null && b !== null) return b !== rule.value_boolean ? 'pass' : 'fail';
      return 'unknown';
    case 'in':
      return rule.value_list && s !== null ? (rule.value_list.includes(s) ? 'pass' : 'fail') : 'unknown';
    case 'not_in':
      return rule.value_list && s !== null ? (!rule.value_list.includes(s) ? 'pass' : 'fail') : 'unknown';
    case 'boolean':
      return b !== null && rule.value_boolean !== null ? (b === rule.value_boolean ? 'pass' : 'fail') : 'unknown';
    case 'exists':
      return 'pass'; // the null/undefined guard above already handled absence
    default:
      return 'unknown';
  }
}

export interface ResolvedRate {
  rate_pct: number | null;
  basis: RateBasis;
  /** Confidence contributed by the rate alone. */
  confidence: Confidence;
  note_ar: string | null;
  note_en: string | null;
}

/**
 * Turn a published rate disclosure into the number the schedule will use — and,
 * critically, record HOW honest that number is.
 *
 * The dangerous case this exists to prevent: a bank advertises "APR starts from
 * 5.96%". That is neither a contractual profit rate nor this customer's APR. If
 * we quietly feed it into the amortisation formula and print an instalment to
 * the halala, we have manufactured false precision. So a starting-from figure
 * produces a number tagged `starting_from` with LOW confidence, and every
 * surface that renders it must show the tag.
 */
export function resolveRate(rate: RateVersionRef | null, benchmarkRatePct: number | null): ResolvedRate {
  if (!rate) {
    return {
      rate_pct: null,
      basis: 'unavailable',
      confidence: 'unavailable',
      note_ar: 'لا تتوفر بيانات تسعير منشورة',
      note_en: 'No published pricing data is available',
    };
  }

  // Variable products: benchmark + margin, using the latest observation.
  if (rate.rate_type === 'variable' && rate.margin_pct !== null) {
    if (benchmarkRatePct === null) {
      return {
        rate_pct: null,
        basis: 'unavailable',
        confidence: 'unavailable',
        note_ar: 'المؤشر المرجعي غير متوفر لحساب السعر المتغير',
        note_en: 'The benchmark observation needed to price this variable product is unavailable',
      };
    }
    return {
      rate_pct: round2(benchmarkRatePct + rate.margin_pct),
      basis: 'contractual',
      confidence: 'medium',
      note_ar: 'سعر متغير = المؤشر + هامش البنك، ويتغير عند إعادة التسعير',
      note_en: 'Variable rate = benchmark + bank margin; it changes at each reset',
    };
  }

  switch (rate.rate_disclosure_type) {
    case 'exact_rate':
      if (rate.contractual_rate_pct !== null) {
        return { rate_pct: rate.contractual_rate_pct, basis: 'contractual', confidence: 'high', note_ar: null, note_en: null };
      }
      break;

    case 'published_range': {
      const lo = rate.contractual_rate_min_pct;
      const hi = rate.contractual_rate_max_pct;
      if (lo !== null && hi !== null) {
        return {
          rate_pct: round2((lo + hi) / 2),
          basis: 'range_midpoint',
          confidence: 'low',
          note_ar: `السعر المنشور نطاق بين ${lo}% و${hi}% — استُخدم المتوسط للتقدير`,
          note_en: `The published rate is a range of ${lo}%–${hi}%; the midpoint was used for this estimate`,
        };
      }
      break;
    }

    case 'starting_from':
    case 'promotional': {
      // Prefer the contractual "from" rate. Falling back to a "from" APR is a
      // deliberate approximation and is labelled as one.
      const from = rate.contractual_rate_pct ?? rate.contractual_rate_min_pct;
      if (from !== null) {
        return {
          rate_pct: from,
          basis: 'starting_from',
          confidence: 'low',
          note_ar: 'السعر المنشور هو "يبدأ من" وليس سعرًا مخصصًا للعميل',
          note_en: 'The published figure is a "starting from" rate, not a customer-specific rate',
        };
      }
      const aprFrom = rate.published_apr_pct ?? rate.published_apr_min_pct;
      if (aprFrom !== null) {
        return {
          rate_pct: aprFrom,
          basis: 'starting_from',
          confidence: 'low',
          note_ar:
            'لم يُنشر سعر الربح التعاقدي؛ استُخدم أدنى معدل نسبة سنوية منشور كتقريب، والقسط الفعلي يتطلب عرضًا من البنك',
          note_en:
            'No contractual profit rate is published; the lowest published APR was used as an approximation. An exact installment requires a bank quotation.',
        };
      }
      break;
    }

    case 'representative_example': {
      // The example's own rate applies to the example's own assumptions. Using
      // it for a different amount/term is an approximation, so: low confidence
      // and an explicit note naming the example's assumptions.
      const exampleRate = rate.contractual_rate_pct ?? rate.published_apr_pct;
      if (exampleRate !== null) {
        const assumptions: string[] = [];
        if (rate.example_property_price) assumptions.push(`property SAR ${rate.example_property_price}`);
        if (rate.example_amount) assumptions.push(`finance SAR ${rate.example_amount}`);
        if (rate.example_term_months) assumptions.push(`${Math.round(rate.example_term_months / 12)} years`);
        if (rate.example_ltv_pct) assumptions.push(`${rate.example_ltv_pct}% LTV`);
        return {
          rate_pct: exampleRate,
          basis: 'example',
          confidence: 'low',
          note_ar: 'السعر مأخوذ من مثال توضيحي منشور بافتراضات محددة، وقد يختلف لهذا العميل',
          note_en: `Rate taken from the provider’s published representative example (${assumptions.join(', ') || 'assumptions not published'}); the customer’s rate may differ`,
        };
      }
      break;
    }

    case 'quotation_required':
    default:
      break;
  }

  return {
    rate_pct: null,
    basis: 'unavailable',
    confidence: 'unavailable',
    note_ar: 'يتطلب عرض سعر من الممول لتحديد القسط',
    note_en: 'A quotation from the provider is required to determine the installment',
  };
}

/** Days since the pricing data was last verified (or collected). */
export function dataAgeDays(rate: RateVersionRef | null, asOf: string): number | null {
  if (!rate) return null;
  const reference = rate.verified_at ?? rate.collected_at;
  if (!reference) return null;
  return daysBetween(reference.slice(0, 10), asOf);
}

/** Whether pricing has aged past the configured freshness policy. */
export function isPricingStale(rate: RateVersionRef | null, asOf: string, freshnessDays: number): boolean {
  const age = dataAgeDays(rate, asOf);
  if (age === null) return true;
  return age > freshnessDays;
}
