// Pure, side-effect-free helpers for the Marketing Operations dashboard.
// The server (SQL RPCs) is the source of truth for alert generation and health;
// these mirror the *display/classification* logic so the UI is consistent and
// unit-testable without a DB. Keep the provider-bucket rule in sync with the SQL
// `mkt_ops_dashboard` provider_counts expression.
import type { OpsProviderHealth, OpsQueueHealth, OpsCost, OpsAlert, OpsDiagnostic, OpsMetricRow } from './client';

export type Bucket = 'healthy' | 'degraded' | 'offline';
export type SystemStatus = 'healthy' | 'degraded' | 'down';

/** Classify a provider into healthy/degraded/offline. Mirrors the SQL rule. */
export function providerBucket(p: Pick<OpsProviderHealth, 'is_enabled' | 'success_rate' | 'consecutive_failures' | 'health_status'>): Bucket {
  if (!p.is_enabled) return 'offline';
  if (p.consecutive_failures >= 3) return 'offline';
  if (p.consecutive_failures >= 1) return 'degraded';
  if (p.success_rate != null && p.success_rate < 0.8) return 'degraded';
  return 'healthy';
}

export function providerCounts(providers: OpsProviderHealth[]): { healthy: number; degraded: number; offline: number; total: number } {
  const c = { healthy: 0, degraded: 0, offline: 0, total: providers.length };
  for (const p of providers) c[providerBucket(p)]++;
  return c;
}

/** A diagnostic/heartbeat status → rank (higher = worse) for aggregation. */
export function statusRank(status: string | null | undefined): number {
  switch (status) {
    case 'down': return 2;
    case 'degraded': return 1;
    case 'ok': return 0;
    default: return 1; // unknown treated as degraded
  }
}

export function alertSeverityRank(sev: string): number {
  switch (sev) {
    case 'critical': return 3;
    case 'warning': return 2;
    case 'info': return 1;
    default: return 0;
  }
}

/** Overall system status from diagnostics, critical alerts, and provider buckets. */
export function overallSystemStatus(input: {
  diagnostics?: OpsDiagnostic[] | Record<string, { status: string }>;
  criticalAlerts: number;
  providers: OpsProviderHealth[];
}): SystemStatus {
  const diagStatuses: string[] = Array.isArray(input.diagnostics)
    ? input.diagnostics.map((d) => d.status)
    : Object.values(input.diagnostics ?? {}).map((d) => d.status);
  const worstDiag = diagStatuses.reduce((acc, s) => Math.max(acc, statusRank(s)), 0);
  const buckets = input.providers.map(providerBucket);
  const anyOffline = buckets.includes('offline');
  const allOffline = buckets.length > 0 && buckets.every((b) => b === 'offline');

  if (input.criticalAlerts > 0 || worstDiag >= 2 || allOffline) return 'down';
  if (worstDiag === 1 || anyOffline || buckets.includes('degraded')) return 'degraded';
  return 'healthy';
}

/** True when an ISO heartbeat/timestamp is older than thresholdSeconds (or missing). */
export function isStale(iso: string | null | undefined, thresholdSeconds: number, now = Date.now()): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return now - t > thresholdSeconds * 1000;
}

/** Percent increase of today's cost over the 7-day average (0 when no baseline). */
export function costSpikePct(cost: Pick<OpsCost, 'spike'>): number {
  const s = cost.spike;
  if (!s || !s.avg7_usd || s.avg7_usd <= 0) return 0;
  return Math.round(((s.today_usd - s.avg7_usd) / s.avg7_usd) * 100);
}

/** Pivot the flat metric_daily rows into a per-day series for one metric. */
export function metricSeries(rows: OpsMetricRow[], metric: string, provider = 'all'): Array<{ day: string; value: number }> {
  return rows
    .filter((r) => r.metric === metric && r.provider === provider)
    .map((r) => ({ day: r.day, value: Number(r.value) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Sum a metric over the given rows (e.g. total posts collected in the window). */
export function sumMetric(rows: OpsMetricRow[], metric: string, provider = 'all'): number {
  return rows.filter((r) => r.metric === metric && r.provider === provider).reduce((a, r) => a + Number(r.value), 0);
}

/** Duplicate-prevention rate = duplicates / (items + duplicates) over the window. */
export function duplicatePreventionRate(rows: OpsMetricRow[]): number {
  const dupes = sumMetric(rows, 'duplicates_prevented');
  const items = sumMetric(rows, 'items_collected');
  const denom = dupes + items;
  return denom > 0 ? dupes / denom : 0;
}

/** Queue backlog severity for the badge. */
export function queueBacklogLevel(q: OpsQueueHealth, backlogCount = 25): 'ok' | 'warn' | 'crit' {
  if (q.queued >= backlogCount * 2) return 'crit';
  if (q.queued >= backlogCount) return 'warn';
  return 'ok';
}

/** Sort alerts most-urgent first: severity desc, then most recent. */
export function sortAlerts(alerts: OpsAlert[]): OpsAlert[] {
  return [...alerts].sort((a, b) => {
    const s = alertSeverityRank(b.severity) - alertSeverityRank(a.severity);
    if (s !== 0) return s;
    return b.last_seen_at.localeCompare(a.last_seen_at);
  });
}

/** Compact "3h ago" style age. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function usd(n: number | null | undefined): string {
  return `$${(Number(n) || 0).toFixed(Math.abs(Number(n) || 0) < 1 ? 4 : 2)}`;
}
