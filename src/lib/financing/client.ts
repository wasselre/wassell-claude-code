/**
 * SPA client for /api/financing.
 *
 * Same bearer-attached, one-wrapper-per-action shape as the other feature
 * clients in this repo. The engine itself is NOT called from here — the server
 * runs it so the stored run is authoritative and cannot be shaped by a stale
 * browser bundle.
 */
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import type { EngineResult, ResultStatus, Confidence, MatchStatus, RateBasis } from './types';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/financing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    // Surface the server's own words: a 409 here is the consent gate and a 403
    // is an RLS refusal — both are actionable and a generic message hides that.
    throw new Error(b?.error ?? `financing ${action} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

// ── Shared vocabulary, bilingual ───────────────────────────────────────────

/** Deliberately no 'approved' entry — the status cannot be produced. */
export const RESULT_STATUS_LABEL: Record<ResultStatus, { ar: string; en: string }> = {
  indicative_match: { ar: 'مطابقة استرشادية', en: 'Indicative match' },
  potentially_suitable: { ar: 'قد يكون مناسبًا', en: 'Potentially suitable' },
  requires_bank_review: { ar: 'يتطلب مراجعة البنك', en: 'Requires bank review' },
  insufficient_information: { ar: 'معلومات غير كافية', en: 'Insufficient information' },
  product_data_unavailable: { ar: 'بيانات المنتج غير متوفرة', en: 'Product data unavailable' },
  product_data_stale: { ar: 'بيانات المنتج قديمة', en: 'Product data stale' },
  appears_outside_published_criteria: { ar: 'يبدو خارج الشروط المنشورة', en: 'Appears outside published criteria' },
  final_approval_required: { ar: 'يتطلب موافقة نهائية', en: 'Final approval required' },
};

export const STATUS_TONE: Record<ResultStatus, 'good' | 'warn' | 'neutral' | 'bad'> = {
  indicative_match: 'good',
  potentially_suitable: 'good',
  requires_bank_review: 'warn',
  insufficient_information: 'neutral',
  product_data_unavailable: 'neutral',
  product_data_stale: 'warn',
  appears_outside_published_criteria: 'bad',
  final_approval_required: 'warn',
};

export const CONFIDENCE_LABEL: Record<Confidence, { ar: string; en: string }> = {
  high: { ar: 'ثقة عالية', en: 'High confidence' },
  medium: { ar: 'ثقة متوسطة', en: 'Medium confidence' },
  low: { ar: 'ثقة منخفضة', en: 'Low confidence' },
  unavailable: { ar: 'غير متاح', en: 'Unavailable' },
};

/** How a displayed rate was arrived at. The UI must always show this next to
 *  any installment — it is the difference between a quote and a guess. */
export const RATE_BASIS_LABEL: Record<RateBasis, { ar: string; en: string }> = {
  contractual: { ar: 'سعر تعاقدي منشور', en: 'Published contractual rate' },
  range_midpoint: { ar: 'متوسط نطاق منشور', en: 'Midpoint of a published range' },
  starting_from: { ar: '"يبدأ من" — ليس سعرًا مخصصًا', en: '"Starting from" — not customer-specific' },
  example: { ar: 'من مثال توضيحي منشور', en: 'From a published example' },
  unavailable: { ar: 'غير متوفر', en: 'Unavailable' },
};

export const OBLIGATION_LABEL: Record<string, { ar: string; en: string }> = {
  personal_finance: { ar: 'تمويل شخصي', en: 'Personal finance' },
  mortgage: { ar: 'تمويل عقاري قائم', en: 'Existing mortgage' },
  auto_finance: { ar: 'تمويل سيارة', en: 'Auto finance' },
  auto_lease: { ar: 'تأجير سيارة', en: 'Auto lease' },
  credit_card: { ar: 'بطاقة ائتمانية', en: 'Credit card' },
  bnpl: { ar: 'اشترِ الآن وادفع لاحقًا', en: 'Buy now, pay later' },
  employer_loan: { ar: 'قرض من جهة العمل', en: 'Employer loan' },
  development_fund: { ar: 'صندوق تنمية', en: 'Development fund' },
  student_finance: { ar: 'تمويل دراسي', en: 'Student finance' },
  guarantee: { ar: 'كفالة', en: 'Guarantee' },
  alimony: { ar: 'نفقة', en: 'Alimony' },
  other: { ar: 'أخرى', en: 'Other' },
};

export const INCOME_LABEL: Record<string, { ar: string; en: string }> = {
  basic_salary: { ar: 'الراتب الأساسي', en: 'Basic salary' },
  housing_allowance: { ar: 'بدل السكن', en: 'Housing allowance' },
  other_allowance: { ar: 'بدلات أخرى', en: 'Other allowances' },
  pension: { ar: 'معاش تقاعدي', en: 'Pension' },
  commission: { ar: 'عمولات', en: 'Commission' },
  bonus: { ar: 'مكافآت', en: 'Bonus' },
  rental: { ar: 'دخل إيجاري', en: 'Rental income' },
  investment: { ar: 'دخل استثماري', en: 'Investment income' },
  business: { ar: 'دخل تجاري', en: 'Business income' },
  other_recurring: { ar: 'دخل متكرر آخر', en: 'Other recurring income' },
  government_support: { ar: 'دعم حكومي', en: 'Government support' },
};

export const DOC_STATUS_LABEL: Record<string, { ar: string; en: string }> = {
  undocumented: { ar: 'غير موثق', en: 'Undocumented' },
  self_declared: { ar: 'إقرار العميل', en: 'Self-declared' },
  payslip: { ar: 'مسير راتب', en: 'Payslip' },
  bank_statement: { ar: 'كشف حساب بنكي', en: 'Bank statement' },
  employer_letter: { ar: 'خطاب تعريف', en: 'Employer letter' },
  gosi: { ar: 'التأمينات الاجتماعية', en: 'GOSI' },
  contract: { ar: 'عقد', en: 'Contract' },
  other: { ar: 'أخرى', en: 'Other' },
};

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * SAR formatting.
 *
 * `precise = false` is the default and rounds to whole riyals, because printing
 * halalas on a figure derived from a "starting from" rate manufactures a
 * precision the underlying data does not have.
 */
export function formatSar(value: number | null | undefined, isAr: boolean, precise = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return isAr ? 'غير متاح' : 'N/A';
  const formatted = new Intl.NumberFormat(isAr ? 'ar-SA' : 'en-US', {
    minimumFractionDigits: precise ? 2 : 0,
    maximumFractionDigits: precise ? 2 : 0,
  }).format(value);
  return isAr ? `${formatted} ر.س` : `SAR ${formatted}`;
}

export function formatPct(value: number | null | undefined, isAr: boolean, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return isAr ? 'غير متاح' : 'N/A';
  return `${value.toFixed(digits)}%`;
}

export function formatMonths(months: number | null | undefined, isAr: boolean): string {
  if (months === null || months === undefined) return isAr ? 'غير متاح' : 'N/A';
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (rem === 0) return isAr ? `${years} سنة` : `${years} years`;
  return isAr ? `${years} سنة و${rem} شهر` : `${years}y ${rem}m`;
}

// ── Typed action wrappers ──────────────────────────────────────────────────

export interface DashboardResponse {
  scenarios: Array<Record<string, unknown>>;
  issues: Array<{
    id: string; severity: 'info' | 'warning' | 'error'; issue_type: string;
    message_en: string; message_ar: string | null; entity_type: string; created_at: string;
  }>;
  /** True when `issues` is a capped slice — the UI must say so rather than
   *  letting the visible list read as the whole queue. */
  issues_truncated: boolean;
  runs: Array<Record<string, unknown>>;
  health: {
    active_products: number;
    products_with_pricing: number;
    pricing_coverage_pct: number;
    stale_pricing: number;
    open_issues: number;
    last_refresh: Record<string, unknown> | null;
  };
}

export const financingApi = {
  dashboard: () => call<DashboardResponse>('dashboard'),
  reference: (asOf?: string) => call<Record<string, unknown>>('reference', asOf ? { as_of: asOf } : {}),
  scenarioList: (filters: Record<string, unknown> = {}) =>
    call<{ scenarios: Array<Record<string, unknown>> }>('scenario_list', filters),
  scenarioGet: (scenarioId: string) => call<Record<string, unknown>>('scenario_get', { scenario_id: scenarioId }),
  scenarioSave: (payload: Record<string, unknown>) => call<{ scenario_id: string }>('scenario_save', payload),
  scenarioDelete: (scenarioId: string) => call<{ ok: true }>('scenario_delete', { scenario_id: scenarioId }),
  scenarioDuplicate: (scenarioId: string, title?: string) =>
    call<{ scenario_id: string }>('scenario_duplicate', { scenario_id: scenarioId, title }),
  calculate: (scenarioId: string, mode: 'affordability' | 'property_payment' | 'comparison' | 'full' = 'full') =>
    call<{ run_id: string; result: EngineResult }>('calculate', { scenario_id: scenarioId, mode }),
  convertToCase: (scenarioId: string, productId?: string) =>
    call<{ financing_record_id: string; required_documents: string[] }>('convert_to_case', {
      scenario_id: scenarioId,
      product_id: productId,
    }),
  recordConsent: (scenarioId: string, granted: boolean, note?: string) =>
    call<{ ok: true }>('record_consent', { scenario_id: scenarioId, granted, note }),
  noteAdd: (scenarioId: string, body: string) => call<{ ok: true }>('note_add', { scenario_id: scenarioId, body }),
  adminData: () => call<Record<string, unknown>>('admin_data'),
  adminIssueUpdate: (issueId: string, status: string, note?: string) =>
    call<{ ok: true }>('admin_issue_update', { issue_id: issueId, status, note }),
  adminReviewDecide: (reviewId: string, decision: 'approved' | 'rejected', note: string) =>
    call<{ ok: true }>('admin_review_decide', { review_id: reviewId, decision, note }),
  adminProductRetire: (productId: string, reason: string, restore = false) =>
    call<{ ok: true }>('admin_product_retire', { product_id: productId, reason, restore }),
  adminVersionHistory: (productId: string) =>
    call<{ versions: Array<Record<string, unknown>>; rates: Array<Record<string, unknown>> }>(
      'admin_version_history',
      { product_id: productId },
    ),
};

/** True when the UI must NOT render a precise-looking installment. */
export function isApproximateNumber(rateBasis: RateBasis | null | undefined): boolean {
  return rateBasis !== 'contractual';
}

export function matchStatusLabel(status: MatchStatus, isAr: boolean): string {
  const l = RESULT_STATUS_LABEL[status as ResultStatus];
  return isAr ? l.ar : l.en;
}

/** Read the current language without subscribing — for non-React helpers. */
export function currentIsAr(): boolean {
  return useAppStore.getState().language === 'ar';
}
