/**
 * balanceBrowserProbe — read the two providers that publish NO balance
 * endpoint (Anthropic, Modal) with a real browser, and record what their
 * dashboards say is left.
 *
 * WHY THIS EXISTS. `ai_usage` can only report the call sites somebody wired,
 * so it can never answer "is anything spending that we are NOT counting". The
 * check that cannot be fooled starts from the VENDOR's number: DeepSeek,
 * Moonshot and fal publish a balance API and are probed in
 * api/_lib/aiBalance.ts; Anthropic and Modal show their numbers only in a web
 * dashboard, so those two are read here with Playwright over Browserbase.
 *
 * WHY THE WORKER. api/_lib/aiBalance.ts runs inside a Vercel Edge function,
 * where Playwright cannot run. The Fly worker already drives Browserbase for
 * other scraping (marketing/discovery, runRegaLookupJob) — same shape here:
 * POST api.browserbase.com/v1/sessions → chromium.connectOverCDP(connectUrl).
 *
 * AUTH — READ BEFORE EDITING. There is deliberately NO username/password
 * login here: Anthropic's console signs in with an emailed code, so a
 * scripted password login is not even possible. The operator captures a
 * session cookie ONCE from their own logged-in browser and stores it as a
 * Fly secret:
 *
 *   ANTHROPIC_CONSOLE_COOKIE — raw `Cookie:` header value for the console
 *   MODAL_CONSOLE_COOKIE     — same idea for modal.com
 *
 * Hard rules (violating any of these silently lies about money):
 *   1. NEVER log, echo, or persist a cookie value — not in an error message,
 *      not in `raw`, not in a console line. Every caught message goes through
 *      redactSecrets().
 *   2. An expired cookie shows up as a redirect to a login page. That is
 *      status:'error' saying the session needs refreshing — NEVER a balance
 *      of 0 (a zero would be subtracted from our figure and read as a full
 *      account's worth of unmetered spend) and never a silent skip.
 *   3. A cookie env var being absent is status:'unsupported', not a throw.
 *   4. Ambiguity is an error, not a guess: two different dollar figures near
 *      the label means we name what was seen and record nothing.
 *
 * The BalanceProbe shape mirrors api/_lib/aiBalance.ts exactly — the worker
 * cannot import from api/_lib (standalone package, rootDir:src), same posture
 * as worker/src/imageGen.ts. Keep the two in sync.
 */

import { chromium } from 'playwright-core';
import type { SupabaseClient } from '@supabase/supabase-js';

export type BalanceSource = 'api' | 'browser' | 'manual';

export interface BalanceProbe {
  provider: string;
  source: BalanceSource;
  status: 'ok' | 'error' | 'unsupported';
  /** Always dollars. For a POSTPAID provider (Modal) this is the current
   *  billing cycle's spend so far — a positive number that rises with use and
   *  resets at the cycle boundary. `v_ai_balance_reconciliation` reads it that
   *  way for any account whose billing_mode is 'postpaid'. */
  balanceUsd?: number;
  currency?: string;
  raw?: unknown;
  error?: string;
}

/** Hard ceiling per provider — a hung browser must not wedge the worker. */
const PROVIDER_TIMEOUT_MS = 60_000;
/** How long to wait for an SPA dashboard to render its figure (inside the ceiling above). */
const HYDRATE_BUDGET_MS = 20_000;
const HYDRATE_POLL_MS = 1_000;

// ---------------------------------------------------------------------------
// Narrow browser surfaces. The real objects are playwright-core's Browser /
// BrowserContext / Page (structural supersets of these); the tests substitute
// fakes. Declaring the narrow surface keeps the "no network, no real browser"
// tests honest without `any`.
// ---------------------------------------------------------------------------

