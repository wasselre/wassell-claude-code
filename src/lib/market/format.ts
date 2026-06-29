/**
 * Formatting + bucketing helpers for Market Intelligence. Pure, no deps.
 * budgetBucket MIRRORS the SQL public.wassell_budget_bucket — keep in sync.
 */

export type BudgetBucket = 'all' | '<1M' | '1-2M' | '2-3M' | '3-5M' | '5M+';
export type BedroomsBucket = 'all' | '1-2' | '3' | '4' | '5+';

export const BUDGET_BUCKETS: BudgetBucket[] = ['<1M', '1-2M', '2-3M', '3-5M', '5M+'];
export const BEDROOMS_BUCKETS: BedroomsBucket[] = ['1-2', '3', '4', '5+'];

/** Bucket a max-budget number — mirror of wassell_budget_bucket(numeric). */
export function budgetBucket(val: number | null | undefined): BudgetBucket {
  if (val == null || !Number.isFinite(val) || val <= 0) return 'all';
  if (val < 1_000_000) return '<1M';
  if (val < 2_000_000) return '1-2M';
  if (val < 3_000_000) return '2-3M';
  if (val < 5_000_000) return '3-5M';
  return '5M+';
}

export function budgetBucketLabel(b: string, isAr: boolean): string {
  switch (b) {
    case 'all': return isAr ? 'كل الميزانيات' : 'All budgets';
    case '<1M': return isAr ? 'أقل من مليون' : 'Under 1M';
    case '1-2M': return isAr ? '1–2 مليون' : '1–2M';
    case '2-3M': return isAr ? '2–3 مليون' : '2–3M';
    case '3-5M': return isAr ? '3–5 مليون' : '3–5M';
    case '5M+': return isAr ? 'أكثر من 5 مليون' : '5M+';
    default: return b;
  }
}

export function bedroomsBucketLabel(b: string, isAr: boolean): string {
  if (b === 'all') return isAr ? 'كل الغرف' : 'All bedrooms';
  if (b === '5+') return isAr ? '5+ غرف' : '5+ beds';
  return isAr ? `${b} غرف` : `${b} beds`;
}

const AR_CUR = 'ر.س';

/** Format a SAR amount with Western digits + thousands separators. */
export function formatSAR(n: number | null | undefined, isAr: boolean): string {
  if (n == null || !Number.isFinite(n)) return isAr ? '—' : '—';
  const v = Math.round(n).toLocaleString('en-US');
  return isAr ? `${v} ${AR_CUR}` : `SAR ${v}`;
}

/** Compact SAR (e.g. 2.6M ر.س) for tight cells. */
export function formatSARCompact(n: number | null | undefined, isAr: boolean): string {
  if (n == null || !Number.isFinite(n)) return '—';
  let s: string;
  if (n >= 1_000_000) s = `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  else if (n >= 1_000) s = `${Math.round(n / 1_000)}K`;
  else s = `${Math.round(n)}`;
  return isAr ? `${s} ${AR_CUR}` : `SAR ${s}`;
}

/** Format price-per-m² (always with /m² unit). */
export function formatPpm2(n: number | null | undefined, isAr: boolean): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Math.round(n).toLocaleString('en-US');
  return isAr ? `${v} ${AR_CUR}/م²` : `SAR ${v}/m²`;
}

/** A signed percentage vs a reference, e.g. "+8%" / "−12%". */
export function formatPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const r = Math.round(pct);
  if (r > 0) return `+${r}%`;
  if (r < 0) return `−${Math.abs(r)}%`;
  return '0%';
}
