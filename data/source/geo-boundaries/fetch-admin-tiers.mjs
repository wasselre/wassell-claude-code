#!/usr/bin/env node
/**
 * Fetch the COUNTRY and REGION boundary polygons that the map layer draws.
 *
 *   node data/source/geo-boundaries/fetch-admin-tiers.mjs
 *
 * Districts already have boundaries (`district_boundaries`, 5,384 rows) and roads and
 * landmarks already have geometry in `geo_elements`. The tiers above district had
 * NOTHING — `regions` and `cities` carry no geometry column at all — so a map could
 * never draw a country, region or city outline.
 *
 * THE CITY TIER IS NOT FETCHED. A city's meaningful outline is the union of its own
 * districts, which is exactly the built-up extent a reader expects (and what the
 * Riyadh reference screenshot shows). That union is computed in Postgres from data we
 * already hold — no request, always consistent with the districts drawn on top of it,
 * and it works for the ~150 cities that have no OSM boundary relation at all.
 *
 * So this only fetches 14 polygons: 2 countries + 12 Saudi regions (the 7 emirates and
 * the UAE outline are already cached by the UAE pipeline and are reused from there).
 *
 * Raw responses cache under `raw/`; re-running is free.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { overpass } from '../geo-lib/overpass.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
mkdirSync(RAW, { recursive: true });

const FORCE = process.argv.includes('--force');
const TIMEOUT = 240;

/** OSM country relations. The UAE's is already cached by the UAE pipeline. */
const COUNTRIES = [
  { code: 'SA', osm_id: 307584, name_en: 'Saudi Arabia', name_ar: 'السعودية' },
  { code: 'AE', osm_id: 307763, name_en: 'United Arab Emirates', name_ar: 'الإمارات العربية المتحدة' },
];

const cachePath = (n) => join(RAW, `${n}.json`);
const isCached = (n) => !FORCE && existsSync(cachePath(n)) && statSync(cachePath(n)).size > 2;

async function cached(name, run) {
  if (isCached(name)) {
    console.log(`· ${name}: cached (${JSON.parse(readFileSync(cachePath(name), 'utf8')).elements?.length ?? 0})`);
    return;
  }
  console.log(`↓ ${name} …`);
  const t0 = Date.now();
  const json = await run();
  writeFileSync(cachePath(name), JSON.stringify(json));
  console.log(`✓ ${name}: ${json.elements?.length ?? 0} elements in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(1200);
}

/** Country outlines, one request each — a whole country's coastline is heavy. */
async function countries() {
  console.log('\n── countries ──');
  for (const c of COUNTRIES) {
    await cached(`country-${c.code}`, () =>
      overpass(`[out:json][timeout:${TIMEOUT}];relation(${c.osm_id});out geom;`,
        { label: `country-${c.code}`, attempts: 10 }));
  }
}

/**
 * Saudi's 13 admin_level=4 regions. Tags first (cheap) so the ids can be matched to our
 * `regions` rows by name, then geometry one region at a time — a single request for all
 * 13 is tens of MB of coastline and desert border and 504s on every mirror.
 */
async function saudiRegions() {
  console.log('\n── Saudi regions ──');
  await cached('sa-regions-index', () =>
    overpass(`[out:json][timeout:${TIMEOUT}];relation[boundary=administrative][admin_level=4](area:3600307584);out tags;`,
      { label: 'sa-regions-index', attempts: 10 }));

  const index = JSON.parse(readFileSync(cachePath('sa-regions-index'), 'utf8')).elements ?? [];
  console.log(`  ${index.length} region relations`);
  const failed = [];
  for (const r of index) {
    const name = r.tags['name:en'] || r.tags.name || String(r.id);
    try {
      await cached(`region-SA-${r.id}`, () =>
        overpass(`[out:json][timeout:${TIMEOUT}];relation(${r.id});out geom;`,
          { label: `region-SA-${r.id} (${name})`, attempts: 10 }));
    } catch (err) {
      // Same posture as the UAE geometry pass: one unfetchable region must not cost the
      // other twelve. Reported, cache untouched, retried by a re-run.
      console.error(`  ✗ region-SA-${r.id} (${name}): ${err.message}`);
      failed.push(name);
    }
  }
  if (failed.length) console.error(`\n  ${failed.length} region(s) missing geometry: ${failed.join(', ')} — re-run to retry`);
}

async function main() {
  console.log(`admin-tier boundary fetch → ${RAW}`);
  await countries();
  await saudiRegions();
  console.log('\nDone. Next: node data/source/geo-boundaries/build-boundaries.mjs');
}

main().catch((e) => { console.error('\nFETCH FAILED:', e.message); process.exit(1); });
