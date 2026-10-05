import { afterEach, describe, expect, it, vi } from 'vitest';
import { geminiPost, resetGeminiKeyState, DAILY_QUOTA_MARK } from '../providers/geminiHttp.js';

const perDay = () => new Response(JSON.stringify({ error: { code: 429, message: 'quota', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '50000s' },
] } }), { status: 429 });
const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe('geminiPost — key rotation on a per-day quota', () => {
  afterEach(() => { vi.unstubAllEnvs(); resetGeminiKeyState(); });

  it('moves to the second key at once and keeps using it', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'k1');
    vi.stubEnv('GEMINI_API_KEY_2', 'k2');
    const seen: string[] = [];
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      const k = (init.headers as Record<string, string>)['x-goog-api-key']!;
      seen.push(k);
      return k === 'k1' ? perDay() : ok();
    });
    const opts = { fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} };
    await expect(geminiPost('/v1beta/models/gemini-3.8-flash:generateContent', {}, opts)).resolves.toEqual({ ok: true });
    await expect(geminiPost('/v1beta/models/gemini-3.8-flash:generateContent', {}, opts)).resolves.toEqual({ ok: true });
    expect(seen).toEqual(['k1', 'k2', 'k2']);
    // another model is a separate quota: key 1 is tried again there
    await geminiPost('/v1beta/models/gemini-embedding-2:batchEmbedContents', {}, opts).catch(() => null);
    expect(seen[3]).toBe('k1');
  });

  it('reports the daily quota only when every key is refused', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'k1');
    vi.stubEnv('GEMINI_API_KEY_2', 'k2');
    const fetchMock = vi.fn(async () => perDay());
    const opts = { fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} };
    const err = await geminiPost('/v1beta/models/gemini-3.8-flash:generateContent', {}, opts).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toContain(DAILY_QUOTA_MARK);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // and a later call does not even try while both are set aside
    const err2 = await geminiPost('/v1beta/models/gemini-3.8-flash:generateContent', {}, opts).then(() => null, (e: unknown) => e as Error);
    expect(err2?.message).toContain('all 2 key(s)');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
