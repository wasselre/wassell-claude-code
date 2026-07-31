#!/usr/bin/env node
/**
 * Push the COUNTRY and REGION outlines into `geo_boundaries`.
 *
 *   node data/source/geo-boundaries/build-boundaries.mjs [--dry-run]
 *
 * The district tier is backfilled by migration from `district_boundaries`, and the city
 * tier is derived in SQL as the union of each city's districts. This script covers the
 * two tiers that can only come from OSM.
 *
 * Saudi region relations are matched to our `regions` rows BY NAME, and an unmatched
 * region is REPORTED, never guessed — a wrong match would draw the Eastern Province's
 * outline around Riyadh and nothing downstream would notice.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { elementGeometry, coordCount } from '../geo-lib/overpass.mjs';
import { normalizeAr, normalizeEn, stripEmirate, stripEmirateAr } from '../geo-lib/classify.mjs';
import { EMIRATES } from '../geo-lib/emirates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const RAW = join(HERE, 'raw');
const UAE_RAW = join(HERE, '..', 'geo-uae', 'raw');
const DRY = process.argv.includes('--dry-run');

function loadEnv() {
  for (const p of [
    join(ROOT, '.env.local'), join(ROOT, '.env'),
    'C:/Users/rayan/Claude/wassell-claude-code/.env.local',
    'C:/Users/rayan/Claude/wassell-claude-code/.env',
  ]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();
const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function get(path) {
  const r = await fetch(`${URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function post(path, rows) {
  if (DRY) return;
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status} ${(await r.text()).slice(0, 400)}`);
}
async function rpc(fn) {
  if (DRY) return null;
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: '{}' });
  if (!r.ok) throw new Error(`RPC ${fn} → ${r.status} ${(await r.text()).slice(0, 300)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const readEls = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).elements ?? [] : []);
const stage = [];

// ── countries ───────────────────────────────────────────────────────────────
const COUNTRIES = [
  { code: 'SA', file: join(RAW, 'country-SA.json'), name_ar: 'السعودية', name_en: 'Saudi Arabia' },
  { code: 'AE', file: join(RAW, 'country-AE.json'), name_ar: 'الإمارات العربية المتحدة', name_en: 'United Arab Emirates' },
];
console.log('── countries ──');
for (const c of COUNTRIES) {
  const rel = readEls(c.file).find((e) => e.type === 'relation');
  const geom = rel ? elementGeometry(rel) : null;
  if (!geom) { console.warn(`  ! ${c.code}: no geometry (${c.file}) — skipped`); continue; }
  stage.push({
    tier: 'country', external_id: c.code, parent_external_id: null, country_code: c.code,
    name_ar: c.name_ar, name_en: c.name_en, geojson: geom,
    source: 'OpenStreetMap via Overpass API (ODbL)',
  });
  console.log(`  ${c.code}: ${geom.type}, ${coordCount(geom)} coords`);
}

// A REGION's external_id is its `regions` row UUID, not 'AE-DXB' or an spl_region_id.
//
// This is not cosmetic and it bit once already: the city tier is backfilled with
// `parent_external_id = cities.region_lookup`, which IS that UUID. Keying regions any
// other way produces a second, parallel set of region outlines that nothing links to —
// 40 rows for 20 regions, every regional boundary drawn twice.
const regionRows = await get('regions?select=id,spl_region_id,country_code,name_ar,name_en');
const regionByCode = new Map(regionRows.map((r) => [String(r.spl_region_id), r]));

// ── regions: UAE emirates (already cached by the UAE pipeline) ──────────────
console.log('\n── UAE emirates ──');
for (const em of EMIRATES) {
  const rel = readEls(join(UAE_RAW, `geom-emirate-${em.code}.json`)).find((e) => e.type === 'relation');
  const geom = rel ? elementGeometry(rel) : null;
  if (!geom) { console.warn(`  ! ${em.code}: no cached polygon — skipped`); continue; }
  const row = regionByCode.get(`AE-${em.code}`);
  if (!row) { console.warn(`  ! ${em.code}: no regions row for AE-${em.code} — skipped`); continue; }
  stage.push({
    tier: 'region', external_id: row.id, parent_external_id: 'AE', country_code: 'AE',
    name_ar: stripEmirateAr(row.name_ar || em.name_ar), name_en: stripEmirate(row.name_en || em.name_en),
    geojson: geom, source: 'OpenStreetMap via Overpass API (ODbL)',
  });
  console.log(`  ${em.code}: ${coordCount(geom)} coords`);
}

// ── regions: Saudi, matched to our rows by name ─────────────────────────────
console.log('\n── Saudi regions ──');
const saRows = regionRows.filter((r) => r.country_code === 'SA');
// OSM decorates region names ("Riyadh Region", "Eastern Province", "منطقة الرياض");
// ours are bare. Strip the decoration from BOTH sides before comparing.
const bareEn = (s) => normalizeEn(String(s ?? '').replace(/\s+(region|province|governorate|emirate)\s*$/i, ''));
const bareAr = (s) => normalizeAr(String(s ?? '').replace(/^\s*(منطقة|إمارة|امارة)\s+/, ''));
const byEn = new Map(saRows.map((r) => [bareEn(r.name_en), r]));
const byAr = new Map(saRows.map((r) => [bareAr(r.name_ar), r]));

const unmatched = [];
let matched = 0;
for (const f of readdirSync(RAW).filter((f) => /^region-SA-\d+\.json$/.test(f))) {
  const rel = readEls(join(RAW, f)).find((e) => e.type === 'relation');
  if (!rel) continue;
  const geom = elementGeometry(rel);
  if (!geom) { console.warn(`  ! ${f}: no geometry — skipped`); continue; }
  const tags = rel.tags ?? {};
  const row = byAr.get(bareAr(tags['name:ar'] || tags.name)) ?? byEn.get(bareEn(tags['name:en'] || tags.name));
  if (!row) {
    // Reported, never guessed: a wrong match would draw one province's outline around
    // another and nothing downstream would catch it.
    unmatched.push(`${f} (${tags['name:en'] || tags.name})`);
    continue;
  }
  stage.push({
    // The regions row UUID — see the note above the emirate loop.
    tier: 'region', external_id: row.id, parent_external_id: 'SA', country_code: 'SA',
    name_ar: row.name_ar, name_en: row.name_en, geojson: geom,
    source: 'OpenStreetMap via Overpass API (ODbL)',
  });
  matched++;
  console.log(`  ${String(row.spl_region_id).padStart(2)} ${(row.name_en || '').padEnd(22)} ${coordCount(geom)} coords`);
}
console.log(`  matched ${matched}/${saRows.length} Saudi regions`);
if (unmatched.length) {
  console.warn(`  ! UNMATCHED (not staged): ${unmatched.join(', ')}`);
}

// ── apply ───────────────────────────────────────────────────────────────────
console.log(`\nstaging ${stage.length} boundaries${DRY ? ' (DRY RUN)' : ''}…`);
if (!DRY) {
  await rpc('geo_boundary_stage_reset');
  for (let i = 0; i < stage.length; i += 5) {
    // Small batches: a country polygon is megabytes of coordinates.
    await post('_geo_boundary_stage', stage.slice(i, i + 5));
    process.stdout.write(`\r  staged ${Math.min(i + 5, stage.length)}/${stage.length}   `);
  }
  console.log('');
  const res = await rpc('geo_boundary_stage_apply');
  console.log(`applied: ${JSON.stringify(res)}`);
}
console.log(`\nDone. countries=${stage.filter((s) => s.tier === 'country').length} regions=${stage.filter((s) => s.tier === 'region').length}`);
