// InventoryMeter — the live "how much of OUR inventory fits this client" number,
// shown while the rep qualifies on a call. Deterministic: the number comes from the
// Project Finder (mode:'count'); this component only renders the state the
// useOwnInventoryCount hook produces. No matching logic here.

import { Loader2, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { OwnInventoryCount } from '../hooks/useOwnInventoryCount';
import type { CorePref, InventoryBand } from '@/lib/matching/inventoryBands';

const CORE_LABELS: Record<CorePref, { ar: string; en: string }> = {
  location: { ar: 'الموقع', en: 'Location' },
  budget: { ar: 'الميزانية', en: 'Budget' },
  unit_type: { ar: 'نوع الوحدة', en: 'Unit type' },
};

/** Band → accent color + optional qualifier chip text. Factual, not coaching. */
const BAND_STYLE: Record<InventoryBand, { color: string; ar: string | null; en: string | null }> = {
  broad: { color: '#3B82F6', ar: 'النطاق واسع', en: 'Broad' },
  healthy: { color: '#10B981', ar: null, en: null },
  narrow: { color: '#C09B5F', ar: 'نطاق ضيّق', en: 'Narrow' },
  zero: { color: '#8E4E3A', ar: null, en: null },
};

function MissingChips({ missing, isAr }: { missing: CorePref[]; isAr: boolean }) {
  if (missing.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {missing.map((m, i) => (
        <span key={m} className="text-xs text-charcoal/60">
          {i > 0 ? <span className="text-charcoal/30">· </span> : null}
          {isAr ? CORE_LABELS[m].ar : CORE_LABELS[m].en}
        </span>
      ))}
    </div>
  );
}

export default function InventoryMeter({ state }: { state: OwnInventoryCount }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const { status, count, band, missing, stale } = state;

  const title = isAr ? 'مخزوننا المناسب' : 'Our matching inventory';

  return (
    <section className="card p-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold text-chocolate">{title}</h2>
        {stale ? <RefreshCw size={13} className="animate-spin text-charcoal/40" /> : null}
      </div>

      {status === 'incomplete' ? (
        <div>
          <p className="text-sm text-charcoal/70">
            {isAr ? 'أضف المزيد من التفضيلات لعرض نتائج أدق' : 'Add more preferences for more precise results'}
          </p>
          <MissingChips missing={missing} isAr={isAr} />
        </div>
      ) : status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-charcoal/60">
          <Loader2 size={14} className="animate-spin" />
          {isAr ? 'جارٍ حساب المخزون…' : 'Checking inventory…'}
        </p>
      ) : status === 'error' ? (
        <p className="text-sm text-terracotta">
          {isAr ? 'تعذّر حساب المخزون — سيُعاد المحاولة عند التعديل' : 'Could not check inventory — will retry on edit'}
        </p>
      ) : band === 'zero' ? (
        <div className={stale ? 'opacity-60' : ''}>
          <p className="text-sm font-semibold" style={{ color: BAND_STYLE.zero.color }}>
            {isAr ? 'لا مشاريع مناسبة بهذه التفضيلات' : 'No matching projects for these preferences'}
          </p>
        </div>
      ) : (
        <div className={stale ? 'opacity-60' : ''}>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold tabular-nums" style={{ color: band ? BAND_STYLE[band].color : '#4A4E54' }} dir="ltr">
              {count}
            </span>
            <span className="text-sm text-charcoal/70">
              {isAr ? 'من مشاريعنا مناسبة' : 'Wassell projects'}
            </span>
            {band && BAND_STYLE[band].ar ? (
              <span
                className="badge"
                style={{ backgroundColor: `${BAND_STYLE[band].color}1A`, color: BAND_STYLE[band].color }}
              >
                {isAr ? BAND_STYLE[band].ar : BAND_STYLE[band].en}
              </span>
            ) : null}
          </div>
          {/* When the search is still broad, name the core prefs not yet set — factual
              qualification guidance, no relaxation/AI coaching. */}
          {band === 'broad' ? <MissingChips missing={missing} isAr={isAr} /> : null}
        </div>
      )}
    </section>
  );
}
