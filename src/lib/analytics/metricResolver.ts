/**
 * Static resolution of `AggregationConfig.metric_id` for a SIMPLE metric: the
 * metric's query is the base (its source + aggregation + base filters), and the
 * consuming query overlays group_by / date_filter / sort / limit / saved_view.
 * The metric's base filters are returned separately so the engine ANDs them as
 * their own group (preserving an 'any' mode rather than flattening).
 *
 * Composite metrics (metric.formula + inputs) are handled directly in the engine
 * (they combine other metrics' scalars via formulaEngine).
 */
import type { MetricDefinition } from '../../types';
import type { AnalyticsQuery, FilterGroup } from './types';

export interface ResolvedMetric {
  query: AnalyticsQuery;
  extraFilters: FilterGroup[];
}

export function mergeSimpleMetric(widget: AnalyticsQuery, metric: MetricDefinition): ResolvedMetric {
  const base = metric.query;
  const effective: AnalyticsQuery = {
    source_model_id: base.source_model_id,
    saved_view_id: widget.saved_view_id ?? base.saved_view_id,
    filters: widget.filters,
    date_filter: widget.date_filter ?? base.date_filter,
    group_by: widget.group_by ?? base.group_by,
    aggregation: { ...base.aggregation, metric_id: undefined },
    sort: widget.sort ?? base.sort,
    limit: widget.limit ?? base.limit,
  };
  return { query: effective, extraFilters: base.filters ? [base.filters] : [] };
}
