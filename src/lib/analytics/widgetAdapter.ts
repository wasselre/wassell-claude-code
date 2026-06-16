/**
 * Lossless migrate-on-read for legacy dashboard widgets: maps the old
 * `WidgetConfig*` shapes onto an `AnalyticsQuery` + `WidgetViz` so existing
 * dashboards render through the universal engine with no data migration. The
 * builder persists `query`/`viz` going forward; the legacy `config` is retained
 * (rollback-safe), and `effectiveQuery`/`effectiveViz` prefer the persisted
 * fields and fall back to this adapter.
 */
import type {
  DashboardWidget,
  WidgetConfigChart,
  WidgetConfigLine,
  WidgetConfigStat,
  WidgetConfigTable,
  WidgetFilterCondition,
  WidgetViz,
} from '../../types';
import type { AnalyticsQuery, FilterGroup, GroupByConfig, TimeBucket } from './types';

function conditionsToGroup(conds: WidgetFilterCondition[] | undefined): FilterGroup | undefined {
  if (!conds || conds.length === 0) return undefined;
  return {
    mode: 'all',
    conditions: conds.map((c) => ({
      id: c.id,
      field: {
        kind: 'field',
        field_id: c.field_id,
        field_path: c.field_path === 'min' || c.field_path === 'max' ? c.field_path : undefined,
      },
      operator: c.operator,
      value: c.value,
    })),
  };
}

export function migrateLegacyWidget(widget: DashboardWidget): { query: AnalyticsQuery; viz: WidgetViz } {
  const source = widget.source_model_id;
  switch (widget.type) {
    case 'stat': {
      const c = (widget.config ?? {}) as WidgetConfigStat;
      return {
        query: { source_model_id: source, filters: conditionsToGroup(c.conditions), aggregation: { type: 'count' } },
        viz: { family: 'stat', color: c.color ?? '#B8734F' },
      };
    }
    case 'bar_chart':
    case 'pie_chart': {
      const c = (widget.config ?? {}) as WidgetConfigChart;
      const group_by: GroupByConfig[] = c.group_by_field_id
        ? [{ field: { kind: 'field', field_id: c.group_by_field_id } }]
        : [];
      const query: AnalyticsQuery = {
        source_model_id: source,
        filters: conditionsToGroup(c.conditions),
        group_by,
        aggregation: { type: 'count' },
      };
      return widget.type === 'bar_chart'
        ? { query, viz: { family: 'bars', color_mode: { kind: 'by_group_option' } } }
        : { query, viz: { family: 'pies', donut: false, color_mode: { kind: 'by_group_option' } } };
    }
    case 'line_chart': {
      const c = (widget.config ?? {}) as WidgetConfigLine;
      const bucket: TimeBucket = c.period === 'week' ? 'week' : c.period === 'month' ? 'month' : 'day';
      return {
        query: {
          source_model_id: source,
          filters: conditionsToGroup(c.conditions),
          group_by: c.date_field_id ? [{ field: { kind: 'field', field_id: c.date_field_id }, time_bucket: bucket }] : [],
          aggregation: { type: 'count' },
          sort: [{ by: { kind: 'group', level: 0 }, direction: 'asc' }],
        },
        viz: { family: 'lines', area: false },
      };
    }
    case 'table':
    default: {
      const c = (widget.config ?? {}) as WidgetConfigTable;
      return {
        query: {
          source_model_id: source,
          filters: conditionsToGroup(c.conditions),
          aggregation: { type: 'count' },
          sort: c.sort_field_id ? [{ by: { kind: 'value' }, direction: c.sort_direction === 'asc' ? 'asc' : 'desc' }] : undefined,
          limit: c.max_rows || 10,
        },
        viz: { family: 'table', column_field_ids: c.field_ids ?? [], page_size: c.max_rows || 10 },
      };
    }
  }
}

export function effectiveQuery(widget: DashboardWidget): AnalyticsQuery {
  return widget.query ?? migrateLegacyWidget(widget).query;
}

export function effectiveViz(widget: DashboardWidget): WidgetViz {
  return widget.viz ?? migrateLegacyWidget(widget).viz;
}
