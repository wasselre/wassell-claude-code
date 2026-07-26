import { describe, it, expect } from 'vitest';
import { runnerStatus, RUNNER_HEARTBEAT_WARN_S, RUNNER_JOB_STUCK_S, RUNNER_BACKLOG_AGE_S } from '../ops';
import type { RunnerHealth, RunnerLease } from '../client';

const NOW = Date.parse('2026-07-26T06:00:00Z');
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

const lease = (o: Partial<RunnerLease> = {}): RunnerLease => ({
  name: 'marketing_intelligence',
  owner_id: 'runner:7845747f4d6638:647',
  host: '7845747f4d6638',
  pid: 647,
  acquired_at: iso(3600),
  heartbeat_at: iso(5),
  expires_at: new Date(NOW + 115_000).toISOString(),
  released_at: null,
  is_live: true,
  heartbeat_age_seconds: 5,
  ...o,
});

const health = (o: Partial<RunnerHealth> = {}): RunnerHealth => ({
  checked_at: iso(0),
  lease: lease(),
  queue: { ready: 11, failed: 8 },
  oldest_pending_age_seconds: null,
  current_job: null,
  failures_24h: [],
  blocked_count: 0,
  last_completed_at: iso(600),
  awaiting_intelligence_posts: 0,
  ...o,
});

const codes = (h: RunnerHealth | null) => runnerStatus(h, NOW).alerts.map((a) => a.code);

describe('runnerStatus — liveness', () => {
  it('healthy when the lease is live and freshly heartbeating', () => {
    const r = runnerStatus(health(), NOW);
    expect(r.status).toBe('healthy');
    expect(r.alerts).toEqual([]);
  });

  it('down when there is no health payload at all', () => {
    expect(runnerStatus(null, NOW).status).toBe('down');
  });

  it('down when no runner has ever taken the lease', () => {
    const r = runnerStatus(health({ lease: null }), NOW);
    expect(r.status).toBe('down');
    expect(r.alerts[0].code).toBe('no_lease');
  });

  it('down when the lease has expired — this is the real outage signal', () => {
    const r = runnerStatus(health({ lease: lease({ is_live: false, heartbeat_age_seconds: 600, heartbeat_at: iso(600) }) }), NOW);
    expect(r.status).toBe('down');
    expect(r.alerts[0].code).toBe('lease_expired');
    // the operator needs to see HOW LONG it has been dead, not just that it is
    expect(r.alerts[0].en).toContain('10m');
  });

  it('degraded — not down — when the heartbeat is late but the lease still holds', () => {
    const age = RUNNER_HEARTBEAT_WARN_S + 10;
    const r = runnerStatus(health({ lease: lease({ heartbeat_age_seconds: age, heartbeat_at: iso(age) }) }), NOW);
    expect(r.status).toBe('degraded');
    expect(codes(health({ lease: lease({ heartbeat_age_seconds: age, heartbeat_at: iso(age) }) }))).toContain('heartbeat_stale');
  });

  it('does not warn on a heartbeat that is merely one interval old', () => {
    // renewal is every 30s; 40s old is normal jitter, not a problem
    expect(codes(health({ lease: lease({ heartbeat_age_seconds: 40, heartbeat_at: iso(40) }) }))).toEqual([]);
  });
});

describe('runnerStatus — queue and work', () => {
  it('flags a backlog only when pending jobs are actually aging', () => {
    const fresh = health({ queue: { pending: 3 }, oldest_pending_age_seconds: 30 });
    expect(codes(fresh)).not.toContain('backlog');

    const stale = health({ queue: { pending: 3 }, oldest_pending_age_seconds: RUNNER_BACKLOG_AGE_S + 60 });
    expect(codes(stale)).toContain('backlog');
    expect(runnerStatus(stale, NOW).status).toBe('degraded');
  });

  it('does not flag a long-running job below the stuck threshold', () => {
    const h = health({ current_job: { id: 'j', kind: 'mkt_content_enrichment', started_at: iso(300), claimed_by: 'runner:x:1', attempts: 1, running_seconds: 300 } });
    expect(codes(h)).not.toContain('job_stuck');
  });

  it('flags a job running past the stuck threshold', () => {
    const secs = RUNNER_JOB_STUCK_S + 60;
    const h = health({ current_job: { id: 'j', kind: 'mkt_content_enrichment', started_at: iso(secs), claimed_by: 'runner:x:1', attempts: 1, running_seconds: secs } });
    expect(codes(h)).toContain('job_stuck');
  });

  it('surfaces subscription-limit blocks as their own condition', () => {
    const h = health({ blocked_count: 4 });
    expect(codes(h)).toContain('subscription_limit');
    expect(runnerStatus(h, NOW).status).toBe('degraded');
  });

  it('treats a couple of failures as info but many as a warning', () => {
    const few = health({ failures_24h: [{ kind: 'ping', n: 2, last_error: 'x' }] });
    expect(runnerStatus(few, NOW).status).toBe('healthy'); // info-only does not degrade
    const many = health({ failures_24h: [{ kind: 'mkt_content_enrichment', n: 6, last_error: 'x' }] });
    expect(runnerStatus(many, NOW).status).toBe('degraded');
  });
});

describe('runnerStatus — the broken-enqueue case', () => {
  it('flags posts parked awaiting intelligence when nothing is queued to do it', () => {
    // This is the failure the runner CANNOT report itself: it is idle and
    // healthy, yet work is stranded upstream because enqueue never happened.
    const h = health({ awaiting_intelligence_posts: 30, queue: { ready: 11 }, current_job: null });
    expect(codes(h)).toContain('posts_waiting');
    expect(runnerStatus(h, NOW).status).toBe('degraded');
  });

  it('stays quiet while those posts are actively being worked', () => {
    const h = health({
      awaiting_intelligence_posts: 30,
      queue: { pending: 2 },
      oldest_pending_age_seconds: 10,
      current_job: { id: 'j', kind: 'mkt_content_enrichment', started_at: iso(60), claimed_by: 'runner:x:1', attempts: 1, running_seconds: 60 },
    });
    expect(codes(h)).not.toContain('posts_waiting');
  });
});
