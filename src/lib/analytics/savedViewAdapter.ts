/**
 * Adapts an existing Saved View's filters (`ModelView.conditions`, which are
 * already `WidgetFilterCondition[]`) into the engine's `FilterGroup`. This is
 * how a dashboard "builds on" a view the user already maintains rather than
 * replacing it. The view's conditions AND together (mode: 'all'); the engine
 * then ANDs them with the query's own filters.
 *
 * `WidgetFilterOperator` is a strict subset of `AnalyticsOperator`, so the
 * mapping is 1:1; `field_path` ('min'/'max' for range fields) carries over.
 */
import type { WidgetFilterCondition } from '../../types';
import type { FilterCondition, FilterGroup } from './types';

export function viewConditionsToFilterGroup(
  conditions: WidgetFilterCondition[] | undefined,
): FilterGroup {
  const conds: FilterCondition[] = (conditions ?? []).map((c) => ({
    id: c.id,
    field: {
      kind: 'field',
      field_id: c.field_id,
      field_path: c.field_path === 'min' || c.field_path === 'max' ? c.field_path : undefined,
    },
    operator: c.operator,
    value: c.value,
  }));
  return { mode: 'all', conditions: conds };
}
