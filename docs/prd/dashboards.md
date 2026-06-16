# PRD: Dashboards

**Status:** Live
**Last updated:** 2026-06-16 (**Universal Analytics Engine — Phase A (in progress).** Dashboards now run on a shared, isomorphic analytics engine (`src/lib/analytics/`) instead of the old COUNT-only client utilities. New: all aggregations (count / count_distinct / sum / avg / min / max / percentage / ratio), multi-level grouping, lookup/assignee/date/number grouping, **time bucketing in Asia/Riyadh** (hour…year — the old UTC bucketing bug is fixed), numeric range bucketing, **relative date ranges** (today / yesterday / this·last week·month·quarter / this year / last 7 · 30 days / all-time), **comparison metrics** on stat cards (vs previous period), a new 6-section **widget builder** with a live preview, and **drill-through** (click any number / bar / slice / point → the records behind it, openable in the record form). A server endpoint `POST /api/analytics` runs the *same* engine for large datasets + (upcoming) public snapshots. Legacy widgets migrate-on-read losslessly. **Now also live:** dashboard-level global filters (a configured filter bar that fans out to widgets by `filter_behavior`), public-dashboard **stored snapshots** (anon renders an `AnalyticsResult` from JSONB — never reads raw records or runs analytics), and the **Semantic Metrics** layer — reusable named measures (a `metric_definitions` table + a Metrics manager + a "Saved metric" picker in the builder). Phase A is functionally complete. **Phase B (same day):** Funnel, Leaderboard, Gauge, Progress, stacked/grouped Bar, Pivot, and Heatmap shipped as thin renderers over the same engine, plus a `top_n` + hide-empty grouping control; the KPI card = Stat + comparison; and a self-contained Saudi bubble Map — all 17 widget types now live.) | 2026-05-07 (Realtime + access hardening) | 2026-04-19 (range-field filters)
**Related PRDs:** model-builder.md, record-management.md, access-control.md, data-storage.md

## What it is (in plain English)
Dashboards are visual, drag-and-drop reports built on top of the user's records. A dashboard is a canvas of widgets; each widget is a **visualization of an analytics query** — pick a source model, a date range, filters, how to group, and how to aggregate, then choose a chart. The same query engine powers the in-browser preview and the server, so the builder preview always matches the saved render. Dashboards can be shared publicly via a tokenized URL.

The engine is a **platform capability**, not a dashboard-only feature: the `AnalyticsQuery → Engine → AnalyticsResult` pipeline (`src/lib/analytics/`) is pure, serializable, and reused by everything that needs analytics (dashboards today; reports / AI insights / KPI monitoring / automations later) — there is no second analytics implementation anywhere.

## Why it exists
Managers need at-a-glance views of the business: today's calls per agent, response rate by hour, revenue by sales rep, reservations by project. Rather than shipping one fixed dashboard, managers build their own on top of whatever models they have — any model, any field type, any date range, any grouping, any aggregation.

