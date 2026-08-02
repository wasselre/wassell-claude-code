// mos-qa.mjs — deterministic capture + comparison harness for the Marketing OS
// visual gate. Reads docs/marketing-reference/manifest.json, drives the live
// app through puppeteer to the exact state each row declares, captures a
// viewport screenshot, and (for ssim-gated rows) compares it against the
// approved-design reference crop via tools/compare.py.
//
// Usage:
//   node scripts/mos-qa.mjs [row-id ...] [--all] [--gate=ssim|assert] [--screen=NN]
//   node scripts/mos-qa.mjs --approve <id> [...]     human sign-off → 'pass'
//   node scripts/mos-qa.mjs --list-pending
//
// Env:
//   MOS_APP_URL              (default http://localhost:3000)
//   MOS_SUPABASE_URL         required — fixture Supabase project
//   MOS_SUPABASE_ANON_KEY    required
//   MOS_QA_EPOCH             frozen wall clock (default 2026-07-29T10:00:00+03:00)
//   MOS_FIXTURE_PASSWORD     password for mos-<role>@fixtures.wassel.local
//   MOS_FIXTURE_IDS_JSON     JSON overrides for FIXTURE_IDS (see mos-qa-setups.mjs)
//
// A row is NEVER auto-passed: ssim rows reach 'metrics-pass' and assert rows
// reach 'captured'; only --approve (human inspection) flips a row to 'pass'.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REF_DIR = path.join(REPO_ROOT, 'docs', 'marketing-reference');
const MANIFEST_JSON_PATH = path.join(REF_DIR, 'manifest.json');
const MANIFEST_MD_PATH = path.join(REF_DIR, 'manifest.md');
const ACTUAL_DIR = path.join(REF_DIR, 'actual-screenshots');
const OVERLAY_DIR = path.join(REF_DIR, 'overlays');
const DIFF_DIR = path.join(REF_DIR, 'diffs');
const COMPARE_PY = path.join(REF_DIR, 'tools', 'compare.py');

// puppeteer/pixelmatch/pngjs live in docs/marketing-reference/tools — resolve
// from there so the repo root gains no new dependency.
const toolsRequire = createRequire(path.join(REF_DIR, 'tools', 'package.json'));
const puppeteer = toolsRequire('puppeteer');

const { SETUPS, FIXTURE_IDS } = await import(
  pathToFileURL(path.join(__dirname, 'mos-qa-setups.mjs')).href
);

// ---------------------------------------------------------------------------
// config + CLI
// ---------------------------------------------------------------------------

