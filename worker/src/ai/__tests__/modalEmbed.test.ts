import { describe, it, expect, afterEach, vi } from 'vitest';
import { createModalEmbedProvider } from '../providers/modalEmbed';
import type { RoleConfig } from '../types';

interface Call { url: string; body: Record<string, unknown>; headers: Record<string, string> }

type Reply = { status: number; json?: unknown; text?: string } | Error;

/** Fake fetch: one queued Reply per call; records url/body/headers. */
function fakeFetch(queue: Reply[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>, headers });
    const next = queue.shift();
    if (!next) throw new Error('fakeFetch: queue exhausted');
    if (next instanceof Error) throw next;
    const body = next.text ?? JSON.stringify(next.json ?? {});
    return new Response(body, { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const TEXT_ROLE: RoleConfig = { provider: 'modal', model: 'bge-m3', version: '1' };
const IMAGE_ROLE: RoleConfig = { provider: 'modal', model: 'siglip2-base-patch16-256', version: '1' };
const noSleep = async () => {};
const base = { baseUrl: 'https://cv.example.modal.run/', token: 'tok', sleep: noSleep };

afterEach(() => vi.restoreAllMocks());

describe('embed_text / embed_images', () => {
  it('POSTs /embed_text with the token header and returns model/version/dim/vectors', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { model: 'bge-m3', version: '1', dim: 3, vectors: [[1, 2, 3], [4, 5, 6]] } }]);
    const p = createModalEmbedProvider({ ...base, fetch });
    const r = await p.embed(TEXT_ROLE, { texts: ['a', 'b'] });
    expect(calls[0].url).toBe('https://cv.example.modal.run/embed_text');
    expect(calls[0].headers['x-wassel-token']).toBe('tok');
    expect(calls[0].body).toEqual({ texts: ['a', 'b'] });
    expect(r).toMatchObject({ model: 'bge-m3', version: '1', dim: 3, provider: 'modal', cost_usd: null });
    expect(r.vectors).toEqual([[1, 2, 3], [4, 5, 6]]);
  });
  it('POSTs /embed_images with {urls}', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { model: 'siglip2', version: '1', dim: 2, vectors: [[0, 1]] } }]);
    const p = createModalEmbedProvider({ ...base, fetch });
    const r = await p.embed(IMAGE_ROLE, { image_urls: ['https://a/b.webp'] });
    expect(calls[0].url).toMatch(/\/embed_images$/);
    expect(calls[0].body).toEqual({ urls: ['https://a/b.webp'] });
    expect(r.dim).toBe(2);
  });
  it('batches inputs in chunks of ≤ 64 and concatenates in order', async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `t${i}`);
    const reply = (n: number) => ({ status: 200, json: { model: 'bge-m3', version: '1', dim: 1, vectors: Array.from({ length: n }, (_, i) => [i]) } });
    const { fetch, calls } = fakeFetch([reply(64), reply(64), reply(22)]);
    const p = createModalEmbedProvider({ ...base, fetch });
    const r = await p.embed(TEXT_ROLE, { texts });
    expect(calls).toHaveLength(3);
    expect((calls[0].body.texts as string[]).length).toBe(64);
    expect((calls[2].body.texts as string[])[0]).toBe('t128');
    expect(r.vectors).toHaveLength(150);
    expect(r.vectors[64]).toEqual([0]);
  });
  it('empty input → no HTTP call, empty vectors', async () => {
    const { fetch, calls } = fakeFetch([]);
    const p = createModalEmbedProvider({ ...base, fetch });
    const r = await p.embed(TEXT_ROLE, { texts: [] });
    expect(r.vectors).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  it('rejects texts + image_urls together, and non-modal roles', async () => {
    const p = createModalEmbedProvider({ ...base, fetch: fakeFetch([]).fetch });
    await expect(p.embed(TEXT_ROLE, { texts: ['a'], image_urls: ['u'] })).rejects.toThrow(/^provider:modal .*not both/);
    await expect(p.embed({ provider: 'anthropic', model: 'x' }, { texts: ['a'] })).rejects.toThrow(/^provider:modal role provider is 'anthropic'/);
  });
  it('vector count mismatch → provider: error', async () => {
    const { fetch } = fakeFetch([{ status: 200, json: { model: 'bge-m3', version: '1', dim: 1, vectors: [[1]] } }]);
    const p = createModalEmbedProvider({ ...base, fetch });
    await expect(p.embed(TEXT_ROLE, { texts: ['a', 'b'] })).rejects.toThrow(/^provider:modal POST \/embed_text returned 1 vectors for 2 inputs/);
  });
});