export interface ProbeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface ProbePage {
  url(): string;
  goto(url: string, opts: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  /** The only evaluation we need: the page's visible text. */
  evaluate(fn: () => string): Promise<string>;
}

export interface ProbeContext {
  pages(): ProbePage[];
  newPage(): Promise<ProbePage>;
  addCookies(cookies: ProbeCookie[]): Promise<void>;
}

export interface ProbeBrowser {
  contexts(): ProbeContext[];
  close(): Promise<void>;
}

export interface BrowserProbeDeps {
  createSession: () => Promise<string>;
  connect: (connectUrl: string) => Promise<ProbeBrowser>;
}

/** Browserbase session → CDP connect URL. Same shape as
 *  marketing/discovery/browserDiscovery.ts `createDiscoverySession` and
 *  runRegaLookupJob's `createBrowserbaseSession` — no proxy geolocation:
 *  these dashboards are US sites and a Saudi residential IP would only make
 *  an unfamiliar-login challenge MORE likely. */
async function createBrowserbaseSession(): Promise<string> {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim();
  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim();
  if (!apiKey || !projectId) {
    throw new Error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set on the worker');
  }
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  const session = (await res.json()) as { connectUrl?: string; message?: string };
  if (!session.connectUrl) {
    throw new Error(`Browserbase session create failed: ${session.message ?? JSON.stringify(session).slice(0, 160)}`);
  }
  return session.connectUrl;
}

function defaultDeps(): BrowserProbeDeps {
  return {
    createSession: createBrowserbaseSession,
    connect: async (connectUrl) => (await chromium.connectOverCDP(connectUrl)) as unknown as ProbeBrowser,
  };
}

// ---------------------------------------------------------------------------
// Cookie handling
// ---------------------------------------------------------------------------

/** Parse a raw `Cookie:` header value (`a=1; b=2`) into domain-scoped cookie
 *  params. Domain scoping (rather than a blanket extra header) means the
 *  session cookie is sent ONLY to the dashboard's own domain — never to the
 *  third-party analytics/tracker requests a console page also makes. */
export function parseCookieHeader(header: string, domains: string[]): ProbeCookie[] {
  const out: ProbeCookie[] = [];
  for (const pair of header.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue; // a flag-only segment — not a name=value pair
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!name || !value) continue;
    for (const domain of domains) out.push({ name, value, domain, path: '/' });
  }
  return out;
}

/** Everything that must never appear in a recorded field: the full header
 *  plus each individual cookie value long enough to be identifying (short
 *  values like "1" would redact half the page if replaced blindly). */
function secretsOf(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  const secrets = [cookieHeader];
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const value = pair.slice(eq + 1).trim();
    if (value.length >= 8) secrets.push(value);
  }
  return secrets;
}

function redactSecrets(msg: string, secrets: string[]): string {
  let out = msg;
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out;
}

// ---------------------------------------------------------------------------
// Amount extraction — pure functions, unit-tested directly
// ---------------------------------------------------------------------------

export type ExtractResult =
  | { ok: true; amount: number; matched: string }
  | { ok: false; error: string; seen: string[] };

