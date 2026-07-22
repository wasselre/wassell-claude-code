import { describe, it, expect, vi, afterEach } from 'vitest';
import { collectViaApify } from '../apifyLifecycle';
import type { SupabaseClient } from '@supabase/supabase-js';

// Minimal fake supabase returning an ENABLED tiktok actor config.
function fakeSb(actor: { is_enabled: boolean; result_parser?: string } | null): SupabaseClient {
  const builder = {
    select: () => builder, eq: () => builder, order: () => builder, limit: () => builder,
    maybeSingle: async () => ({
      data: actor ? { source_type: 'tiktok_profile', actor_id: 'clockworks/tiktok-scraper', result_parser: actor.result_parser ?? 'parseTiktokVideos', is_enabled: actor.is_enabled } : null,
      error: null,
    }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

const TIKTOK_ITEM = {
  id: '7420108274738990354', text: 'مشروع مينا 52', webVideoUrl: 'https://www.tiktok.com/@menaco_sa/video/7420108274738990354',
  createTimeISO: '2026-05-01T09:00:00.000Z', playCount: 1000, diggCount: 10, videoMeta: { coverUrl: 'c.jpg', duration: 20 },
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Apify lifecycle (worker) — the single implementation', () => {
  it('runs start → poll(RUNNING→SUCCEEDED) → dataset → parse and reports cost', async () => {
    vi.stubEnv('APIFY_API_TOKEN', 'tok');
    let pollCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: { method?: string }) => {
      const url = input.toString();
      if (url.includes('/acts/') && init?.method === 'POST') {
        return new Response(JSON.stringify({ data: { id: 'RUN1', status: 'READY' } }), { status: 201 });
      }
      if (url.includes('/actor-runs/RUN1') && (init?.method ?? 'GET') === 'GET') {
        pollCount++;
        const status = pollCount < 2 ? 'RUNNING' : 'SUCCEEDED';
        return new Response(JSON.stringify({ data: { id: 'RUN1', status, defaultDatasetId: 'DS1', stats: { computeUnits: 0.02 }, usageTotalUsd: 0.01 } }), { status: 200 });
      }
      if (url.includes('/datasets/DS1/items')) {
        return new Response(JSON.stringify([TIKTOK_ITEM]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));

    const res = await collectViaApify(fakeSb({ is_enabled: true }), { platform: 'tiktok', handle: 'menaco_sa', limit: 15, timeoutMs: 30000 });
    expect(res.posts).toHaveLength(1);
    expect(res.posts[0]!.externalId).toBe('7420108274738990354');
    expect(res.runId).toBe('RUN1');
    expect(res.rawItems).toHaveLength(1);
    expect(res.cost).toMatchObject({ run_id: 'RUN1', dataset_items: 1, compute_units: 0.02, usage_total_usd: 0.01 });
    expect(pollCount).toBeGreaterThanOrEqual(2); // actually polled through RUNNING
  });

  it('refuses a DISABLED actor (config_invalid) before starting any run', async () => {
    vi.stubEnv('APIFY_API_TOKEN', 'tok');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(collectViaApify(fakeSb({ is_enabled: false }), { platform: 'tiktok', handle: 'x', limit: 15 }))
      .rejects.toThrow(/disabled/i);
    expect(fetchMock).not.toHaveBeenCalled(); // no run started = no cost
  });

  it('reports not_configured when APIFY_API_TOKEN is unset', async () => {
    vi.stubEnv('APIFY_API_TOKEN', '');
    await expect(collectViaApify(fakeSb({ is_enabled: true }), { platform: 'tiktok', handle: 'x', limit: 15 }))
      .rejects.toThrow(/APIFY_API_TOKEN/);
  });
});
