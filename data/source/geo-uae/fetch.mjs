#!/usr/bin/env node
/**
 * Fetch the raw OpenStreetMap extract for the UAE geography build.
 *
 *   node data/source/geo-uae/fetch.mjs                 # all passes, resumable
 *   node data/source/geo-uae/fetch.mjs emirates        # pass 0 — emirate polygons
 *   node data/source/geo-uae/fetch.mjs survey          # pass A — tags + centroids
 *   node data/source/geo-uae/fetch.mjs geometry        # pass B — geometry by id
 *   node data/source/geo-uae/fetch.mjs survey --force  # ignore the cache
 *
 * THREE PASSES, and the shape of them is driven by what the public Overpass
 * instances will actually serve.
 *
 * Pass 0 (emirates) — the 7 emirate boundary relations by id, with geometry. Cheap
 * (7 ids) and it unlocks everything else: process.mjs uses these polygons to reject
 * anything the bbox dragged in from Oman/Saudi, and to assign each district to its
 * emirate and nearest city.
 *
 * Pass A (survey) — `out tags center;` over a UAE BOUNDING BOX. Two deliberate
 * choices: `area(3600307763)` costs ~90s per query because Overpass has to recurse
 * the whole country relation, while a bbox is near-instant; and the region/city tiers
 * need no geometry at all (the Saudi layer stores boundaries for districts only), so
 * tags + a centroid is the entire answer for them.
 *
 * Pass B (geometry) — `out geom;` for an explicit id list written by
 * plan-geometry.mjs once the survey is classified. Country-wide `out geom;`
 * reliably 504s (UAE coastline and island polygons are enormous); id-scoped chunks
 * never do.
 *
 * Raw responses are cached under `raw/`. process.mjs reads only from `raw/`, never the
 * network — that is what makes the dataset reproducible.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { overpass } from './lib/overpass.mjs';
import { EMIRATES } from './lib/emirates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
mkdirSync(RAW, { recursive: true });

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const passes = argv.filter((a) => !a.startsWith('--'));
const wants = (p) => passes.length === 0 || passes.includes(p);

/**
 * UAE bounding box (south,west,north,east). Deliberately a little generous — it also
 * covers slices of Oman (Al Buraimi, the Musandam approach) and Saudi. process.mjs
 * discards anything whose centroid falls outside the real emirate polygons, so a
 * loose box costs nothing but a stricter one would silently clip Fujairah's coast and
 * the western Al Dhafra islands.
 */
const BBOX = '22.50,51.00,26.20,56.50';

const TIMEOUT = 240;

const cachePath = (name) => join(RAW, `${name}.json`);
const isCached = (name) => !FORCE && existsSync(cachePath(name)) && statSync(cachePath(name)).size > 2;

