#!/usr/bin/env node
/**
 * phone-check-chats — the WhatsApp chats screen at phone size, every button.
 *
 *   npm run phone-check:chats
 *   npm run phone-check:chats -- --chat <chat record id> --device iphone
 *   npm run phone-check:chats -- --base http://localhost:5182
 *
 * Opens the chat list and one conversation as a real phone (iPhone 14 and a
 * Pixel 7), then clicks EVERY button in the conversation one at a time and
 * measures what it opens: sideways scroll, things cut off at the edge, buttons
 * that cannot be reached (a pop-up taller than the screen that does not
 * scroll), text boxes an iPhone zooms into (font under 16px), small tap
 * targets, how long the screen takes to settle, and errors.
 *
 * NOTHING IS SENT OR SAVED. Every request that is not a read (POST / PATCH /
 * PUT / DELETE) is answered by this script and never reaches the server —
 * except the sign-in refresh and the reads listed in READ_RPCS / READ_APIS.
 * Buttons whose label says send / delete are not clicked at all. The report
 * lists every request that was held back, so a new write path shows up there.
 *
 * Session: same as phone-check (admin generate_link → verify), revoked at the
 * end. Output: .phone-check/chats-<stamp>/report.md + screenshots.
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
const BASE = arg('base', 'https://app.wassel.re').replace(/\/$/, '');
const EMAIL = arg('email', 'r.abanumay@wassel.re');
// A client-linked chat on the sales line with every message kind in it.
const CHAT_ID = arg('chat', '8af0b5f1-f4da-5e3a-a58c-f6c24b994ab9');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEVICE_ARG = arg('device', 'both');
const ONLY = arg('only', ''); // substring filter on button labels, for re-checking one action

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

/** Non-GET requests that only READ — let through so screens render real data. */
// Checked to be STABLE (pg_proc.provolatile = 's'): a stable function cannot write.
const READ_RPCS = new Set(['mos_client_acquisition', ...(process.env.PHONE_CHECK_READ_RPCS || '').split(',').filter(Boolean)]);
const READ_RPC_PATTERN = /^(get_|list_|search_|fetch_|count_|wassell_(view|can|is|effective|chat_scope|search)|chat_read_candidates$|.*_for_(client|chat|project)$)/;
const READ_APIS = [/^\/api\/files\/sign/, /^\/api\/project-finder/, /^\/api\/files\/office-preview$/];
/** Labels never clicked — sending, deleting, signing out. */
const SKIP_LABEL = /إرسال|ارسال|أرسل|ارسل|\bsend\b|حذف|احذف|delete|remove|تسجيل الخروج|sign out|log ?out/i;

if (!SUPABASE_URL || !ANON || !SERVICE) {
  console.error('[phone-check-chats] missing SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (.env.local or .env)');
  process.exit(2);
}

async function mintSession(email) {
  const link = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const body = await link.json();
  const hashed = body.hashed_token ?? body.properties?.hashed_token;
  if (!link.ok || !hashed) throw new Error(`generate_link failed (${link.status})`);
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
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${session.access_token}` },
  });
  if (!res.ok && res.status !== 204) console.error(`[phone-check-chats] could not revoke the test session (${res.status}) — it expires within the hour`);
}

/** Runs in the page: what is wrong with what is on screen right now. */
function measure() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const describe = (el) => {
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${text ? ` «${text}»` : ''}`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const overflowOf = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll') return 'scroll';
      if (ox === 'hidden' || ox === 'clip') return 'clip';
    }
    return null;
  };
  const sticksOut = [];
  const cutOff = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.right > vw + 1 || r.left < -1)) continue;
    if (r.left >= vw - 1 || r.right <= 1) continue;
    const how = overflowOf(el);
    if (how === 'scroll') continue;
    const list = how === 'clip' ? cutOff : sticksOut;
    if (!list.some((o) => o.el.contains(el))) list.push({ el, by: Math.round(Math.max(r.right - vw, -r.left)) });
  }
  // Buttons inside a fixed layer (pop-up, sheet, bar) that sit off-screen with
  // nothing between them and the layer able to scroll: the user cannot reach them.
  const unreachable = [];
  const small = [];
  for (const el of document.querySelectorAll('button, a[href], [role="button"], input, textarea, select')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    let fixedLayer = null;
    let scrollable = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const st = getComputedStyle(p);
      if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 2) scrollable = true;
      if (st.position === 'fixed') { fixedLayer = p; break; }
    }
    if (fixedLayer && !scrollable && (r.top > vh - 4 || r.bottom < 4)) unreachable.push(describe(el));
    const tag = el.tagName.toLowerCase();
    if ((tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') && r.top < vh && r.bottom > 0 && (r.width < 32 || r.height < 32)) {
      small.push(`${describe(el)} (${Math.round(r.width)}×${Math.round(r.height)})`);
    }
  }
  // iOS zooms the whole page into any text box whose font is under 16px — the
  // layout then sits zoomed until the user pinches back out.
  const zoomsOnFocus = [];
  for (const el of document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), textarea, select, [contenteditable="true"]')) {
    if (!visible(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 16) zoomsOnFocus.push(`${describe(el)} (${fs}px)`);
  }
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible);
  // Layers stacked over the page: fixed elements covering a real share of the screen.
  const layers = [...document.querySelectorAll('body *')].filter((el) => {
    const st = getComputedStyle(el);
    if (st.position !== 'fixed' || !visible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width * r.height > vw * vh * 0.15;
  }).length;
  return {
    pageWidth: document.documentElement.scrollWidth, vw,
    // Full-screen screens (the chat) should not scroll the page itself.
    pageExtraHeight: Math.max(0, document.documentElement.scrollHeight - vh),
    sideways: document.documentElement.scrollWidth > vw + 1,
    sticksOut: sticksOut.slice(0, 6).map((o) => `${describe(o.el)} — ${o.by}px past the edge`),
    cutOff: cutOff.slice(0, 6).map((o) => `${describe(o.el)} — ${o.by}px hidden`),
    cutOffCount: cutOff.length,
    unreachable: [...new Set(unreachable)].slice(0, 6),
    small: small.slice(0, 8), smallCount: small.length,
    zoomsOnFocus: [...new Set(zoomsOnFocus)].slice(0, 6),
    dialogs: dialogs.length, layers,
    domSize: document.getElementsByTagName('*').length,
  };
}

