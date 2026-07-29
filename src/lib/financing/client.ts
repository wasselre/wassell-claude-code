/**
 * SPA client for /api/financing, plus the bilingual vocabulary the UI renders.
 *
 * The engine is NOT called from here — the server runs it so the stored snapshot
 * is authoritative.
 */
import { supabase } from '@/lib/supabase';
import type { FinancingProduct, FinancingResult, MatchStatus, RateBasis, ResultStatus, RuleSet } from './types';

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
    // 409 is the consent gate or a frozen snapshot; 403 is an RLS refusal. Both
    // are actionable, so the server's own words are surfaced.
    throw new Error(b?.error ?? `financing ${action} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** 'approved' is deliberately absent — it does not exist in this system. */
export const STATUS_LABEL: Record<ResultStatus, { ar: string; en: string }> = {
  meets_published_criteria: { ar: 'يستوفي الشروط المنشورة', en: 'Meets published criteria' },
  does_not_meet_published_criteria: { ar: 'لا يستوفي الشروط المنشورة', en: 'Does not meet published criteria' },
  requires_bank_review: { ar: 'يتطلب مراجعة البنك', en: 'Requires bank review' },
  pricing_unavailable: { ar: 'التسعير غير متوفر', en: 'Pricing unavailable' },
  rate_stale: { ar: 'السعر قديم', en: 'Rate stale' },
  insufficient_information: { ar: 'معلومات غير كافية', en: 'Insufficient information' },
};

export const STATUS_TONE: Record<ResultStatus, 'good' | 'warn' | 'bad' | 'neutral'> = {
  meets_published_criteria: 'good',
  does_not_meet_published_criteria: 'bad',
  requires_bank_review: 'warn',
  pricing_unavailable: 'neutral',
  rate_stale: 'warn',
  insufficient_information: 'neutral',
};

/** The chip that must appear beside any payment. */
export const RATE_BASIS_LABEL: Record<RateBasis, { ar: string; en: string; exact: boolean }> = {
  contractual: { ar: 'سعر تعاقدي منشور', en: 'Published contractual rate', exact: true },
  quotation: { ar: 'عرض سعر من البنك', en: 'Bank quotation', exact: true },
  starting_from: { ar: '«يبدأ من» — ليس سعر العميل', en: '"Starting from" — not the customer’s rate', exact: false },
  example: { ar: 'من مثال توضيحي منشور', en: 'From a published example', exact: false },
  unavailable: { ar: 'يتطلب عرض سعر', en: 'Requires a bank quotation', exact: false },
};

export const CONFIDENCE_LABEL = {
  high: { ar: 'ثقة عالية', en: 'High confidence' },
  medium: { ar: 'ثقة متوسطة', en: 'Medium confidence' },
  low: { ar: 'ثقة منخفضة', en: 'Low confidence' },
  unavailable: { ar: 'غير متاح', en: 'Unavailable' },
} as const;

export function formatSar(value: number | null | undefined, isAr: boolean): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return isAr ? 'غير متاح' : 'N/A';
  const n = new Intl.NumberFormat(isAr ? 'ar-SA' : 'en-US', { maximumFractionDigits: 0 }).format(value);
  return isAr ? `${n} ر.س` : `SAR ${n}`;
}

export function formatPct(value: number | null | undefined, isAr: boolean): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return isAr ? 'غير متاح' : 'N/A';
  return `${value.toFixed(2)}%`;
}

export function formatYears(months: number | null | undefined, isAr: boolean): string {
  if (!months) return isAr ? 'غير متاح' : 'N/A';
  const y = Math.round(months / 12);
  return isAr ? `${y} سنة` : `${y} years`;
}

export const financingApi = {
  reference: () => call<{ products: FinancingProduct[]; rules: RuleSet }>('reference'),
  scenarioList: (filters: Record<string, unknown> = {}) =>
    call<{ scenarios: Array<Record<string, unknown>> }>('scenario_list', filters),
  scenarioGet: (id: string) => call<{ scenario: Record<string, unknown> }>('scenario_get', { scenario_id: id }),
  scenarioSave: (payload: Record<string, unknown>) => call<{ scenario_id: string }>('scenario_save', payload),
  calculate: (id: string) => call<{ result: FinancingResult }>('calculate', { scenario_id: id }),
  recordConsent: (id: string, granted: boolean) => call<{ ok: true }>('record_consent', { scenario_id: id, granted }),
  convertToCase: (id: string) => call<{ financing_record_id: string }>('convert_to_case', { scenario_id: id }),
  adminData: () => call<{
    products: Array<Record<string, unknown>>;
    rates: Array<Record<string, unknown>>;
    rules: Array<Record<string, unknown>>;
  }>('admin_data'),
  adminProductSave: (product: Record<string, unknown>, productId?: string) =>
    call<{ product_id: string }>('admin_product_save', { product, product_id: productId }),
  adminRateAdd: (rate: Record<string, unknown>) => call<{ rate_id: string }>('admin_rate_add', { rate }),
  adminRateStale: (rateId: string, stale = true) => call<{ ok: true }>('admin_rate_stale', { rate_id: rateId, stale }),
  adminProductRetire: (productId: string, restore = false) =>
    call<{ ok: true }>('admin_product_retire', { product_id: productId, restore }),
};

/**
 * A saved `result_snapshot` is frozen forever, including snapshots written by an
 * engine whose vocabulary no longer exists. Every label lookup below must
 * therefore be TOTAL: an unrecognised value shows the raw value, it does not
 * throw. A blank page is a far worse outcome than an untranslated word.
 */
export function statusLabel(status: MatchStatus | ResultStatus | string, isAr: boolean): string {
  const l = STATUS_LABEL[status as ResultStatus];
  if (!l) return String(status);
  return isAr ? l.ar : l.en;
}

export function statusTone(status: MatchStatus | ResultStatus | string): 'good' | 'warn' | 'bad' | 'neutral' {
  return STATUS_TONE[status as ResultStatus] ?? 'neutral';
}

export function rateBasisLabel(basis: RateBasis | string): { ar: string; en: string; exact: boolean } {
  return RATE_BASIS_LABEL[basis as RateBasis] ?? { ar: String(basis), en: String(basis), exact: false };
}

export function confidenceLabel(c: string): { ar: string; en: string } {
  return (CONFIDENCE_LABEL as Record<string, { ar: string; en: string }>)[c] ?? { ar: String(c), en: String(c) };
}

/**
 * How a bank disclosed its pricing — the field that decides whether an exact
 * payment is possible at all, so it must read as a sentence in the admin table
 * rather than as a raw enum value.
 */
export function disclosureLabel(kind: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    exact_rate: { ar: 'سعر تعاقدي منشور', en: 'Published contractual rate' },
    starting_from: { ar: '"يبدأ من" — ليس سعر العميل', en: '"Starting from" — not the customer’s rate' },
    representative_example: { ar: 'مثال توضيحي منشور', en: 'Published representative example' },
    none: { ar: 'لا إفصاح — يتطلب عرض سعر', en: 'No disclosure — quotation required' },
  };
  const l = map[kind];
  return l ? (isAr ? l.ar : l.en) : kind;
}

/**
 * True when a snapshot predates V2. V2 always stamps `calculation_version`;
 * V1 stamped `engine_version` and used a different status vocabulary and match
 * shape, so its results must be shown as recorded rather than re-rendered.
 */
export function isLegacySnapshot(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  return !('calculation_version' in (result as Record<string, unknown>));
}
