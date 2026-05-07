# PRD: Dashboards

**Status:** Live
**Last updated:** 2026-05-07 (**Realtime + access hardening — Phases B.1+B.2, C.1, deployed 2026-05-07.** `dashboards` is now on the `supabase_realtime` publication at `REPLICA IDENTITY FULL` — multi-user dashboard edits propagate live to other open browsers via the `RealtimeOrchestrator`. The public-dashboard read path is unchanged but reinforced: `get_public_dashboard(p_token)` is now the **only** public-schema RPC explicitly granted `EXECUTE` to `anon` (every other function had `REVOKE EXECUTE FROM PUBLIC` applied). Anon callers get `42501` on any other function. The token-based public access at `/public/dashboard/:token` continues to work because the function is SECURITY DEFINER and enforces both `is_public = true` AND `token = p_token` server-side.) | 2026-04-19 (range-field filter support — min/max sub-path picker)
**Related PRDs:** model-builder.md, record-management.md, access-control.md, data-storage.md

## What it is (in plain English)
Dashboards are visual, drag-and-drop reports built on top of the user's records. A dashboard is a canvas of widgets: stat cards, bar charts, pie charts, line charts, and tables. Each widget is pointed at a model, filtered, grouped/aggregated, and laid out on a grid. Dashboards can be shared publicly via a tokenized URL — no login needed for viewers.

## Why it exists
Managers need at-a-glance views of the business: how many hot leads, pipeline by region, calls logged per rep this week. Rather than shipping one fixed dashboard, we let managers build their own on top of whatever models they have.

## Key behaviors
- URL: `/dashboards` (list), `/dashboards/:dashboardId` (editor), `/public/dashboard/:token` (public view — no layout).
- **5 widget types:** Stat (single number), Bar Chart, Pie Chart, Line Chart, Table.
- Each widget has config: source model, filters, group-by field, aggregation (count / sum / avg / min / max), optional date bucket for line charts.
- **Range-field filters:** when a filter condition targets a range field (stored shape `{ min?: number; max?: number }`), the editor shows a min/max sub-path picker between the field and the operator. The chosen bound (`field_path: 'min' | 'max'`) is the scalar compared by `greater_than` / `less_than` / `equals` etc. `is_empty` / `is_not_empty` skip the sub-path picker and evaluate against the whole range value. Conditions saved before this support (range field + no `field_path` + numeric operator) are silently skipped at evaluation time instead of filtering every record out.
- Widgets are laid out on a responsive grid; user can resize and drag widgets.
- Dashboards store layout + widget configs together in `dashboards.widgets` JSONB.
- **Public sharing:** dashboard has a unique `public_token`. Visiting `/public/dashboard/:token` bypasses the app layout/sidebar and renders the widgets read-only.
- Public dashboards do NOT require authentication — anyone with the link sees the live data.
- Dashboards re-compute widgets on the client whenever underlying records change.
- Bilingual title/description.

## User flows
1. **Create dashboard:** `/dashboards` → "+ New Dashboard" → blank canvas opens.
2. **Add a widget:** Click "+ Widget" → pick a type → configure (model, filters, group-by, aggregation) → widget appears on grid.
3. **Arrange:** Drag widgets to reposition, resize handles on corners.
4. **Edit widget:** Click widget settings icon → config modal opens.
5. **Share publicly:** Toggle "Make public" → copy the generated URL → send to stakeholder → they can view without logging in.
6. **View public dashboard:** Open the public URL → clean standalone page, no sidebar, just widgets.

## Data touched
- Reads/writes: `dashboards` (widgets + layout as JSONB, public_token, is_public flag).
- Reads: `records` and `models` for widget data computation.

## Key files
| File | What it does |
|---|---|
| `src/pages/Dashboard/DashboardListPage.tsx` | List of dashboards |
| `src/pages/Dashboard/DashboardEditorPage.tsx` | Dashboard editor canvas |
| `src/pages/Dashboard/PublicDashboardPage.tsx` | Read-only public view |
| `src/pages/Dashboard/components/WidgetRenderer.tsx` | Dispatch to specific widget by type |
| `src/pages/Dashboard/components/WidgetConfigModal.tsx` | Widget configuration UI |
| `src/pages/Dashboard/components/StatWidget.tsx` | Single-number KPI |
| `src/pages/Dashboard/components/BarChartWidget.tsx` | Bar chart (Recharts) |
| `src/pages/Dashboard/components/PieChartWidget.tsx` | Pie chart |
| `src/pages/Dashboard/components/LineChartWidget.tsx` | Line chart (time series) |
| `src/pages/Dashboard/components/TableWidget.tsx` | Tabular widget |
| `src/lib/dashboardUtils.ts` | Aggregation + filtering logic for widgets |
| `src/lib/widgetLayout.ts` | Grid layout positioning helpers |
| `src/types/index.ts` | `Dashboard`, `Widget`, `WidgetType`, `WidgetConfig` |
| `src/stores/appStore.ts` | `dashboards` state, `saveDashboard` |

## Open questions / known limitations
- No cross-model widgets (each widget is tied to one model).
- No drill-through from a chart to the underlying record list.
- No scheduled email of dashboard snapshots.
- Public dashboards share live data — no way to snapshot a point in time.
- No access control on public dashboards — anyone with the token sees everything.