/** Candidate buttons in the chat area (not the app header / sidebar). */
function listButtons(skipSource) {
  const SKIP = new RegExp(skipSource, 'i');
  // The whole page: sheets and pop-ups render outside <main> (portals).
  const root = document.body;
  const out = [];
  const seen = new Map();
  for (const el of root.querySelectorAll('button, [role="button"], a[href^="/"], summary')) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || el.disabled) continue;
    if (el.closest('header.safe-top') || el.closest('aside') || el.closest('nav')) continue;
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50) || `(${el.tagName.toLowerCase()} icon)`;
    if (SKIP.test(label)) continue;
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    // Message bubbles repeat the same actions per message: check the first two.
    if (n > 2) continue;
    out.push({ label, nth: n });
  }
  return out;
}

/** Click the nth element with this label (re-found each time — the DOM changes). */
function clickByLabel([label, nth, skipSource]) {
  // The whole page: sheets and pop-ups render outside <main> (portals).
  const root = document.body;
  let n = 0;
  for (const el of root.querySelectorAll('button, [role="button"], a[href^="/"], summary')) {
    if (el.closest('header.safe-top') || el.closest('aside') || el.closest('nav')) continue;
    // Same visibility rule as listButtons — the desktop copy of an action is
    // display:none on a phone, and clicking it would skip the phone's own path.
    const rr = el.getBoundingClientRect();
    if (rr.width === 0 || rr.height === 0 || getComputedStyle(el).visibility === 'hidden' || el.disabled) continue;
    const l = (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50) || `(${el.tagName.toLowerCase()} icon)`;
    if (l !== label) continue;
    n += 1;
    if (n !== nth) continue;
    if (new RegExp(skipSource, 'i').test(l)) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }
  return false;
}

