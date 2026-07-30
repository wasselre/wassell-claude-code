#!/usr/bin/env node
/**
 * Import the processed UAE geography into Wassell.
 *
 *   node scripts/geo-uae/import-uae-geography.mjs [--dry-run]
 *
 * Reads `data/source/geo-uae/uae-geography.json` + `uae-district-boundaries.geojson`
 * (produced by process-admin.mjs) and upserts:
 *
 *   regions             7 emirates      (frozen table)
 *   cities              (frozen table)
 *   districts           (frozen table)
 *   district_boundaries PostGIS polygons, via a staging table
 *   district_aliases    AR/EN name variants for the matcher
 *   geography_import_runs  one audit row
 *
 * Idempotent: row ids are md5-derived from the external id, so a re-run upserts the
 * same rows rather than duplicating them — the same scheme the Saudi import used
 * (`geo-district:<id>`), and UAE ids are namespaced (`AE-DXB-D0001`) so they can
 * never collide with Saudi's numeric SPL ids.
 *
 * WRITES GO DIRECTLY TO THE FROZEN TABLES, not through `record_save`. CLAUDE.md's
 * rule is that the APP must never write to `records` for a frozen model; a bulk
 * reference-data import writing the dedicated table with explicit columns is exactly
 * what `freeze_apply_row` does internally, and it is what a migration would do. These
 * three models have no multi-value fields, so there are no junctions or subtables to
 * keep in step.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DATA = join(ROOT, 'data', 'source', 'geo-uae');
const DRY = process.argv.includes('--dry-run');

// ── env (the worktree has no .env; fall back to the main checkout) ───────────
function loadEnv() {
  const candidates = [
    join(ROOT, '.env.local'), join(ROOT, '.env'),
    'C:/Users/rayan/Claude/wassell-claude-code/.env.local',
    'C:/Users/rayan/Claude/wassell-claude-code/.env',
  ];
  for (const p of candidates) {
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

const MODEL = {
  regions:   'd15a0001-0000-4000-8000-000000000001',
  cities:    'd15a0001-0000-4000-8000-000000000002',
  districts: 'd9a9db7e-b602-470c-b81b-5d6ff17048e9',
};
const COUNTRY_AE = 'd15a0003-0000-4000-8000-000000000002';
const SOURCE = 'OpenStreetMap via Overpass API (© OpenStreetMap contributors, ODbL)';

/** Deterministic UUID from a namespaced key — re-runs land on the same row. */
const uuid = (s) => {
  const h = createHash('md5').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const rid = (id) => uuid(`geo-region:${id}`);
const cid = (id) => uuid(`geo-city:${id}`);
const did = (id) => uuid(`geo-district:${id}`);

async function post(path, rows, prefer = 'resolution=merge-duplicates,return=minimal') {
  if (DRY) return;
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method: 'POST', headers: { ...H, Prefer: prefer }, body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`POST ${path} (${rows.length} rows) → ${r.status} ${(await r.text()).slice(0, 500)}`);
}
async function batched(path, rows, size) {
  for (let i = 0; i < rows.length; i += size) {
    await post(path, rows.slice(i, i + size));
    process.stdout.write(`\r  ${path}: ${Math.min(i + size, rows.length)}/${rows.length}   `);
  }
  console.log('');
}
async function rpc(fn, args = {}) {
  if (DRY) return null;
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`RPC ${fn} → ${r.status} ${(await r.text()).slice(0, 500)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
async function del(path) {
  if (DRY) return;
  const r = await fetch(`${URL}/rest/v1/${path}`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${path} → ${r.status} ${(await r.text()).slice(0, 300)}`);
}

// ── load the processed dataset ──────────────────────────────────────────────
const geoPath = join(DATA, 'uae-geography.json');
if (!existsSync(geoPath)) {
  console.error(`Missing ${geoPath}. Run: node data/source/geo-uae/process-admin.mjs`);
  process.exit(1);
}
const geo = JSON.parse(readFileSync(geoPath, 'utf8'));
const boundaryPath = join(DATA, 'uae-district-boundaries.geojson');
const boundaryFc = existsSync(boundaryPath) ? JSON.parse(readFileSync(boundaryPath, 'utf8')) : { features: [] };

