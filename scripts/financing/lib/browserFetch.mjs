/**
 * Parallel Browserbase fetcher for the financing ingestion pipeline.
 *
 * WHY BROWSERBASE AND NOT plain fetch(): every source that matters here is a
 * bank / regulator site behind Cloudflare or an SPA that renders its product
 * tables client-side. A plain HTTP GET returns a challenge page or an empty
 * shell — we measured this on sama.gov.sa (error page), sakani.sa (403 /
 * "Just a moment…"), bidaya.com.sa (403) and bsf.sa (permission denied).
 *
 * WHY N SESSIONS AT ONCE: sources are independent. Fetching them one at a time
 * makes a 25-source refresh run take 25x longer than it needs to for no benefit.
 * `fetchAll` runs a bounded worker pool over the manifest so a full refresh is
 * one wall-clock batch.
 *
 * The fetcher NEVER interprets what it reads — it returns raw text + html +
 * a content hash. Parsing lives in the per-source parsers, so a parser change
 * can be re-run against stored snapshots without re-hitting the source (and
 * without pretending a page said something it didn't).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ENV_CANDIDATES = [
  path.join(process.cwd(), '.env.local'),
  path.join(process.cwd(), '.env'),
  'C:/Users/rayan/Claude/wassell-claude-code/.env.local',
  'C:/Users/rayan/Claude/wassell-claude-code/.env',
];

/** Read BROWSERBASE_* from the environment, falling back to a .env file.
 *  Worktrees don't carry .env, hence the parent-repo fallback. */
export function browserbaseCreds() {
  let apiKey = process.env.BROWSERBASE_API_KEY;
  let projectId = process.env.BROWSERBASE_PROJECT_ID;
  for (const file of ENV_CANDIDATES) {
    if (apiKey && projectId) break;
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    apiKey ||= (raw.match(/^BROWSERBASE_API_KEY\s*=\s*"?([^"\r\n]+)/m) || [])[1];
    projectId ||= (raw.match(/^BROWSERBASE_PROJECT_ID\s*=\s*"?([^"\r\n]+)/m) || [])[1];
  }
  if (!apiKey || !projectId) {
    throw new Error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not found in env or .env files');
  }
  return { apiKey, projectId };
}

