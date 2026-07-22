import { describe, it, expect } from 'vitest';
import {
  providerBucket, providerCounts, overallSystemStatus, statusRank, alertSeverityRank,
  isStale, costSpikePct, metricSeries, sumMetric, duplicatePreventionRate, queueBacklogLevel,
  sortAlerts, ago, usd,
} from '../ops';
import type { OpsProviderHealth, OpsAlert, OpsMetricRow, OpsQueueHealth } from '../client';

const prov = (o: Partial<OpsProviderHealth>): OpsProviderHealth => ({
  provider: 'apify', display_name: 'Apify', is_enabled: true, health_status: null, health_detail: null,
  last_checked_at: null, last_success: null, last_failure: null, consecutive_failures: 0,
  avg_run_duration_ms: 1000, avg_response_ms: 1000, runs_14d: 10, success_rate: 1, error_rate: 0,
  cost_today: 0, cost_month: 0, ...o,
});

describe('providerBucket — health classification', () => {
  it('healthy when enabled, no consecutive failures, success_rate >= 0.8', () => {
    expect(providerBucket(prov({ success_rate: 0.95, consecutive_failures: 0 }))).toBe('healthy');
  });
  it('degraded on 1-2 consecutive failures', () => {
    expect(providerBucket(prov({ consecutive_failures: 1 }))).toBe('degraded');
    expect(providerBucket(prov({ consecutive_failures: 2 }))).toBe('degraded');
  });
  it('degraded when success_rate < 0.8 (no failures streak)', () => {
    expect(providerBucket(prov({ success_rate: 0.5, consecutive_failures: 0 }))).toBe('degraded');
  });
  it('offline on >=3 consecutive failures or disabled', () => {
    expect(providerBucket(prov({ consecutive_failures: 3 }))).toBe('offline');
    expect(providerBucket(prov({ is_enabled: false }))).toBe('offline');
  });
  it('null success_rate (no runs) is not degraded by itself', () => {
    expect(providerBucket(prov({ success_rate: null, consecutive_failures: 0 }))).toBe('healthy');
  });
});

describe('providerCounts', () => {
  it('buckets a mixed fleet', () => {
    const c = providerCounts([
      prov({ consecutive_failures: 0, success_rate: 1 }),   // healthy
      prov({ consecutive_failures: 1 }),                    // degraded
      prov({ consecutive_failures: 5 }),                    // offline
      prov({ is_enabled: false }),                          // offline
    ]);
    expect(c).toEqual({ healthy: 1, degraded: 1, offline: 2, total: 4 });
  });
});

describe('overallSystemStatus', () => {
  it('down when a critical alert is open', () => {
    expect(overallSystemStatus({ diagnostics: [], criticalAlerts: 1, providers: [prov({})] })).toBe('down');
  });
  it('down when a diagnostic is down', () => {
    expect(overallSystemStatus({ diagnostics: [{ check_name: 'x', status: 'down', detail: null, latency_ms: null, checked_at: '' }], criticalAlerts: 0, providers: [prov({})] })).toBe('down');
  });
  it('degraded when a provider is degraded but nothing critical', () => {
    expect(overallSystemStatus({ diagnostics: [{ check_name: 'x', status: 'ok', detail: null, latency_ms: null, checked_at: '' }], criticalAlerts: 0, providers: [prov({ consecutive_failures: 1 })] })).toBe('degraded');
  });
  it('healthy when all green', () => {
    expect(overallSystemStatus({ diagnostics: { db: { status: 'ok' } }, criticalAlerts: 0, providers: [prov({})] })).toBe('healthy');
  });
  it('accepts diagnostics as a record map', () => {
    expect(overallSystemStatus({ diagnostics: { worker: { status: 'down' } }, criticalAlerts: 0, providers: [prov({})] })).toBe('down');
  });
});

describe('statusRank / alertSeverityRank', () => {
  it('ranks worst-highest', () => {
    expect(statusRank('down')).toBeGreaterThan(statusRank('degraded'));
    expect(statusRank('degraded')).toBeGreaterThan(statusRank('ok'));
    expect(statusRank(undefined)).toBe(1);
  });
  it('orders severities', () => {
    expect(alertSeverityRank('critical')).toBeGreaterThan(alertSeverityRank('warning'));
    expect(alertSeverityRank('warning')).toBeGreaterThan(alertSeverityRank('info'));
  });
});

