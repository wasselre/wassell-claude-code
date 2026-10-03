import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { YouTube, ProviderError } from '../providers';
import { runCollectionJob, failCollectionJob, type CollectionJob } from '../runCollectionJob';
import type { WorkerEnv } from '../../env';

// Six YouTube accounts failed every day with "YouTube channel not found": the
// error was 'unavailable', so each job was retried to max_attempts, failed, and
// the scheduler re-enqueued the account the next morning — 1,691 failed jobs
// and nobody told. Four held a lowercased channel id ('ucd117cauhsn4hsyof7c7_ea'
// for 'UCD117CaUHsn4hSYOf7C7_EA'); ids are case-sensitive, so it can never
// resolve. These tests pin: a channel the API says is absent is 'not_found'
// (terminal), a transport failure is NOT, and the job runner switches the
// account off, alerts once, and never hands it to Browserbase.

const REAL_ID = 'UCD117CaUHsn4hSYOf7C7_EA';
const LOWERCASED_ID = 'ucd117cauhsn4hsyof7c7_ea';

type FetchUrl = string | URL;
function mockFetch(respond: (url: URL) => Response | Promise<Response>) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: FetchUrl) => {
    const url = new URL(String(input));
    calls.push(url);
    return respond(url);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected the promise to reject');
}

beforeEach(() => { vi.stubEnv('YOUTUBE_DATA_API_KEY', 'test-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('YouTube.resolveChannel — an absent channel is terminal, an outage is not', () => {
  it('an empty items answer → ProviderError with health not_found', async () => {
    const calls = mockFetch(() => json({ kind: 'youtube#channelListResponse', pageInfo: { totalResults: 0 }, items: [] }));
    const err = await caught(YouTube.resolveChannel('@no_such_developer'));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).health).toBe('not_found');
    expect((err as ProviderError).message).toBe('YouTube channel not found: @no_such_developer');
    expect(calls[0]!.searchParams.get('forHandle')).toBe('no_such_developer');
  });

  it('an answer with no items key at all is also not_found', async () => {
    mockFetch(() => json({ kind: 'youtube#channelListResponse', pageInfo: { totalResults: 0 } }));
    const err = await caught(YouTube.resolveChannel('@gone'));
    expect((err as ProviderError).health).toBe('not_found');
  });

  it('a lowercased channel id → not_found, and the message says it is stored in the wrong letter case', async () => {
    const calls = mockFetch(() => json({ items: [] }));
    const err = await caught(YouTube.resolveChannel(LOWERCASED_ID));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).health).toBe('not_found');
    expect((err as ProviderError).message).toMatch(/wrong letter case/);
    expect((err as ProviderError).message).toMatch(/case-sensitive/);
    expect((err as ProviderError).message).toContain(LOWERCASED_ID);
    // It fails the case-sensitive id test, so it went out as a handle lookup —
    // the reason it can never match.
    expect(calls[0]!.searchParams.get('id')).toBeNull();
    expect(calls[0]!.searchParams.get('forHandle')).toBe(LOWERCASED_ID);
  });

  it('a plain missing handle is not blamed on letter case', async () => {
    mockFetch(() => json({ items: [] }));
    const err = await caught(YouTube.resolveChannel('@wasselre'));
    expect((err as ProviderError).message).not.toMatch(/letter case/);
  });

  it('an HTTP 500 is NOT not_found — it stays a retryable outage', async () => {
    mockFetch(() => new Response('backend error', { status: 500 }));
    const err = await caught(YouTube.resolveChannel(REAL_ID));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).health).not.toBe('not_found');
    expect((err as ProviderError).health).toBe('unavailable');
  });

  it('a network failure (fetch rejects) is NOT not_found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const err = await caught(YouTube.resolveChannel(REAL_ID));
    expect(err instanceof ProviderError && err.health === 'not_found').toBe(false);
  });

  it('a 403 quota answer keeps its rate_limited health', async () => {
    mockFetch(() => json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, 403));
    const err = await caught(YouTube.resolveChannel(REAL_ID));
    expect((err as ProviderError).health).toBe('rate_limited');
  });

  it('a channel answered without an uploads playlist is an odd answer, not proof of absence', async () => {
    mockFetch(() => json({ items: [{ id: REAL_ID, snippet: { title: 'x' }, contentDetails: { relatedPlaylists: {} } }] }));
    const err = await caught(YouTube.resolveChannel(REAL_ID));
    expect((err as ProviderError).health).toBe('unavailable');
  });

  it('a normal channel answer resolves (correct-case id goes out as id=)', async () => {
    const calls = mockFetch(() => json({
      items: [{
        id: REAL_ID, snippet: { title: 'روشن' }, statistics: { subscriberCount: '12500' },
        contentDetails: { relatedPlaylists: { uploads: 'UUD117CaUHsn4hSYOf7C7_EA' } },
      }],
    }));
    await expect(YouTube.resolveChannel(` ${REAL_ID} `)).resolves.toEqual({
      channelId: REAL_ID, uploads: 'UUD117CaUHsn4hSYOf7C7_EA', title: 'روشن', subs: 12500,
    });
    expect(calls[0]!.searchParams.get('id')).toBe(REAL_ID);
    expect(calls[0]!.searchParams.get('forHandle')).toBeNull();
  });
});

