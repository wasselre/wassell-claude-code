import type { AppModel, DashboardFilter, DashboardWidget, ModelField } from '@/types';
import type { AnalyticsQuery, DateFilterMode, FilterCondition } from '@/lib/analytics/types';
import { effectiveQuery } from '@/lib/analytics/widgetAdapter';
import { flattenFields } from '@/lib/analytics';

/**
 * Runtime value of a dashboard-level global filter, keyed by the filter's id in
 * `GlobalFilterState`. The bar writes these; `composeWidgetQuery` reads them and
 * merges them into each (inheriting) widget's query.
 */
export type GlobalFilterValue =
  | { kind: 'date'; mode: DateFilterMode; from?: string; to?: string }
  | { kind: 'select'; values: string[] }
  | { kind: 'search'; text: string };

export type GlobalFilterState = Record<string, GlobalFilterValue | undefined>;

export const DATE_PRESETS: { value: DateFilterMode; ar: string; en: string }[] = [
  { value: 'today', ar: 'اليوم', en: 'Today' },
  { value: 'yesterday', ar: 'أمس', en: 'Yesterday' },
  { value: 'this_week', ar: 'هذا الأسبوع', en: 'This week' },
  { value: 'last_week', ar: 'الأسبوع الماضي', en: 'Last week' },
  { value: 'this_month', ar: 'هذا الشهر', en: 'This month' },
  { value: 'last_month', ar: 'الشهر الماضي', en: 'Last month' },
  { value: 'this_quarter', ar: 'هذا الربع', en: 'This quarter' },
  { value: 'this_year', ar: 'هذه السنة', en: 'This year' },
  { value: 'last_7_days', ar: 'آخر ٧ أيام', en: 'Last 7 days' },
  { value: 'last_30_days', ar: 'آخر ٣٠ يوم', en: 'Last 30 days' },
];

/** The slug of the dashboard filter's reference field (used for inherit slug-match). */
export function refFieldSlug(f: DashboardFilter, models: AppModel[]): string | null {
  if (!f.ref_model_id || !f.ref_field_id) return null;
  const m = models.find((x) => x.id === f.ref_model_id);
  const fld = m ? flattenFields(m).find((x) => x.id === f.ref_field_id) : undefined;
  return fld?.name ?? null;
}

/** The reference field itself (for building the select control's options). */
export function refField(f: DashboardFilter, models: AppModel[]): ModelField | null {
  if (!f.ref_model_id || !f.ref_field_id) return null;
  const m = models.find((x) => x.id === f.ref_model_id);
  return (m ? flattenFields(m).find((x) => x.id === f.ref_field_id) : undefined) ?? null;
}

/**
 * Which field on a widget's source model a dashboard filter targets, honoring
 * the widget's filter_behavior: inherit → match by slug (zero-config for
 * same-slug models); custom_mapping → the explicit per-widget mapping;
 * ignore → none.
 */
function targetField(f: DashboardFilter, widget: DashboardWidget, models: AppModel[]): ModelField | null {
  const behavior = widget.filter_behavior ?? { mode: 'inherit_dashboard_filters' };
  if (behavior.mode === 'ignore_dashboard_filters') return null;
  const wm = models.find((m) => m.id === widget.source_model_id);
  if (!wm) return null;
  const wfields = flattenFields(wm);
  if (behavior.mode === 'custom_mapping') {
    const map = behavior.mappings.find((mp) => mp.dashboard_filter_id === f.id);
    if (!map || !map.target_field_id) return null;
    return wfields.find((x) => x.id === map.target_field_id) ?? null;
  }
  const slug = refFieldSlug(f, models);
  if (!slug) return null;
  return wfields.find((x) => x.name === slug) ?? null;
}

/**
 * Merge the active dashboard filters into a widget's effective query, without
 * mutating the saved query. Global conditions AND with the widget's own. A
 * date filter sets/overrides the query's date_filter on the matched field.
 */
export function composeWidgetQuery(
  widget: DashboardWidget,
  dashboardFilters: DashboardFilter[] | undefined,
  state: GlobalFilterState,
  models: AppModel[],
): AnalyticsQuery {
  const base = effectiveQuery(widget);
  const active = (dashboardFilters ?? []).filter((f) => state[f.id]);
  if (active.length === 0) return base;

  const q: AnalyticsQuery = JSON.parse(JSON.stringify(base));
  const extra: FilterCondition[] = [];
  for (const f of active) {
    const val = state[f.id]!;
    const tf = targetField(f, widget, models);
    if (!tf) continue;
    if (val.kind === 'date') {
      q.date_filter = { field: { kind: 'field', field_id: tf.id }, mode: val.mode, from: val.from, to: val.to };
    } else if (val.kind === 'select' && val.values.length > 0) {
      extra.push({ id: `gf_${f.id}`, field: { kind: 'field', field_id: tf.id }, operator: 'in', value: val.values });
    } else if (val.kind === 'search' && val.text.trim()) {
      extra.push({ id: `gf_${f.id}`, field: { kind: 'field', field_id: tf.id }, operator: 'contains', value: val.text.trim() });
    }
  }
  if (extra.length > 0) {
    const existing = q.filters?.conditions ?? [];
    q.filters = { mode: 'all', conditions: [...existing, ...extra] };
  }
  return q;
}

/** True if any dashboard filter has an active value. */
export function hasActiveFilters(state: GlobalFilterState): boolean {
  return Object.values(state).some((v) => {
    if (!v) return false;
    if (v.kind === 'date') return true;
    if (v.kind === 'select') return v.values.length > 0;
    return v.text.trim().length > 0;
  });
}