async function createSession({ apiKey, projectId }) {
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers: { 'X-BB-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  if (!res.ok) throw new Error(`browserbase session create failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Fetch ONE source in its own Browserbase session.
 * Returns a snapshot envelope — never throws for a source-side failure, because
 * a dead source is DATA (it becomes a `fin_source_records` row with
 * status='fetch_failed'), not a reason to abort the whole refresh run.
 */
export async function fetchOne(source, creds) {
  const startedAt = new Date().toISOString();
  let browser = null;
  let sessionId = null;
  try {
    const session = await createSession(creds);
    sessionId = session.id;
    browser = await chromium.connectOverCDP(session.connectUrl);
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] || (await ctx.newPage());
    page.setDefaultTimeout(source.timeout_ms ?? 90_000);

    const response = await page.goto(source.url, {
      waitUntil: source.wait_until ?? 'domcontentloaded',
      timeout: source.timeout_ms ?? 90_000,
    });
    const httpStatus = response?.status() ?? null;

    // Cloudflare interstitials resolve on their own within a few seconds; the
    // settle wait is what makes the difference between "Just a moment…" and the
    // real page. SPA product tables need the same grace period.
    await page.waitForTimeout(source.settle_ms ?? 5000);
    if (source.wait_for_selector) {
      await page
        .waitForSelector(source.wait_for_selector, { timeout: 20_000 })
        .catch(() => {/* selector absent is a parse-time concern, not a fetch failure */});
    }
    // Lazy content (accordion product tables, infinite lists) needs scrolling.
    for (let i = 0; i < (source.scroll_passes ?? 4); i += 1) {
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(500);
    }
    // Expand collapsed disclosure panels — Saudi bank product pages hide most
    // eligibility/fee text behind accordions that never render until clicked.
    if (source.expand_all !== false) {
      await page
        .evaluate(() => {
          document.querySelectorAll('details').forEach((d) => d.setAttribute('open', 'true'));
          const clickable = document.querySelectorAll(
            '[data-toggle="collapse"],.accordion-button,.accordion-header,[aria-expanded="false"]',
          );
          clickable.forEach((el) => {
            try { el.click(); } catch { /* a non-clickable match is fine */ }
          });
        })
        .catch(() => {/* evaluate can fail on a navigated-away page; text below still captures what loaded */});
      await page.waitForTimeout(1500);
    }

    const captured = await page.evaluate(() => ({
      text: document.body ? document.body.innerText : '',
      title: document.title,
      finalUrl: location.href,
      links: Array.from(document.querySelectorAll('a[href]'))
        .map((a) => ({ text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120), href: a.href }))
        .filter((l) => l.href && !l.href.startsWith('javascript:'))
        .slice(0, 400),
      tables: Array.from(document.querySelectorAll('table')).map((t) =>
        Array.from(t.querySelectorAll('tr')).map((tr) =>
          Array.from(tr.querySelectorAll('th,td')).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()),
        ),
      ),
    }));

    await browser.close().catch(() => {/* session teardown best-effort */});
    browser = null;

    const text = (captured.text || '').replace(/\r\n/g, '\n').trim();
    // A challenge page is a FETCH FAILURE, not content. Recording it as content
    // would let a parser "find" nothing and silently retire a real product.
    const blocked = detectBlocked(text, captured.title, httpStatus);

    return {
      source_key: source.key,
      url: source.url,
      final_url: captured.finalUrl,
      http_status: httpStatus,
      status: blocked ? 'fetch_blocked' : 'ok',
      blocked_reason: blocked,
      title: captured.title,
      text,
      links: captured.links,
      tables: captured.tables,
      content_hash: sha256(text),
      fetched_at: startedAt,
      session_id: sessionId,
      error: null,
    };
  } catch (err) {
    if (browser) await browser.close().catch(() => {/* already dead */});
    return {
      source_key: source.key,
      url: source.url,
      final_url: null,
      http_status: null,
      status: 'fetch_failed',
      blocked_reason: null,
      title: null,
      text: '',
      links: [],
      tables: [],
      content_hash: null,
      fetched_at: startedAt,
      session_id: sessionId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Signatures of a bot-wall / error page masquerading as content. */
function detectBlocked(text, title, httpStatus) {
  const t = `${title || ''}\n${text.slice(0, 2000)}`.toLowerCase();
  if (/just a moment|checking your browser|attention required|cf-browser-verification/.test(t)) return 'cloudflare_challenge';
  if (/access denied|permission denied|you do not have permissions|403 forbidden/.test(t)) return 'access_denied';
  if (/something went wrong in your request/.test(t)) return 'server_error_page';
  if (/page( you are looking for)? (is )?not found|404 not found|الصفحة التي تبحث عنها غير موجودة/.test(t)) return 'not_found';
  if (httpStatus && httpStatus >= 400) return `http_${httpStatus}`;
  if (text.trim().length < 200) return 'empty_body';
  return null;
}

/**
 * Run the whole manifest through a bounded pool of concurrent Browserbase
 * sessions. `concurrency` is capped by the Browserbase plan's parallel-session
 * limit; overshooting it just makes sessions fail to create, which shows up as
 * fetch_failed rows rather than corrupting anything.
 */
export async function fetchAll(sources, { concurrency = 5, onResult } = {}) {
  const creds = browserbaseCreds();
  const queue = [...sources];
  const results = [];
  async function worker(workerId) {
    while (queue.length) {
      const source = queue.shift();
      if (!source) return;
      const started = Date.now();
      const result = await fetchOne(source, creds);
      result.duration_ms = Date.now() - started;
      results.push(result);
      if (onResult) onResult(result, workerId);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, sources.length) }, (_, i) => worker(i + 1)),
  );
  // Preserve manifest order so downstream diffs are stable.
  const order = new Map(sources.map((s, i) => [s.key, i]));
  results.sort((a, b) => (order.get(a.source_key) ?? 0) - (order.get(b.source_key) ?? 0));
  return results;
}

/** Persist one snapshot to disk so parsers can be re-run without re-fetching. */
export function writeSnapshot(dir, result) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${result.source_key}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 1), 'utf8');
  return file;
}
