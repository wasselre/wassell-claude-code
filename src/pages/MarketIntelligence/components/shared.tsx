/** Small shared atoms for the Market Intelligence surface. */
import type { ReactNode } from 'react';
import type { ConfidenceGrade } from '@/lib/market/types';

export function ConfidencePill({ grade, isAr }: { grade: ConfidenceGrade | null; isAr: boolean }) {
  const map: Record<string, { ar: string; en: string; cls: string }> = {
    high: { ar: 'ثقة مرتفعة', en: 'High confidence', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    medium: { ar: 'ثقة متوسطة', en: 'Medium confidence', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    low: { ar: 'ثقة منخفضة', en: 'Low confidence', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  };
  const m = grade ? map[grade] : null;
  if (!m) return <span className="text-xs text-charcoal/40">—</span>;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${m.cls}`}>
      {isAr ? m.ar : m.en}
    </span>
  );
}

export function SourcePill({ source, isAr }: { source: string; isAr: boolean }) {
  const asking = { ar: 'السوق المعروض', en: 'Asking market', cls: 'bg-sand/30 text-charcoal border-sand/40' };
  const map: Record<string, { ar: string; en: string; cls: string }> = {
    asking,
    transaction: { ar: 'صفقات فعلية', en: 'Transactions', cls: 'bg-copper/15 text-terracotta border-copper/30' },
    our_verified: { ar: 'مخزون وصل', en: 'Wassel verified', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  };
  const m = map[source] ?? asking;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${m.cls}`}>{isAr ? m.ar : m.en}</span>;
}

/** A loud, always-visible caveat strip — never bury methodology in tiny text. */
export function CaveatStrip({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-800">
      {children}
    </div>
  );
}

export function Section({ title, subtitle, children, right }: { title: string; subtitle?: string; children: ReactNode; right?: ReactNode }) {
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

export function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-sand/50 bg-cream/40 px-4 py-8 text-center text-sm text-charcoal/50">{children}</div>;
}