/** Resolves when the DOM has been quiet for 400ms (or 8s passed). Returns ms. */
function settleMs() {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let last = t0;
    const mo = new MutationObserver(() => { last = performance.now(); });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    const tick = () => {
      const now = performance.now();
      if (now - last >= 400 || now - t0 > 8000) { mo.disconnect(); resolve(Math.round(last - t0)); }
      else setTimeout(tick, 100);
    };
    setTimeout(tick, 100);
  });
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join('.phone-check', `chats-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
  const devices = DEVICE_ARG === 'both' ? ['iphone', 'android'] : [DEVICE_ARG];
  const session = await mintSession(EMAIL);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const blocked = new Map();
  const results = [];
  const writeReport = () => {
  const problems = (r) => [
    r.sideways && `the whole screen scrolls sideways (${r.pageWidth}px on a ${r.vw}px phone)`,
    ...(r.sticksOut ?? []).map((s) => `sticks out: ${s}`),
    ...(r.cutOff ?? []).map((s) => `cut off: ${s}`),
    ...(r.unreachable ?? []).map((s) => `cannot be reached (off-screen in a pop-up that does not scroll): ${s}`),
    ...(r.zoomsOnFocus ?? []).map((s) => `iPhone zooms in when typing here: ${s}`),
    (r.settle ?? 0) > 3000 && `took ${(r.settle / 1000).toFixed(1)} s to settle`,
    ...(r.errors ?? []).map((e) => `error: ${e}`),
    ...(r.failed ?? []).map((e) => `failed request: ${e}`),
  ].filter(Boolean);
  const lines = [
    `# Phone check — WhatsApp chats — ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Riyadh' })} (Riyadh)`,
    '',
    `${BASE} · chat \`${CHAT_ID}\` · ${results.length} steps · writes held back: ${[...blocked.values()].reduce((a, b) => a + b, 0)}`,
    '',
    '| Device | Step | Settle | Problems | Small taps | Screenshot |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.device} | ${r.step} | ${r.settle != null ? `${r.settle} ms` : '—'} | ${r.skipped ?? (problems(r).length || '')} | ${r.smallCount ?? ''} | ${r.shot ? `[${r.shot}](${r.shot})` : ''} |`),
    '',
    '## Problems',
    '',
  ];
  for (const r of results) {
    const p = problems(r);
    if (!p.length) continue;
    lines.push(`### ${r.device} — ${r.step} ([screenshot](${r.shot}))`);
    for (const x of p) lines.push(`- ${x}`);
    lines.push('');
  }
  lines.push('## Requests held back (writes, never sent)', '');
  for (const [k, n] of [...blocked.entries()].sort()) lines.push(`- ${k} × ${n}`);
  writeFileSync(join(outDir, 'report.md'), lines.join('\n'));
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ results, blocked: Object.fromEntries(blocked) }, null, 2));
  };

  try {
    for (const key of devices) {
      const { label: deviceLabel, ...device } = DEVICES[key];
      const context = await browser.newContext({ ...device, locale: 'ar-SA' });
      await context.addInitScript(([k, v]) => {
        try { localStorage.setItem(k, v); } catch { /* storage blocked — the login screen will show in the report */ }
      }, [`sb-${ref}-auth-token`, JSON.stringify(session)]);
      // The write guard. Everything not a GET is answered here unless it is a known read.
      await context.route('**/*', (route) => {
        const req = route.request();
        const method = req.method();
        if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue();
        const u = new URL(req.url());
        if (u.pathname.startsWith('/auth/v1/token')) return route.continue();
        const rpc = u.pathname.startsWith('/rest/v1/rpc/') ? u.pathname.slice('/rest/v1/rpc/'.length) : null;
        if (rpc && (READ_RPCS.has(rpc) || READ_RPC_PATTERN.test(rpc))) return route.continue();
        if (READ_APIS.some((re) => re.test(u.pathname))) return route.continue();
        const k = `${method} ${rpc ? `rpc/${rpc}` : u.pathname}`;
        blocked.set(k, (blocked.get(k) ?? 0) + 1);
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'phone-check: writes are blocked' }) });
      });

      const page = await context.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error' && !/phone-check: writes are blocked|403/.test(m.text())) errors.push(m.text().slice(0, 160)); });
      page.on('pageerror', (e) => errors.push(`CRASH: ${String(e.message).slice(0, 160)}`));
      const failed = [];
      page.on('response', (r) => {
        const s = r.status();
        if (s < 400) return;
        const u = new URL(r.url());
        // 403 = this script's own write guard answering.
        if (s === 403 && r.request().method() !== 'GET') return;
        failed.push(`${s} ${r.request().method()} ${u.host === new URL(BASE).host ? '' : u.host}${u.pathname}${u.search.slice(0, 60)}`);
      });

      const record = async (step, extra = {}) => {
        const m = await page.evaluate(measure).catch((e) => ({ error: String(e) }));
        const shot = `${key}-${String(results.length).padStart(3, '0')}.png`;
        await page.screenshot({ path: join(outDir, shot) }).catch(() => {});
        const errs = errors.splice(0).filter((e) => !/^Failed to load resource/.test(e));
        const fails = [...new Set(failed.splice(0))];
        const r = { device: deviceLabel, step, shot, errors: errs, failed: fails, url: page.url().replace(BASE, ''), ...extra, ...m };
        results.push(r);
        writeReport();
        const bad = r.sideways || r.cutOffCount || (r.unreachable?.length) || errs.length || fails.length || (r.settle ?? 0) > 3000;
        console.log(`  ${bad ? '✗' : '✓'} ${deviceLabel.padEnd(17)} ${step.slice(0, 60).padEnd(60)} ${r.settle != null ? `${r.settle}ms` : ''}${r.sideways ? ' SIDEWAYS' : ''}${r.cutOffCount ? ` cut:${r.cutOffCount}` : ''}${r.unreachable?.length ? ` unreachable:${r.unreachable.length}` : ''}${errs.length ? ` errors:${errs.length}` : ''}${fails.length ? ` failed:${fails.length}` : ''}`);
        return r;
      };

      const waitReady = async () => {
        await page.waitForFunction(() => performance.getEntriesByName('wassell:init:ready').length > 0, null, { timeout: 45000 }).catch(() => {});
        await page.evaluate(settleMs).catch(() => 0);
      };

      // 1. The list.
      const t0 = Date.now();
      await page.goto(`${BASE}/model/chats`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitReady();
      await record('chat list', { settle: Date.now() - t0 });

      // 2. Open the conversation the way a rep does — tap its row.
      // Full load the first time; afterwards switch screens INSIDE the running
      // app (home, then back to the chat) — the chat page unmounts, so every
      // pop-up it owned is gone, without paying a 10-15 s app boot per step.
      let booted = false;
      const openThread = async () => {
        if (!booted) {
          await page.goto(`${BASE}/model/chats/${CHAT_ID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await waitReady();
          await page.waitForTimeout(1500);
          booted = true;
          return;
        }
        const nav = (path) => page.evaluate((p) => { window.history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
        await page.keyboard.press('Escape').catch(() => {});
        await nav('/');
        await page.waitForTimeout(300);
        await nav(`/model/chats/${CHAT_ID}`);
        await page.evaluate(settleMs).catch(() => 0);
        // If the app did not come back to the conversation (a page crashed,
        // a full navigation happened), fall back to a real load.
        const ok = await page.evaluate((id) => location.pathname.endsWith(id) && document.querySelectorAll('main button').length > 5, CHAT_ID).catch(() => false);
        if (!ok) { booted = false; await openThread(); }
      };
      const t1 = Date.now();
      await openThread();
      await record('conversation open', { settle: Date.now() - t1 });

      // Scroll the thread to the top and back (loads older messages; checks it stays smooth).
      const scrollMs = await page.evaluate(async () => {
        const sc = [...document.querySelectorAll('main *')].find((el) => {
          const st = getComputedStyle(el);
          return (st.overflowY === 'auto' || st.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 200;
        });
        if (!sc) return null;
        const t = performance.now();
        sc.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 1500));
        sc.scrollTop = sc.scrollHeight;
        return Math.round(performance.now() - t);
      }).catch(() => null);
      await record('conversation scrolled to the top and back', { settle: scrollMs ?? undefined });

      // 3. Every button in the conversation, one at a time — and every button
      //    INSIDE whatever it opens (menus, sheets, pop-ups). The conversation
      //    is reloaded after each step: pop-ups here do not all close on Escape,
      //    and a stacked one would falsify the next measurement.
      const key2 = (b) => `${b.label}#${b.nth}`;
      const baseline = await page.evaluate(listButtons, SKIP_LABEL.source);
      const baseKeys = new Set(baseline.map(key2));
      const todo = ONLY ? baseline.filter((b) => b.label.includes(ONLY)) : baseline;
      console.log(`  … ${todo.length} buttons to try on ${deviceLabel}`);
      const click = async (b) => page.evaluate(clickByLabel, [b.label, b.nth, SKIP_LABEL.source]).catch(() => false);
      const done = new Set();
      for (const b of todo) {
        await openThread();
        if (!(await click(b))) { results.push({ device: deviceLabel, step: `«${b.label}» #${b.nth}`, skipped: 'not found' }); continue; }
        const settle = await page.evaluate(settleMs).catch(() => null);
        await record(`«${b.label}»${b.nth > 1 ? ` #${b.nth}` : ''}`, { settle });
        // What did it open? Buttons that were not on the conversation before.
        const after = await page.evaluate(listButtons, SKIP_LABEL.source).catch(() => []);
        const inner = after.filter((x) => !baseKeys.has(key2(x)) && !done.has(`${key2(b)}>${key2(x)}`)).slice(0, b.label === 'رجوع' ? 12 : 30);
        for (const x of inner) {
          done.add(`${key2(b)}>${key2(x)}`);
          await openThread();
          if (!(await click(b))) continue;
          await page.evaluate(settleMs).catch(() => null);
          if (!(await click(x))) { results.push({ device: deviceLabel, step: `«${b.label}» › «${x.label}»`, skipped: 'not found' }); continue; }
          const s2 = await page.evaluate(settleMs).catch(() => null);
          await record(`«${b.label}» › «${x.label}»${x.nth > 1 ? ` #${x.nth}` : ''}`, { settle: s2 });
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await revokeSession(session);
    writeReport();
    console.log(`[phone-check-chats] report: ${join(outDir, 'report.md')}`);
  }
}

main().catch((e) => {
  console.error('[phone-check-chats] failed:', e.message || e);
  process.exit(2);
});