const APP_URL = (process.env.MOS_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const SUPABASE_URL = (process.env.MOS_SUPABASE_URL ?? '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.MOS_SUPABASE_ANON_KEY ?? '';
const QA_EPOCH = process.env.MOS_QA_EPOCH ?? '2026-07-29T10:00:00+03:00';
const FIXTURE_PASSWORD = process.env.MOS_FIXTURE_PASSWORD ?? '';
const SSIM_MIN = 0.98;
const PIXEL_PCT_MIN = 99;

const argv = process.argv.slice(2);
const positional = [];
const approveIds = [];
let flagAll = false;
let flagListPending = false;
let gateFilter = null;
let screenFilter = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--all') flagAll = true;
  else if (a === '--list-pending') flagListPending = true;
  else if (a === '--approve') {
    // everything after --approve up to the next --flag is an id
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) approveIds.push(argv[++i]);
    if (approveIds.length === 0) throw new Error('mos-qa: --approve needs at least one row id');
  } else if (a.startsWith('--gate=')) {
    gateFilter = a.split('=')[1];
    if (gateFilter !== 'ssim' && gateFilter !== 'assert') throw new Error(`mos-qa: unknown --gate=${gateFilter}`);
  } else if (a.startsWith('--screen=')) {
    screenFilter = parseInt(a.split('=')[1], 10);
    if (!Number.isFinite(screenFilter)) throw new Error(`mos-qa: bad --screen=${a.split('=')[1]}`);
  } else if (a.startsWith('--')) {
    throw new Error(`mos-qa: unknown flag ${a}`);
  } else positional.push(a);
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_JSON_PATH)) {
    throw new Error(`mos-qa: ${MANIFEST_JSON_PATH} missing — run node scripts/mos-manifest.mjs first`);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_JSON_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------
// manifest.md renderer — same table format as scripts/mos-manifest.mjs
// (mos-manifest.mjs exports nothing, so the small renderer is duplicated).
// ---------------------------------------------------------------------------

function renderManifestMd(manifest) {
  const rows = manifest.rows;
  const ssimCount = rows.filter((r) => r.gate === 'ssim').length;
  const assertCount = rows.filter((r) => r.gate === 'assert').length;
  const esc = (v) => String(v ?? '').replace(/\|/g, '\\|');
  const lines = [];
  lines.push('# Marketing OS — Visual Gate Manifest');
  lines.push('');
  lines.push(`Generated: ${manifest.generated_at}`);
  lines.push('Sources: `frames-index.json` + `coverage-matrix.mjs` (regenerate with `node scripts/mos-manifest.mjs`)');
  lines.push('');
  lines.push(`**Totals:** ${rows.length} rows — ${ssimCount} ssim / ${assertCount} assert — ` +
    `pending: ${manifest.totals.by_gate_pending.ssim} ssim / ${manifest.totals.by_gate_pending.assert} assert — ` +
    `updated by \`scripts/mos-qa.mjs\``);
  lines.push('');
  lines.push('| id | screen | route | setup | locale | theme | role | viewport | gate | status |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    lines.push(
      `| ${esc(r.id)} | ${esc(r.screen ?? '')} | ${esc(r.route)} | ${esc(r.setup)} | ${esc(r.locale)} | ` +
      `${esc(r.theme)} | ${esc(r.role)} | ${r.viewport.width}x${r.viewport.height} | ${esc(r.gate)} | ${esc(r.status)} |`,
    );
  }
  lines.push('');
  fs.writeFileSync(MANIFEST_MD_PATH, lines.join('\n'), 'utf8');
}

