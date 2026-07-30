#!/usr/bin/env node
/**
 * Acceptance test for the UAE geography classification.
 *
 *   node data/source/geo-uae/verify.mjs
 *
 * Not a vitest suite on purpose: it asserts against the real cached OSM boundaries in
 * `raw/`, which are gitignored (reproducible from fetch.mjs, hundreds of MB). A unit
 * test would need simplified fixtures and would then be testing the fixtures rather
 * than the data we actually ship. Run this after any fetch or any change to
 * lib/classify.mjs.
 *
 * Exits non-zero on any failure so it can gate an import.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { elementGeometry, coordCount } from '../geo-lib/overpass.mjs';
import { bboxOf, locateEmirate, pointInGeometry } from '../geo-lib/classify.mjs';
import { EMIRATES } from '../geo-lib/emirates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');

const load = (name) => {
  const p = join(RAW, `${name}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')).elements?.[0] ?? null;
};

const regions = [];
for (const em of EMIRATES) {
  const rel = load(`geom-emirate-${em.code}`);
  if (!rel) { console.error(`MISSING raw/geom-emirate-${em.code}.json — run: node data/source/geo-uae/fetch.mjs emirates`); process.exit(1); }
  const geometry = elementGeometry(rel);
  regions.push({ code: em.code, geometry, bbox: bboxOf(geometry) });
}
const countryRel = load('geom-country-AE');
if (!countryRel) { console.error('MISSING raw/geom-country-AE.json — run: node data/source/geo-uae/fetch.mjs emirates'); process.exit(1); }
const country = elementGeometry(countryRel);

console.log('boundaries');
for (const r of regions) console.log(`  ${r.code.padEnd(4)} ${r.geometry.type.padEnd(13)} ${String(coordCount(r.geometry)).padStart(5)} coords`);
console.log(`  AE   ${country.type.padEnd(13)} ${String(coordCount(country)).padStart(5)} coords`);

/**
 * Landmarks chosen to pin down the cases that actually break:
 *  · every emirate's own capital, so no emirate is silently unreachable
 *  · the master-planned islands, which are the UAE's highest-value anchors and the
 *    most likely to fall outside a coastline traced before they were built
 *  · Dubai's Hatta enclave and Sharjah's east-coast exclaves (Kalba, Khor Fakkan) —
 *    discontiguous territory that a naive nearest-emirate rule assigns wrongly
 *  · foreign cities, including Al Buraimi (2.3 km from Abu Dhabi's edge, closer than
 *    some legitimate reclamation) and Omani Musandam (north of the whole UAE)
 */
const CASES = [
  ['Abu Dhabi city', [54.3773, 24.4539], 'AUH'],
  ['Al Ain', [55.7447, 24.2075], 'AUH'],
  ['Yas Island', [54.6072, 24.4994], 'AUH'],
  ['Saadiyat Island', [54.4340, 24.5430], 'AUH'],
  ['Al Reem Island', [54.4020, 24.4960], 'AUH'],
  ['Sir Bani Yas', [52.6000, 24.3100], 'AUH'],
  ['Dubai Marina', [55.1385, 25.0805], 'DXB'],
  ['Burj Khalifa', [55.2744, 25.1972], 'DXB'],
  ['Palm Jumeirah', [55.1385, 25.1124], 'DXB'],
  ['Palm Jebel Ali', [54.9930, 25.0060], 'DXB'],
  ['Hatta (Dubai enclave)', [56.1183, 24.8000], 'DXB'],
  ['Sharjah city', [55.4033, 25.3463], 'SHJ'],
  ['Kalba (Sharjah exclave)', [56.3556, 25.0700], 'SHJ'],
  ['Khor Fakkan (Sharjah exclave)', [56.3450, 25.3390], 'SHJ'],
  ['Ajman city', [55.4794, 25.4052], 'AJM'],
  ['Umm Al Quwain city', [55.5533, 25.5647], 'UAQ'],
  ['Ras Al Khaimah city', [55.9432, 25.7895], 'RAK'],
  ['Fujairah city', [56.3265, 25.1288], 'FUJ'],
  ['Muscat, Oman', [58.4059, 23.5880], null],
  ['Sohar, Oman', [56.7090, 24.3470], null],
  ['Al Buraimi, Oman', [55.7930, 24.2500], null],
  ['Khasab, Oman (Musandam)', [56.2430, 26.1800], null],
  ['Riyadh, Saudi Arabia', [46.6753, 24.7136], null],
  ['Doha, Qatar', [51.5310, 25.2860], null],
];

console.log('\nemirate assignment');
let pass = 0;
const failures = [];
for (const [name, point, want] of CASES) {
  const hit = locateEmirate(point, regions, { country });
  const got = hit ? hit.emirate.code : null;
  const ok = want === null ? got === null : got === want;
  if (ok) pass++; else failures.push({ name, want, got });
  const note = hit && !hit.exact ? ` (${hit.why}, ${hit.km.toFixed(2)}km)` : '';
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} → ${String(got ?? '—').padEnd(5)}${note}`);
}

// Every emirate must be reachable, or its whole district list would be orphaned.
const covered = new Set(CASES.filter(([, , w]) => w).map(([, , w]) => w));
const uncovered = EMIRATES.filter((e) => !covered.has(e.code));
if (uncovered.length) failures.push({ name: 'coverage', want: 'all 7 emirates asserted', got: `missing ${uncovered.map((e) => e.code).join(',')}` });

// The country polygon must actually contain every emirate capital, else the seam
// fallback in step 2 would never fire and legitimate seam points would be dropped.
console.log('\ncountry polygon sanity');
for (const [name, point, want] of CASES.filter(([, , w]) => w)) {
  if (!pointInGeometry(point, country)) failures.push({ name: `${name} inside country polygon`, want: 'true', got: 'false' });
}
console.log(`  ${CASES.filter(([, , w]) => w).length} in-country points checked`);

console.log(`\n${pass}/${CASES.length} assignment cases pass`);
if (failures.length) {
  console.error('\nFAILURES:');
  for (const f of failures) console.error(`  ${f.name}: wanted ${f.want}, got ${f.got}`);
  process.exit(1);
}
console.log('ALL CHECKS PASS');