// ── the job runner's catch block ────────────────────────────────────────────
type Row = Record<string, unknown>;
interface FakeDb {
  sb: SupabaseClient;
  account: Row;
  updates: Array<{ table: string; patch: Row; id: unknown }>;
  rpcCalls: Array<{ fn: string; params: Record<string, unknown> }>;
}

/** Just enough PostgREST for a `discover` job: the account read, the run
 *  ledger RPCs, the settings read, and the catch block's writes. Errors can be
 *  injected per write so the "checked and logged, never swallowed" rule is
 *  exercised, not assumed. */
function fakeDb(account: Row, opts: { metaReadError?: string; updateError?: string; alertError?: string } = {}): FakeDb {
  const updates: FakeDb['updates'] = [];
  const rpcCalls: FakeDb['rpcCalls'] = [];
  const sb = {
    from(table: string) {
      return {
        select(cols: string) {
          return {
            eq(_col: string, val: unknown) {
              return {
                async maybeSingle() {
                  if (table !== 'mkt_social_accounts') return { data: null, error: null };
                  if (cols === 'provider_metadata' && opts.metaReadError) return { data: null, error: { message: opts.metaReadError } };
                  return { data: account.id === val ? { ...account } : null, error: null };
                },
              };
            },
          };
        },
        update(patch: Row) {
          return {
            async eq(_col: string, val: unknown) {
              updates.push({ table, patch, id: val });
              if (table === 'mkt_social_accounts' && opts.updateError && 'collection_enabled' in patch) return { data: null, error: { message: opts.updateError } };
              if (table === 'mkt_social_accounts' && account.id === val) Object.assign(account, patch);
              return { data: null, error: null };
            },
          };
        },
      };
    },
    async rpc(fn: string, params: Record<string, unknown>) {
      rpcCalls.push({ fn, params });
      if (fn === 'mkt_ingestion_run_start') return { data: 'run-1', error: null };
      if (fn === 'mkt_alert_emit' && opts.alertError) return { data: null, error: { message: opts.alertError } };
      return { data: null, error: null };
    },
  };
  return { sb: sb as unknown as SupabaseClient, account, updates, rpcCalls };
}

const ACCOUNT_ID = '7d6f0a2e-1c3b-4d5e-8f90-a1b2c3d4e5f6';
const youtubeAccount = (): Row => ({
  id: ACCOUNT_ID, platform: 'youtube', provider: 'youtube', handle: LOWERCASED_ID, organization_id: null,
  collection_enabled: true, scrape_status: 'ok', is_active: true,
  provider_metadata: { discovered: true, discovery_run_id: 'run-42', confidence: 0.9 },
});
// attempts == max_attempts: the state in which an 'unavailable' failure IS
// handed to Browserbase — so "no fallback" below is a real assertion.
const discoverJob = (): CollectionJob => ({
  id: 'job-1', kind: 'discover', provider: 'youtube', social_account_id: ACCOUNT_ID, params: {}, attempts: 5, max_attempts: 5,
});
const run = (db: FakeDb, job = discoverJob()) => runCollectionJob({ supabase: db.sb, env: {} as WorkerEnv, job });

