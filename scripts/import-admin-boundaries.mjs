#!/usr/bin/env node
/**
 * Import real OSM administrative borders (country + region) into `geo_boundaries`,
 * the tier store the map layer reads.
 *
 *   node scripts/import-admin-boundaries.mjs
 *
 * WHY THIS IS NEEDED. 2026-07-30e backfilled the `district` and `city` tiers by
 * dissolving district polygons, but left `country` and `region` EMPTY — while
 * `geo_map_tier_for_zoom` serves 'country' at zoom ≤5 and 'region' at ≤7. Zooming
 * out therefore drew nothing. Those two tiers cannot be derived the same way:
 * districts exist only inside built-up areas, so the union of every Saudi district
 * is not Saudi Arabia, it is ~190 disconnected city blobs.
 *
 * Reads data/source/geo/admin-boundaries.json (produced by
 * data/source/geo/fetch-admin.mjs). One RPC call per boundary — a region can carry
 * ~65k coordinates, so batching would build a request body big enough to be
 * refused. Idempotent: upserts on (tier, external_id).
 *
 * Raw fetch, not @supabase/supabase-js — that package aborts on Node 24 / Windows
 * with a libuv assertion during teardown.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'data', 'source', 'geo', 'admin-boundaries.json');

function envRoots() {
  const roots = [ROOT];
  const marker = '\\.claude\\worktrees\\';
  const norm = ROOT.replace(/\//g, '\\');
  const idx = norm.lastIndexOf(marker);
  if (idx > 0) roots.push(norm.slice(0, idx));
  return roots;
}
for (const root of envRoots()) {
  for (const f of ['.env.local', '.env']) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      if (!/^[A-Z0-9_]+$/.test(k)) continue;
      if (!(k in process.env)) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!existsSync(SRC)) { console.error(`Missing ${SRC} — run data/source/geo/fetch-admin.mjs first.`); process.exit(1); }

async function rpc(fn, args) {
  const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const rows = JSON.parse(readFileSync(SRC, 'utf8'));
console.log(`[admin-import] ${rows.length} boundaries from ${SRC}`);

let ok = 0;
const failures = [];
for (const r of rows) {
  try {
    // geometry_geojson must reach ST_GeomFromGeoJSON as TEXT, so stringify it here.
    const res = await rpc('geo_boundary_import_admin', {
      p_row: { ...r, geometry_geojson: JSON.stringify(r.geometry_geojson) },
    });
    ok++;
    console.log(`[admin-import] ${res.tier} ${r.country_code} ${res.external_id}` +
      `${res.joined ? ' (joined to record)' : ' (UNJOINED — check name match)'} — ${res.points} pts`);
  } catch (err) {
    failures.push({ row: `${r.level} ${r.country_code} ${r.ref_id}`, error: err.message });
    console.error(`[admin-import] ${r.level} ${r.country_code} ${r.ref_id} FAILED: ${err.message}`);
  }
}

console.log(`\n[admin-import] done. imported=${ok} failed=${failures.length}`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f.row}: ${f.error}`);
  process.exit(1);
}
