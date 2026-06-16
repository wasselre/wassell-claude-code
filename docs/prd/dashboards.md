# PRD: Dashboards

**Status:** Live
**Last updated:** 2026-06-16 (**Universal Analytics Engine — Phase A (in progress).** Dashboards now run on a shared, isomorphic analytics engine (`src/lib/analytics/`) instead of the old COUNT-only client utilities. New: all aggregations (count / count_distinct / sum / avg / min / max / percentage / ratio), multi-level grouping, lookup/assignee/date/number grouping, **time bucketing in Asia/Riyadh** (hour…year — the old UTC bucketing bug is fixed), numeric range bucketing, **relative date ranges** (today / yesterday / this·last week·month·quarter / this year / last 7 · 30 days / all-time), **comparison metrics** on stat cards (vs previous period), a new 6-section **widget builder** with a live preview, and **drill-through** (click any number / bar / slice / point → the records behind it, openable in the record form). A server endpoint `POST /api/analytics` runs the *same* engine for large datasets + (upcoming) public snapshots. Legacy widgets migrate-on-read losslessly. **Still in progress for Phase A:** dashboard-level global filters, public-dashboard stored snapshots, and the Semantic Metrics manager UI.) | 2026-05-07 (Realtime + access hardening) | 2026-04-19 (range-field filters)
**Related PRDs:** model-builder.md, record-management.md, access-control.md, data-storage.md

## What it is (in plain English)
Dashboards are visual, drag-and-drop reports built on top of the user's records. A dashboard is a canvas of widgets; each widget is a **visualization of an analytics query** — pick a source model, a date range, filters, how to group, and how to aggregate, then choose a chart. The same query engine powers the in-browser preview and the server, so the builder preview always matches the saved render. Dashboards can be shared publicly via a tokenized URL.

The engine is a **platform capability**, not a dashboard-only feature: the `AnalyticsQuery → Engine → AnalyticsResult` pipeline (`src/lib/analytics/`) is pure, serializable, and reused by everything that needs analytics (dashboards today; reports / AI insights / KPI monitoring / automations later) — there is no second analytics implementation anywhere.

## Why it exists
Managers need at-a-glance views of the business: today's calls per agent, response rate by hour, revenue by sales rep, reservations by project. Rather than shipping one fixed dashboard, managers build their own on top of whatever models they have — any model, any field type, any date range, any grouping, any aggregation.

## Key behaviors
- URL: `/dashboards` (list), `/dashboards/:dashboardId` (editor), `/public/dashboard/:token` (public view).
- **5 widget families (Phase A):** Stat (single number, with optional comparison vs previous period), Bar, Pie/Donut, Line/Area, Table (record list). (12 more widget types — KPI card, stacked/grouped bar, pivot, funnel, gauge, leaderboard, map, heatmap… — are Phase B.)
- **The query** (`AnalyticsQuery`, a pure-JSON document) carries: `source_model_id`, optional `saved_view_id`, `filters` (AND/OR group), `date_filter` (a date field + a relative/custom range), `group_by[]` (multi-level; each level can carry a time bucket for dates or a numeric bin width for numbers), `aggregation` (type + field, or numerator/denominator sub-queries for ratio/percentage, or a `metric_id`), `sort`, `limit`. It never contains code — all resolution happens in the engine.
- **Aggregations:** count, count_distinct, sum, avg, min, max, percentage (part / whole), ratio (numerator / denominator).
- **Grouping:** dropdown (option order + colors, zero-count options shown), multiselect (fan-out), lookup (resolved display value), assignee (user name), checkbox (Yes/No), date (hour…year, Riyadh), number/currency (range bins). Multi-level → cartesian groups.
- **Dates:** all date math is Asia/Riyadh via one module (`src/lib/analytics/dateWindows.ts`). User `date`/`datetime` fields are read as Riyadh wall-clock; `created_at`/`updated_at` as UTC instants shifted to Riyadh.
- **Drill-through (mandatory):** clicking any number/bar/slice/point opens a modal listing the underlying records (reusing the record table + `DynamicCell`); clicking a row opens it in `RecordFormModal` (read-only on public).
- **Builder:** one modal — Title → Source model → Visualization → Aggregation (type + type-filtered field picker; percentage gets a part-filter sub-editor) → Group by (multi-level with bucket pickers) → Date range (relative presets) → Filters → display options — with a **live preview** rendered by the real engine. A simple COUNT stat stays ~3 clicks.
- **Warnings, never silent:** unknown field / non-numeric skipped / not-aggregatable / zero-denominator / page-ceiling are surfaced, not swallowed; widget loading/empty/error states render explicitly.
- Bilingual; RTL-aware charts (axis reversal, LTR digits). Public sharing unchanged: `get_public_dashboard(token)` (SECURITY DEFINER, anon-only RPC) gates on `is_public` + token.

