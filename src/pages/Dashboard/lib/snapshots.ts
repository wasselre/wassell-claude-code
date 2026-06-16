import { supabase } from '@/lib/supabase';
import { effectiveQuery, effectiveViz } from '@/lib/analytics/widgetAdapter';
import { vizFamilyFor } from './widgetViz';
import type { Dashboard, DashboardWidget } from '@/types';

export interface RefreshResult {
  widgets: DashboardWidget[];
  refreshed: number;
  failed: number;
}

/**
 * Computes a snapshot for each engine-backed widget by running the same
 * `/api/analytics` engine server-side with the caller's (owner's) RLS scope,
 * and stores it on the widget. The public page renders these snapshots so an
 * anonymous viewer never reads raw records. Snapshots use the BASE query (no
 * dashboard global filters) — public dashboards are static, point-in-time.
 *
 * The record-list (table) family isn't snapshotted in Phase A (it renders raw
 * records, not an AnalyticsResult). Per-widget failures are counted and
 * surfaced by the caller, never silently dropped.
 */
export async function refreshDashboardSnapshots(dashboard: Dashboard): Promise<RefreshResult> {
  if (!supabase) throw new Error('Supabase not configured');
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const computed_at = new Date().toISOString();
  const widgets: DashboardWidget[] = [];
  let refreshed = 0;
  let failed = 0;

  for (const w of dashboard.widgets) {
    if (vizFamilyFor(w.type) === 'table') {
      widgets.push(w);
      continue;
    }
    const viz = effectiveViz(w);
    const comparison = viz.family === 'stat' && !!viz.comparison;
    try {
      const res = await fetch('/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: effectiveQuery(w), comparison }),
      });
      const body = res.ok ? await res.json() : null;
      if (body?.result) {
        widgets.push({ ...w, snapshot: { result: body.result, computed_at } });
        refreshed++;
      } else {
        widgets.push(w);
        failed++;
      }
    } catch {
      widgets.push(w); // keep any prior snapshot; counted as failed so the caller surfaces it
      failed++;
    }
  }
  return { widgets, refreshed, failed };
}
