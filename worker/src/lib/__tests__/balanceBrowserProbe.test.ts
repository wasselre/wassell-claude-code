import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runBrowserBalanceProbes,
  extractAnthropicCredits,
  extractModalAmountOwed,
  parseCookieHeader,
  type BrowserProbeDeps,
  type ProbeBrowser,
  type ProbePage,
} from '../balanceBrowserProbe';

// ---------------------------------------------------------------------------
// Fakes — no network, no real browser. The Browserbase HTTP surface is the
// injected `createSession`; the Playwright surface is the injected `connect`.
// ---------------------------------------------------------------------------

interface FakePageOpts {
  /** What page.url() returns AFTER goto (a login redirect changes it). */
  landedUrl?: string;
  /** What the page's visible text evaluates to. */
  text?: string;
}

function fakeBrowser(opts: FakePageOpts, tracker: { closed: number }): ProbeBrowser {
  let url = 'about:blank';
  const page: ProbePage = {
    url: () => url,
    goto: async (u) => {
      url = opts.landedUrl ?? u;
    },
    waitForTimeout: async () => {},
    evaluate: async () => opts.text ?? '',
  };
  const cookiesSeen: Array<{ name: string; value: string; domain: string }> = [];
  return {
    contexts: () => [
      {
        pages: () => [page],
        newPage: async () => page,
        addCookies: async (cs) => {
          cookiesSeen.push(...cs);
        },
      },
    ],
    close: async () => {
      tracker.closed += 1;
    },
  };
}

/** Deps where createSession calls happen synchronously in provider order
 *  (anthropic first) — see runBrowserBalanceProbes — so behaviors can be
 *  keyed by call index deterministically. */
function fakeDeps(behaviors: Array<ProbeBrowser | Error>, counters: { sessions: number; connects: number }): BrowserProbeDeps {
  let sessionCalls = 0;
  let connectCalls = 0;
  return {
    createSession: async () => {
      counters.sessions += 1;
      sessionCalls += 1;
      return `cdp://fake/${sessionCalls}`;
    },
    connect: async () => {
      counters.connects += 1;
      const b = behaviors[connectCalls++];
      if (!b) throw new Error('fakeDeps: connect called more times than behaviors provided');
      if (b instanceof Error) throw b;
      return b;
    },
  };
}

interface RpcCall {
  name: string;
  params: Record<string, unknown>;
}

function fakeSb(): { sb: SupabaseClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const sb = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      return { data: '00000000-0000-0000-0000-000000000000', error: null };
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

const COOKIE = 'session_token=sup3rs3cret-c00kie-value-12345; other=abc';

const ENV_VARS = ['ANTHROPIC_CONSOLE_COOKIE', 'MODAL_CONSOLE_COOKIE'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const v of ENV_VARS) {
    savedEnv.set(v, process.env[v]);
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of ENV_VARS) {
    const prev = savedEnv.get(v);
    if (prev === undefined) delete process.env[v];
    else process.env[v] = prev;
  }
  savedEnv.clear();
});

// ---------------------------------------------------------------------------
// Pure extraction
// ---------------------------------------------------------------------------

describe('extractAnthropicCredits', () => {
  it('parses a realistic "$9.43" credits snippet', () => {
    const text = 'Claude Console\nHome  Billing  Settings\nCredits $9.43\nAPI keys\nUsage';
    const ex = extractAnthropicCredits(text);
    expect(ex).toEqual({ ok: true, amount: 9.43, matched: '$9.43' });
  });
  it('collapses an identical figure repeated in the sidebar and the main panel', () => {
    const text = 'Credits $9.43\n…\nBilling\nCredits $9.43 remaining this month';
    const ex = extractAnthropicCredits(text);
    expect(ex.ok).toBe(true);
    if (ex.ok) expect(ex.amount).toBe(9.43);
  });
  it('refuses to guess when two DIFFERENT dollar figures sit near "Credits"', () => {
    const text = 'Credits $9.43\nBuy more credits: $25.00\nCredits $12.10 was added on Sep 1';
    const ex = extractAnthropicCredits(text);
    expect(ex.ok).toBe(false);
    if (!ex.ok) {
      expect(ex.error).toMatch(/ambiguous/);
      expect(ex.error).toMatch(/\$9\.43/);
      expect(ex.error).toMatch(/\$25\.00/);
    }
  });
  it('does not let an unrelated price count as a credits figure', () => {
    const text = 'Upgrade for $20.00/month\nNo balance section rendered';
    const ex = extractAnthropicCredits(text);
    expect(ex.ok).toBe(false);
  });
});

