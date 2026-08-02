// mos-manifest.mjs — coverage-manifest generator for the Marketing workspace
// visual gate. PURE GENERATOR: reads frames-index.json + coverage-matrix.mjs
// and emits manifest.json (machine) + manifest.md (readable table). One row
// per (frame × locale × theme × role-variant × viewport) with NO row cap.
//
// Re-running is QA-progress-safe: rows whose id AND (setup, route, viewport,
// reference) match the previous manifest keep their status + evidence;
// changed or new rows reset to 'pending'. The carried/reset counts are logged.
//
// Usage: node scripts/mos-manifest.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REF_DIR = path.join(REPO_ROOT, 'docs', 'marketing-reference');

/** Real pixel size of a reference crop, straight from the PNG IHDR
 *  (bytes 16..24: width/height as big-endian uint32). Null if unreadable. */
function pngDims(relPath) {
  if (!relPath) return null;
  try {
    const fd = fs.openSync(path.join(REF_DIR, relPath), 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    fs.closeSync(fd);
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch (err) {
    console.error(`pngDims: cannot read ${relPath}: ${err.message}`);
    return null;
  }
}
const FRAMES_INDEX_PATH = path.join(REF_DIR, 'frames-index.json');
const MANIFEST_JSON_PATH = path.join(REF_DIR, 'manifest.json');
const MANIFEST_MD_PATH = path.join(REF_DIR, 'manifest.md');

// Import the coverage matrix via a relative file URL (ESM, no deps).
const matrixUrl = new URL('../docs/marketing-reference/coverage-matrix.mjs', import.meta.url);
const { SCREENS, ALL_ROUTES, MOBILE_VIEWPORTS, NAV_VISIBILITY_ROLES } = await import(matrixUrl.href);

const framesIndex = JSON.parse(fs.readFileSync(FRAMES_INDEX_PATH, 'utf8'));

const THEMES = ['dark', 'light'];
const NN = (n) => String(n).padStart(2, '0');

function freshEvidence() {
  return { actual: null, overlay: null, diff: null, ssim: null, pixel_pct: null, inspected: false };
}

function baseRow(over) {
  return {
    id: over.id,
    screen: over.screen ?? null,
    title: over.title,
    frame_key: over.frame_key ?? null,
    surface: over.surface,
    route: over.route,
    setup: over.setup,
    locale: over.locale,
    theme: over.theme,
    role: over.role,
    viewport: { width: over.viewport.width, height: over.viewport.height },
    gate: over.gate,
    reference: over.reference ?? null,
    status: 'pending',
    evidence: freshEvidence(),
    ...(over.notes ? { notes: over.notes } : {}),
  };
}

/** route slug: non-alphanumerics collapsed to '-'; the query part stays in. */
function slug(route) {
  return route
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Row generation
// ---------------------------------------------------------------------------

const referenceRows = []; // rule 1
const screenExtraRows = []; // rules 2 (extra substates), 3 (en mirror), 4 (role variants)
const routeRows = []; // rule 5
const navRows = []; // rule 6

for (const screen of framesIndex.screens) {
  const n = screen.n;
  const decl = SCREENS[n];
  if (!decl) continue; // a screen without a matrix entry gets no rows

  const locale = decl.locale ?? 'ar';
  const role = decl.role ?? 'marketing_manager';
  const firstFrame = screen.frames[0];

  // Rule 1 — REFERENCE ROWS (gate 'ssim')
  for (const frame of screen.frames) {
    const fOver = decl.frames?.[frame.key] ?? {};
    const setup = fOver.setup ?? decl.setup;
    const route = fOver.route ?? decl.route;
    const notes = fOver.notes ?? decl.notes;
    // The capture viewport must equal the reference PNG's REAL pixel size —
    // frames-index carries the boundingBox, which rounds (879.5 → 880) and
    // fails the dimension gate by one pixel. Read the IHDR directly.
    const realDims = pngDims(frame.file_dark);
    if (realDims) { frame.width = realDims.width; frame.height = realDims.height; }
    for (const theme of THEMES) {
      referenceRows.push(baseRow({
        id: `s${NN(n)}-${frame.key}-${locale}-${theme}`,
        screen: n,
        title: screen.title,
        frame_key: frame.key,
        surface: decl.surface,
        route,
        setup,
        locale,
        theme,
        role,
        viewport: { width: frame.width, height: frame.height },
        gate: 'ssim',
        reference: theme === 'dark' ? frame.file_dark : frame.file_light,
        notes,
      }));
    }
  }

  // Rule 2 — EXTRA SUBSTATE ROWS (gate as declared)
  for (const sub of decl.extraSubstates ?? []) {
    for (const theme of THEMES) {
      screenExtraRows.push(baseRow({
        id: `s${NN(n)}-${sub.key}-ar-${theme}`,
        screen: n,
        title: `${screen.title} — ${sub.key}`,
        surface: decl.surface,
        route: decl.route,
        setup: sub.setup,
        locale: 'ar',
        theme,
        role,
        viewport: { width: firstFrame.width, height: firstFrame.height },
        gate: sub.gate,
        reference: null,
        notes: sub.notes,
      }));
    }
  }

  // Rule 3 — EN MIRROR ROWS (gate 'assert')
  if (decl.en === true) {
    screenExtraRows.push(baseRow({
      id: `s${NN(n)}-main-en-mirror`,
      screen: n,
      title: `${screen.title} — EN mirror`,
      surface: decl.surface,
      route: decl.route,
      setup: decl.setup,
      locale: 'en',
      theme: 'dark',
      role,
      viewport: { width: firstFrame.width, height: firstFrame.height },
      gate: 'assert',
      reference: null,
    }));
  }

  // Rule 4 — ROLE VARIANT ROWS (gate 'assert')
  for (const rv of decl.roleVariants ?? []) {
    screenExtraRows.push(baseRow({
      id: `s${NN(n)}-role-${rv}`,
      screen: n,
      title: `${screen.title} — role: ${rv}`,
      surface: decl.surface,
      route: decl.route,
      setup: `${decl.setup}@role=${rv}`,
      locale: 'ar',
      theme: 'dark',
      role: rv,
      viewport: { width: firstFrame.width, height: firstFrame.height },
      gate: 'assert',
      reference: null,
      notes: decl.notes,
    }));
  }
}

// Rule 5 — PAGE-52 MOBILE PATTERN ROWS (gate 'assert'): ALL_ROUTES × MOBILE_VIEWPORTS
for (const entry of ALL_ROUTES) {
  for (const vp of MOBILE_VIEWPORTS) {
    routeRows.push(baseRow({
      id: `route-${slug(entry.route)}-${vp.key}`,
      title: `Route pattern — ${entry.route} @ ${vp.key}`,
      surface: entry.surface,
      route: entry.route,
      setup: entry.setup,
      locale: 'ar',
      theme: 'dark',
      role: 'marketing_manager',
      viewport: { width: vp.width, height: vp.height },
      gate: 'assert',
      reference: null,
    }));
  }
}

// Rule 6 — NAV VISIBILITY ROWS (gate 'assert')
const NAV_VIEWPORTS = [
  { key: 'desktop', width: 1320, height: 760 },
  { key: 'iphone', width: 390, height: 844 },
];
for (const role of NAV_VISIBILITY_ROLES) {
  for (const vp of NAV_VIEWPORTS) {
    navRows.push(baseRow({
      id: `nav-${role}-${vp.key}`,
      title: `Nav visibility — ${role} (${vp.key})`,
      surface: 'overview',
      route: '/m',
      setup: `overview-loaded@role=${role}`,
      locale: 'ar',
      theme: 'dark',
      role,
      viewport: { width: vp.width, height: vp.height },
      gate: 'assert',
      reference: null,
      notes: 'rail/tab set must equal surface_access — hidden means absent',
    }));
  }
}

const rows = [...referenceRows, ...screenExtraRows, ...routeRows, ...navRows];

// ---------------------------------------------------------------------------
// Dedupe — identical ids are a generator bug; fail loudly.
// ---------------------------------------------------------------------------

const seen = new Set();
for (const row of rows) {
  if (seen.has(row.id)) {
    throw new Error(`mos-manifest: duplicate row id '${row.id}' — generation rules collided`);
  }
  seen.add(row.id);
}

// ---------------------------------------------------------------------------
// Carry forward QA progress from a previous manifest.
// ---------------------------------------------------------------------------

function sameViewport(a, b) {
  return a && b && a.width === b.width && a.height === b.height;
}

let carried = 0;
let reset = 0;
if (fs.existsSync(MANIFEST_JSON_PATH)) {
  let prevRows = [];
  try {
    const prev = JSON.parse(fs.readFileSync(MANIFEST_JSON_PATH, 'utf8'));
    prevRows = Array.isArray(prev.rows) ? prev.rows : [];
  } catch (err) {
    // A corrupt previous manifest must not silently wipe history, but it also
    // must not crash the generator — treat it as "nothing to carry" and say so.
    console.error(`mos-manifest: previous manifest.json unreadable (${err.message}) — all rows reset`);
  }
  const prevById = new Map(prevRows.map((r) => [r.id, r]));
  for (const row of rows) {
    const prev = prevById.get(row.id);
    if (
      prev &&
      prev.setup === row.setup &&
      prev.route === row.route &&
      sameViewport(prev.viewport, row.viewport) &&
      prev.reference === row.reference
    ) {
      row.status = prev.status;
      row.evidence = prev.evidence ?? freshEvidence();
      carried++;
    } else {
      reset++;
    }
  }
} else {
  reset = rows.length;
}

// ---------------------------------------------------------------------------
// Emit manifest.json
// ---------------------------------------------------------------------------

const ssimCount = rows.filter((r) => r.gate === 'ssim').length;
const assertCount = rows.filter((r) => r.gate === 'assert').length;

const manifest = {
  generated_at: new Date().toISOString(),
  source: { frames_index: 'frames-index.json', matrix: 'coverage-matrix.mjs' },
  totals: {
    rows: rows.length,
    ssim: ssimCount,
    assert: assertCount,
    by_gate_pending: {
      ssim: rows.filter((r) => r.gate === 'ssim' && r.status === 'pending').length,
      assert: rows.filter((r) => r.gate === 'assert' && r.status === 'pending').length,
    },
  },
  rows,
};

fs.writeFileSync(MANIFEST_JSON_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------------------
// Emit manifest.md — full listing, no truncation.
// ---------------------------------------------------------------------------

const esc = (v) => String(v ?? '').replace(/\|/g, '\\|');
const lines = [];
lines.push('# Marketing OS — Visual Gate Manifest');
lines.push('');
lines.push(`Generated: ${manifest.generated_at}`);
lines.push(`Sources: \`frames-index.json\` + \`coverage-matrix.mjs\` (regenerate with \`node scripts/mos-manifest.mjs\`)`);
lines.push('');
lines.push(`**Totals:** ${rows.length} rows — ${ssimCount} ssim / ${assertCount} assert — ` +
  `pending: ${manifest.totals.by_gate_pending.ssim} ssim / ${manifest.totals.by_gate_pending.assert} assert — ` +
  `carried forward: ${carried} / reset: ${reset}`);
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

console.log(
  `mos-manifest: ${rows.length} rows (${ssimCount} ssim / ${assertCount} assert) — ` +
  `carried ${carried}, reset ${reset} → docs/marketing-reference/manifest.{json,md}`,
);
