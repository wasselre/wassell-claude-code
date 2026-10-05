import { describe, expect, it, vi } from 'vitest';
import { geminiPost, dailyQuotaRetryAfter, CREDITS_DEPLETED, MONTHLY_CAP } from '../providers/geminiHttp.js';

describe('geminiPost — empty prepaid balance (HTTP 402)', () => {
  it('throws a deferrable error naming the empty balance, without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 402, message: 'Your prepayment credits are depleted.' } }), { status: 402 }));
    const err = await geminiPost('/v1beta/models/x:generateContent', {}, { apiKey: 'test-key', fetch: fetchMock as unknown as typeof fetch, maxAttempts: 5, baseDelayMs: 1, sleep: async () => {} })
      .then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).toContain(CREDITS_DEPLETED);
    expect(dailyQuotaRetryAfter(err!.message)).toBe(900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pauses (hourly re-check) on the tier monthly spending cap, without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: 429, message: 'Your billing account has exceeded its monthly spending cap. Please go to AI Studio', status: 'RESOURCE_EXHAUSTED' } }), { status: 429 }));
    const err = await geminiPost('/v1beta/models/x:generateContent', {}, { apiKey: 'k', fetch: fetchMock as unknown as typeof fetch, maxAttempts: 5, baseDelayMs: 1, sleep: async () => {} }).then(() => null, (e: unknown) => e as Error);
    expect(err!.message).toContain(MONTHLY_CAP);
    expect(dailyQuotaRetryAfter(err!.message)).toBe(3600);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