function persistManifest(manifest) {
  manifest.generated_at = new Date().toISOString();
  manifest.totals.by_gate_pending = {
    ssim: manifest.rows.filter((r) => r.gate === 'ssim' && r.status === 'pending').length,
    assert: manifest.rows.filter((r) => r.gate === 'assert' && r.status === 'pending').length,
  };
  fs.writeFileSync(MANIFEST_JSON_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  renderManifestMd(manifest);
}

// ---------------------------------------------------------------------------
// --approve / --list-pending modes (no browser)
// ---------------------------------------------------------------------------

if (flagListPending) {
  const manifest = loadManifest();
  const pending = manifest.rows.filter((r) => r.status === 'pending');
  for (const r of pending) console.log(`${r.id}  [${r.gate}] ${r.title}`);
  console.log(`\n${pending.length} pending of ${manifest.rows.length}`);
  process.exit(0);
}

if (approveIds.length > 0) {
  const manifest = loadManifest();
  const byId = new Map(manifest.rows.map((r) => [r.id, r]));
  for (const id of approveIds) {
    const row = byId.get(id);
    if (!row) throw new Error(`mos-qa: --approve unknown row id '${id}'`);
    if (row.status !== 'metrics-pass' && row.status !== 'captured') {
      throw new Error(
        `mos-qa: --approve '${id}' is '${row.status}' — only 'metrics-pass' or 'captured' rows can be approved`,
      );
    }
    row.status = 'pass';
    row.evidence = { ...(row.evidence ?? {}), inspected: true };
    delete row.note;
    console.log(`approved: ${id}`);
  }
  persistManifest(manifest);
  console.log('QA-HARNESS approval recorded.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// row selection
// ---------------------------------------------------------------------------

const manifest = loadManifest();
let selected;
if (positional.length > 0) {
  const byId = new Map(manifest.rows.map((r) => [r.id, r]));
  selected = positional.map((id) => {
    const row = byId.get(id);
    if (!row) throw new Error(`mos-qa: unknown row id '${id}'`);
    return row;
  });
} else if (flagAll || gateFilter || screenFilter !== null) {
  selected = manifest.rows.slice();
} else {
  throw new Error('mos-qa: nothing selected — pass row ids, --all, --gate=, or --screen=NN');
}
if (gateFilter) selected = selected.filter((r) => r.gate === gateFilter);
if (screenFilter !== null) selected = selected.filter((r) => r.screen === screenFilter);
if (selected.length === 0) throw new Error('mos-qa: selection matched zero rows');

// env needed for the capture run
if (!SUPABASE_URL) throw new Error('mos-qa: MOS_SUPABASE_URL is required');
if (!SUPABASE_ANON_KEY) throw new Error('mos-qa: MOS_SUPABASE_ANON_KEY is required');
if (!FIXTURE_PASSWORD) throw new Error('mos-qa: MOS_FIXTURE_PASSWORD is required');

for (const dir of [ACTUAL_DIR, OVERLAY_DIR, DIFF_DIR]) fs.mkdirSync(dir, { recursive: true });

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];
const roleEmail = (role) => `mos-${role}@fixtures.wassel.local`;
const sessions = new Map(); // role -> session json

async function signIn(role) {
  if (sessions.has(role)) return sessions.get(role);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ email: roleEmail(role), password: FIXTURE_PASSWORD }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || !body.access_token) {
    throw new Error(`mos-qa: auth failed for ${roleEmail(role)} — HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  sessions.set(role, body);
  return body;
}

// ---------------------------------------------------------------------------
// determinism — injected BEFORE any app load
// ---------------------------------------------------------------------------

const epochMs = new Date(QA_EPOCH).getTime();
if (!Number.isFinite(epochMs)) throw new Error(`mos-qa: bad MOS_QA_EPOCH '${QA_EPOCH}'`);

function determinismPrelude(epoch, authTokenKey, sessionJson, locale) {
  // Truly frozen clock: no-arg Date / Date.now() return the epoch; explicit-arg
  // constructors keep working. (No real-elapsed advance — that is not wanted.)
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(epoch);
      else super(...args);
    }
    static now() { return epoch; }
  }
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  Object.defineProperty(window, 'Date', { value: FrozenDate, writable: true, configurable: true });

  // Reduced motion: the app must not animate between capture and compare.
  const realMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : null;
  window.matchMedia = (query) => {
    if (typeof query === 'string' && query.includes('prefers-reduced-motion')) {
      return {
        matches: true,
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() { return false; },
      };
    }
    if (!realMatchMedia) {
      return {
        matches: false, media: query, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {},
        removeEventListener() {}, dispatchEvent() { return false; },
      };
    }
    return realMatchMedia(query);
  };

  // Seed the Supabase session + persisted language before the app bundle reads
  // them. about:blank has no localStorage — only touch http(s) documents.
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    localStorage.setItem(authTokenKey, JSON.stringify(sessionJson));
    localStorage.setItem('wassell_language', JSON.stringify(locale));
  }
}

const FREEZE_CSS = '*,*::before,*::after{animation:none !important;transition:none !important;caret-color:transparent !important}';

// ---------------------------------------------------------------------------
// setup ctx
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-run cache for ref→id resolution and list/detail responses. Keys are
 *  role-scoped: RLS can legitimately show different sets to different roles. */
const refCache = new Map();

function makeCtx(page, row, session, role) {
  const bearer = session.access_token;

  /** POST /api/marketing-os as THIS ROW's role. Throws on error envelopes. */
  async function api(action, payload = {}) {
    const res = await fetch(`${APP_URL}/api/marketing-os`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.error) {
      throw new Error(
        `mos-qa: api '${action}' failed as ${role} — HTTP ${res.status}: ${JSON.stringify(body)?.slice(0, 500)}`,
      );
    }
    return body;
  }

  async function cachedList(action, payload, field) {
    const key = `${role}:${action}`;
    if (!refCache.has(key)) refCache.set(key, (await api(action, payload))[field] ?? []);
    return refCache.get(key);
  }

  /** Resolve a fixture ref to a live record id at capture time. */
  async function resolveRef(kind, ref) {
    const cacheKey = `${role}:${kind}:${ref}`;
    if (refCache.has(cacheKey)) return refCache.get(cacheKey);
    let id = null;
    if (kind === 'content') {
      id = (await cachedList('content_list', { limit: 500 }, 'content'))
        .find((r) => r.ref === ref)?.id ?? null;
    } else if (kind === 'campaign') {
      id = (await cachedList('campaign_list', { limit: 100 }, 'campaigns'))
        .find((r) => r.ref === ref)?.id ?? null;
    } else if (kind === 'shoot') {
      const requests = await cachedList('shoot_list', {}, 'requests');
      let hit = requests.find((r) => r.ref === ref);
      if (!hit && ref.startsWith('SR-')) {
        // Documented branch-allocator divergence: mos_tg_shoot_ref mints 'SH-',
        // not the mockups' 'SR-' (see scripts/mos-fixtures.mjs header note 2).
        hit = requests.find((r) => r.ref === `SH-${ref.slice(3)}`);
        if (hit) {
          console.warn(`mos-qa: shoot '${ref}' resolved to branch-minted '${hit.ref}' (known SH-/SR- divergence)`);
        }
      }
      id = hit?.id ?? null;
    } else if (kind === 'asset') {
      id = (await cachedList('asset_list', { limit: 500 }, 'assets'))
        .find((r) => r.title === ref || r.ref === ref)?.id ?? null;
    } else {
      throw new Error(`mos-qa: resolveRef unknown kind '${kind}'`);
    }
    if (!id) {
      throw new Error(`mos-qa: resolveRef found no ${kind} '${ref}' as ${role} — are the fixtures built? (node scripts/mos-fixtures.mjs)`);
    }
    refCache.set(cacheKey, id);
    return id;
  }

  /** ':token' → live id. FIXTURE_IDS (env override) wins; otherwise the token
   *  conventions resolve against the fixture dataset via the API. */
  async function resolveToken(token, route) {
    if (token === 'e1') {
      const c002 = await resolveRef('campaign', 'C-002');
      const key = `${role}:campaign_detail:${c002}`;
      if (!refCache.has(key)) refCache.set(key, await api('campaign_detail', { id: c002 }));
      const first = (refCache.get(key).executions ?? [])[0];
      if (!first?.id) {
        throw new Error(`mos-qa: ':e1' in '${route}' — C-002 has no executions; are the fixtures built?`);
      }
      return String(first.id);
    }
    // a012 — the asset screen 22 is built around: s22's «اقتراب ليلي خارجي»
    // (the first asset scripts/mos-fixtures.mjs creates).
    if (token === 'a012') return resolveRef('asset', 'اقتراب ليلي خارجي');
    const m = token.match(/^([a-z]+)(\d+)$/);
    if (m) {
      const n = m[2].padStart(3, '0');
      if (m[1] === 'v' || m[1] === 'p') return resolveRef('content', `${m[1].toUpperCase()}-${n}`);
      if (m[1] === 'c') return resolveRef('campaign', `C-${n}`);
      if (m[1] === 'sr') return resolveRef('shoot', `SR-${n}`);
    }
    throw new Error(`mos-qa: unresolved route token ':${token}' in '${route}' — set it via MOS_FIXTURE_IDS_JSON`);
  }

  async function resolveRoute(route) {
    let out = route;
    for (const m of route.matchAll(/:([A-Za-z0-9_]+)/g)) {
      const token = m[1];
      const fixed = FIXTURE_IDS[token];
      const id = fixed != null && fixed !== '' ? String(fixed) : await resolveToken(token, route);
      out = out.replace(`:${token}`, id);
    }
    return out;
  }

  return {
    page,
    appUrl: APP_URL,
    row,
    role,
    api,
    resolveRef,
    resolveRoute,
    goto: async (p) => {
      await page.goto(APP_URL + p, { waitUntil: 'networkidle0', timeout: 60000 });
      await page.evaluate(() => document.fonts.ready);
      await sleep(500);
    },
  };
}

// ---------------------------------------------------------------------------
// per-row capture
// ---------------------------------------------------------------------------

/** Parse 'name@role=<r>' — the role suffix overrides row.role. */
function parseSetup(rawSetup, rowRole) {
  const at = rawSetup.indexOf('@role=');
  if (at === -1) return { setupId: rawSetup, role: rowRole };
  return { setupId: rawSetup.slice(0, at), role: rawSetup.slice(at + '@role='.length) };
}

async function captureRow(browser, row, results) {
  const { setupId, role } = parseSetup(row.setup, row.role);
  const recipe = SETUPS[setupId];
  if (!recipe) {
    row.status = 'pending';
    row.note = 'no-setup';
    results.push({ id: row.id, status: 'pending', note: 'no-setup' });
    console.log(`no-setup  ${row.id}  (${setupId})`);
    return;
  }

  const session = await signIn(role);
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await page.evaluateOnNewDocument(
      determinismPrelude, epochMs, `sb-${projectRef}-auth-token`, session, row.locale,
    );
    await page.setViewport({ width: row.viewport.width, height: row.viewport.height, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: row.theme }]);

    // Boot the app at /m first (auth + i18n bootstrap), THEN navigate via the recipe.
    await page.goto(`${APP_URL}/m`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: FREEZE_CSS });

    // AMIRI ASSERTION — if Amiri failed to load, Arabic text falls back to a
    // serif and every pixel comparison is noise. Probe with identical strings.
    const probe = await page.evaluate(() => {
      const measure = (fontFamily) => {
        const s = document.createElement('span');
        s.style.cssText = `font-family:${fontFamily};font-size:32px;position:absolute;visibility:hidden;white-space:nowrap;`;
        s.textContent = 'اختبار النص';
        document.body.appendChild(s);
        const w = s.getBoundingClientRect().width;
        s.remove();
        return w;
      };
      return { amiri: measure("'Amiri'"), serif: measure('serif') };
    });
    if (Math.abs(probe.amiri - probe.serif) < 0.5) {
      row.status = 'fail';
      row.note = 'amiri-fallback';
      results.push({ id: row.id, status: 'fail', note: 'amiri-fallback' });
      console.log(`FAIL      ${row.id}  amiri-fallback`);
      return;
    }

    // The state recipe.
    await recipe(makeCtx(page, row, session, role));
    await page.addStyleTag({ content: FREEZE_CSS }).catch((err) => {
      // addStyleTag after a same-document SPA navigation is fine; a real
      // failure here means the page died — that must be loud, not skipped.
      throw new Error(`mos-qa: freeze-CSS injection failed for ${row.id}: ${err.message}`);
    });

    const actualPath = path.join(ACTUAL_DIR, `${row.id}.png`);
    await page.screenshot({ path: actualPath, type: 'png' });
    const actualRel = `actual-screenshots/${row.id}.png`;

    if (row.gate === 'assert') {
      // Structural assertions per setup come later — captured is NOT a pass.
      row.status = 'captured';
      row.evidence = { actual: actualRel, overlay: null, diff: null, ssim: null, pixel_pct: null, inspected: false };
      delete row.note;
      results.push({ id: row.id, status: 'captured' });
      console.log(`captured  ${row.id}`);
      return;
    }

    // gate 'ssim' — compare against the reference crop.
    if (!row.reference) {
      row.status = 'fail';
      row.note = 'no-reference';
      results.push({ id: row.id, status: 'fail', note: 'no-reference' });
      console.log(`FAIL      ${row.id}  no-reference`);
      return;
    }
    const refPath = path.join(REF_DIR, row.reference);
    if (!fs.existsSync(refPath)) {
      row.status = 'fail';
      row.note = `reference-missing:${row.reference}`;
      results.push({ id: row.id, status: 'fail', note: row.note });
      console.log(`FAIL      ${row.id}  reference missing: ${row.reference}`);
      return;
    }
    const overlayRel = `overlays/${row.id}.png`;
    const diffRel = `diffs/${row.id}.png`;
    const proc = spawnSync('python', [
      COMPARE_PY, refPath, actualPath, path.join(REF_DIR, overlayRel), path.join(REF_DIR, diffRel),
    ], { encoding: 'utf8' });
    if (proc.error) {
      throw new Error(`mos-qa: failed to spawn python for ${row.id}: ${proc.error.message}`);
    }
    if (proc.status !== 0) {
      throw new Error(`mos-qa: compare.py exited ${proc.status} for ${row.id}:\n${proc.stderr}`);
    }
    const lastLine = proc.stdout.trim().split('\n').pop();
    let cmp;
    try {
      cmp = JSON.parse(lastLine);
    } catch {
      throw new Error(`mos-qa: compare.py printed no JSON for ${row.id}:\nstdout: ${proc.stdout}\nstderr: ${proc.stderr}`);
    }

    if (!cmp.dim_match) {
      row.status = 'fail';
      row.note = 'dimension-mismatch';
      row.evidence = {
        actual: actualRel, overlay: overlayRel, diff: diffRel,
        ssim: null, pixel_pct: null, inspected: false,
      };
      results.push({ id: row.id, status: 'fail', note: 'dimension-mismatch' });
      console.log(`FAIL      ${row.id}  dimension-mismatch ref=${cmp.ref} actual=${cmp.actual}`);
      return;
    }

    const passMetrics = cmp.ssim >= SSIM_MIN && cmp.pixel_pct >= PIXEL_PCT_MIN;
    row.status = passMetrics ? 'metrics-pass' : 'fail';
    row.evidence = {
      actual: actualRel, overlay: overlayRel, diff: diffRel,
      ssim: cmp.ssim, pixel_pct: cmp.pixel_pct, inspected: false,
    };
    if (passMetrics) delete row.note;
    else row.note = `metrics-below-threshold (ssim ${cmp.ssim} < ${SSIM_MIN} or pixel_pct ${cmp.pixel_pct} < ${PIXEL_PCT_MIN})`;
    results.push({ id: row.id, status: row.status, note: passMetrics ? null : row.note });
    console.log(
      `${passMetrics ? 'metrics-pass' : 'FAIL     '}  ${row.id}  ssim=${cmp.ssim} pixel_pct=${cmp.pixel_pct}`,
    );
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const browser = await puppeteer.launch({
  headless: 'new',
  env: { ...process.env, TZ: 'Asia/Riyadh' },
});

const results = [];
try {
  for (const row of selected) {
    try {
      await captureRow(browser, row, results);
    } catch (err) {
      // A crashed row is a loud failure, not a skip.
      row.status = 'fail';
      row.note = `harness-error: ${err.message}`;
      results.push({ id: row.id, status: 'fail', note: row.note });
      console.error(`FAIL      ${row.id}  ${err.message}`);
    }
  }
} finally {
  await browser.close();
}

persistManifest(manifest);

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const counts = new Map();
for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
console.log('\n--- summary ---');
for (const [status, n] of [...counts.entries()].sort()) console.log(`${status}: ${n}`);
const failed = results.filter((r) => r.status === 'fail' || r.note === 'no-setup');
if (failed.length > 0) {
  console.log('\nfailures:');
  for (const r of failed) console.log(`  ${r.id}  ${r.note ?? ''}`);
}
process.exit(failed.length > 0 ? 1 : 0);
