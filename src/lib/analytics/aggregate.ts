/**
 * Folds a set of records into a single numeric value for the simple aggregation
 * types (count / count_distinct / sum / avg / min / max). percentage & ratio are
 * composite (sub-queries) and handled in the engine. Non-numeric values under a
 * sum/avg are SKIPPED and counted into a `non_numeric_skipped` warning by the
 * caller — never silently zeroed.
 *
 * Mirrors the SQL recipe in `recalc_project_rollups_data`: `toNumeric` == SQL
 * `try_numeric`; sum over no rows = 0; avg/min/max over no rows = null.
 */
import type { AppRecord, ModelField } from '../../types';
import type { AggregationConfig } from './types';
import type { AnalyticsContext } from './context';
import { toNumeric } from './numeric';
import { valueRiyadhMs } from './dateWindows';
import { readRefValue } from './filter';

export interface AggregateOutcome {
  value: number | null;
  nonNumericSkipped: number;
}

function readAgg(record: AppRecord, agg: AggregationConfig, aggField: ModelField | undefined): unknown {
  if (!agg.field) return undefined;
  return readRefValue(record, agg.field, aggField);
}

function checkboxToNum(v: unknown): number | null {
  if (v === true || v === 'true') return 1;
  if (v === false || v === 'false') return 0;
  return null;
}

export function aggregateRecords(
  records: AppRecord[],
  agg: AggregationConfig,
  aggField: ModelField | undefined,
  _ctx: AnalyticsContext,
): AggregateOutcome {
  switch (agg.type) {
    case 'count':
      return { value: records.length, nonNumericSkipped: 0 };
    case 'count_distinct': {
      const set = new Set<string>();
      for (const r of records) {
        const v = readAgg(r, agg, aggField);
        if (Array.isArray(v)) {
          for (const x of v) if (x !== null && x !== undefined && x !== '') set.add(String(x));
        } else if (v !== null && v !== undefined && v !== '') {
          set.add(String(v));
        }
      }
      return { value: set.size, nonNumericSkipped: 0 };
    }
    case 'sum':
    case 'avg': {
      const isCheckbox = aggField?.type === 'checkbox';
      let sum = 0;
      let n = 0;
      let skipped = 0;
      for (const r of records) {
        const v = readAgg(r, agg, aggField);
        if (v === null || v === undefined || v === '') continue;
        const num = isCheckbox ? checkboxToNum(v) : toNumeric(v);
        if (num === null) {
          skipped++;
          continue;
        }
        sum += num;
        n++;
      }
      if (agg.type === 'sum') return { value: sum, nonNumericSkipped: skipped };
      return { value: n === 0 ? null : sum / n, nonNumericSkipped: skipped };
    }
    case 'min':
    case 'max': {
      const isDate =
        aggField?.type === 'date' ||
        aggField?.type === 'datetime' ||
        agg.field?.kind === 'created_at' ||
        agg.field?.kind === 'updated_at';
      let best: number | null = null;
      let skipped = 0;
      for (const r of records) {
        const v = readAgg(r, agg, aggField);
        if (v === null || v === undefined || v === '') continue;
        const num = isDate ? valueRiyadhMs(v) : toNumeric(v);
        if (num === null) {
          skipped++;
          continue;
        }
        best = best === null ? num : agg.type === 'min' ? Math.min(best, num) : Math.max(best, num);
      }
      return { value: best, nonNumericSkipped: skipped };
    }
    default:
      return { value: null, nonNumericSkipped: 0 };
  }
}
