/**
 * Reusable Paseet driver: spins a Browserbase Chromium session bound to the
 * persistent context that holds Paseet auth cookies, sends a single prompt,
 * waits for the chat response to settle, and returns a structured result.
 *
 * Used by:
 *   - api/research-project.ts (the legacy hardcoded "Research Project" button)
 *   - api/run-button-workflow.ts (the generalized custom-button workflow path)
 *
 * The runner stays format-agnostic — it returns the rendered table (when one
 * exists) plus the assistant's settled raw text. Callers map those into the
 * shape they care about via `applyPaseetMapping` in `paseetMapper.ts`.
 */

import { chromium, type Page } from 'playwright-core';

export type PaseetResponseShape = 'text' | 'single_value' | 'table_rows';

type Logger = (...parts: unknown[]) => void;

const stderrLog: Logger = (...parts) => {
  process.stderr.write(`${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
};

export interface PaseetQueryRequest {
  /** Free-form prompt text — already field-substituted by the caller. */
  prompt: string;
  /** What kind of answer the caller expects, drives how long we wait. */
  responseShape: PaseetResponseShape;
  /** Hard cap on Paseet response wait. Default 90_000 (90s), max 180_000. */
  timeoutMs?: number;
  /** Optional logger. Defaults to stderr (Vercel runtime logs). */
  log?: Logger;
}

export interface PaseetQueryResult {
  /** Settled assistant text — the last ~5KB of the page innerText after the
   *  response stops streaming. Useful for `text` and `single_value` shapes. */
  rawText: string;
  /** Parsed `<table>` rendered for the prompt — last table on the page after
   *  any horizontal-scroll virtualization has been walked. `null` if Paseet
   *  didn't render a table (text-only answer, or the prompt was rejected). */
  table: { headers: string[]; rows: string[][] } | null;
  /** Browserbase session id, surfaced for debugging. */
  sessionId: string;
}

async function createSession(
  apiKey: string,
  projectId: string,
  contextId: string,
): Promise<{ id: string; connectUrl: string }> {
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId,
      browserSettings: { context: { id: contextId, persist: true } },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Browserbase session create failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }
  return (await res.json()) as { id: string; connectUrl: string };
}

/**
 * Send `prompt` into the chat textarea and wait until either:
 *   - a `<table>` appears and its text length stops growing for 2s
 *   - OR the page innerText stops growing for 2s (text-only answer)
 *   - OR `maxMs` elapses (hard cap)
 */
async function sendAndWait(
  page: Page,
  prompt: string,
  expectTable: boolean,
  maxMs: number,
  log: Logger,
): Promise<void> {
  await page.waitForSelector('textarea', { timeout: 15000 });
  const textarea = page.locator('textarea').first();
  await textarea.click({ timeout: 10000 });
  // `fill` sets the value in one CDP call; `type` would issue one per char
  // and burn ~150ms each (Vercel↔BB latency).
  await textarea.fill(prompt, { timeout: 10000 });
  await page.keyboard.press('Enter');
  log('[paseet] prompt sent, waiting for response to settle');

  const t0 = Date.now();
  let lastTableLen = -1;
  let lastTextLen = -1;
  let stableSince: number | null = null;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(750);
    const sample = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      const last = tables[tables.length - 1];
      return {
        tableLen: last ? (last.textContent || '').length : 0,
        textLen: document.body.innerText.length,
      };
    });
    const indicator = expectTable ? sample.tableLen : sample.textLen;
    const lastIndicator = expectTable ? lastTableLen : lastTextLen;
    if (indicator > 0 && indicator === lastIndicator) {
      if (stableSince === null) stableSince = Date.now();
      if (Date.now() - stableSince >= 2000) break;
    } else {
      stableSince = null;
    }
    lastTableLen = sample.tableLen;
    lastTextLen = sample.textLen;
  }
  log('[paseet] response settled after', Date.now() - t0, 'ms; tableLen=', lastTableLen, 'textLen=', lastTextLen);
}

/**
 * Walk the last `<table>`'s closest horizontally-scrollable ancestor from
 * scrollLeft 0 → max → 0 → -max → 0 in 80ms steps, so any virtualized
 * columns mount before we read cells.
 */
async function extractLastTable(page: Page): Promise<{ headers: string[]; rows: string[][] } | null> {
  return page.evaluate(async () => {
    const tables = Array.from(document.querySelectorAll('table'));
    if (tables.length === 0) return null;
    const lastTable = tables[tables.length - 1]!;

    let scrollEl: HTMLElement | null = lastTable.parentElement;
    while (scrollEl && scrollEl !== document.body) {
      const s = getComputedStyle(scrollEl);
      if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && scrollEl.scrollWidth > scrollEl.clientWidth) break;
      scrollEl = scrollEl.parentElement;
    }
    if (scrollEl && scrollEl !== document.body) {
      const max = scrollEl.scrollWidth - scrollEl.clientWidth;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i <= 10; i++) { scrollEl.scrollLeft = (max * i) / 10; await sleep(80); }
      for (let i = 0; i <= 10; i++) { scrollEl.scrollLeft = -(max * i) / 10; await sleep(80); }
      scrollEl.scrollLeft = 0;
    }

    const finalLast = Array.from(document.querySelectorAll('table')).pop()!;
    const allRows = Array.from(finalLast.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.querySelectorAll('th, td')).map((c) => (c.textContent || '').trim()),
    );
    if (allRows.length === 0) return null;
    return { headers: allRows[0]!, rows: allRows.slice(1) };
  });
}

/**
 * Run one Paseet query end-to-end. Throws if env vars are missing, the BB
 * session can't be created, or the persistent context doesn't have valid
 * Paseet cookies (we land on /login instead of /chat).
 */
export async function runPaseetQuery(req: PaseetQueryRequest): Promise<PaseetQueryResult> {
  const log = req.log ?? stderrLog;
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const contextId = process.env.PASEET_CONTEXT_ID ?? '';
  if (!apiKey || !projectId) {
    throw new Error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID env vars missing');
  }
  if (!contextId) {
    throw new Error(
      'PASEET_CONTEXT_ID env var missing — set up a Browserbase context with Paseet cookies via scripts/paseet-context-setup.mjs first',
    );
  }
  const maxMs = Math.min(req.timeoutMs ?? 90_000, 180_000);

  log('[paseet] creating BB session with context', contextId);
  const session = await createSession(apiKey, projectId, contextId);
  log('[paseet] BB session', session.id);
  const browser = await chromium.connectOverCDP(session.connectUrl);
  try {
    const ctx = browser.contexts()[0]!;
    const page = ctx.pages()[0] ?? (await ctx.newPage());

    // Verify auth: navigate to chat and check we didn't get bounced to /login.
    await page.goto('https://paseet.ai/ar/chat', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const url = page.url();
    if (url.includes('/login') || url.includes('/signin')) {
      throw new Error(
        `Paseet context cookies expired (landed on ${url}). Redo manual login via Browserbase Live View for context ${contextId}.`,
      );
    }
    log('[paseet] auth ok on', url);

    const expectTable = req.responseShape === 'table_rows' || req.responseShape === 'single_value';
    await sendAndWait(page, req.prompt, expectTable, maxMs, log);

    const table = expectTable ? await extractLastTable(page) : null;
    const rawText = await page.evaluate(() => document.body.innerText.slice(-5000));

    return { rawText, table, sessionId: session.id };
  } finally {
    await browser.close().catch(() => {});
  }
}