const startedAt = new Date().toISOString();
console.log(`UAE geography import${DRY ? ' (DRY RUN)' : ''}`);
console.log(`  regions=${geo.regions.length} cities=${geo.cities.length} districts=${geo.districts.length} boundaries=${boundaryFc.features.length}`);

const byRegionId = new Map(geo.regions.map((r) => [r.region_id, r]));
const byCityId = new Map(geo.cities.map((c) => [c.city_id, c]));

// ── regions (emirates) ──────────────────────────────────────────────────────
const regionRows = geo.regions.map((r) => ({
  id: rid(r.region_id),
  name_ar: r.name_ar,
  name_en: r.name_en,
  spl_region_id: r.region_id,      // generic "external region id"; the column name is
                                    // Saudi-flavoured because it predates multi-country.
  country_code: 'AE',
  country_lookup: COUNTRY_AE,
  source: SOURCE,
  source_updated_at: startedAt,
  is_active: true,
}));

// ── cities ──────────────────────────────────────────────────────────────────
const cityRows = geo.cities.map((c) => {
  const reg = byRegionId.get(c.region_id);
  return {
    id: cid(c.city_id),
    name_ar: c.name_ar || null,
    name_en: c.name_en || null,
    display_name: c.display_name || c.name_ar || c.name_en,
    spl_city_id: c.city_id,
    region_lookup: rid(c.region_id),
    region_name_ar: reg?.name_ar ?? null,
    region_name_en: reg?.name_en ?? null,
    source: SOURCE,
    source_updated_at: startedAt,
    has_districts: geo.districts.some((d) => d.city_id === c.city_id),
    is_active: true,
  };
});

// ── districts ───────────────────────────────────────────────────────────────
const districtRows = geo.districts.map((d) => {
  const reg = byRegionId.get(d.region_id);
  const city = byCityId.get(d.city_id);
  return {
    id: did(d.district_id),
    district_id: d.district_id,
    spl_district_id: d.district_id,          // the join key district_boundaries uses
    name_ar: d.name_ar || null,
    name_en: d.name_en || null,
    display_name: d.display_name || d.name_ar || d.name_en,
    city_lookup: cid(d.city_id),
    city_id: d.city_id,
    city: city?.display_name ?? null,
    city_name_ar: city?.name_ar ?? null,
    city_name_en: city?.name_en ?? null,
    region_lookup: rid(d.region_id),
    region_id: d.region_id,
    region: reg?.name_ar ?? null,
    region_name_ar: reg?.name_ar ?? null,
    region_name_en: reg?.name_en ?? null,
    centroid_lat: d.centroid_lat,
    centroid_lng: d.centroid_lng,
    center_lat: d.centroid_lat,
    center_lng: d.centroid_lng,
    source: SOURCE,
    source_updated_at: startedAt,
    is_active: true,
    // Provenance a reviewer can act on: which OSM element, which tier it came from,
    // and — the part worth checking — how its city was decided.
    migration_notes: `osm:${d.osm} source:${d.source_kind}${d.admin_level ? ` admin_level:${d.admin_level}` : ''}${d.place ? ` place:${d.place}` : ''} city_by:${d.city_assignment}${d.city_distance_km != null ? ` (${d.city_distance_km}km)` : ''}`,
  };
});

