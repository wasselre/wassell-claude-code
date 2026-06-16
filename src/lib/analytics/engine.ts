/**
 * runAnalyticsQuery — the single, isomorphic entry point for the whole platform.
 * Pure: it filters/groups/aggregates the records the caller hands it (already
 * RLS-scoped) and never reaches out to a store, network, or RLS. The same
 * function powers the in-browser builder preview AND the server `/api/analytics`
 * endpoint, so a result can never disagree between the two.
 *
 * Algorithm: resolve model + fields → resolve metric/saved-view → resolve the
 * Riyadh date window → filter (date + layered groups) → group (multi-level,
 * cartesian) → aggregate each leaf (+ percentage/ratio via sub-queries) → sort /
 * top_n / limit → grand total → optional previous-window comparison. Every
 * unresolved reference or skipped value is surfaced as a warning, never dropped.
 */
import type { ModelField } from '../../types';
import type {
  AggregationConfig,
  AnalyticsQuery,
  AnalyticsResult,
  AnalyticsRow,
  AnalyticsWarning,
  DateRange,
  FilterGroup,
  GroupByConfig,
  GroupKey,
  SortConfig,
} from './types';
import type { AnalyticsContext } from './context';
import { canAggregateFieldType, fieldMapById } from './fieldResolver.js';
import { readRefValue, recordPassesGroup } from './filter.js';
import { inDateRange, previousWindow, resolveDateRange } from './dateWindows.js';
import { viewConditionsToFilterGroup } from './savedViewAdapter.js';
import { groupKeysForRecord, seedOptionKeys } from './grouping.js';
import { aggregateRecords } from './aggregate.js';
import { mergeSimpleMetric } from './metricResolver.js';
import { evaluateFormula } from '../formulaEngine.js';

const MAX_DEPTH = 6;
const PATH_SEP = '';
const OTHER_KEY: GroupKey = { field_id: null, raw: '__other__', label_ar: 'أخرى', label_en: 'Other' };

interface InternalResult {
  rows: AnalyticsRow[];
  total: number | null;
  scanned: number;
  range?: DateRange;
}

function pathOf(keys: GroupKey[]): string {
  return keys.map((k) => k.raw).join(PATH_SEP);
}

function cartesian(levels: GroupKey[][]): GroupKey[][] {
  return levels.reduce<GroupKey[][]>((acc, level) => {
    const out: GroupKey[][] = [];
    for (const combo of acc) for (const key of level) out.push([...combo, key]);
    return out;
  }, [[]]);
}

function pushUnknownField(warnings: AnalyticsWarning[], seen: Set<string>, fieldId: string): void {
  if (seen.has(fieldId)) return;
  seen.add(fieldId);
  warnings.push({ code: 'unknown_field', field_id: fieldId });
}

function defaultSortMode(groupBy: GroupByConfig[], levelFields: (ModelField | undefined)[]): 'time' | 'options' | 'value' {
  const g0 = groupBy[0];
  if (g0?.time_bucket || g0?.field.kind === 'created_at' || g0?.field.kind === 'updated_at') return 'time';
  const f0 = levelFields[0];
  if (f0 && (f0.type === 'dropdown' || f0.type === 'section_selector')) return 'options';
  return 'value';
}