describe('runCollectionJob — a not_found account is switched off, alerted once, never retried via Browserbase', () => {
  it('disables the account, merges the reason into provider_metadata, emits one alert, rethrows', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch(() => json({ items: [] }));
    const db = fakeDb(youtubeAccount());

    const err = await caught(run(db));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).health).toBe('not_found');

    expect(db.account.collection_enabled).toBe(false);
    expect(db.account.scrape_status).toBe('error'); // the CHECK has no 'not_found'
    const meta = db.account.provider_metadata as Row;
    expect(meta).toMatchObject({ discovered: true, discovery_run_id: 'run-42', confidence: 0.9, disabled_reason: 'not_found' });
    expect(typeof meta.disabled_at).toBe('string');
    expect(meta.disabled_detail).toMatch(/wrong letter case/);

    const alerts = db.rpcCalls.filter((c) => c.fn === 'mkt_alert_emit');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.params).toMatchObject({
      p_kind: 'account_not_found', p_dedup_key: `account_not_found:${ACCOUNT_ID}`,
      p_severity: 'warning', p_subject_type: 'social_account', p_subject_id: ACCOUNT_ID,
    });
    expect(alerts[0]!.params.p_title).toContain(LOWERCASED_ID);
    expect(alerts[0]!.params.p_title).toMatch(/[؀-ۿ]/); // Arabic title

    expect(db.rpcCalls.some((c) => c.fn === 'mkt_job_enqueue')).toBe(false); // no Browserbase fallback
    expect(db.rpcCalls.find((c) => c.fn === 'mkt_ingestion_run_finish')!.params.p_status).toBe('failed');
    // the generic scrape_status write (which runs before the fallback) is skipped
    expect(db.updates.filter((u) => u.table === 'mkt_social_accounts')).toHaveLength(1);
    expect(logged.mock.calls.some((c) => String(c[0]).includes('disabled'))).toBe(true);
  });

  it('contrast: an outage on the same exhausted job DOES go to Browserbase — the fake can see a fallback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch(() => new Response('backend error', { status: 500 }));
    const db = fakeDb(youtubeAccount());

    const err = await caught(run(db));
    expect((err as ProviderError).health).toBe('unavailable');
    expect(db.rpcCalls.filter((c) => c.fn === 'mkt_job_enqueue')).toHaveLength(1);
    expect(db.rpcCalls.some((c) => c.fn === 'mkt_alert_emit')).toBe(false);
    expect(db.account.collection_enabled).toBe(true);
  });

  it('an unreadable provider_metadata still disables the account, without overwriting the metadata, and logs it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch(() => json({ items: [] }));
    const db = fakeDb(youtubeAccount(), { metaReadError: 'connection reset' });

    const err = await caught(run(db));
    expect((err as ProviderError).health).toBe('not_found');
    expect(db.account.collection_enabled).toBe(false);
    expect(db.account.scrape_status).toBe('error');
    expect(db.account.provider_metadata).toEqual({ discovered: true, discovery_run_id: 'run-42', confidence: 0.9 });
    expect(logged.mock.calls.some((c) => String(c[0]).includes('connection reset'))).toBe(true);
    expect(db.rpcCalls.filter((c) => c.fn === 'mkt_alert_emit')).toHaveLength(1);
  });

  it('failed account update and failed alert are both logged, and the original error still propagates', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch(() => json({ items: [] }));
    const db = fakeDb(youtubeAccount(), { updateError: 'violates check constraint', alertError: 'permission denied' });

    const err = await caught(run(db));
    expect((err as ProviderError).health).toBe('not_found');
    const lines = logged.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('violates check constraint'))).toBe(true);
    expect(lines.some((l) => l.includes('permission denied'))).toBe(true);
    expect(db.account.collection_enabled).toBe(true);
    // the alert records that the switch-off did NOT land
    expect((db.rpcCalls.find((c) => c.fn === 'mkt_alert_emit')!.params.p_evidence as Row).account_disabled).toBe(false);
    expect(db.rpcCalls.some((c) => c.fn === 'mkt_job_enqueue')).toBe(false);
  });
});

