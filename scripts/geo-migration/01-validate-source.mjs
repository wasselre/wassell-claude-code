// Gate 1: validate the Saudi-districts source dataset before any Wassell change.
// Read-only. Exits non-zero with a clear report if any check fails.
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] ||
  'C:/Users/rayan/Claude/wassell-claude-code/.claude/worktrees/objective-turing-410d0c/saudi-districts/output';

const fail = [];
const warn = [];
const ok = [];
const p = (f) => path.join(DIR, f);
const must = (cond, msg) => (cond ? ok.push(msg) : fail.push(msg));

// --- presence ---
const files = ['summary.json','saudi_city_districts.json','saudi_city_districts.csv',
  'saudi_districts.geojson','cities_without_districts.json','failed_cities.json','missing_english_names.csv'];
for (const f of files) must(fs.existsSync(p(f)), `file present: ${f}`);

// --- summary ---
const summary = JSON.parse(fs.readFileSync(p('summary.json'),'utf8'));
must(summary.total_regions === 13, `summary.total_regions=13 (got ${summary.total_regions})`);
must(summary.total_districts === 3732, `summary.total_districts=3732 (got ${summary.total_districts})`);
must(summary.duplicate_district_rows_removed === 0, `summary.duplicate_district_rows_removed=0 (got ${summary.duplicate_district_rows_removed})`);
must(summary.missing_english_district_names === 0, `summary.missing_english_district_names=0 (got ${summary.missing_english_district_names})`);

// --- saudi_city_districts.json ---
const rows = JSON.parse(fs.readFileSync(p('saudi_city_districts.json'),'utf8'));
must(Array.isArray(rows), `saudi_city_districts.json is an array (len ${rows.length})`);
const req = ['region_id','region_name_ar','region_name_en','city_id','city_name_ar','city_name_en',
  'district_id','district_name_ar','district_name_en','centroid_lat','centroid_lng'];
let missingField = 0, badCentroid = 0;
const cityDistSet = new Set(), srcCityDistSet = new Set();
let dupCityDist = 0, dupSrcCityDist = 0;
const regionIds = new Set(), cityIds = new Set(), districtIds = new Set();
for (const r of rows) {
  for (const k of req) if (r[k] === undefined || r[k] === null || r[k] === '') missingField++;
  const lat = Number(r.centroid_lat), lng = Number(r.centroid_lng);
  if (!(lat >= 16 && lat <= 33 && lng >= 34 && lng <= 56)) badCentroid++;
  const cd = `${r.city_id}|${r.district_id}`;
  if (cityDistSet.has(cd)) dupCityDist++; else cityDistSet.add(cd);
  const scd = `${r.source}|${r.city_id}|${r.district_id}`;
  if (srcCityDistSet.has(scd)) dupSrcCityDist++; else srcCityDistSet.add(scd);
  regionIds.add(String(r.region_id)); cityIds.add(String(r.city_id)); districtIds.add(String(r.district_id));
}
must(rows.length === 3732, `json row count = 3732 (got ${rows.length})`);
must(missingField === 0, `json: no missing required fields (got ${missingField} empties)`);
must(badCentroid === 0, `json: all centroids in KSA bbox (got ${badCentroid} bad)`);
must(dupCityDist === 0, `json: no dup city_id+district_id (got ${dupCityDist})`);
must(dupSrcCityDist === 0, `json: no dup source+city_id+district_id (got ${dupSrcCityDist})`);
must(regionIds.size === 13, `json distinct region_id = 13 (got ${regionIds.size})`);
ok.push(`json distinct city_id = ${cityIds.size}, distinct district_id = ${districtIds.size}`);

// --- saudi_districts.geojson (24MB) ---
const gj = JSON.parse(fs.readFileSync(p('saudi_districts.geojson'),'utf8'));
must(gj.type === 'FeatureCollection', `geojson type=FeatureCollection (got ${gj.type})`);
const feats = gj.features || [];
must(feats.length === 3732, `geojson feature count = 3732 (got ${feats.length})`);
let noDid = 0, didNotInJson = 0, badOrder = 0, badGeom = 0;
const featDistrictIds = new Map();
function firstCoord(geom){
  if (!geom) return null;
  if (geom.type === 'Polygon') return geom.coordinates?.[0]?.[0] ?? null;
  if (geom.type === 'MultiPolygon') return geom.coordinates?.[0]?.[0]?.[0] ?? null;
  return null;
}
for (const ft of feats) {
  const props = ft.properties || {};
  const did = props.district_id ?? props.districtId ?? null;
  if (did === undefined || did === null || did === '') { noDid++; continue; }
  if (!districtIds.has(String(did))) didNotInJson++;
  featDistrictIds.set(String(did), (featDistrictIds.get(String(did))||0)+1);
  if (!ft.geometry || !['Polygon','MultiPolygon'].includes(ft.geometry.type)) { badGeom++; continue; }
  const c = firstCoord(ft.geometry);
  if (c) { const lng = Number(c[0]), lat = Number(c[1]);
    if (!(lng >= 34 && lng <= 56 && lat >= 16 && lat <= 33)) badOrder++; }
}
must(noDid === 0, `geojson: every feature has district_id (got ${noDid} missing)`);
must(didNotInJson === 0, `geojson: every feature district_id exists in json (got ${didNotInJson} orphans)`);
must(badOrder === 0, `geojson: coords in [lng,lat] KSA order (got ${badOrder} out-of-bbox)`);
must(badGeom === 0, `geojson: all geometries Polygon/MultiPolygon (got ${badGeom} bad)`);
let multiBoundary = 0; for (const [,n] of featDistrictIds) if (n > 1) multiBoundary++;
must(multiBoundary === 0, `geojson: no district has multiple boundary features (got ${multiBoundary})`);
// every json district has a boundary?
let jsonWithoutBoundary = 0; for (const d of districtIds) if (!featDistrictIds.has(d)) jsonWithoutBoundary++;
must(jsonWithoutBoundary === 0, `every json district has a boundary feature (got ${jsonWithoutBoundary} without)`);

// --- report ---
console.log('=== PASSED ===');
for (const m of ok) console.log('  ok  ', m);
if (warn.length){ console.log('=== WARN ==='); for (const m of warn) console.log('  warn', m); }
if (fail.length){ console.log('=== FAILED ==='); for (const m of fail) console.log('  FAIL', m); }
console.log(`\nRESULT: ${fail.length === 0 ? 'ALL CHECKS PASSED' : fail.length + ' CHECK(S) FAILED'}`);
// sample row + feature props for downstream field mapping
console.log('\nSAMPLE json row:', JSON.stringify(rows[0]));
console.log('SAMPLE geojson props:', JSON.stringify(feats[0]?.properties));
console.log('SAMPLE geojson geom type:', feats[0]?.geometry?.type);
process.exit(fail.length === 0 ? 0 : 1);
