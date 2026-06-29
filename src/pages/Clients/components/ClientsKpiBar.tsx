import type { ClientKpis } from '../lib/clientFilters';
import type { Tone } from '../lib/lifecycleDisplay';
import { toneColor } from '../lib/lifecycleDisplay';

export type KpiKey = 'total' | 'open' | 'overdue' | 'noNextAction' | 'closedWon' | 'lostUnqualified' | 'atRisk' | 'withVisitRating';

interface KpiDef {
  key: KpiKey;
  label_ar: string;
  label_en: string;
  tone: Tone;
}

const DEFS: KpiDef[] = [
  { key: 'total', label_ar: 'إجمالي العملاء', label_en: 'Total clients', tone: 'neutral' },
  { key: 'open', label_ar: 'عملاء مفتوحون', label_en: 'Open', tone: 'info' },
  { key: 'overdue', label_ar: 'متأخرون', label_en: 'Overdue', tone: 'danger' },
  { key: 'noNextAction', label_ar: 'بلا إجراء تالٍ', label_en: 'No next action', tone: 'warning' },
  { key: 'closedWon', label_ar: 'مغلق ناجح', label_en: 'Closed won', tone: 'success' },
  { key: 'lostUnqualified', label_ar: 'خاسر / غير مؤهل', label_en: 'Lost / unqualified', tone: 'muted' },
  { key: 'atRisk', label_ar: 'في خطر', label_en: 'At risk', tone: 'warning' },
  { key: 'withVisitRating', label_ar: 'بتقييم زيارة', label_en: 'With visit rating', tone: 'info' },
];

interface ClientsKpiBarProps {
  kpis: ClientKpis;
  isAr: boolean;
  activeKey: KpiKey | null;
  onSelect: (key: KpiKey) => void;
}

/** Clickable KPI cards. Selecting one applies the matching quick filter. */
export default function ClientsKpiBar({ kpis, isAr, activeKey, onSelect }: ClientsKpiBarProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      {DEFS.map((d) => {
        const color = toneColor(d.tone);
        const active = activeKey === d.key;
        return (
          <button
            key={d.key}
            type="button"
            onClick={() => onSelect(d.key)}
            className={`card p-3.5 text-start transition hover:shadow-md ${active ? 'ring-2 ring-offset-1' : ''}`}
            style={active ? { boxShadow: `0 0 0 2px ${color}` } : undefined}
          >
            <div className="text-2xl font-extrabold leading-none" style={{ color }}>
              {kpis[d.key]}
            </div>
            <div className="mt-1.5 text-[11px] font-semibold leading-tight text-charcoal/60">
              {isAr ? d.label_ar : d.label_en}
            </div>
          </button>
        );
      })}
    </div>
  );
}