describe('embed_query', () => {
  it('returns both towers', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, json: { image_vec: [1, 2], text_vec: [3, 4, 5] } }]);
    const p = createModalEmbedProvider({ ...base, fetch });
    const q = await p.embedQuery('شقة');
    expect(calls[0].url).toMatch(/\/embed_query$/);
    expect(calls[0].body).toEqual({ text: 'شقة' });
    expect(q.image_vec).toEqual([1, 2]);
    expect(q.text_vec).toEqual([3, 4, 5]);
    expect(q.cost_usd).toBeNull();
  });
});

describe('errors + retries', () => {
  it('missing env → clear provider:modal error before any HTTP', async () => {
    const prevUrl = process.env.MODAL_CV_URL;
    const prevTok = process.env.MODAL_CV_TOKEN;
    delete process.env.MODAL_CV_URL;
    delete process.env.MODAL_CV_TOKEN;
    try {
      const { fetch, calls } = fakeFetch([]);
      const p = createModalEmbedProvider({ fetch, sleep: noSleep });
      await expect(p.embed(TEXT_ROLE, { texts: ['a'] })).rejects.toThrow(/^provider:modal MODAL_CV_URL is not set/);
      expect(calls).toHaveLength(0);
    } finally {
      if (prevUrl !== undefined) process.env.MODAL_CV_URL = prevUrl;
      if (prevTok !== undefined) process.env.MODAL_CV_TOKEN = prevTok;
    }
  });
  it('4xx is not retried and includes the body snippet', async () => {
    const { fetch, calls } = fakeFetch([{ status: 401, text: '{"detail":"bad token"}' }]);
    const p = createModalEmbedProvider({ ...base, fetch });
    await expect(p.embed(TEXT_ROLE, { texts: ['a'] })).rejects.toThrow(/^provider:modal POST \/embed_text HTTP 401: \{"detail":"bad token"\}/);
    expect(calls).toHaveLength(1);
  });
  it('503 (cold start) and network errors are retried up to 3 attempts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = { status: 200, json: { model: 'bge-m3', version: '1', dim: 1, vectors: [[1]] } };
    const { fetch, calls } = fakeFetch([{ status: 503 }, new TypeError('fetch failed'), ok]);
    const p = createModalEmbedProvider({ ...base, fetch });
    const r = await p.embed(TEXT_ROLE, { texts: ['a'] });
    expect(r.vectors).toEqual([[1]]);
    expect(calls).toHaveLength(3);
  });
  it('gives up after 3 transient failures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { fetch, calls } = fakeFetch([{ status: 502 }, { status: 503 }, { status: 504 }]);
    const p = createModalEmbedProvider({ ...base, fetch });
    await expect(p.embed(TEXT_ROLE, { texts: ['a'] })).rejects.toThrow(/^provider:modal POST \/embed_text HTTP 504/);
    expect(calls).toHaveLength(3);
  });
  it('times out via AbortController and reports the timeout', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hang = ((_: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })) as typeof fetch;
    const p = createModalEmbedProvider({ ...base, fetch: hang, timeoutMs: 5, maxAttempts: 1 });
    await expect(p.embed(TEXT_ROLE, { texts: ['a'] })).rejects.toThrow(/^provider:modal POST \/embed_text timeout after 5ms/);
  });
  it('non-JSON body → provider: error', async () => {
    const { fetch } = fakeFetch([{ status: 200, text: '<html>' }]);
    const p = createModalEmbedProvider({ ...base, fetch });
    await expect(p.embed(TEXT_ROLE, { texts: ['a'] })).rejects.toThrow(/^provider:modal POST \/embed_text returned non-JSON body/);
  });
});