describe('extractModalAmountOwed', () => {
  it('reads a single amount-due figure', () => {
    const ex = extractModalAmountOwed('Billing\nCurrent usage $53.27\nPayment method Visa •••• 4242');
    expect(ex).toEqual({ ok: true, amount: 53.27, matched: '$53.27' });
  });
  it('finds nothing on a page with no amount-owed label', () => {
    const ex = extractModalAmountOwed('Billing\nInvoices\nSeptember 2026');
    expect(ex.ok).toBe(false);
  });
});

describe('parseCookieHeader', () => {
  it('splits name=value pairs and scopes them to every given domain', () => {
    const cs = parseCookieHeader('a=1; b=two=2; ; flag', ['.example.com', '.example.org']);
    expect(cs).toHaveLength(4);
    expect(cs[0]).toEqual({ name: 'a', value: '1', domain: '.example.com', path: '/' });
    expect(cs[1]).toEqual({ name: 'a', value: '1', domain: '.example.org', path: '/' });
    expect(cs[2]).toMatchObject({ name: 'b', value: 'two=2' });
  });
});

// ---------------------------------------------------------------------------
// Full probe runs (faked browser surfaces)
// ---------------------------------------------------------------------------

describe('runBrowserBalanceProbes', () => {
  it('a cookie-less provider returns unsupported and makes no network call', async () => {
    // Neither cookie env var is set (beforeEach cleared them).
    const counters = { sessions: 0, connects: 0 };
    const tracker = { closed: 0 };
    const deps = fakeDeps([], counters);
    const { sb, calls } = fakeSb();

    const probes = await runBrowserBalanceProbes(sb, deps);

    expect(counters.sessions).toBe(0);
    expect(counters.connects).toBe(0);
    expect(tracker.closed).toBe(0);
    expect(probes).toHaveLength(2);
    for (const p of probes) {
      expect(p.status).toBe('unsupported');
      expect(p.error).toMatch(/not configured/);
      expect(p.balanceUsd).toBeUndefined();
    }
    // Both unsupported rows are still RECORDED — an unchecked provider must be
    // visible, not absent.
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.params.p_status)).toEqual(['unsupported', 'unsupported']);
    expect(calls.map((c) => c.params.p_source)).toEqual(['browser', 'browser']);
  });

  it('a page that redirects to login is an expired-session error, never a zero', async () => {
    process.env.ANTHROPIC_CONSOLE_COOKIE = COOKIE;
    const tracker = { closed: 0 };
    const counters = { sessions: 0, connects: 0 };
    const deps = fakeDeps(
      [fakeBrowser({ landedUrl: 'https://platform.claude.com/login', text: 'Log in to continue' }, tracker)],
      counters,
    );
    const { sb, calls } = fakeSb();

    const probes = await runBrowserBalanceProbes(sb, deps);
    const anthropic = probes.find((p) => p.provider === 'anthropic')!;

    expect(anthropic.status).toBe('error');
    expect(anthropic.error).toMatch(/session expired/i);
    expect(anthropic.error).toMatch(/ANTHROPIC_CONSOLE_COOKIE/);
    expect(anthropic.balanceUsd).toBeUndefined();
    const row = calls.find((c) => c.params.p_provider === 'anthropic')!;
    expect(row.params.p_status).toBe('error');
    expect(row.params.p_balance).toBeNull();
    // The browser was still closed (session released) on the failure path.
    expect(tracker.closed).toBe(1);
  });

  it('a successful Anthropic run records the credits figure and closes the browser', async () => {
    process.env.ANTHROPIC_CONSOLE_COOKIE = COOKIE;
    const tracker = { closed: 0 };
    const counters = { sessions: 0, connects: 0 };
    const deps = fakeDeps(
      [fakeBrowser({ text: 'Claude Console\nBilling\nCredits $9.43\nUsage' }, tracker)],
      counters,
    );
    const { sb, calls } = fakeSb();

    const probes = await runBrowserBalanceProbes(sb, deps);
    const anthropic = probes.find((p) => p.provider === 'anthropic')!;

    expect(anthropic).toMatchObject({ provider: 'anthropic', source: 'browser', status: 'ok', balanceUsd: 9.43, currency: 'USD' });
    const row = calls.find((c) => c.params.p_provider === 'anthropic')!;
    expect(row.name).toBe('ai_balance_probe_add');
    expect(row.params.p_status).toBe('ok');
    expect(row.params.p_balance).toBe(9.43);
    expect(row.params.p_source).toBe('browser');
    expect(tracker.closed).toBe(1);
  });

  it('an ambiguous page (two different dollar figures) records an error, not a guess', async () => {
    process.env.ANTHROPIC_CONSOLE_COOKIE = COOKIE;
    const tracker = { closed: 0 };
    const counters = { sessions: 0, connects: 0 };
    const deps = fakeDeps(
      [fakeBrowser({ text: 'Credits $9.43\nAuto-reload: when credits fall below $5.00, buy $10.00\nCredits $12.10 added Sep 1' }, tracker)],
      counters,
    );
    const { sb, calls } = fakeSb();

    const probes = await runBrowserBalanceProbes(sb, deps);
    const anthropic = probes.find((p) => p.provider === 'anthropic')!;

    expect(anthropic.status).toBe('error');
    expect(anthropic.error).toMatch(/ambiguous/i);
    expect(anthropic.balanceUsd).toBeUndefined();
    const row = calls.find((c) => c.params.p_provider === 'anthropic')!;
    expect(row.params.p_balance).toBeNull();
  });

  it('a Modal amount-owed is recorded NEGATIVE (usage-billed, not prepaid)', async () => {
    process.env.MODAL_CONSOLE_COOKIE = COOKIE;
    const tracker = { closed: 0 };
    const counters = { sessions: 0, connects: 0 };
    // Anthropic runs first (no cookie → unsupported, no connect), Modal second.
    const deps = fakeDeps(
      [fakeBrowser({ text: 'Billing\nCurrent usage $53.27\nInvoices' }, tracker)],
      counters,
    );
    const { sb, calls } = fakeSb();

    const probes = await runBrowserBalanceProbes(sb, deps);
    const modal = probes.find((p) => p.provider === 'modal')!;

    expect(modal).toMatchObject({ status: 'ok', balanceUsd: -53.27, currency: 'USD' });
    const row = calls.find((c) => c.params.p_provider === 'modal')!;
    expect(row.params.p_balance).toBe(-53.27);
  });

  it('the cookie value never appears in any recorded field or error string', async () => {
    process.env.ANTHROPIC_CONSOLE_COOKIE = COOKIE;
    process.env.MODAL_CONSOLE_COOKIE = COOKIE;
    const tracker = { closed: 0 };
    const counters = { sessions: 0, connects: 0 };
    // Worst case: the underlying failure ECHOES the credential (a proxy error
    // page quoting the request headers). It must be redacted before anything
    // is recorded.
    const echo = new Error(`request failed: headers { cookie: "${COOKIE}" }`);
    const deps = fakeDeps([echo, echo], counters);
    const { sb, calls } = fakeSb();

    const probes = await runBrowserBalanceProbes(sb, deps);

    expect(probes).toHaveLength(2);
    for (const p of probes) {
      expect(p.status).toBe('error');
      expect(JSON.stringify(p)).not.toContain('sup3rs3cret-c00kie-value-12345');
      expect(p.error).toContain('[redacted]');
    }
    for (const c of calls) {
      expect(JSON.stringify(c.params)).not.toContain('sup3rs3cret-c00kie-value-12345');
    }
  });

  it('one provider throwing does not stop the other being read and recorded', async () => {
    process.env.ANTHROPIC_CONSOLE_COOKIE = COOKIE;
    process.env.MODAL_CONSOLE_COOKIE = COOKIE;
    const tracker = { closed: 0 };
    const counters = { sessions: 0, connects: 0 };
    // Anthropic's connect throws; Modal's browser works.
    const deps = fakeDeps(
      [
        new Error('CDP websocket exploded'),
        fakeBrowser({ text: 'Billing\nAmount due $12.34\nInvoices' }, tracker),
      ],
      counters,
    );
    const { sb, calls } = fakeSb();

    const probes = await runBrowserBalanceProbes(sb, deps);
    const anthropic = probes.find((p) => p.provider === 'anthropic')!;
    const modal = probes.find((p) => p.provider === 'modal')!;

    expect(anthropic.status).toBe('error');
    expect(anthropic.error).toMatch(/CDP websocket exploded/);
    expect(modal).toMatchObject({ status: 'ok', balanceUsd: -12.34 });
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.params.p_provider === 'modal')!.params.p_status).toBe('ok');
    expect(calls.find((c) => c.params.p_provider === 'anthropic')!.params.p_status).toBe('error');
  });
});
