import { useAppStore } from '@/stores/appStore';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import { formatNumber } from '../../lib/format';
import type { AnalyticsResult } from '@/lib/analytics/types';
import type { DashboardWidget, VizGauge } from '@/types';

/**
 * Gauge: the scalar total drawn as a 180° radial arc filling to value/max. Max
 * defaults to 100 for percent metrics, else the value itself (full arc). Drills
 * to the records behind the number, like the stat card.
 */
export default function GaugeWidget({
  widget,
  result,
  onDrill,
}: {
  widget: DashboardWidget;
  result: AnalyticsResult | null;
  onDrill?: (recordIds: string[], title: string) => void;
}) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const viz = effectiveViz(widget) as VizGauge;
  const value = result?.total ?? 0;
  const max = viz.max && viz.max > 0 ? viz.max : viz.number_format?.percent ? 100 : Math.max(value, 1);
  const pct = Math.max(0, Math.min(1, value / max));
  const title = isAr ? widget.title_ar : widget.title_en;
  const drillIds = result?.rows?.flatMap((r) => r.recordIds ?? []) ?? [];
  const color = viz.color ?? '#B8734F';
  const a = Math.PI * (1 - pct);
  const end = { x: 50 + 40 * Math.cos(a), y: 50 - 40 * Math.sin(a) };

  return (
    <div
      className={`flex h-full flex-col items-center justify-center ${onDrill ? 'cursor-pointer' : ''}`}
      role={onDrill ? 'button' : undefined}
      onClick={onDrill ? () => onDrill(drillIds, title) : undefined}
    >
      <svg viewBox="0 0 100 56" className="w-full max-w-[180px]">
        <path d="M 10 50 A 40 40 0 0 1 90 50" fill="none" stroke="#E7DAC6" strokeWidth="9" strokeLinecap="round" />
        {pct > 0 && <path d={`M 10 50 A 40 40 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" />}
      </svg>
      <div className="-mt-3 text-2xl font-bold" style={{ color }} dir="ltr">
        {formatNumber(value, viz.number_format)}
      </div>
      <div className="px-2 text-center text-xs text-charcoal/50">{title}</div>
      {viz.max ? (
        <div className="text-[10px] text-charcoal/35" dir="ltr">
          / {formatNumber(max, viz.number_format)}
        </div>
      ) : null}
    </div>
  );
}
