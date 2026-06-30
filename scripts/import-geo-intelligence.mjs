#!/usr/bin/env node
/**
 * Import the gathered Riyadh geo-intelligence dataset into geo_elements.
 *
 *   node scripts/import-geo-intelligence.mjs
 *
 * Reads data/source/geo/riyadh-geo-intelligence.json (the raw uploaded file),
 * upserts every anchor into public.geo_elements BY external_id via the
 * service-role RPC `wassell_import_geo_elements` (geometry parses server-side
 * with ST_GeomFromGeoJSON), rebuilds AR/EN aliases, and writes a validation
 * report to data/source/geo/import-report.{json,md}.
 *
 * Idempotent: re-running upserts the same rows. Needs SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY (auto-loaded from .env.local / .env, like the other
 * scripts). The import RPC is service-role only — the anon key will be rejected.
 *
 * NOTE: this script never lives inside api/_lib/geoMatch.ts — the 725 anchors
 * are runtime DB data, not matching logic.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data', 'source', 'geo');
const SRC = join(DATA, 'riyadh-geo-intelligence.json');
const BATCH = 100;
const CONFIDENCE_FLOOR = 0.5; // keep in sync with the SQL matcher + geoMatch.ts

// ── minimal .env loader (no dotenv dependency — mirrors sync-model-workflow-prds.mjs)
function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}
loadEnv();

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (set them in .env.local).');
  process.exit(1);
}
if (!existsSync(SRC)) {
  console.error(`Dataset not found at ${SRC}. Place riyadh-geo-intelligence.json there first.`);
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const rows = JSON.parse(readFileSync(SRC, 'utf8'));
if (!Array.isArray(rows)) {
  console.error('Dataset is not a JSON array.');
  process.exit(1);
}
console.log(`[import] ${rows.length} anchors from ${SRC}`);

// ── upsert in batches ───────────────────────────────────────────────────────
let upserted = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const { data, error } = await supabase.rpc('wassell_import_geo_elements', { p_rows: chunk });
  if (error) {
    console.error(`[import] batch ${i}-${i + chunk.length} failed:`, error.message);
    process.exit(1);
  }
  upserted += Number(data?.upserted ?? 0);
  console.log(`[import] batch ${i / BATCH + 1}: +${data?.upserted} (total ${upserted})`);
}

const { data: aliasRes, error: aliasErr } = await supabase.rpc('wassell_rebuild_geo_aliases');
if (aliasErr) { console.error('[import] alias rebuild failed:', aliasErr.message); process.exit(1); }
console.log(`[import] aliases: +${aliasRes?.aliases_added}`);

// ── validation report (from the source rows) ────────────────────────────────
const by = (fn) => rows.reduce((a, r) => { const k = fn(r) ?? '∅'; a[k] = (a[k] || 0) + 1; return a; }, {});
const num = (v) => (v == null || v === '' ? null : Number(v));
const report = {
  generated_at: new Date().toISOString(),
  source_file: 'data/source/geo/riyadh-geo-intelligence.json',
  total: rows.length,
  upserted,
  aliases_added: Number(aliasRes?.aliases_added ?? 0),
  by_category: by((r) => r.category),
  by_type: by((r) => r.type),
  by_source_type: by((r) => r.source_type),
  by_geometry_type: by((r) => r.geometry_type),
  missing_geometry: rows.filter((r) => !r.geometry_geojson).length,
  missing_external_id: rows.filter((r) => !r.id).length,
  missing_coords: rows.filter((r) => num(r.latitude) == null || num(r.longitude) == null).length,
  is_verified: rows.filter((r) => r.is_verified === true).length,
  is_approximate: rows.filter((r) => r.is_approximate === true).length,
  // anchors that would compile to needs_review for within_radius (low confidence)
  low_confidence_below_floor: rows.filter((r) => { const c = num(r.confidence_score); return c != null && c < CONFIDENCE_FLOOR; }).length,
  confidence_floor: CONFIDENCE_FLOOR,
};

writeFileSync(join(DATA, 'import-report.json'), JSON.stringify(report, null, 2));
const md = [
  `# Geo-intelligence import report`,
  ``,
  `- Generated: ${report.generated_at}`,
  `- Source: \`${report.source_file}\``,
  `- Total anchors: **${report.total}** · upserted: **${report.upserted}** · aliases: **${report.aliases_added}**`,
  `- Verified: ${report.is_verified} · approximate: ${report.is_approximate} · missing geometry: ${report.missing_geometry} · missing coords: ${report.missing_coords}`,
  `- Low-confidence (< ${CONFIDENCE_FLOOR}, → needs_review for within_radius): **${report.low_confidence_below_floor}**`,
  ``,
  `## By category`,
  ...Object.entries(report.by_category).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
  ``,
  `## By geometry type`,
  ...Object.entries(report.by_geometry_type).map(([k, v]) => `- ${k}: ${v}`),
  ``,
].join('\n');
writeFileSync(join(DATA, 'import-report.md'), md);

console.log(`[import] done. report → data/source/geo/import-report.md`);
console.log(JSON.stringify(report, null, 2));