## Key behaviors
- URL: `/dashboards` (list), `/dashboards/:dashboardId` (editor), `/public/dashboard/:token` (public view).
- **Widget families:** Stat (single number + optional comparison — doubles as the KPI card), Bar (single / **stacked** / **grouped**), Pie/Donut, Line/Area, Table (record list), **Funnel** (ordered stages), **Leaderboard** (ranked with inline bars), **Gauge** (radial vs max), **Progress** (linear vs target), **Pivot** (2-level matrix), **Heatmap** (2-level density grid), and a **Map** (city bubbles over a built-in simplified Saudi outline). All 17 widget types are live.
- **The query** (`AnalyticsQuery`, a pure-JSON document) carries: `source_model_id`, optional `saved_view_id`, `filters` (AND/OR group), `date_filter` (a date field + a relative/custom range), `group_by[]` (multi-level; each level can carry a time bucket for dates or a numeric bin width for numbers), `aggregation` (type + field, or numerator/denominator sub-queries for ratio/percentage, or a `metric_id`), `sort`, `limit`. It never contains code — all resolution happens in the engine.
- **Aggregations:** count, count_distinct, sum, avg, min, max, percentage (part / whole), ratio (numerator / denominator).
- **Semantic Metrics:** reusable named measures (e.g. "Revenue" = Σ total_price on Units). A `MetricDefinition` is a value-only `AnalyticsQuery` plus a display `format`, stored in `metric_definitions` (admin-RLS, `updated_at` trigger — mirrors `dashboards`). Manage them in the **Metrics** manager (dashboard editor → "Metrics"); pick one in the builder's **Saved metric** dropdown to drive a widget. The metric supplies source + aggregation + base filters while the widget overlays `group_by` / `date_filter`, so "Revenue **by district**" = the metric plus a district group level. KPI targets are deliberately out of scope (a future `KPIDefinition { metric_id, target_value, … }` layers on top without changing the metric or engine).
- **Global filters:** an admin configures filter controls (date / select / search) bound to a reference field; the bar renders atop the dashboard and each widget merges the active filters into its query per its `filter_behavior` — inherit (match by field slug), `custom_mapping`, or ignore (per-widget toggle).
- **Grouping:** dropdown (option order + colors; zero-count options shown by default, hideable via the widget's **Hide empty** / **Top N** control), multiselect (fan-out), lookup (resolved display value), assignee (user name), checkbox (Yes/No), date (hour…year, Riyadh), number/currency (range bins). Multi-level → cartesian groups (feed stacked/grouped bars, pivot, heatmap).
- **Dates:** all date math is Asia/Riyadh via one module (`src/lib/analytics/dateWindows.ts`). User `date`/`datetime` fields are read as Riyadh wall-clock; `created_at`/`updated_at` as UTC instants shifted to Riyadh.
- **Drill-through (mandatory):** clicking any number/bar/slice/point opens a modal listing the underlying records (reusing the record table + `DynamicCell`); clicking a row opens it in `RecordFormModal` (read-only on public).
- **Builder:** one modal — Title → Source model → Visualization → Aggregation (type + type-filtered field picker; percentage gets a part-filter sub-editor) → Group by (multi-level with bucket pickers) → Date range (relative presets) → Filters → display options — with a **live preview** rendered by the real engine. The Visualization step offers all families; bars get a Stacked toggle, gauge/progress a max/target, and grouped widgets a **Top N** + **Hide empty** control. A simple COUNT stat stays ~3 clicks.
- **Warnings, never silent:** unknown field / non-numeric skipped / not-aggregatable / zero-denominator / page-ceiling are surfaced, not swallowed; widget loading/empty/error states render explicitly.
- Bilingual; RTL-aware charts (axis reversal, LTR digits). Public sharing unchanged: `get_public_dashboard(token)` (SECURITY DEFINER, anon-only RPC) gates on `is_public` + token.

## User flows
1. **Create dashboard:** `/dashboards` → "+ New Dashboard" → blank canvas.
2. **Add a widget:** "+ Widget" → builder opens → choose model, visualization, aggregation, grouping, date range, filters → live preview updates → Save.
3. **Arrange:** drag / resize on the grid.
4. **Drill in:** click a bar/number → see and open the records behind it.
5. **Share publicly:** toggle "Make public" → snapshots refresh with the owner's scope → copy the URL → stakeholder views without logging in.
6. **Define a metric:** dashboard editor → "Metrics" → New metric → name it, pick a source model + aggregation (+ optional filters) → Save. Then in any widget's builder, choose it under "Saved metric" (optionally add a Group by to break it down).

## Data touched
- Reads/writes: `dashboards` (widgets `{ query, viz, filter_behavior, config (legacy), x/y/w/h }` + `filters[]` + `owner_user_id` + `public_token`/`is_public`, all JSONB).
- Reads (engine): `unified_records` (server) / the store's RLS-scoped records (client), `models`, `model_views` (saved-view filters), `users` (labels), and `metric_definitions` (named metrics resolved by the engine).

## Key files
| File | What it does |
|---|---|
| `src/lib/analytics/*` | The universal engine — `engine.ts` (`runAnalyticsQuery`), `types.ts`, `filter/grouping/aggregate/dateWindows/numeric/fieldResolver/metricResolver/savedViewAdapter/validate/widgetAdapter` |
| `api/analytics.ts` | Server endpoint running the same engine (paginated, RLS-scoped) |
| `src/pages/Dashboard/hooks/useAnalyticsQuery.ts` | Client-mode hook over the store |
| `src/pages/Dashboard/components/WidgetRenderer.tsx` | Runs the engine, dispatches by family, drill-through host |
| `src/pages/Dashboard/components/builder/WidgetBuilder.tsx` | The widget builder (+ `ConditionsEditor.tsx`) |
| `src/pages/Dashboard/components/DrillThroughModal.tsx` | Records-behind-the-number modal |
| `src/pages/Dashboard/components/MetricsManagerModal.tsx` | Semantic-metrics CRUD (opened from the editor's "Metrics" button) |
| `src/pages/Dashboard/components/{DashboardFilterBar,DashboardFiltersConfigModal}.tsx` | Global filter bar + admin config |
| `src/pages/Dashboard/components/widgets/{Stat,BarChart,PieChart,LineChart,Table,Funnel,Leaderboard,Gauge,Progress,Pivot,Heatmap,Map}Widget.tsx` | Presentational renderers (one per family) |
| `src/pages/Dashboard/lib/{widgetViz,resultToChartData,format,globalFilters,snapshots,saudiGeo}.ts` | Viz families, chart adapter, number formatting, global-filter compose, public-snapshot refresh, Saudi map geo |
| `src/types/index.ts` | `Dashboard`, `DashboardWidget`, `WidgetViz`, `DashboardFilter`, `MetricDefinition` |
| `src/stores/appStore.ts` | `dashboards` + `metricDefinitions` state; `saveDashboard` / `saveMetricDefinition` / `deleteMetricDefinition` |
| `supabase/migrations/2026-06-16_metric_definitions.sql` | `metric_definitions` table + admin RLS + `updated_at` trigger |

## Open questions / known limitations
- **Map** is **city-level**: a built-in centroid lookup for ~20 major Saudi cities over a simplified national outline (self-contained — no map tiles / API keys, matching the private-CRM posture). District-level boundaries (a GeoJSON choropleth) are a future enhancement; cities the lookup doesn't know surface as a "not on map" footnote count. A KPI-target card was folded into Stat + comparison; per-target On-Track/Off-Track lives in the future `KPIDefinition` layer, not a widget.
- High-cardinality grouping shows all dropdown options incl. zero-count by default (good for small categoricals like stages); use the per-widget **Hide empty** / **Top N** control for large ones. Funnel / leaderboard / pivot / heatmap hide empties automatically.
- Composite-metric grouping is scalar-only in Phase A.
- The record-list (table) widget family isn't snapshotted for public dashboards in Phase A.
- No scheduled email of snapshots.