// A discover job looks the channel up by HANDLE, but every incremental resolves
// by the stored external_account_id. Since not_found switches the whole account
// off, a renamed channel (stale '@old_handle', valid id) must not be disabled on
// the handle alone — before the fallback, exactly that happened.
describe('runCollectionJob discover — a stale handle is not proof the channel is gone', () => {
  const channelAnswer = () => json({
    items: [{
      id: REAL_ID, snippet: { title: 'رتال' }, statistics: { subscriberCount: '900' },
      contentDetails: { relatedPlaylists: { uploads: 'UUD117CaUHsn4hSYOf7C7_EA' } },
    }],
  });
  const renamedAccount = (): Row => ({ ...youtubeAccount(), handle: '@old_handle', external_account_id: REAL_ID });

  it('handle missing but the stored id resolves → account stays enabled, no alert, run partial naming the stale handle', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = mockFetch((url) => (url.searchParams.get('id') === REAL_ID ? channelAnswer() : json({ items: [] })));
    const db = fakeDb(renamedAccount());

    await expect(run(db)).resolves.toMatchObject({ status: 'ok' });
    expect(calls.map((u) => u.searchParams.get('forHandle') ?? u.searchParams.get('id'))).toEqual(['old_handle', REAL_ID]);
    expect(db.account.collection_enabled).toBe(true);
    expect(db.account.scrape_status).toBe('ok');
    expect(db.account.external_account_id).toBe(REAL_ID);
    expect(db.account.provider_metadata).not.toHaveProperty('disabled_reason');
    expect(db.rpcCalls.some((c) => c.fn === 'mkt_alert_emit')).toBe(false);
    const finish = db.rpcCalls.find((c) => c.fn === 'mkt_ingestion_run_finish')!.params;
    expect(finish.p_status).toBe('partial');
    expect(String((finish.p_errors as string[])[0])).toMatch(/@old_handle.*stale/);
  });

  it('a handle that resolves wins over the stored id (one lookup, no fallback)', async () => {
    const calls = mockFetch((url) => (url.searchParams.get('forHandle') === 'old_handle' ? channelAnswer() : json({ items: [] })));
    const db = fakeDb(renamedAccount());

    await expect(run(db)).resolves.toMatchObject({ status: 'ok' });
    expect(calls).toHaveLength(1);
    expect(db.rpcCalls.find((c) => c.fn === 'mkt_ingestion_run_finish')!.params.p_status).toBe('succeeded');
  });

  it('handle AND stored id both missing → not_found, disabled once, detail names both lookups', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch(() => json({ items: [] }));
    const db = fakeDb(renamedAccount());

    const err = await caught(run(db));
    expect((err as ProviderError).health).toBe('not_found');
    expect((err as ProviderError).message).toMatch(/@old_handle.*stored channel id was tried too.*UCD117CaUHsn4hSYOf7C7_EA/);
    expect(db.account.collection_enabled).toBe(false);
    expect(db.rpcCalls.filter((c) => c.fn === 'mkt_alert_emit')).toHaveLength(1);
  });

  it('handle missing and the id lookup hits an outage → the outage propagates, the account is NOT disabled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch((url) => (url.searchParams.get('id') ? new Response('backend error', { status: 500 }) : json({ items: [] })));
    const db = fakeDb(renamedAccount());

    const err = await caught(run(db));
    expect((err as ProviderError).health).toBe('unavailable');
    expect(db.account.collection_enabled).toBe(true);
    expect(db.rpcCalls.some((c) => c.fn === 'mkt_alert_emit')).toBe(false);
  });
});

// ── index.ts hands a failed job to failCollectionJob ────────────────────────
interface FakeJobsDb {
  sb: SupabaseClient;
  job: Row;
  writes: Array<{ table: string; patch: Row; filters: Array<[string, unknown]> }>;
  rpcCalls: Array<{ fn: string; params: Record<string, unknown> }>;
}

/** One mkt_collection_jobs row. The guarded update honours EVERY .eq() filter,
 *  so a write that drops `status = 'running'` overwrites a requeued job here
 *  exactly as it would in Postgres. mkt_job_fail mimics its non-terminal branch
 *  (requeue) and its 'noop' when the row is no longer running. */
