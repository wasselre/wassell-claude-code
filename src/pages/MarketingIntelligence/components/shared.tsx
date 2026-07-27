/**
 * Shared primitives for the Marketing Intelligence page.
 *
 * The recurring failure of this platform is a confidently-wrong number: rollups
 * that mixed speculative attributions into project activity (~4x inflation), a
 * job queue that read 684-succeeded / 0-failed while its OCR step was dead, and
 * a backlog alert that counted a status the schema forbids. So the primitives
 * here are deliberately biased toward disclosure — `Stat` renders "—" rather
 * than 0 for an unmeasurable value, and every capped list gets a `ShownOf`.
 */
import type { ReactNode } from 'react';

export function Section({
  title, subtitle, right, children,
}: { title: string; subtitle?: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-charcoal">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-charcoal/55">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/**
 * A number with its label. `value === null` renders an em dash, NOT a zero —
 * "we cannot see this yet" and "this is zero" are different claims and the
 * organization-intelligence backend deliberately distinguishes them
 * (`growth_measurable`, `change_pct`).
 */
export function Stat({
  label, value, hint, tone = 'default',
}: { label: string; value: number | string | null; hint?: string; tone?: 'default' | 'muted' | 'warn' }) {
  const toneClass =
    tone === 'warn' ? 'text-amber-700' : tone === 'muted' ? 'text-charcoal/50' : 'text-charcoal';
  return (
    <div className="rounded-xl border border-sand/50 bg-cream-light px-3.5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-charcoal/45">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${toneClass}`}>
        {value === null || value === '' ? '—' : typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] leading-snug text-charcoal/45">{hint}</div>}
    </div>
  );
}

export function SeverityPill({ severity, isAr }: { severity: string; isAr: boolean }) {
  const map: Record<string, { cls: string; ar: string; en: string }> = {
    critical: { cls: 'bg-red-50 text-red-700 border-red-200', ar: 'حرج', en: 'Critical' },
    warning: { cls: 'bg-amber-50 text-amber-800 border-amber-200', ar: 'تنبيه', en: 'Warning' },
    // `opportunity` is emitted by new_offer_detected — a competitor move worth
    // acting on, not a problem. Green, so it does not read as an incident.
    opportunity: { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', ar: 'فرصة', en: 'Opportunity' },
    info: { cls: 'bg-sky-50 text-sky-700 border-sky-200', ar: 'معلومة', en: 'Info' },
  };
  const m = map[severity] ?? map.info!;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${m.cls}`}>
      {isAr ? m.ar : m.en}
    </span>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'copper' }) {
  const cls = tone === 'copper'
    ? 'border-copper/30 bg-copper/10 text-copper-500'
    : 'border-sand/60 bg-cream text-charcoal/70';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

/** A capped list must say it is capped. A silently truncated list reads as "that is all there is". */
export function ShownOf({ shown, total, isAr }: { shown: number; total: number; isAr: boolean }) {
  if (total <= shown) return <span className="text-[12px] text-charcoal/45">{total.toLocaleString()}</span>;
  return (
    <span className="text-[12px] text-charcoal/55">
      {isAr
        ? `عرض ${shown.toLocaleString()} من ${total.toLocaleString()}`
        : `showing ${shown.toLocaleString()} of ${total.toLocaleString()}`}
    </span>
  );
}

export function CaveatStrip({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] leading-relaxed text-amber-800">
      {children}
    </div>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-sand/70 bg-cream-light px-4 py-8 text-center text-[13px] text-charcoal/50">
      {children}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-14 text-[13px] text-charcoal/50">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-copper/30 border-t-copper" />
      {label}
    </div>
  );
}

export function fmtDate(iso: string | null, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** SAR, compact. Returns null (not "0") when there is no price to show. */
export function fmtPrice(n: number | null): string | null {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}
