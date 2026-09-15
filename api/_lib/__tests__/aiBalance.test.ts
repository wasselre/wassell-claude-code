/**
 * Tests for the provider balance adapters.
 *
 * These parse three different vendors' payloads into one number that the page
 * subtracts from ours to decide whether money went missing. That makes them the
 * highest-consequence parsing in the cost system: a misread balance does not
 * look like a bug, it looks like unmetered spend — or, worse, silently hides
 * real unmetered spend behind a figure that happens to agree.
 *
 * So the cases here are the ones that would be believed if they were wrong:
 * the currency each vendor reports, the exact auth header each expects, and
 * what happens when a vendor answers with something unexpected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BALANCE_ADAPTERS, probeAllBalances } from '../aiBalance.js';

const ENV = { DEEPSEEK_API_KEY: 'ds-key', KIMI_API_KEY: 'kimi-key', FAL_KEY: 'fal-key' };

type Call = { url: string; headers: Record<string, string> };
let calls: Call[];

function mockFetch(responder: (url: string) => { ok?: boolean; status?: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = responder(url);
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { ok: r.ok ?? true, status: r.status ?? 200, text: async () => text } as unknown as Response;
  }));
}

beforeEach(() => {
  calls = [];
  Object.assign(process.env, ENV);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DeepSeek balance', () => {
  it('reads total_balance from the USD entry', () => {
    mockFetch(() => ({ body: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '52.00', granted_balance: '0', topped_up_balance: '52.00' }] } }));
    return BALANCE_ADAPTERS.deepseek!().then((p) => {
      expect(p).toMatchObject({ provider: 'deepseek', source: 'api', status: 'ok', balanceUsd: 52, currency: 'USD' });
      expect(calls[0]!.url).toBe('https://api.deepseek.com/user/balance');
      expect(calls[0]!.headers.Authorization).toBe('Bearer ds-key');
    });
  });

  it('picks the USD entry when the account also reports CNY', async () => {
    // A mixed-currency account is normal. Summing them, or taking [0], would
    // silently inflate or deflate the balance by the FX rate.
    mockFetch(() => ({ body: { balance_infos: [
      { currency: 'CNY', total_balance: '380.00' },
      { currency: 'USD', total_balance: '52.00' },
    ] } }));
    const p = await BALANCE_ADAPTERS.deepseek!();
    expect(p.balanceUsd).toBe(52);
  });

  it('refuses to convert a CNY-only balance rather than inventing a rate', async () => {
    // Same rule the price book follows: a number you cannot cite is worse than
    // no number, because the page would treat it as fact.
    mockFetch(() => ({ body: { balance_infos: [{ currency: 'CNY', total_balance: '380.00' }] } }));
    const p = await BALANCE_ADAPTERS.deepseek!();
    expect(p.status).toBe('error');
    expect(p.error).toMatch(/CNY/);
    expect(p.error).toMatch(/without a cited FX rate/);
    expect(p.balanceUsd).toBeUndefined();
  });

  it('reports an HTTP failure instead of a zero balance', async () => {
    // A zero here would read as "the account is empty" and, subtracted from
    // ours, as a full-balance-worth of unmetered spend.
    mockFetch(() => ({ ok: false, status: 401, body: 'unauthorized' }));
    const p = await BALANCE_ADAPTERS.deepseek!();
    expect(p.status).toBe('error');
    expect(p.balanceUsd).toBeUndefined();
  });

  it('errors when the key is absent rather than reporting nothing left', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const p = await BALANCE_ADAPTERS.deepseek!();
    expect(p).toMatchObject({ status: 'error' });
    expect(p.error).toMatch(/DEEPSEEK_API_KEY/);
  });
});

describe('Moonshot balance', () => {
  it('reads data.available_balance, which already includes vouchers', async () => {
    // cash_balance can legitimately be negative, so summing the parts is wrong.
    mockFetch(() => ({ body: { code: 0, data: { available_balance: 27.97, voucher_balance: 25, cash_balance: 2.97 }, status: true } }));
    const p = await BALANCE_ADAPTERS.moonshot!();
    expect(p).toMatchObject({ status: 'ok', balanceUsd: 27.97, currency: 'USD' });
    expect(calls[0]!.url).toBe('https://api.moonshot.ai/v1/users/me/balance');
    expect(calls[0]!.headers.Authorization).toBe('Bearer kimi-key');
  });

  it('treats a non-zero response code as a failure', async () => {
    mockFetch(() => ({ body: { code: 1, scode: '0x1', status: false } }));
    const p = await BALANCE_ADAPTERS.moonshot!();
    expect(p.status).toBe('error');
  });

  it('strips the /anthropic suffix off KIMI_BASE_URL', async () => {
    // The chat client points at the Anthropic-compatible surface; the balance
    // endpoint lives on the root. Reusing the base verbatim would 404.
    process.env.KIMI_BASE_URL = 'https://api.moonshot.ai/anthropic';
    mockFetch(() => ({ body: { code: 0, data: { available_balance: 1 } } }));
    await BALANCE_ADAPTERS.moonshot!();
    expect(calls[0]!.url).toBe('https://api.moonshot.ai/v1/users/me/balance');
    delete process.env.KIMI_BASE_URL;
  });
});

describe('fal balance', () => {
  it('sends `Key <k>` — not Bearer — and asks for credits', async () => {
    // fal is the one provider here that does not use Bearer. Getting it wrong
    // is a 401, which this adapter would report as an error rather than a zero.
    mockFetch(() => ({ body: { username: 'wassel', credits: { current_balance: 15.3, currency: 'USD' } } }));
    const p = await BALANCE_ADAPTERS.fal!();
    expect(p).toMatchObject({ status: 'ok', balanceUsd: 15.3 });
    expect(calls[0]!.url).toContain('expand=credits');
    expect(calls[0]!.headers.Authorization).toBe('Key fal-key');
  });

  it('explains that the billing endpoint needs an admin key on a 403', async () => {
    mockFetch(() => ({ ok: false, status: 403, body: 'forbidden' }));
    const p = await BALANCE_ADAPTERS.fal!();
    expect(p.error).toMatch(/ADMIN fal key/);
  });

  it('flags a missing credits object instead of assuming zero', async () => {
    mockFetch(() => ({ body: { username: 'wassel' } }));
    const p = await BALANCE_ADAPTERS.fal!();
    expect(p.status).toBe('error');
    expect(p.balanceUsd).toBeUndefined();
  });

  it('does not treat the offline stub key as a real account', async () => {
    process.env.FAL_KEY = 'stub';
    const p = await BALANCE_ADAPTERS.fal!();
    expect(p.status).toBe('error');
    expect(calls).toHaveLength(0);
  });
});

describe('providers with no balance endpoint', () => {
  it('report `unsupported`, which is not the same as an error or a zero', async () => {
    // The page prints "cannot be checked" for these. A zero or a blank would
    // read as agreement with our own figure, which is the exact failure this
    // whole comparison exists to prevent.
    for (const provider of ['anthropic', 'modal']) {
      const p = await BALANCE_ADAPTERS[provider]!();
      expect(p.status).toBe('unsupported');
      expect(p.balanceUsd).toBeUndefined();
      expect(p.error).toBeTruthy();
    }
  });
});

describe('probeAllBalances', () => {
  it('covers every account provider the app bills', () => {
    expect(Object.keys(BALANCE_ADAPTERS).sort()).toEqual(['anthropic', 'deepseek', 'fal', 'modal', 'moonshot']);
  });

  it('settles providers independently so one outage never hides the rest', async () => {
    mockFetch((url) => {
      if (url.includes('deepseek')) throw new Error('ECONNRESET');
      if (url.includes('moonshot')) return { body: { code: 0, data: { available_balance: 5 } } };
      return { body: { credits: { current_balance: 2, currency: 'USD' } } };
    });
    const all = await probeAllBalances();
    const by = Object.fromEntries(all.map((p) => [p.provider, p]));
    expect(by.deepseek!.status).toBe('error');
    expect(by.moonshot!.status).toBe('ok');
    expect(by.fal!.status).toBe('ok');
    expect(all).toHaveLength(5);
  });
});
