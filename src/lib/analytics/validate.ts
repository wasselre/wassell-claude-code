/**
 * Query validation + the serializability guard.
 *
 * `assertSerializable` enforces the HARD RULE that an `AnalyticsQuery` is pure
 * JSON — it throws if the query holds a function, symbol, bigint, NaN/Infinity,
 * or a non-plain object (Date, Map, class instance). Run it before persisting a
 * query anywhere (widget, metric, snapshot) so non-JSON content can never reach
 * the database.
 *
 * `validateAnalyticsQuery` returns a human-readable error string (or null) for
 * structural problems the builder/endpoint should reject up front.
 */
import type { AnalyticsQuery, AggregationConfig } from './types';

function checkJson(v: unknown, path: string): void {
  if (v === null || v === undefined) return; // undefined is dropped by JSON harmlessly
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(v as number)) throw new Error(`non-finite number at ${path}`);
    return;
  }
  if (t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new Error(`non-serializable ${t} at ${path}`);
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => checkJson(x, `${path}[${i}]`));
    return;
  }
  if (t === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      const name = (v as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
      throw new Error(`non-plain object (${name}) at ${path}`);
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) checkJson(val, `${path}.${k}`);
    return;
  }
  throw new Error(`non-serializable ${t} at ${path}`);
}

/** Throws if `query` is not pure JSON. No-op on success. */
export function assertSerializable(query: AnalyticsQuery): void {
  checkJson(query, 'query');
}

const AGG_NEEDS_FIELD = new Set(['sum', 'avg', 'min', 'max', 'count_distinct']);

function validateAggregation(agg: AggregationConfig | undefined): string | null {
  if (!agg || typeof agg !== 'object') return 'aggregation is required';
  if (agg.metric_id) return null; // a metric reference is resolved + validated by the engine
  if (!agg.type) return 'aggregation.type is required';
  if (AGG_NEEDS_FIELD.has(agg.type) && !agg.field) {
    return `aggregation "${agg.type}" requires a field`;
  }
  if (agg.type === 'ratio') {
    if (!agg.numerator) return 'ratio requires a numerator query';
    if (!agg.denominator) return 'ratio requires a denominator query';
  }
  if (agg.type === 'percentage' && !agg.numerator) {
    return 'percentage requires a numerator query';
  }
  return null;
}

/** Returns the first structural problem, or null if the query is well-formed. */
export function validateAnalyticsQuery(query: unknown): string | null {
  if (!query || typeof query !== 'object') return 'query must be an object';
  const q = query as Partial<AnalyticsQuery>;
  if (!q.source_model_id || typeof q.source_model_id !== 'string') {
    return 'source_model_id is required';
  }
  const aggErr = validateAggregation(q.aggregation);
  if (aggErr) return aggErr;
  if (q.group_by) {
    if (!Array.isArray(q.group_by)) return 'group_by must be an array';
    for (let i = 0; i < q.group_by.length; i++) {
      if (!q.group_by[i]?.field) return `group_by[${i}] requires a field`;
    }
  }
  if (q.filters && !Array.isArray(q.filters.conditions)) {
    return 'filters.conditions must be an array';
  }
  return null;
}
