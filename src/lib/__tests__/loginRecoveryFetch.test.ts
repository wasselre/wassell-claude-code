import { describe, expect, it, vi } from 'vitest';
import { makeLoginRecoveryFetch, shareRenewal } from '../loginRecoveryFetch';

const expired = () => new Response(JSON.stringify({ code: 'PGRST303', message: 'JWT expired' }), { status: 401 });
const ok = (body = '[]') => new Response(body, { status: 200 });

describe('makeLoginRecoveryFetch', () => {
  it('renews once and retries with the new token when the server says the JWT expired', async () => {
    const base = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(expired())
      .mockResolvedValueOnce(ok('[1]'));
    const renew = vi.fn(async () => 'fresh-token');
    const f = makeLoginRecoveryFetch(renew, base);

    const res = await f('https://x.supabase.co/rest/v1/records', { headers: { Authorization: 'Bearer old', apikey: 'k' } });

    expect(await res.text()).toBe('[1]');
    expect(renew).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledTimes(2);
    const retryHeaders = new Headers(base.mock.calls[1]![1]!.headers);
    expect(retryHeaders.get('Authorization')).toBe('Bearer fresh-token');
    expect(retryHeaders.get('apikey')).toBe('k');
  });

  it('passes through a 401 that is not an expired JWT (e.g. RLS / bad key)', async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"message":"permission denied"}', { status: 401 }));
    const renew = vi.fn(async () => 'fresh-token');
    const res = await makeLoginRecoveryFetch(renew, base)('https://x.supabase.co/rest/v1/records');
    expect(res.status).toBe(401);
    expect(renew).not.toHaveBeenCalled();
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('never retries the auth endpoints themselves', async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValueOnce(expired());
    const renew = vi.fn(async () => 'fresh-token');
    const res = await makeLoginRecoveryFetch(renew, base)('https://x.supabase.co/auth/v1/token?grant_type=refresh_token');
    expect(res.status).toBe(401);
    expect(renew).not.toHaveBeenCalled();
  });

  it('returns the original 401 when the renewal fails, so error reporting still fires', async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValueOnce(expired());
    const renew = vi.fn(async () => null);
    const res = await makeLoginRecoveryFetch(renew, base)('https://x.supabase.co/rest/v1/records');
    expect(res.status).toBe(401);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('leaves successful responses untouched', async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValueOnce(ok());
    const renew = vi.fn(async () => 'fresh-token');
    const res = await makeLoginRecoveryFetch(renew, base)('https://x.supabase.co/rest/v1/records');
    expect(res.status).toBe(200);
    expect(renew).not.toHaveBeenCalled();
  });
});

describe('shareRenewal', () => {
  it('runs one renewal for many requests that expire together', async () => {
    let resolve: (t: string) => void = () => {};
    const renew = vi.fn(() => new Promise<string | null>((r) => { resolve = r; }));
    const shared = shareRenewal(renew);
    const all = Promise.all([shared(), shared(), shared()]);
    resolve('t');
    expect(await all).toEqual(['t', 't', 't']);
    expect(renew).toHaveBeenCalledTimes(1);
  });
});
