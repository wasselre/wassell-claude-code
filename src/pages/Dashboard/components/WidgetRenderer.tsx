import { useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { effectiveViz } from '@/lib/analytics/widgetAdapter';
import { composeWidgetQuery, type GlobalFilterState } from '../lib/globalFilters';
import { vizFamilyFor } from '../lib/widgetViz';
import { useAnalyticsQuery } from '../hooks/useAnalyticsQuery';
import DrillThroughModal, { type DrillContext } from './DrillThroughModal';
import StatWidget from './widgets/StatWidget';
import BarChartWidget from './widgets/BarChartWidget';
import PieChartWidget from './widgets/PieChartWidget';
import LineChartWidget from './widgets/LineChartWidget';
import TableWidget from './widgets/TableWidget';
import type { DashboardFilter, DashboardWidget, VizStat } from '@/types';

interface WidgetRendererProps {
  widget: DashboardWidget;
  isPublic?: boolean;
  dashboardFilters?: DashboardFilter[];
  filterState?: GlobalFilterState;
}

/**
 * The single render path for every aggregation widget: derive the effective
 * AnalyticsQuery (persisted, or migrated from legacy config), run the shared
 * engine via useAnalyticsQuery, and hand the result to a presentational family
 * renderer. Loading / empty / error are surfaced here (never swallowed). Every
 * mark is clickable → DrillThroughModal shows the records behind the number.
 * The `table` family renders raw records (not an aggregation) via TableWidget.
 */
export default function WidgetRenderer({ widget, isPublic, dashboardFilters, filterState }: WidgetRendererProps) {
  const language = useAppStore((s) => s.language);
  const models = useAppStore((s) => s.models);
  const isAr = language === 'ar';
  const family = vizFamilyFor(widget.type);
  const [drill, setDrill] = useState<DrillContext | null>(null);

  // Hooks must run unconditionally — null query for the table family skips the
  // engine. Global dashboard filters merge in per the widget's filter_behavior
  // (composeWidgetQuery returns the base query untouched when none are active).
  const query = useMemo(
    () => (family === 'table' ? null : composeWidgetQuery(widget, dashboardFilters, filterState ?? {}, models)),
    [widget, family, dashboardFilters, filterState, models],
  );
  const viz = effectiveViz(widget);
  const wantComparison = viz.family === 'stat' && !!(viz as VizStat).comparison;
  const { data, loading, error } = useAnalyticsQuery(query, { comparison: wantComparison, includeRecordIds: true });

  const onDrill = (recordIds: string[], title: string) =>
    setDrill({ sourceModelId: widget.source_model_id, recordIds, title });

  if (family === 'table') return <TableWidget widget={widget} isPublic={isPublic} />;

  if (loading) return <div className="h-full w-full animate-pulse rounded-lg bg-sand/20" />;
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 rounded-lg border border-red-300 bg-red-50/50 px-2 text-center">
        <div className="text-xs text-red-700">{isAr ? 'تعذّر تحميل البيانات' : 'Failed to load data'}</div>
        <div className="text-[10px] text-red-500">{error}</div>
      </div>
    );
  }

  const noRows = !data || data.rows.length === 0;
  if (family !== 'stat' && noRows) {
    return <div className="flex h-full items-center justify-center text-xs text-charcoal/40">{isAr ? 'لا توجد بيانات' : 'No data'}</div>;
  }

  let body: JSX.Element;
  switch (family) {
    case 'stat':
      body = <StatWidget widget={widget} result={data} onDrill={onDrill} />;
      break;
    case 'bars':
      body = <BarChartWidget widget={widget} result={data} onDrill={onDrill} />;
      break;
    case 'pies':
      body = <PieChartWidget widget={widget} result={data} onDrill={onDrill} />;
      break;
    case 'lines':
      body = <LineChartWidget widget={widget} result={data} onDrill={onDrill} />;
      break;
    default:
      body = <div className="text-xs text-charcoal/40">Unknown widget</div>;
  }

  return (
    <>
      {body}
      <DrillThroughModal ctx={drill} onClose={() => setDrill(null)} isPublic={isPublic} />
    </>
  );
}
