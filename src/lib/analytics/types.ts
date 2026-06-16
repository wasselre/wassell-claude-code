/**
 * Universal analytics query types — the platform-wide
 * `AnalyticsQuery → Engine → AnalyticsResult` contract.
 *
 * HARD RULE (see the plan): every type here is a PURE, SERIALIZABLE JSON
 * document. No functions, closures, callbacks, runtime resolvers, or embedded
 * code — ever. An `AnalyticsQuery` behaves like a SQL / GraphQL / Mongo query
 * document: serializable, persistable, transferable, AI-generatable, API-safe.
 * ALL resolution (metric, saved-view, formula, lookup display, RLS scope)
 * happens in the ENGINE from its context, keyed by string ids — never inside
 * the query. `validate.ts#assertSerializable` enforces this with a JSON
 * round-trip.
 *
 * This module has ZERO imports so it stays dependency-free and isomorphic
 * (runs identically in the browser and in a Vercel function).
 */

/**
 * How a query points at a value. Fields are referenced by id (UUID) — the
 * engine resolves id → slug internally. Synthetic refs address system columns
 * that aren't schema fields.
 */
export type AnalyticsFieldRef =
  | { kind: 'field'; field_id: string; field_path?: 'min' | 'max' } // field_path: a sub-key of a structured value (range fields)
  | { kind: 'created_by' }
  | { kind: 'created_at' }
  | { kind: 'updated_at' };

export type AnalyticsOperator =
  | 'equals'
  | 'not_equals'
  | 'in' // value: unknown[]
  | 'not_in' // value: unknown[]
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'greater_or_equal'
  | 'less_than'
  | 'less_or_equal'
  | 'between' // value: [lo, hi]
  | 'is_empty'
  | 'is_not_empty';

export interface FilterCondition {
  id: string;
  field: AnalyticsFieldRef;
  operator: AnalyticsOperator;
  value?: unknown;
}

/** A boolean group of conditions. `all` = AND (default, byte-compatible with
 *  today's dashboards); `any` = OR. */
export interface FilterGroup {
  mode: 'all' | 'any';
  conditions: FilterCondition[];
}

export type DateFilterMode =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year'
  | 'last_7_days'
  | 'last_30_days'
  | 'custom';

export interface DateFilter {
  field: AnalyticsFieldRef; // a date/datetime field, or created_at/updated_at
  mode: DateFilterMode;
  from?: string; // ISO; custom only
  to?: string; // ISO; custom only (a date-only `to` is treated as inclusive end-of-day)
}

export type TimeBucket = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface NumericBucket {
  width: number; // bin size, e.g. 1_000_000
  min?: number; // optional floor (values below collapse into the first bin)
  max?: number; // optional ceil (values at/above collapse into a final "max+" bin)
}

export interface GroupByConfig {
  field: AnalyticsFieldRef;
  time_bucket?: TimeBucket; // date/datetime fields only
  numeric_bucket?: NumericBucket; // number/currency fields only
  fan_out_multi?: boolean; // multiselect / multi-lookup: one contribution per value (default true)
  top_n?: number; // cap distinct groups at this level; the remainder folds into one "Other" group
  include_empty?: boolean; // dropdown levels: seed zero-count options (default true). Set false to hide categories with no records.
}

export type AggregationType =
  | 'count'
  | 'count_distinct'
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'percentage'
  | 'ratio';

export interface AggregationConfig {
  type: AggregationType;
  field?: AnalyticsFieldRef; // required for sum/avg/min/max/count_distinct
  numerator?: AnalyticsQuery; // ratio/percentage
  denominator?: AnalyticsQuery; // ratio; omit for percentage → denominator = the parent total
  on_zero?: 'null' | 'zero'; // div-by-zero policy for ratio/percentage (default 'null')
  metric_id?: string; // reference a Semantic Metric instead of inlining (engine-resolved)
}

export interface SortConfig {
  by: { kind: 'group'; level: number } | { kind: 'value' };
  direction: 'asc' | 'desc';
}

export interface AnalyticsQuery {
  source_model_id: string;
  saved_view_id?: string; // layer this Saved View's filters in (engine-resolved from ctx.savedViews)
  filters?: FilterGroup;
  date_filter?: DateFilter;
  group_by?: GroupByConfig[]; // multi-level; omitted / [] = scalar result
  aggregation: AggregationConfig;
  sort?: SortConfig[];
  limit?: number;
}

// ── Result ────────────────────────────────────────────────────────────────

export interface GroupKey {
  field_id: string | null; // null for synthetic refs (created_by/at) or the "Other" bucket
  raw: string; // canonical Map key (option value, linked id, user id, bucket-start, bin lower bound)
  label_ar: string;
  label_en: string;
  color?: string; // dropdown option color, when applicable
  bucket_start?: string; // time/numeric bucket lower edge (ISO, or number-as-string)
  bucket_end?: string;
}

export interface AnalyticsRow {
  keys: GroupKey[]; // length === (group_by?.length ?? 0)
  value: number | null; // null for an empty avg / ratio-by-zero
  recordIds?: string[]; // drill-through; populated only when ctx.options.include_record_ids
}

export interface DateRange {
  from: string;
  to: string;
}

export interface AnalyticsComparison {
  total: number | null;
  rows?: AnalyticsRow[];
  delta_pct: number | null; // (current.total - prev.total) / |prev.total| * 100
  resolved_date_range: DateRange;
}

export type AnalyticsWarning =
  | { code: 'unknown_field'; field_id: string }
  | { code: 'non_numeric_skipped'; field_id: string; count: number }
  | { code: 'ratio_zero_denominator' }
  | { code: 'not_aggregatable'; field_id: string; field_type: string }
  | { code: 'unknown_metric'; metric_id: string }
  | { code: 'unknown_saved_view'; saved_view_id: string }
  | { code: 'page_ceiling_hit'; scanned: number };

export interface AnalyticsResult {
  rows: AnalyticsRow[];
  total: number | null; // grand aggregate over all filtered rows, pre group_by
  comparison?: AnalyticsComparison; // populated only when ctx.options.comparison
  resolved_date_range?: DateRange;
  warnings: AnalyticsWarning[]; // surfaced, NEVER silently dropped
  scanned: number; // candidate rows scanned (post-RLS, pre-filter)
}