function parseAmount(raw: string): number | null {
  const n = Number(raw.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Collect every distinct dollar amount appearing within `window` chars AFTER
 *  one of `label` matches. Identical duplicates (a sidebar figure repeated in
 *  the main panel) collapse to one reading; DIFFERENT figures are ambiguity
 *  and become an error — per the hard rule that we name what was seen rather
 *  than guess. */
function collectLabelledAmounts(pageText: string, label: RegExp, window: number): ExtractResult {
  const seen = new Map<number, string>(); // amount → first matched snippet
  const re = new RegExp(label.source, label.flags.includes('g') ? label.flags : label.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(pageText)) !== null) {
    const after = pageText.slice(m.index, m.index + m[0].length + window);
    const amountMatch = after.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    if (!amountMatch) continue;
    const amount = parseAmount(amountMatch[1]!);
    if (amount === null) continue;
    if (!seen.has(amount)) {
      seen.set(amount, amountMatch[0].replace(/\s+/g, ' ').trim());
    }
  }
  const amounts = [...seen.keys()];
  if (amounts.length === 1) {
    return { ok: true, amount: amounts[0]!, matched: seen.get(amounts[0]!)! };
  }
  if (amounts.length === 0) {
    return { ok: false, error: 'no matching figure found', seen: [] };
  }
  const description = amounts.map((a) => `$${a.toFixed(2)} ("${seen.get(a)!}")`).join(' and ');
  return { ok: false, error: `ambiguous page: found ${amounts.length} different figures — ${description}`, seen: [...seen.values()] };
}

/**
 * Anthropic console — https://platform.claude.com/settings/billing. The
 * sidebar of every console page shows "Credits $x.xx". We accept a match only
 * when the dollar figure appears shortly AFTER the word "Credits", so a price
 * on a marketing banner cannot be mistaken for the balance.
 */
export function extractAnthropicCredits(pageText: string): ExtractResult {
  return collectLabelledAmounts(pageText, /credits\b/gi, 60);
}

/**
 * Modal — usage-billed, NOT prepaid. The workspace usage overview
 * (modal.com/settings/<workspace>/usage?tab=overview) shows "Total Usage $x"
 * for the CURRENT billing cycle, and that is the one figure we read: it is the
 * same number the invoice is built from (verified 2026-09-21 — $220.18 on the
 * page, matching the resource breakdown in ai_vendor_cost).
 *
 * The older /settings/billing page carries no such figure, which is why every
 * probe until 2026-09-21 came back 'unsupported'.
 */
export function extractModalCycleSpend(pageText: string): ExtractResult {
  return collectLabelledAmounts(pageText, /total usage\b/gi, 40);
}

// ---------------------------------------------------------------------------
// Per-provider probes
// ---------------------------------------------------------------------------

interface ProviderSpec {
  provider: 'anthropic' | 'modal';
  cookieEnv: 'ANTHROPIC_CONSOLE_COOKIE' | 'MODAL_CONSOLE_COOKIE';
  /** Domains the cookie is scoped to. Anthropic's console has lived on both
   *  console.anthropic.com and platform.claude.com; we set the cookie on both
   *  so a captured session survives the redirect between them. */
  cookieDomains: string[];
  /** Returns the page to read, or null + why when it cannot be built. */
  url: () => { url: string } | { error: string };
  extract: (pageText: string) => ExtractResult;
  /** Map an extracted amount (or its absence) to the final probe fields. */
  interpret: (ex: ExtractResult, ctx: { url: string; pageText: string; scrapedAt: string }) => Omit<BalanceProbe, 'provider' | 'source'>;
}

const LOGIN_URL_RE = /\/(login|sign[-_]?in|auth|get-started)(\/|$|\?|#)/i;
const LOGIN_TEXT_RE = /\b(log in|sign in|continue with (google|email|sso))\b/i;

function interpretAnthropic(ex: ExtractResult, ctx: { url: string; pageText: string; scrapedAt: string }): Omit<BalanceProbe, 'provider' | 'source'> {
  const raw = { url: ctx.url, scraped_at: ctx.scrapedAt, ...(ex.ok ? { matched: ex.matched } : { seen: ex.seen, page_excerpt: ctx.pageText.slice(0, 300) }) };
  if (ex.ok) {
    return { status: 'ok', balanceUsd: ex.amount, currency: 'USD', raw };
  }
  return { status: 'error', raw, error: `${ex.error} on the console billing page — if the dashboard redirected to a login page, ANTHROPIC_CONSOLE_COOKIE has expired and needs refreshing` };
}

function interpretModal(ex: ExtractResult, ctx: { url: string; pageText: string; scrapedAt: string }): Omit<BalanceProbe, 'provider' | 'source'> {
  const raw = { url: ctx.url, scraped_at: ctx.scrapedAt, ...(ex.ok ? { matched: ex.matched, convention: 'postpaid: current billing cycle spend so far' } : { seen: ex.seen, page_excerpt: ctx.pageText.slice(0, 300) }) };
  if (ex.ok) {
    return { status: 'ok', balanceUsd: ex.amount, currency: 'USD', raw };
  }
  // A missing figure is an ERROR, not 'unsupported': we know exactly which
  // page carries it, so its absence means the page changed or never loaded.
  return { status: 'error', raw, error: `${ex.error} for "Total Usage" on the Modal usage overview — the page layout may have changed, or MODAL_CONSOLE_COOKIE has expired` };
}

const PROVIDERS: ProviderSpec[] = [
  {
    provider: 'anthropic',
    cookieEnv: 'ANTHROPIC_CONSOLE_COOKIE',
    cookieDomains: ['.claude.com', '.anthropic.com'],
    url: () => ({ url: 'https://platform.claude.com/settings/billing' }),
    extract: extractAnthropicCredits,
    interpret: (ex, ctx) => interpretAnthropic(ex, ctx),
  },
  {
    provider: 'modal',
    cookieEnv: 'MODAL_CONSOLE_COOKIE',
    cookieDomains: ['.modal.com'],
    // The usage page is scoped to a workspace slug. It is configuration, not a
    // secret, but it names a person, so it lives in the worker env rather than
    // in this public repo.
    url: () => {
      const ws = process.env.MODAL_WORKSPACE?.trim();
      return ws
        ? { url: `https://modal.com/settings/${encodeURIComponent(ws)}/usage?tab=overview` }
        : { error: 'MODAL_WORKSPACE is not set on the worker — set it to the workspace slug shown in modal.com/settings/<workspace>/usage' };
    },
    extract: extractModalCycleSpend,
    interpret: (ex, ctx) => interpretModal(ex, ctx),
  },
];

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

async function probeWithBrowser(spec: ProviderSpec, deps: BrowserProbeDeps): Promise<BalanceProbe> {
  const cookie = process.env[spec.cookieEnv]?.trim() ?? null;
  if (!cookie) {
    return {
      provider: spec.provider,
      source: 'browser',
      status: 'unsupported',
      error: `${spec.cookieEnv} is not configured — capture the session cookie from a logged-in browser and set it as a worker secret`,
    };
  }
  const target = spec.url();
  if ('error' in target) {
    return { provider: spec.provider, source: 'browser', status: 'unsupported', error: target.error };
  }
  const url = target.url;
  const secrets = secretsOf(cookie);
  const fail = (error: string, raw?: unknown): BalanceProbe => ({
    provider: spec.provider,
    source: 'browser',
    status: 'error',
    error: redactSecrets(error, secrets),
    ...(raw !== undefined ? { raw } : {}),
  });

  const run = async (): Promise<BalanceProbe> => {
    let browser: ProbeBrowser | null = null;
    try {
      const connectUrl = await deps.createSession();
      browser = await deps.connect(connectUrl);
      const ctx = browser.contexts()[0];
      if (!ctx) throw new Error('Browserbase session exposed no browser context');
      await ctx.addCookies(parseCookieHeader(cookie, spec.cookieDomains));
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // An expired session cookie does not error — it REDIRECTS to a login
      // page. Detect that before trusting anything on the page.
      if (LOGIN_URL_RE.test(page.url())) {
        return fail(
          `session expired: ${url} redirected to a login page — ${spec.cookieEnv} needs refreshing (capture a fresh cookie from a logged-in browser)`,
          { url, landed_on: page.url(), scraped_at: new Date().toISOString() },
        );
      }

      // Both dashboards are SPAs: domcontentloaded fires on an empty shell and
      // the figure arrives with a later XHR. A fixed 2.5 s sleep read the shell
      // on 103 of 121 Anthropic runs ("no matching figure"). Poll instead: read
      // the text, stop as soon as the figure (or a login screen) is there, and
      // give up after HYDRATE_BUDGET_MS with the last text we saw.
      let pageText = '';
      let ex: ExtractResult = { ok: false, error: 'no matching figure found', seen: [] };
      const hydrateDeadline = Date.now() + HYDRATE_BUDGET_MS;
      for (;;) {
        pageText = await page.evaluate(() => {
          // Runs in the browser page (serialized by Playwright) — reference the
          // DOM through a narrow typed view of globalThis so the Node-only
          // worker tsconfig type-checks without the DOM lib.
          const doc = (globalThis as unknown as { document: { body: { innerText: string } | null } }).document;
          return doc.body ? doc.body.innerText : '';
        });
        ex = spec.extract(pageText);
        // An ambiguous page will not become unambiguous by waiting, and a
        // login screen will not turn into a dashboard.
        if (ex.ok || ex.seen.length > 0 || LOGIN_TEXT_RE.test(pageText)) break;
        if (Date.now() >= hydrateDeadline) break;
        await page.waitForTimeout(HYDRATE_POLL_MS);
      }

      // Same redirect, second signal: some dashboards client-side route to a
      // login screen without the URL matching LOGIN_URL_RE.
      if (LOGIN_TEXT_RE.test(pageText)) {
        return fail(
          `session expired: landed on a login page — ${spec.cookieEnv} needs refreshing (capture a fresh cookie from a logged-in browser)`,
          { url, landed_on: page.url(), scraped_at: new Date().toISOString() },
        );
      }

      const interpreted = spec.interpret(ex, { url, pageText, scrapedAt: new Date().toISOString() });
      return { provider: spec.provider, source: 'browser', ...interpreted };
    } catch (e) {
      return fail(`browser probe failed: ${errMsg(e)}`);
    } finally {
      // ALWAYS release the Browserbase session, including on failure — a
      // leaked session keeps billing browser-minutes until it idles out.
      if (browser) await browser.close().catch(() => {});
    }
  };

  // Hard 60s ceiling: a hung browser rejects here while run()'s own finally
  // still closes the session whenever the underlying call settles.
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      run(),
      new Promise<BalanceProbe>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timed out after ${PROVIDER_TIMEOUT_MS / 1000}s`)), PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    return fail(errMsg(e));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Probe Anthropic + Modal with a real browser, write one
 * `ai_provider_balance_probes` row per provider (source='browser'), and
 * return the summary. The two providers are fully independent — one failing
 * never prevents the other from being read or recorded.
 *
 * A row that cannot be STORED is logged loudly, not swallowed: if the probe
 * cannot be persisted the whole safety net is off, which is worse than a
 * provider being unreachable (same posture as /api/cron/ai-balance-probe).
 */
export async function runBrowserBalanceProbes(
  sb: SupabaseClient,
  deps: BrowserProbeDeps = defaultDeps(),
): Promise<BalanceProbe[]> {
  const settled = await Promise.allSettled(PROVIDERS.map((spec) => probeWithBrowser(spec, deps)));
  const probes = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    return {
      provider: PROVIDERS[i]!.provider,
      source: 'browser' as const,
      status: 'error' as const,
      error: redactSecrets(errMsg(s.reason), secretsOf(process.env[PROVIDERS[i]!.cookieEnv]?.trim() ?? null)),
    };
  });

  for (const p of probes) {
    const { error } = await sb.rpc('ai_balance_probe_add', {
      p_provider: p.provider,
      p_source: p.source,
      p_status: p.status,
      p_balance: p.status === 'ok' ? (p.balanceUsd ?? null) : null,
      p_currency: p.currency ?? 'USD',
      p_raw: p.raw ?? null,
      p_error: p.error ?? null,
    });
    if (error) {
      console.error(`[balance-browser-probe] could not store ${p.provider}: ${redactSecrets(error.message, secretsOf(process.env[PROVIDERS.find((s) => s.provider === p.provider)!.cookieEnv]?.trim() ?? null))}`);
    }
  }

  return probes;
}
