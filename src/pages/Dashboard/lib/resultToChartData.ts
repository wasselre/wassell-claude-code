import type { AnalyticsResult, AnalyticsRow } from '@/lib/analytics/types';
import { BRAND_PALETTE } from './widgetViz';

export interface ChartDatum {
  name: string; // bilingual label of the first group level
  raw: string; // canonical key (for drill-through)
  value: number;
  color: string;
  recordIds?: string[];
}

/**
 * Flattens a single-level (or first-level) AnalyticsResult into recharts-ready
 * data. Uses the group option's color when present, else cycles the brand
 * palette. Null values render as 0 on a chart (the row is still present so the
 * category shows). For multi-level results, only the first level is used here —
 * stacked/grouped series rendering is a Phase B concern.
 */
export function resultToChartData(result: AnalyticsResult | null, isAr: boolean): ChartDatum[] {
  if (!result) return [];
  return result.rows.map((row: AnalyticsRow, i) => {
    const key = row.keys[0];
    const label = key ? (isAr ? key.label_ar : key.label_en) : '';
    return {
      name: label,
      raw: key?.raw ?? String(i),
      value: row.value ?? 0,
      color: key?.color ?? BRAND_PALETTE[i % BRAND_PALETTE.length]!,
      recordIds: row.recordIds,
    };
  });
}

export interface SeriesPoint {
  name: string; // first-level (x-axis) label
  [series: string]: number | string;
}
export interface SeriesResult {
  data: SeriesPoint[];
  series: { key: string; color: string }[]; // second-level series (legend)
}

/**
 * Pivots a TWO-level AnalyticsResult into recharts series shape: the first group
 * level becomes the x-axis category, the second becomes the series (one bar/area
 * per second-level value within each category). Series color follows the second
 * level's option color, else the brand palette. Powers stacked/grouped bars and
 * the pivot table. A single-level result collapses to one unnamed series.
 */
export function resultToSeries(result: AnalyticsResult | null, isAr: boolean): SeriesResult {
  if (!result) return { data: [], series: [] };
  const xOrder: string[] = [];
  const sOrder: string[] = [];
  const sColor: Record<string, string> = {};
  const cell: Record<string, Record<string, number>> = {};
  result.rows.forEach((row) => {
    const k0 = row.keys[0];
    const k1 = row.keys[1];
    const x = k0 ? (isAr ? k0.label_ar : k0.label_en) : '—';
    const s = k1 ? (isAr ? k1.label_ar : k1.label_en) : '—';
    if (!xOrder.includes(x)) xOrder.push(x);
    if (!(s in sColor)) {
      sColor[s] = k1?.color ?? BRAND_PALETTE[sOrder.length % BRAND_PALETTE.length]!;
      sOrder.push(s);
    }
    cell[x] ??= {};
    cell[x]![s] = (cell[x]![s] ?? 0) + (row.value ?? 0);
  });
  const data: SeriesPoint[] = xOrder.map((x) => ({ name: x, ...cell[x] }));
  return { data, series: sOrder.map((s) => ({ key: s, color: sColor[s]! })) };
}
