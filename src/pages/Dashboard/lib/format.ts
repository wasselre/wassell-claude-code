import type { WidgetNumberFormat } from '@/types';

/**
 * Format an analytics numeric value for display. Digits always render LTR (the
 * caller wraps them in `dir="ltr"` where needed); SAR shows as ر.س. Returns a
 * dash for null/non-finite so a missing avg/ratio never shows "NaN".
 */
export function formatNumber(value: number | null | undefined, fmt?: WidgetNumberFormat): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const f = fmt ?? {};
  let n = value;
  const decimals = f.decimals ?? (Number.isInteger(n) ? 0 : 2);

  if (f.compact && Math.abs(n) >= 1000) {
    const units: [number, string][] = [
      [1_000_000_000, 'B'],
      [1_000_000, 'M'],
      [1_000, 'K'],
    ];
    for (const [div, suffix] of units) {
      if (Math.abs(n) >= div) {
        const compact = (n / div).toLocaleString('en-US', { maximumFractionDigits: 1 });
        return withAffixes(`${compact}${suffix}`, f);
      }
    }
  }

  const body = n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: f.thousands_separator !== false,
  });
  return withAffixes(body, f);
}

function withAffixes(body: string, f: WidgetNumberFormat): string {
  if (f.percent) return `${body}%`;
  if (f.currency) return f.currency === 'SAR' ? `${body} ر.س` : `${body} ${f.currency}`;
  return body;
}
