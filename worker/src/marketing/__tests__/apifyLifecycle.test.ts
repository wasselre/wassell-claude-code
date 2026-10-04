import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  collectViaApify, classifyApifyError, buildInput, incrementalWindow,
  ProviderPausedError, INCREMENTAL_CEILING, HISTORY_CEILING, decideBudgetAction,
} from '../apifyLifecycle';
import { apifyRunIdsToSweep, mayHoldMedia } from '../apifyStorageSweep';
import { browserbaseFallbackEligible } from '../pipeline';
import type { SupabaseClient } from '@supabase/supabase-js';

// Table-aware fake: the actor config, and the provider's pause state.
function fakeSb(opts: { actor?: { is_enabled: boolean; result_parser?: string; source_type?: string; actor_id?: string } | null; pausedUntil?: string | null } = {}): SupabaseClient {
  const actor = opts.actor === undefined ? { is_enabled: true } : opts.actor;
  return {
    from: (table: string) => {
      const builder = {
        select: () => builder, eq: () => builder, order: () => builder, limit: () => builder,
        maybeSingle: async () => {
          if (table === 'mkt_providers') return { data: { paused_until: opts.pausedUntil ?? null, pause_reason: null }, error: null };
          return {
            data: actor ? {
              source_type: actor.source_type ?? 'tiktok_profile', actor_id: actor.actor_id ?? 'clockworks/tiktok-scraper',
              result_parser: actor.result_parser ?? 'parseTiktokVideos', is_enabled: actor.is_enabled,
            } : null,
            error: null,
          };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const tiktokItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id, text: 'مشروع مينا 52', webVideoUrl: `https://www.tiktok.com/@menaco_sa/video/${id}`,
  createTimeISO: '2026-09-20T09:00:00.000Z', playCount: 1000, diggCount: 10, videoMeta: { coverUrl: 'c.jpg', duration: 20 }, ...extra,
});

/** A fake Apify API. Each POST /acts/…/runs starts the next scripted run. */
function fakeApify(datasets: Array<Array<Record<string, unknown>>>) {
  const started: Array<Record<string, unknown>> = [];
  const deletes: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: { method?: string; body?: string }) => {
    const url = input.toString();
    const method = init?.method ?? 'GET';
    if (url.includes('/acts/') && method === 'POST') {
      started.push(JSON.parse(init!.body!));
      return new Response(JSON.stringify({ data: { id: `RUN${started.length}`, status: 'READY' } }), { status: 201 });
    }
    const run = url.match(/\/actor-runs\/(RUN\d+)$/);
    if (run && method === 'GET') {
      const n = run[1]!;
      return new Response(JSON.stringify({ data: {
        id: n, status: 'SUCCEEDED', defaultDatasetId: `DS${n}`, defaultKeyValueStoreId: `KV${n}`, defaultRequestQueueId: `RQ${n}`,
        stats: { computeUnits: 0.02 }, usageTotalUsd: 0.01,
      } }), { status: 200 });
    }
    const ds = url.match(/\/datasets\/DSRUN(\d+)\/items/);
    if (ds) return new Response(JSON.stringify(datasets[Number(ds[1]) - 1] ?? []), { status: 200 });
    if (method === 'DELETE') { deletes.push(url.replace('https://api.apify.com/v2', '')); return new Response(null, { status: 204 }); }
    return new Response('{}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { started, deletes, fetchMock };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Apify lifecycle — collection', () => {
  it('TikTok: metadata pass without downloads, then downloads ONLY the new video', async () => {
    vi.stubEnv('APIFY_API_TOKEN', 'tok');
    const { started, deletes } = fakeApify([
      [tiktokItem('111'), tiktokItem('222')],                                   // metadata pass
      [tiktokItem('222', { mediaUrls: ['https://api.apify.com/v2/key-value-stores/KV/records/v.mp4'] })], // download pass
    ]);
    const res = await collectViaApify(fakeSb(), {
      platform: 'tiktok', handle: 'menaco_sa', limit: 30, newerThan: '2026-09-07T00:00:00.000Z',
      knownExternalIds: async () => new Set(['111']),
    });

    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ profiles: ['menaco_sa'], shouldDownloadVideos: false, oldestPostDateUnified: '2026-09-07' });
    expect(started[1]).toMatchObject({ postURLs: ['https://www.tiktok.com/@menaco_sa/video/222'], shouldDownloadVideos: true });
    expect(started[1]).not.toHaveProperty('profiles');

    // the new post carries the downloadable file; the known one is metadata-only
    const byId = new Map(res.posts.map((p) => [p.externalId, p]));
    expect((byId.get('222')!.raw as { mediaUrls?: string[] }).mediaUrls).toHaveLength(1);
    expect((byId.get('111')!.raw as { mediaUrls?: string[] }).mediaUrls).toBeUndefined();

    // metadata run storage is gone immediately; the download run's is kept for the media step
    expect(deletes).toEqual(expect.arrayContaining(['/datasets/DSRUN1', '/key-value-stores/KVRUN1', '/request-queues/RQRUN1']));
    expect(deletes.some((d) => d.includes('RUN2'))).toBe(false);
    expect(res.cost).toMatchObject({ run_id: 'RUN1', storage_deleted_runs: ['RUN1'], pending_storage_runs: ['RUN2'], usage_total_usd: 0.02 });
    expect(res.warnings).toEqual([]);
  });

  it('TikTok: no download pass at all when every returned video is already stored', async () => {
    vi.stubEnv('APIFY_API_TOKEN', 'tok');
    const { started } = fakeApify([[tiktokItem('111')]]);
    const res = await collectViaApify(fakeSb(), { platform: 'tiktok', handle: 'menaco_sa', limit: 30, knownExternalIds: async () => new Set(['111']) });
    expect(started).toHaveLength(1);
    expect(res.cost).toMatchObject({ pending_storage_runs: [], usage_total_usd: 0.01 });
  });

  it('Instagram: passes the cutoff, never downloads, and deletes its storage', async () => {
    vi.stubEnv('APIFY_API_TOKEN', 'tok');
    const { started, deletes } = fakeApify([[{ id: 'ig1', shortCode: 'abc', caption: 'x', timestamp: '2026-09-20T00:00:00Z' }]]);
    const res = await collectViaApify(fakeSb({ actor: { is_enabled: true, source_type: 'instagram_profile', actor_id: 'apify/instagram-scraper', result_parser: 'parseInstagramPosts' } }),
      { platform: 'instagram', handle: 'riva_aqar', limit: 30, newerThan: '2026-09-07T00:00:00.000Z' });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ directUrls: ['https://www.instagram.com/riva_aqar/'], resultsLimit: 30, onlyPostsNewerThan: '2026-09-07T00:00:00.000Z' });
    expect(res.posts).toHaveLength(1);
    expect(deletes).toContain('/key-value-stores/KVRUN1');
  });

  it('reports hitting the ceiling as a warning instead of silently truncating', async () => {
    vi.stubEnv('APIFY_API_TOKEN', 'tok');
    fakeApify([[tiktokItem('1'), tiktokItem('2')]]);
    const res = await collectViaApify(fakeSb(), { platform: 'tiktok', handle: 'x', limit: 2, knownExternalIds: async () => new Set(['1', '2']) });
    expect(res.warnings.join(' ')).toMatch(/2-post ceiling/);
  });

  it('refuses to start any run while the provider is paused for budget', async () => {
    vi.stubEnv('APIFY_API_TOKEN', 'tok');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const until = new Date(Date.now() + 86_400_000).toISOString();
    await expect(collectViaApify(fakeSb({ pausedUntil: until }), { platform: 'tiktok', handle: 'x', limit: 30, knownExternalIds: async () => new Set() }))
      .rejects.toBeInstanceOf(ProviderPausedError);
    expect(fetchMock).not.toHaveBeenCalled(); // no run started = no cost
  });

  it('runs normally once the pause time has passed', async () => {
    vi.stubEnv('APIFY_API_TOKEN', 'tok');
    const { started } = fakeApify([[]]);
    await collectViaApify(fakeSb({ pausedUntil: '2026-01-01T00:00:00Z' }), { platform: 'tiktok', handle: 'x', limit: 30, knownExternalIds: async () => new Set() });
    expect(started).toHaveLength(1);
  });

  it('refuses a DISABLED actor (config_invalid) before starting any run', async () => {
    vi.stubEnv('APIFY_API_TOKEN', 'tok');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(collectViaApify(fakeSb({ actor: { is_enabled: false } }), { platform: 'tiktok', handle: 'x', limit: 15 }))
      .rejects.toThrow(/disabled/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports not_configured when APIFY_API_TOKEN is unset', async () => {
    vi.stubEnv('APIFY_API_TOKEN', '');
    await expect(collectViaApify(fakeSb(), { platform: 'tiktok', handle: 'x', limit: 15 }))
      .rejects.toThrow(/APIFY_API_TOKEN/);
  });
});

describe('classifyApifyError — a spent budget is not an outage', () => {
  it('recognises the real 403 monthly-limit response', () => {
    const body = JSON.stringify({ error: { type: 'platform-feature-disabled', message: 'Monthly usage hard limit exceeded' } });
    expect(classifyApifyError(403, body)).toBe('budget_exhausted');
  });
  it('recognises the 402 "not enough usage to run" response', () => {
    expect(classifyApifyError(402, '{"error":{"type":"not-enough-usage-to-run-paid-actor"}}')).toBe('budget_exhausted');
  });
  it('keeps other failures as they were', () => {
    expect(classifyApifyError(403, '{"error":{"type":"insufficient-permissions"}}')).toBe('unavailable');
    expect(classifyApifyError(500, 'oops')).toBe('unavailable');
    expect(classifyApifyError(401, '')).toBe('auth_failed');
    expect(classifyApifyError(429, '')).toBe('rate_limited');
  });
  it('never sends a spent budget to the paid fallback scraper', () => {
    expect(browserbaseFallbackEligible({ primaryHealth: 'budget_exhausted', attemptsExhausted: true }).eligible).toBe(false);
  });
});

describe('incrementalWindow — 12 months once, then only new posts', () => {
  const now = new Date('2026-10-04T07:00:00Z');
  it('history never collected: the last 12 months, history ceiling', () => {
    expect(incrementalWindow(null, null, now)).toEqual({ newerThan: '2025-10-04T07:00:00.000Z', limit: HISTORY_CEILING, mode: 'history' });
    // posts stored by the old collector do not count as a collected history
    expect(incrementalWindow('2026-09-20T10:00:00Z', null, now).mode).toBe('history');
  });
  it('active account: only posts since our newest one, minus a one-day overlap', () => {
    expect(incrementalWindow('2026-10-03T10:00:00Z', '2026-09-30T00:00:00Z', now))
      .toEqual({ newerThan: '2026-10-02T10:00:00.000Z', limit: INCREMENTAL_CEILING, mode: 'new_only' });
  });
  it('quiet account: anchored on the history run, not on an old post (nothing re-bought)', () => {
    expect(incrementalWindow('2026-01-01T00:00:00Z', '2026-10-01T00:00:00Z', now).newerThan).toBe('2026-09-30T00:00:00.000Z');
  });
  it('after a long pause: still only new posts, but with the larger ceiling', () => {
    const w = incrementalWindow('2026-08-01T00:00:00Z', '2026-07-01T00:00:00Z', now);
    expect(w).toEqual({ newerThan: '2026-07-31T00:00:00.000Z', limit: HISTORY_CEILING, mode: 'new_only' });
  });
  it('never reaches further back than 12 months', () => {
    expect(incrementalWindow('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', now).newerThan).toBe('2025-10-04T07:00:00.000Z');
  });
});

describe('buildInput', () => {
  it('Instagram post links: exactly those posts', () => {
    expect(buildInput('instagram_profile', 'h', 30, { postUrls: ['https://www.instagram.com/p/A/', 'https://www.instagram.com/p/B/'] }))
      .toEqual({ directUrls: ['https://www.instagram.com/p/A/', 'https://www.instagram.com/p/B/'], resultsType: 'posts', resultsLimit: 2 });
  });
  it('TikTok post links: the views check does not pay for a video download', () => {
    expect(buildInput('tiktok_profile', 'h', 30, { postUrls: ['u'], download: false })).toMatchObject({ postURLs: ['u'], shouldDownloadVideos: false, shouldDownloadCovers: false });
    // the download pass and the redownload keep downloading by default
    expect(buildInput('tiktok_profile', 'h', 30, { postUrls: ['u'] })).toMatchObject({ shouldDownloadVideos: true });
  });
  it('TikTok without a cutoff still never downloads on the profile pass', () => {
    expect(buildInput('tiktok_profile', 'h', 30)).toMatchObject({ profiles: ['h'], shouldDownloadVideos: false, shouldDownloadCovers: false });
    expect(buildInput('tiktok_profile', 'h', 30)).not.toHaveProperty('oldestPostDateUnified');
  });
});

describe('apify storage sweep — which runs, and whether media may still be needed', () => {
  it('collects every run id and skips ones already deleted', () => {
    expect(apifyRunIdsToSweep({ run_id: 'A', runs: [{ run_id: 'A' }, { run_id: 'B' }], pending_storage_runs: ['B'], storage_deleted_runs: ['A'] })).toEqual(['B']);
    expect(apifyRunIdsToSweep({ run_id: 'OLD' })).toEqual(['OLD']);
  });
  it('treats pre-2026-09-21 TikTok runs as possibly holding videos, Instagram never', () => {
    expect(mayHoldMedia({ run_id: 'OLD' }, 'tiktok')).toBe(true);
    expect(mayHoldMedia({ run_id: 'OLD' }, 'instagram')).toBe(false);
    expect(mayHoldMedia({ run_id: 'A', runs: [{ run_id: 'A' }], pending_storage_runs: [] }, 'tiktok')).toBe(false);
    expect(mayHoldMedia({ run_id: 'A', runs: [{ run_id: 'A' }, { run_id: 'B' }], pending_storage_runs: ['B'] }, 'tiktok')).toBe(true);
  });
});


describe('decideBudgetAction — a refusal is not proof the budget is gone', () => {
  // The 2026-09-23 incident: 19 seconds into a fresh cycle Apify answered 402
  // "remaining usage of $0.00" while its limits endpoint reported $29 free. The
  // old code paused collection until 2026-10-22 and lost four days.
  it('retries when Apify reports the cycle is fresh', () => {
    const d = decideBudgetAction({ usedUsd: 0.0014, capUsd: 29, cycleEnd: '2026-10-22T23:59:59.999Z' });
    expect(d.action).toBe('retry');
    expect(d.reason).toMatch(/\$28\.00 left|left\)/);
  });
  it('pauses to the cycle end when the budget really is spent', () => {
    const d = decideBudgetAction({ usedUsd: 31.65, capUsd: 29, cycleEnd: '2026-10-22T23:59:59.999Z' });
    expect(d).toMatchObject({ action: 'pause', until: '2026-10-22T23:59:59.999Z' });
  });
  it('pauses when the remaining budget is only rounding dust', () => {
    expect(decideBudgetAction({ usedUsd: 28.9, capUsd: 29, cycleEnd: null }).action).toBe('pause');
  });
  it('pauses on the provider word when the limit cannot be read', () => {
    expect(decideBudgetAction(null)).toMatchObject({ action: 'pause', until: null });
    expect(decideBudgetAction({ usedUsd: null, capUsd: null, cycleEnd: '2026-10-22T23:59:59.999Z' }))
      .toMatchObject({ action: 'pause', until: '2026-10-22T23:59:59.999Z' });
  });
});