describe('isStale — freshness detection', () => {
  const now = Date.parse('2026-07-22T12:00:00Z');
  it('missing timestamp is stale', () => expect(isStale(null, 180, now)).toBe(true));
  it('fresh within threshold', () => expect(isStale('2026-07-22T11:59:00Z', 180, now)).toBe(false));
  it('stale beyond threshold', () => expect(isStale('2026-07-22T11:50:00Z', 180, now)).toBe(true));
  it('garbage parses as stale', () => expect(isStale('not-a-date', 180, now)).toBe(true));
});

describe('costSpikePct', () => {
  it('0 when no baseline', () => expect(costSpikePct({ spike: { is_spike: false, today_usd: 5, avg7_usd: 0 } })).toBe(0));
  it('computes percent over average', () => expect(costSpikePct({ spike: { is_spike: true, today_usd: 4, avg7_usd: 1 } })).toBe(300));
});

describe('metric aggregation — dashboard queries', () => {
  const rows: OpsMetricRow[] = [
    { day: '2026-07-20', metric: 'posts_collected', provider: 'all', value: 5 },
    { day: '2026-07-21', metric: 'posts_collected', provider: 'all', value: 3 },
    { day: '2026-07-22', metric: 'posts_collected', provider: 'all', value: 7 },
    { day: '2026-07-22', metric: 'items_collected', provider: 'all', value: 100 },
    { day: '2026-07-22', metric: 'duplicates_prevented', provider: 'all', value: 300 },
    { day: '2026-07-22', metric: 'runs', provider: 'apify', value: 9 },
  ];
  it('metricSeries pivots + sorts one metric', () => {
    expect(metricSeries(rows, 'posts_collected')).toEqual([
      { day: '2026-07-20', value: 5 }, { day: '2026-07-21', value: 3 }, { day: '2026-07-22', value: 7 },
    ]);
  });
  it('metricSeries respects provider filter', () => {
    expect(metricSeries(rows, 'runs', 'apify')).toEqual([{ day: '2026-07-22', value: 9 }]);
    expect(metricSeries(rows, 'runs', 'all')).toEqual([]);
  });
  it('sumMetric totals the window', () => expect(sumMetric(rows, 'posts_collected')).toBe(15));
  it('duplicatePreventionRate = dupes/(dupes+items)', () => {
    expect(duplicatePreventionRate(rows)).toBeCloseTo(300 / 400, 5);
  });
  it('duplicatePreventionRate 0 when no data', () => expect(duplicatePreventionRate([])).toBe(0));
});

describe('queueBacklogLevel — queue metrics', () => {
  const q = (queued: number): OpsQueueHealth => ({ queued, running: 0, retrying: 0, succeeded_24h: 0, failed_24h: 0, retried_total: 0, oldest_queued_at: null, longest_running_at: null });
  it('ok below threshold', () => expect(queueBacklogLevel(q(5), 25)).toBe('ok'));
  it('warn at threshold', () => expect(queueBacklogLevel(q(25), 25)).toBe('warn'));
  it('crit at 2x threshold', () => expect(queueBacklogLevel(q(50), 25)).toBe('crit'));
});

describe('sortAlerts', () => {
  const mk = (sev: OpsAlert['severity'], last: string): OpsAlert => ({
    id: last, kind: 'x', severity: sev, subject_type: null, subject_id: null, title: 't', body: null,
    evidence: {}, status: 'open', occurrences: 1, first_seen_at: last, last_seen_at: last,
  });
  it('critical before warning before info; recent first within severity', () => {
    const out = sortAlerts([
      mk('info', '2026-07-22T10:00:00Z'),
      mk('critical', '2026-07-22T09:00:00Z'),
      mk('warning', '2026-07-22T11:00:00Z'),
      mk('critical', '2026-07-22T12:00:00Z'),
    ]);
    expect(out.map((a) => `${a.severity}@${a.last_seen_at.slice(11, 13)}`)).toEqual(['critical@12', 'critical@09', 'warning@11', 'info@10']);
  });
});

describe('formatters', () => {
  it('ago compacts', () => {
    const now = Date.parse('2026-07-22T12:00:00Z');
    expect(ago('2026-07-22T11:59:30Z', now)).toBe('30s');
    expect(ago('2026-07-22T11:30:00Z', now)).toBe('30m');
    expect(ago('2026-07-22T09:00:00Z', now)).toBe('3h');
    expect(ago(null, now)).toBe('—');
  });
  it('usd uses 4 decimals under $1, 2 above', () => {
    expect(usd(0.1685)).toBe('$0.1685');
    expect(usd(12.5)).toBe('$12.50');
    expect(usd(null)).toBe('$0.0000');
  });
});