function sortRows(
  rows: AnalyticsRow[],
  sort: SortConfig[] | undefined,
  isAr: boolean,
  groupBy: GroupByConfig[],
  levelFields: (ModelField | undefined)[],
): AnalyticsRow[] {
  const others = rows.filter((r) => r.keys.some((k) => k.raw === OTHER_KEY.raw));
  let main = rows.filter((r) => !r.keys.some((k) => k.raw === OTHER_KEY.raw));

  if (sort && sort.length > 0) {
    main = [...main].sort((a, b) => {
      for (const s of sort) {
        let cmp = 0;
        if (s.by.kind === 'value') {
          cmp = (a.value ?? -Infinity) - (b.value ?? -Infinity);
        } else {
          const lvl = s.by.level;
          const ka = a.keys[lvl];
          const kb = b.keys[lvl];
          const la = ka ? (isAr ? ka.label_ar : ka.label_en) : '';
          const lb = kb ? (isAr ? kb.label_ar : kb.label_en) : '';
          const sa = ka?.bucket_start ?? la;
          const sb = kb?.bucket_start ?? lb;
          cmp = String(sa).localeCompare(String(sb), isAr ? 'ar' : 'en', { numeric: true });
        }
        if (cmp !== 0) return s.direction === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  } else {
    const mode = defaultSortMode(groupBy, levelFields);
    if (mode === 'time') {
      main = [...main].sort((a, b) =>
        String(a.keys[0]?.bucket_start ?? a.keys[0]?.raw ?? '').localeCompare(
          String(b.keys[0]?.bucket_start ?? b.keys[0]?.raw ?? ''),
          'en',
          { numeric: true },
        ),
      );
    } else if (mode === 'value') {
      main = [...main].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    }
    // 'options' → preserve insertion order (seed order = schema option order)
  }
  return [...main, ...others];
}

function collectUnknownFieldWarnings(
  q: AnalyticsQuery,
  groups: (FilterGroup | undefined)[],
  fieldsById: Map<string, ModelField>,
  warnings: AnalyticsWarning[],
  seen: Set<string>,
): void {
  for (const g of groups) {
    for (const c of g?.conditions ?? []) {
      if (c.field.kind === 'field' && !fieldsById.has(c.field.field_id)) pushUnknownField(warnings, seen, c.field.field_id);
    }
  }
  for (const gb of q.group_by ?? []) {
    if (gb.field.kind === 'field' && !fieldsById.has(gb.field.field_id)) pushUnknownField(warnings, seen, gb.field.field_id);
  }
  if (q.date_filter?.field.kind === 'field' && !fieldsById.has(q.date_filter.field.field_id)) {
    pushUnknownField(warnings, seen, q.date_filter.field.field_id);
  }
}

function runRatio(
  outer: AnalyticsQuery,
  agg: AggregationConfig,
  ctx: AnalyticsContext,
  outerGroups: FilterGroup[],
  warnings: AnalyticsWarning[],
  depth: number,
): { rows: AnalyticsRow[]; total: number | null } {
  const mult = agg.type === 'percentage' ? 100 : 1;
  const subCtx: AnalyticsContext = { ...ctx, options: {} };
  const inject = (sub: AnalyticsQuery): AnalyticsQuery => ({
    source_model_id: outer.source_model_id,
    saved_view_id: sub.saved_view_id,
    filters: sub.filters,
    date_filter: sub.date_filter ?? outer.date_filter,
    group_by: outer.group_by,
    aggregation: sub.aggregation,
  });
  const numRes = runInternal(inject(agg.numerator!), subCtx, outerGroups, warnings, depth + 1);
  const denRes = agg.denominator
    ? runInternal(inject(agg.denominator), subCtx, outerGroups, warnings, depth + 1)
    : runInternal(
        {
          source_model_id: outer.source_model_id,
          date_filter: outer.date_filter,
          group_by: outer.group_by,
          aggregation: { type: 'count' },
        },
        subCtx,
        outerGroups,
        warnings,
        depth + 1,
      );

  const div = (a: number, b: number): number | null => {
    if (!b) return agg.on_zero === 'zero' ? 0 : null;
    return (a / b) * mult;
  };
  if (!denRes.total) warnings.push({ code: 'ratio_zero_denominator' });
  const total = div(numRes.total ?? 0, denRes.total ?? 0);
  const denMap = new Map(denRes.rows.map((r) => [pathOf(r.keys), r.value ?? 0]));
  const rows = numRes.rows.map((r) => ({ keys: r.keys, value: div(r.value ?? 0, denMap.get(pathOf(r.keys)) ?? 0) }));
  return { rows, total };
}

function runCompositeMetric(
  query: AnalyticsQuery,
  metric: { formula?: string; inputs?: { name: string; metric_id: string }[] },
  ctx: AnalyticsContext,
  extraFilters: FilterGroup[],
  warnings: AnalyticsWarning[],
  depth: number,
): InternalResult {
  const vars: Record<string, unknown> = {};
  const outerFilter = query.filters ? [query.filters] : [];
  for (const input of metric.inputs ?? []) {
    const im = (ctx.metrics ?? []).find((m) => m.id === input.metric_id);
    if (!im) {
      warnings.push({ code: 'unknown_metric', metric_id: input.metric_id });
      vars[input.name] = 0;
      continue;
    }
    const sub: AnalyticsQuery = {
      ...im.query,
      group_by: [],
      date_filter: query.date_filter ?? im.query.date_filter,
      aggregation: { ...im.query.aggregation, metric_id: undefined },
    };
    const res = runInternal(sub, { ...ctx, options: {} }, [...extraFilters, ...outerFilter], warnings, depth + 1);
    vars[input.name] = res.total ?? 0;
  }
  const out = metric.formula ? evaluateFormula(metric.formula, vars) : null;
  const value = typeof out === 'number' && Number.isFinite(out) ? out : null;
  if (query.group_by && query.group_by.length > 0) {
    warnings.push({ code: 'not_aggregatable', field_id: '(composite metric)', field_type: 'composite_metric_grouping' });
  }
  return { rows: [{ keys: [], value }], total: value, scanned: ctx.records.length };
}

function runInternal(
  query: AnalyticsQuery,
  ctx: AnalyticsContext,
  extraFilters: FilterGroup[],
  warnings: AnalyticsWarning[],
  depth: number,
): InternalResult {
  if (depth > MAX_DEPTH) return { rows: [], total: null, scanned: 0 };
  const model = ctx.models.find((m) => m.id === query.source_model_id);
  if (!model) return { rows: [], total: null, scanned: 0 };
  const fieldsById = fieldMapById(model);
  const seen = new Set<string>();

  // Resolve a metric reference.
  let q = query;
  const metricExtra: FilterGroup[] = [];
  if (query.aggregation?.metric_id) {
    const metric = (ctx.metrics ?? []).find((m) => m.id === query.aggregation!.metric_id);
    if (!metric) {
      warnings.push({ code: 'unknown_metric', metric_id: query.aggregation.metric_id });
    } else if (metric.formula && metric.inputs && metric.inputs.length > 0) {
      return runCompositeMetric(query, metric, ctx, extraFilters, warnings, depth);
    } else {
      const merged = mergeSimpleMetric(query, metric);
      q = merged.query;
      metricExtra.push(...merged.extraFilters);
    }
  }

  const agg = q.aggregation;
  let aggField: ModelField | undefined;
  if (agg.field?.kind === 'field') {
    aggField = fieldsById.get(agg.field.field_id);
    if (!aggField) pushUnknownField(warnings, seen, agg.field.field_id);
    else if (!canAggregateFieldType(agg.type, aggField.type)) {
      warnings.push({ code: 'not_aggregatable', field_id: aggField.id, field_type: aggField.type });
    }
  }

  // Saved-view filters.
  let savedViewGroup: FilterGroup | undefined;
  if (q.saved_view_id) {
    const view = (ctx.savedViews ?? []).find((v) => v.id === q.saved_view_id);
    if (!view) warnings.push({ code: 'unknown_saved_view', saved_view_id: q.saved_view_id });
    else savedViewGroup = viewConditionsToFilterGroup(view.conditions);
  }

  const allGroups = [savedViewGroup, q.filters, ...extraFilters, ...metricExtra].filter(Boolean) as FilterGroup[];
  collectUnknownFieldWarnings(q, [savedViewGroup, q.filters], fieldsById, warnings, seen);

  // Riyadh date window.
  let range: DateRange | undefined;
  let datePredicate: ((r: (typeof ctx.records)[number]) => boolean) | null = null;
  if (q.date_filter) {
    const df = q.date_filter;
    range = resolveDateRange(df.mode, ctx.now ?? new Date(), df.from, df.to);
    const dfField = df.field.kind === 'field' ? fieldsById.get(df.field.field_id) : undefined;
    const frozenRange = range;
    datePredicate = (r) => inDateRange(readRefValue(r, df.field, dfField), frozenRange);
  }

  const filtered = ctx.records.filter((r) => {
    if (datePredicate && !datePredicate(r)) return false;
    return allGroups.every((g) => recordPassesGroup(r, g, fieldsById));
  });
  const scanned = ctx.records.length;

  // percentage / ratio (composite of sub-queries).
  if (agg.type === 'ratio' || agg.type === 'percentage') {
    const { rows, total } = runRatio(q, agg, ctx, allGroups, warnings, depth);
    return { rows: sortRows(rows, q.sort, ctx.isAr, q.group_by ?? [], (q.group_by ?? []).map(() => undefined)), total, scanned, range };
  }

  const includeIds = !!ctx.options?.include_record_ids;
  const groupBy = q.group_by ?? [];

  // Scalar (no grouping).
  if (groupBy.length === 0) {
    const outcome = aggregateRecords(filtered, agg, aggField, ctx);
    if (outcome.nonNumericSkipped > 0 && agg.field?.kind === 'field') {
      warnings.push({ code: 'non_numeric_skipped', field_id: agg.field.field_id, count: outcome.nonNumericSkipped });
    }
    const row: AnalyticsRow = { keys: [], value: outcome.value };
    if (includeIds) row.recordIds = filtered.map((r) => r.id);
    return { rows: [row], total: outcome.value, scanned, range };
  }

  // Multi-level grouping (cartesian over each level's keys).
  const levelFields = groupBy.map((g) => (g.field.kind === 'field' ? fieldsById.get(g.field.field_id) : undefined));
  const groups = new Map<string, { keys: GroupKey[]; records: typeof filtered }>();
  for (const r of filtered) {
    const perLevel = groupBy.map((g, i) => groupKeysForRecord(r, g, levelFields[i], ctx));
    for (const combo of cartesian(perLevel)) {
      const path = pathOf(combo);
      let entry = groups.get(path);
      if (!entry) {
        entry = { keys: combo, records: [] };
        groups.set(path, entry);
      }
      entry.records.push(r);
    }
  }

  // Zero-count option seeding for a single dropdown level. Skipped when the
  // level opts out via include_empty:false (hides categories with no records —
  // e.g. a "by district" chart over a 120-option dropdown that only uses 10).
  if (groupBy.length === 1 && levelFields[0] && groupBy[0]?.include_empty !== false) {
    for (const k of seedOptionKeys(levelFields[0])) {
      if (!groups.has(k.raw)) groups.set(k.raw, { keys: [k], records: [] });
    }
  }

  // top_n on a single level: keep the largest N groups (by record count), fold
  // the rest into one "Other" group whose records are re-aggregated exactly.
  let entries = [...groups.values()];
  const topN = groupBy.length === 1 ? groupBy[0]?.top_n : undefined;
  if (topN && topN > 0 && entries.length > topN) {
    entries = [...entries].sort((a, b) => b.records.length - a.records.length);
    const head = entries.slice(0, topN);
    const tail = entries.slice(topN);
    const otherRecords = tail.flatMap((e) => e.records);
    head.push({ keys: [OTHER_KEY], records: otherRecords });
    entries = head;
  }

  let rows: AnalyticsRow[] = [];
  let skippedTotal = 0;
  for (const { keys, records } of entries) {
    const outcome = aggregateRecords(records, agg, aggField, ctx);
    skippedTotal += outcome.nonNumericSkipped;
    const row: AnalyticsRow = { keys, value: outcome.value };
    if (includeIds) row.recordIds = records.map((r) => r.id);
    rows.push(row);
  }
  if (skippedTotal > 0 && agg.field?.kind === 'field') {
    warnings.push({ code: 'non_numeric_skipped', field_id: agg.field.field_id, count: skippedTotal });
  }

  rows = sortRows(rows, q.sort, ctx.isAr, groupBy, levelFields);
  if (q.limit && q.limit > 0) {
    const others = rows.filter((r) => r.keys.some((k) => k.raw === OTHER_KEY.raw));
    rows = rows.filter((r) => !r.keys.some((k) => k.raw === OTHER_KEY.raw)).slice(0, q.limit).concat(others);
  }

  const totalOutcome = aggregateRecords(filtered, agg, aggField, ctx);
  return { rows, total: totalOutcome.value, scanned, range };
}

export function runAnalyticsQuery(query: AnalyticsQuery, ctx: AnalyticsContext): AnalyticsResult {
  const warnings: AnalyticsWarning[] = [];
  const model = ctx.models.find((m) => m.id === query.source_model_id);
  if (!model) {
    return { rows: [], total: null, warnings: [{ code: 'unknown_field', field_id: query.source_model_id }], scanned: 0 };
  }
  const main = runInternal(query, ctx, [], warnings, 0);
  const result: AnalyticsResult = {
    rows: main.rows,
    total: main.total,
    warnings,
    scanned: main.scanned,
    resolved_date_range: main.range,
  };

  if (ctx.options?.comparison && query.date_filter) {
    const df = query.date_filter;
    const prevRange = previousWindow(df.mode, ctx.now ?? new Date(), df.from, df.to);
    const prevQuery: AnalyticsQuery = {
      ...query,
      date_filter: { field: df.field, mode: 'custom', from: prevRange.from, to: prevRange.to },
    };
    const prev = runInternal(prevQuery, ctx, [], warnings, 0);
    const delta =
      main.total != null && prev.total != null && prev.total !== 0
        ? ((main.total - prev.total) / Math.abs(prev.total)) * 100
        : null;
    result.comparison = { total: prev.total, rows: prev.rows, delta_pct: delta, resolved_date_range: prevRange };
  }

  return result;
}