function fakeJobsDb(job: Row, opts: { updateError?: string; failError?: string } = {}): FakeJobsDb {
  const writes: FakeJobsDb['writes'] = [];
  const rpcCalls: FakeJobsDb['rpcCalls'] = [];
  const sb = {
    from(table: string) {
      return {
        update(patch: Row) {
          const filters: Array<[string, unknown]> = [];
          const chain = {
            eq(col: string, val: unknown) { filters.push([col, val]); return chain; },
            async select(_cols: string) {
              writes.push({ table, patch, filters });
              if (opts.updateError) return { data: null, error: { message: opts.updateError } };
              const hit = table === 'mkt_collection_jobs' && filters.every(([c, v]) => job[c] === v);
              if (hit) Object.assign(job, patch);
              return { data: hit ? [{ id: job.id }] : [], error: null };
            },
          };
          return chain;
        },
      };
    },
    async rpc(fn: string, params: Record<string, unknown>) {
      rpcCalls.push({ fn, params });
      if (fn !== 'mkt_job_fail') return { data: null, error: null };
      if (opts.failError) return { data: null, error: { message: opts.failError } };
      if (job.status !== 'running') return { data: 'noop', error: null };
      Object.assign(job, { status: 'queued', error_message: params.p_error });
      return { data: 'requeued', error: null };
    },
  };
  return { sb: sb as unknown as SupabaseClient, job, writes, rpcCalls };
}

const runningJob = (): Row => ({ id: 'job-9', status: 'running', attempts: 1, max_attempts: 5, lease_expires_at: '2026-10-03T10:10:00Z', finished_at: null, error_message: null });
const notFound = () => new ProviderError('YouTube channel not found: @gone', 'not_found');

describe('failCollectionJob — a not_found job ends terminally, everything else retries via mkt_job_fail', () => {
  it('not_found on a running job → status failed with the message, lease cleared, mkt_job_fail never called', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeJobsDb(runningJob());

    await expect(failCollectionJob(db.sb, 'job-9', notFound())).resolves.toEqual({ path: 'terminal', outcome: 'failed' });
    expect(db.job).toMatchObject({ status: 'failed', error_message: 'YouTube channel not found: @gone', lease_expires_at: null });
    expect(Number.isNaN(Date.parse(String(db.job.finished_at)))).toBe(false);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]!.table).toBe('mkt_collection_jobs');
    expect(db.writes[0]!.filters).toEqual(expect.arrayContaining([['id', 'job-9'], ['status', 'running']]));
    expect(db.rpcCalls.some((c) => c.fn === 'mkt_job_fail')).toBe(false); // not requeued with backoff
  });

  it('not_found on a job the watchdog already requeued → noop: the row is left alone and not re-failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeJobsDb({ ...runningJob(), status: 'queued', lease_expires_at: null });

    await expect(failCollectionJob(db.sb, 'job-9', notFound())).resolves.toEqual({ path: 'terminal', outcome: 'noop' });
    expect(db.job.status).toBe('queued');
    expect(db.job.error_message).toBeNull();
    expect(db.rpcCalls.some((c) => c.fn === 'mkt_job_fail')).toBe(false);
  });

  it('a failed terminal write is logged and falls back to mkt_job_fail, so the job is never left running', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeJobsDb(runningJob(), { updateError: 'permission denied for table mkt_collection_jobs' });

    await expect(failCollectionJob(db.sb, 'job-9', notFound())).resolves.toEqual({ path: 'mkt_job_fail', outcome: 'requeued' });
    expect(logged.mock.calls.some((c) => String(c[0]).includes('permission denied for table mkt_collection_jobs'))).toBe(true);
    expect(db.rpcCalls.filter((c) => c.fn === 'mkt_job_fail')).toHaveLength(1);
    expect(db.job.status).toBe('queued');
  });

  it('an outage is NOT terminal: no direct write, handed to mkt_job_fail for backoff', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeJobsDb(runningJob());

    await expect(failCollectionJob(db.sb, 'job-9', new ProviderError('YouTube 500', 'unavailable'))).resolves.toEqual({ path: 'mkt_job_fail', outcome: 'requeued' });
    expect(db.writes).toHaveLength(0);
    expect(db.rpcCalls).toEqual([{ fn: 'mkt_job_fail', params: { p_job_id: 'job-9', p_error: 'YouTube 500' } }]);
  });

  it('a non-provider error also goes to mkt_job_fail, and a failing mkt_job_fail is logged, not swallowed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = fakeJobsDb(runningJob(), { failError: 'connection reset' });

    await expect(failCollectionJob(db.sb, 'job-9', new Error('boom'))).resolves.toEqual({ path: 'mkt_job_fail', outcome: 'error' });
    expect(db.writes).toHaveLength(0);
    expect(logged.mock.calls.some((c) => String(c[0]).includes('connection reset'))).toBe(true);
  });
});
