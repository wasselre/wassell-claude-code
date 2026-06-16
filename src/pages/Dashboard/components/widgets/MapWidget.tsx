import { useAppStore } from '@/stores/appStore';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import { resultToChartData } from '../../lib/resultToChartData';
import { formatNumber } from '../../lib/format';
import { SAUDI_OUTLINE, matchCity } from '../../lib/saudiGeo';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizMap } from '@/types';

function rgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

/**
 * Map: a single-level grouped result (a city/region field) as a bubble map over
 * a built-in simplified Saudi outline — bubble area ∝ value, fill by intensity.
 * Self-contained (no tiles/keys). Group labels that don't match a known city are
 * counted in a footnote, never silently dropped. Bubbles drill to their records.
 */
export default function MapWidget({
  widget,
  result,
  onDrill,
}: {
  widget: DashboardWidget;
  result: AnalyticsResult | null;
  onDrill?: (recordIds: string[], title: string) => void;
}) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const viz = effectiveViz(widget) as VizMap;
  const base = viz.color ?? '#B8734F';
  const data = resultToChartData(result, isAr);

  const placed = data
    .map((d) => ({ d, c: matchCity(d.name) }))
    .filter((p): p is { d: (typeof data)[number]; c: NonNullable<ReturnType<typeof matchCity>> } => !!p.c);
  const unmatched = data.length - placed.length;
  const max = Math.max(1, ...placed.map((p) => p.d.value));

  return (
    <div className="relative h-full w-full">
      <svg viewBox="0 0 100 100" className="h-full w-full" preserveAspectRatio="xMidYMid meet">
        <path d={SAUDI_OUTLINE} fill="#F5EDE0" stroke="#D4B896" strokeWidth="0.6" strokeLinejoin="round" />
        {placed.map(({ d, c }, i) => {
          const r = 2 + Math.sqrt(d.value / max) * 7;
          return (
            <g key={d.raw + i} className={onDrill ? 'cursor-pointer' : ''} onClick={onDrill ? () => onDrill(d.recordIds ?? [], d.name) : undefined}>
              <title>{`${d.name}: ${formatNumber(d.value, viz.number_format)}`}</title>
              <circle cx={c.x} cy={c.y} r={r} fill={rgba(base, 0.3 + (d.value / max) * 0.55)} stroke={base} strokeWidth="0.4" />
            </g>
          );
        })}
      </svg>
      {unmatched > 0 && (
        <div className="absolute bottom-1 start-2 text-[10px] text-charcoal/40">
          {isAr ? `${unmatched} فئة خارج الخريطة` : `${unmatched} not on map`}
        </div>
      )}
      {placed.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-charcoal/40">
          {isAr ? 'لا مدن سعودية مطابقة' : 'No matching Saudi cities'}
        </div>
      )}
    </div>
  );
}
