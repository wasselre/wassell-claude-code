#!/usr/bin/env node
/**
 * Phone check — open the live app at phone size and measure what breaks.
 *
 * For each device (iPhone, Android) and each page it records:
 *   - SIDEWAYS SCROLL: does the page get wider than the screen, and which
 *     elements stick out past the edge (the usual phone bug);
 *   - SMALL TAP TARGETS: visible buttons/links smaller than 32×32 px;
 *   - ERRORS: console errors, page crashes, failed server requests (5xx, 401/403);
 *   - READY TIME: when the app's own `wassell:init:ready` mark fired;
 *   - a SCREENSHOT.
 * and writes `.phone-check/<run>/report.md` (+ report.json + screenshots).
 *
 * Login: a temporary session is minted with the service key (Supabase admin
 * `generate_link` → `verify`; see the "mint test session" note), put into the
 * page's localStorage before the app loads, and REVOKED at the end with
 * `logout?scope=local` — only this session, never the person's other ones.
 * Nothing is written into the repo's public/ folder.
 *
 * Usage:
 *   npm run phone-check
 *   node scripts/phone-check.mjs --email someone@wassel.re --device iphone --pages /,/m/month
 * Env (auto-read from .env.local / .env): SUPABASE_URL or VITE_SUPABASE_URL,
 * VITE_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, optional PHONE_CHECK_EMAIL,
 * PHONE_CHECK_BASE, CHROME_PATH.
 * Exit code 1 when any page scrolls sideways, crashes, or has failed requests.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#') || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnvFile('.env.local');
loadEnvFile('.env');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE = arg('base', process.env.PHONE_CHECK_BASE || 'https://app.wassel.re').replace(/\/$/, '');
const EMAIL = arg('email', process.env.PHONE_CHECK_EMAIL || 'r.abanumay@wassel.re');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEVICE_ARG = arg('device', 'both');

// Pages a non-MFA (aal1) session can open. Admin settings pages need a second
// factor in the app, so they are not in the default list.
const DEFAULT_PAGES = [
  '/', '/sales-workspace', '/m/month', '/m/my-work', '/m/content', '/m/publishing',
  '/m/analytics', '/m/competitors', '/projects-inventory', '/files',
];
const PAGES = arg('pages', '') ? arg('pages', '').split(',') : DEFAULT_PAGES;

const DEVICES = {
  iphone: {
    label: 'iPhone 14',
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  },
  android: {
    label: 'Android (Pixel 7)',
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  },
};

if (!SUPABASE_URL || !ANON || !SERVICE) {
  console.error('[phone-check] missing SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (.env.local or .env)');
  process.exit(2);
}
if (!existsSync(CHROME)) {
  console.error(`[phone-check] Chrome not found at ${CHROME} — set CHROME_PATH`);
  process.exit(2);
}

async function mintSession(email) {
  const link = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const linkBody = await link.json();
  const hashed = linkBody.hashed_token ?? linkBody.properties?.hashed_token;
  if (!link.ok || !hashed) throw new Error(`generate_link failed (${link.status}): ${JSON.stringify(linkBody).slice(0, 200)}`);
  const verify = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashed }),
  });
  const session = await verify.json();
  if (!verify.ok || !session.access_token) throw new Error(`verify failed (${verify.status})`);
  return session;
}

async function revokeSession(session) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}` },
  });
  if (!res.ok && res.status !== 204) console.error(`[phone-check] could not revoke the test session (${res.status}) — it expires on its own within the hour`);
}

/** Runs inside the page: everything that can be measured without guessing. */
function measureInPage() {
  const vw = window.innerWidth;
  // How an ancestor treats horizontal overflow: 'scroll' (a deliberate sideways
  // row, e.g. the tab bar — fine), 'clip' (hidden: the element is CUT OFF), or
  // null (nothing contains it: the page itself scrolls sideways).
  const containedBy = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return 'scroll';
      if (ox === 'hidden' || ox === 'clip') return 'clip';
    }
    return null;
  };
  const describe = (el) => {
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).slice(0, 3).join('.');
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${text ? ` «${text}»` : ''}`;
  };
  const offenders = [];
  const cutOff = [];
  for (const el of document.body.querySelectorAll('*')) {
    // Judge an icon as a whole, not its inner <path>/<circle> pieces.
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    if (!(r.right > vw + 1 || r.left < -1)) continue;
    // Entirely off-screen = parked on purpose (the phone menu drawer while
    // closed). Only something that straddles the edge is half-visible.
    if (r.left >= vw - 1 || r.right <= 1) continue;
    const how = containedBy(el);
    if (how === 'scroll') continue;
    const list = how === 'clip' ? cutOff : offenders;
    // Report the outermost element only — its children follow it out.
    if (!list.some((o) => o.el.contains(el))) list.push({ el, by: Math.round(Math.max(r.right - vw, -r.left)) });
  }
  const small = [];
  for (const el of document.querySelectorAll('a, button, [role="button"], [role="tab"], input[type="checkbox"], select')) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || r.bottom < 0 || r.top > window.innerHeight * 3) continue;
    if (r.width < 32 || r.height < 32) small.push(`${describe(el)} (${Math.round(r.width)}×${Math.round(r.height)})`);
  }
  // 'wassell:init:ready' is both a MARK and a MEASURE (same name); the
  // measure's startTime is init:start, so ask for the mark explicitly.
  const ready = performance.getEntriesByName('wassell:init:ready', 'mark')[0];
  const start = performance.getEntriesByName('wassell:init:start', 'mark')[0];
  return {
    viewport: vw,
    pageWidth: document.documentElement.scrollWidth,
    sidewaysScroll: document.documentElement.scrollWidth > vw + 1,
    offenders: offenders.slice(0, 8).map((o) => `${describe(o.el)} — ${o.by}px past the edge`),
    cutOff: cutOff.length,
    cutOffExamples: cutOff.slice(0, 6).map((o) => `${describe(o.el)} — ${o.by}px hidden past the edge`),
    smallTapTargets: small.length,
    smallTapExamples: small.slice(0, 5),
    // From opening the page, and from the app starting to load its data.
    readyMs: ready ? Math.round(ready.startTime) : null,
    loadMs: ready && start ? Math.round(ready.startTime - start.startTime) : null,
    marks: performance.getEntriesByType('mark').filter((m) => m.name.startsWith('wassell:'))
      .map((m) => `${m.name.slice(8)}@${Math.round(m.startTime)}`),
  };
}

async function checkPage(context, deviceKey, path, outDir) {
  const page = await context.newPage();
  const consoleErrors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push(`CRASH: ${String(e.message).slice(0, 200)}`));
  page.on('response', (r) => {
    const s = r.status();
    if (s >= 500 || s === 401 || s === 403) failed.push(`${s} ${new URL(r.url()).pathname.slice(0, 80)}`);
  });
  const started = Date.now();
  let navError = null;
  try {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => performance.getEntriesByName('wassell:init:ready').length > 0, null, { timeout: 45000 })
      .catch(() => { navError = 'the app never reported ready within 45 s'; });
    await page.waitForTimeout(3500); // let the page's own data and images settle
  } catch (e) {
    navError = String(e.message || e).slice(0, 200);
  }
  const m = await page.evaluate(measureInPage).catch((e) => ({ error: String(e) }));
  const slug = path === '/' ? 'home' : path.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-');
  const shot = `${deviceKey}-${slug}.png`;
  await page.screenshot({ path: join(outDir, shot), fullPage: false }).catch(() => {});
  await page.close();
  return { device: deviceKey, path, finalUrl: page.url(), wallMs: Date.now() - started, navError, consoleErrors, failed, shot, ...m };
}

const hasProblem = (r) => !!(r.sidewaysScroll || r.cutOff || r.navError || r.consoleErrors.length || r.failed.length);

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join('.phone-check', stamp);
  mkdirSync(outDir, { recursive: true });
  const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
  const devices = DEVICE_ARG === 'both' ? ['iphone', 'android'] : [DEVICE_ARG];

  console.log(`[phone-check] ${BASE} as ${EMAIL} — ${devices.join(', ')} × ${PAGES.length} pages`);
  const session = await mintSession(EMAIL);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const results = [];
  try {
    for (const key of devices) {
      const { label, ...device } = DEVICES[key];
      const context = await browser.newContext({ ...device, locale: 'ar-SA' });
      await context.addInitScript(([k, v]) => {
        try {
          localStorage.setItem(k, v);
          localStorage.removeItem('mos_active_role');
        } catch { /* storage blocked — the page will show the login screen, which the report flags */ }
      }, [`sb-${ref}-auth-token`, JSON.stringify(session)]);
      for (const path of PAGES) {
        const r = await checkPage(context, key, path, outDir);
        results.push({ ...r, deviceLabel: label });
        const flag = hasProblem(r) ? '✗' : '✓';
        console.log(`  ${flag} ${label.padEnd(18)} ${path.padEnd(22)} load ${r.loadMs ?? '—'} ms · width ${r.pageWidth}/${r.viewport} · cut off ${r.cutOff ?? 0} · small taps ${r.smallTapTargets} · errors ${r.consoleErrors.length} · failed ${r.failed.length}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await revokeSession(session);
  }

  const bad = results.filter(hasProblem);
  const lines = [
    `# Phone check — ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Riyadh' })} (Riyadh)`,
    '',
    `${BASE} · signed in as ${EMAIL} · ${results.length} page loads · **${bad.length} with problems**`,
    '',
    'Load = from the app starting to load its data until the page is usable.',
    '',
    '| Device | Page | Load | Sideways scroll | Cut off at the edge | Small tap targets | Errors | Failed requests | Screenshot |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.deviceLabel} | \`${r.path}\` | ${r.loadMs != null ? (r.loadMs / 1000).toFixed(1) + ' s' : '—'} | ${r.sidewaysScroll ? `**yes** (${r.pageWidth}px on a ${r.viewport}px screen)` : 'no'} | ${r.cutOff ? `**${r.cutOff}**` : 0} | ${r.smallTapTargets} | ${r.consoleErrors.length} | ${r.failed.length} | [${r.shot}](${r.shot}) |`),
    '',
  ];
  for (const r of bad) {
    lines.push(`## ${r.deviceLabel} — \`${r.path}\``);
    if (r.navError) lines.push(`- Did not finish loading: ${r.navError} (ended on ${r.finalUrl})`);
    for (const o of r.offenders ?? []) lines.push(`- Sticks out: ${o}`);
    for (const o of r.cutOffExamples ?? []) lines.push(`- Cut off: ${o}`);
    for (const e of r.consoleErrors.slice(0, 5)) lines.push(`- Error: ${e}`);
    for (const f of r.failed.slice(0, 5)) lines.push(`- Failed request: ${f}`);
    lines.push('');
  }
  writeFileSync(join(outDir, 'report.md'), lines.join('\n'));
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(results, null, 2));
  console.log(`[phone-check] report: ${join(outDir, 'report.md')}`);
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[phone-check] failed:', e.message || e);
  process.exit(2);
});