## User flows
1. **Create dashboard:** `/dashboards` → "+ New Dashboard" → blank canvas.
2. **Add a widget:** "+ Widget" → builder opens → choose model, visualization, aggregation, grouping, date range, filters → live preview updates → Save.
3. **Arrange:** drag / resize on the grid.
4. **Drill in:** click a bar/number → see and open the records behind it.
5. **Share publicly:** toggle "Make public" → copy the URL → stakeholder views without logging in.

## Data touched
- Reads/writes: `dashboards` (widgets `{ query, viz, filter_behavior, config (legacy), x/y/w/h }` + `filters[]` + `owner_user_id` + `public_token`/`is_public`, all JSONB).
- Reads (engine): `unified_records` (server) / the store's RLS-scoped records (client), `models`, `model_views` (saved-view filters), `users` (labels), and (upcoming) `metric_definitions`.

## Key files
| File | What it does |
|---|---|
| `src/lib/analytics/*` | The universal engine — `engine.ts` (`runAnalyticsQuery`), `types.ts`, `filter/grouping/aggregate/dateWindows/numeric/fieldResolver/metricResolver/savedViewAdapter/validate/widgetAdapter` |
| `api/analytics.ts` | Server endpoint running the same engine (paginated, RLS-scoped) |
| `src/pages/Dashboard/hooks/useAnalyticsQuery.ts` | Client-mode hook over the store |
| `src/pages/Dashboard/components/WidgetRenderer.tsx` | Runs the engine, dispatches by family, drill-through host |
| `src/pages/Dashboard/components/builder/WidgetBuilder.tsx` | The widget builder (+ `ConditionsEditor.tsx`) |
| `src/pages/Dashboard/components/DrillThroughModal.tsx` | Records-behind-the-number modal |
| `src/pages/Dashboard/components/widgets/{Stat,BarChart,PieChart,LineChart,Table}Widget.tsx` | Presentational renderers |
| `src/pages/Dashboard/lib/{widgetViz,resultToChartData,format}.ts` | Viz families, chart adapter, number formatting |
| `src/types/index.ts` | `Dashboard`, `DashboardWidget`, `WidgetViz`, `DashboardFilter`, `MetricDefinition` |
| `src/stores/appStore.ts` | `dashboards` state, `saveDashboard` |

## Open questions / known limitations
- **Phase B widget types** (KPI card, stacked/grouped bar, pivot, funnel, gauge, progress, leaderboard, map, heatmap) not built yet.
- **Dashboard-level global filters** (date / district / agent controls that fan out to widgets) — designed, not yet shipped.
- **Public stored snapshots** — the engine + endpoint exist; the publish/refresh flow + `PublicDashboardPage` rewrite are pending. Until then public dashboards render from client records (limited for anon).
- **Semantic Metrics manager UI** — the `MetricDefinition` type + engine resolution exist; the table + manager UI are pending.
- Composite-metric grouping is scalar-only in Phase A.
- No scheduled email of snapshots.
