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