async function cached(name, run) {
  if (isCached(name)) {
    const n = JSON.parse(readFileSync(cachePath(name), 'utf8')).elements?.length ?? 0;
    console.log(`· ${name}: cached (${n} elements)`);
    return;
  }
  console.log(`↓ ${name} …`);
  const t0 = Date.now();
  const json = await run();
  writeFileSync(cachePath(name), JSON.stringify(json));
  console.log(`✓ ${name}: ${json.elements?.length ?? 0} elements in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(1200); // be a good Overpass citizen
}

const bboxQuery = (selector, out) =>
  `[out:json][timeout:${TIMEOUT}][bbox:${BBOX}];(${selector});${out}`;

// ── pass 0: emirate polygons ────────────────────────────────────────────────
// One request PER emirate. All seven at once 504s on every mirror: Abu Dhabi alone
// carries a Gulf coastline plus ~200 offshore islands, and the combined response is
// tens of MB of coordinates. Per-emirate files are also independently cached, so a
// single failure doesn't cost the other six.
async function emirates() {
  console.log('\n── pass 0: emirate + country polygons ──');
  for (const em of EMIRATES) {
    await cached(`geom-emirate-${em.code}`, () =>
      overpass(`[out:json][timeout:${TIMEOUT}];relation(${em.osm_id});out geom;`,
        { label: `emirate-${em.code}`, attempts: 8 }),
    );
  }
  // The UAE national boundary. Load-bearing, not decorative: emirate borders are
  // traced independently and don't tile the country perfectly, so a point can land in
  // a seam between two of them. The country polygon is what distinguishes such a point
  // (keep it, assign to the nearest emirate) from one in a foreign enclave — Al
  // Buraimi, Oman sits inside Abu Dhabi's BOUNDING BOX right next to Al Ain, and only
  // a real boundary can reject it.
  await cached('geom-country-AE', () =>
    overpass(`[out:json][timeout:${TIMEOUT}];relation(307763);out geom;`,
      { label: 'country-AE', attempts: 8 }),
  );
}

// ── pass A: survey (tags + centroid) ────────────────────────────────────────
// Levels below 4 vary by emirate — Abu Dhabi uses 5/6 for its city region and its
// three regions, Dubai uses 7 for rural sectors, and the community tier is 8 (374)
// with sub-communities at 10 (129). Every level is surveyed and process.mjs decides
// which tier each one lands in.
const ADMIN_LEVELS = [4, 5, 6, 7, 8, 9, 10];

const PLACE_QUERIES = {
  'places-settlements': `nwr[place~"^(city|town|village)$"][name];`,
  // The district tier in the UAE is mapped predominantly as place=suburb /
  // neighbourhood (Dubai "communities"), frequently WITHOUT an administrative
  // relation — this is the long tail of names buyers actually use.
  'places-districts': `nwr[place~"^(suburb|neighbourhood|quarter|city_block)$"][name];`,
  // Named residential landuse polygons — the fallback boundary for a community
  // mapped only as a point.
  'places-residential': `nwr[landuse=residential][name];`,
};

// Mirrors the Riyadh category set, plus `islands`: in the UAE the master-planned
// islands (Palm Jumeirah, Yas, Saadiyat, Al Reem, Al Maryah) are primary real-estate
// anchors with real polygons, so they earn their own category.
const ANCHOR_QUERIES = {
  roads_major: `way[highway~"^(motorway|trunk|primary)$"][name];`,
  secondary_roads: `way[highway=secondary][name];`,
  metro_lines: `relation[route~"^(subway|light_rail|monorail|tram)$"];`,
  metro_stations: `nwr[railway=station];nwr[station~"^(subway|light_rail|monorail)$"];nwr[railway=tram_stop][name];`,
  malls: `nwr[shop=mall];nwr[shop=department_store][name];`,
  universities: `nwr[amenity~"^(university|college)$"][name];`,
  hospitals: `nwr[amenity=hospital][name];nwr[healthcare=hospital][name];`,
  airports_transport: `nwr[aeroway=aerodrome][name];nwr[amenity=bus_station][name];nwr[amenity=ferry_terminal][name];`,
  parks: `nwr[leisure~"^(park|garden)$"][name];`,
  landmarks: `nwr[tourism~"^(attraction|museum|theme_park|zoo|aquarium)$"][name];nwr[man_made=tower][name];nwr[historic][name];`,
  business_zones: `nwr[landuse~"^(commercial|industrial)$"][name];nwr[office=government][name];`,
  free_zones: `nwr[name~"[Ff]ree [Zz]one"];nwr["name:en"~"[Ff]ree [Zz]one"];`,
  lifestyle: `nwr[leisure~"^(water_park|beach_resort|marina|golf_course)$"][name];nwr[natural=beach][name];`,
  islands: `nwr[place~"^(island|islet)$"][name];`,
};

async function survey() {
  console.log('\n── pass A: survey (tags + centroid, bbox-scoped) ──');
  for (const lvl of ADMIN_LEVELS) {
    await cached(`survey-admin-${lvl}`, () =>
      overpass(bboxQuery(`relation[boundary=administrative][admin_level=${lvl}];`, 'out tags center;'),
        { label: `admin-${lvl}`, attempts: 6 }),
    );
  }
  for (const [name, sel] of Object.entries(PLACE_QUERIES)) {
    await cached(`survey-${name}`, () =>
      overpass(bboxQuery(sel, 'out tags center;'), { label: name, attempts: 6 }));
  }
  for (const [name, sel] of Object.entries(ANCHOR_QUERIES)) {
    await cached(`survey-anchor-${name}`, () =>
      overpass(bboxQuery(sel, 'out tags center;'), { label: `anchor-${name}`, attempts: 6 }));
  }
}

// ── pass B: geometry for an explicit id list ────────────────────────────────
const CHUNK = { relation: 40, way: 200, node: 500 };

/**
 * `geometry-plan.json` is written by plan-geometry.mjs:
 *   { "<batch>": { "relation": [ids], "way": [ids] } }
 * Chunked id queries, because a single `out geom;` over hundreds of boundary
 * relations is exactly what makes the public instances 504.
 */
async function geometry() {
  console.log('\n── pass B: geometry by id ──');
  const planPath = join(HERE, 'geometry-plan.json');
  if (!existsSync(planPath)) {
    console.log('  (no geometry-plan.json — run plan-geometry.mjs after the survey)');
    return;
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  for (const [batch, byType] of Object.entries(plan)) {
    for (const [osmType, ids] of Object.entries(byType)) {
      if (!Array.isArray(ids) || !ids.length) continue;
      const size = CHUNK[osmType] ?? 100;
      for (let i = 0; i < ids.length; i += size) {
        const slice = ids.slice(i, i + size);
        const name = `geom-${batch}-${osmType}-${String(Math.floor(i / size)).padStart(3, '0')}`;
        await cached(name, () =>
          overpass(`[out:json][timeout:${TIMEOUT}];${osmType}(id:${slice.join(',')});out geom;`,
            { label: name, attempts: 6 }),
        );
      }
    }
  }
}

async function main() {
  console.log(`UAE geography fetch → ${RAW}`);
  if (wants('emirates')) await emirates();
  if (wants('survey')) await survey();
  if (wants('geometry')) await geometry();
  console.log('\nDone.');
}

main().catch((err) => { console.error('\nFETCH FAILED:', err.message); process.exit(1); });