// ── aliases (what the matcher normalizes against) ────────────────────────────
const stripHayy = (s) => String(s ?? '').replace(/^\s*حي\s+/, '').trim();
const stripAl = (s) => String(s ?? '').replace(/^\s*(Al|El)[\s-]+/i, '').trim();
const aliases = [];
for (const d of geo.districts) {
  const drec = did(d.district_id);
  const push = (ar, en, type, conf) => {
    if (!ar && !en) return;
    aliases.push({
      district_record_id: drec, spl_district_id: d.district_id,
      alias_ar: ar || null, alias_en: en || null,
      alias_type: type, source: SOURCE, confidence_score: conf, is_active: true,
    });
  };
  push(d.name_ar || null, d.name_en || null, 'official', 1.0);
  const ar2 = stripHayy(d.name_ar);
  if (ar2 && ar2 !== d.name_ar) push(ar2, null, 'arabic_variant', 0.9);
  // "Al Barsha" / "Barsha", "Al Nahda" / "Nahda" — the article is dropped constantly
  // in listings and in speech, and this is the single most common UAE spelling variant.
  const en2 = stripAl(d.name_en);
  if (en2 && en2 !== d.name_en) push(null, en2, 'english_variant', 0.9);
}

// ── boundary staging rows ───────────────────────────────────────────────────
const stageRows = boundaryFc.features.map((ft) => ({
  spl_district_id: ft.properties.district_id,
  city_id: ft.properties.city_id ?? null,
  region_id: ft.properties.region_id ?? null,
  geojson: ft.geometry,
  geometry_type: ft.geometry?.type ?? null,
}));

async function main() {
  console.log('\nregions…');   await batched('regions', regionRows, 200);
  console.log('cities…');      await batched('cities', cityRows, 200);
  console.log('districts…');   await batched('districts', districtRows, 200);

  console.log('aliases (replacing this source only)…');
  await del(`district_aliases?source=eq.${encodeURIComponent(SOURCE)}`);
  await batched('district_aliases', aliases, 500);

  if (stageRows.length) {
    console.log('boundaries → staging…');
    // Polygons cannot be POSTed as PostGIS geometry over PostgREST, so land the
    // GeoJSON in a staging table and let ST_GeomFromGeoJSON do the parsing
    // server-side — the same two-step the Saudi import used.
    await rpc('geo_uae_stage_reset');
    await batched('_geo_uae_stage_boundaries', stageRows, 40);
    console.log('boundaries → district_boundaries (ST_GeomFromGeoJSON)…');
    const res = await rpc('geo_uae_apply_boundaries');
    console.log(`  applied: ${JSON.stringify(res)}`);
  } else {
    console.log('boundaries: none in the dataset — skipping (run fetch.mjs geometry + re-run process-admin.mjs)');
  }

  const audit = {
    source: SOURCE,
    source_path: 'data/source/geo-uae/uae-geography.json',
    extraction_date: startedAt.slice(0, 10),
    import_started_at: startedAt,
    import_completed_at: new Date().toISOString(),
    total_regions: geo.regions.length,
    total_cities: geo.cities.length,
    cities_with_districts: cityRows.filter((c) => c.has_districts).length,
    cities_without_districts: cityRows.filter((c) => !c.has_districts).length,
    total_districts: geo.districts.length,
    imported_regions: regionRows.length,
    imported_cities: cityRows.length,
    imported_districts: districtRows.length,
    imported_boundaries: stageRows.length,
    missing_english_names_count: geo.districts.filter((d) => !d.name_en).length,
    duplicate_rows_removed: 0,
    failed_records_count: 0,
    status: 'completed',
    notes: 'UAE geography (7 emirates). Derived from OSM: tiers classified by admin_level + place tags, city assigned by nearest same-emirate settlement. See data/source/geo-uae/report-admin.md.',
    validation_report_json: geo.counts,
  };
  await post('geography_import_runs', [audit], 'return=minimal');
  // Named -admin so it can't collide with the anchor importer's import-report.json,
  // which lands in this same directory.
  writeFileSync(join(DATA, 'import-report-admin.json'), JSON.stringify(audit, null, 2));

  console.log(`\nDone${DRY ? ' (dry run — nothing written)' : ''}.`);
  console.log(`  ${regionRows.length} regions · ${cityRows.length} cities · ${districtRows.length} districts · ${aliases.length} aliases · ${stageRows.length} boundaries`);
}

main().catch((e) => { console.error('\nIMPORT FAILED:', e.message); process.exit(1); });
