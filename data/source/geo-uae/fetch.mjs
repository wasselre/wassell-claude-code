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
//
// FEW FAT QUERIES, not many small ones. Measured against the public mirrors: one bbox
// survey query costs 100–375s wall clock including 504 retries, and that cost is
// dominated by per-request overhead — Overpass walks the bbox index and the member
// ways regardless of how many tag filters ride along. Twenty-four separate queries
// projected to ~2.5 hours; the same coverage in six is minutes. The responses stay
// small because `out tags center;` emits no geometry (pass B fetches that by id).
//
// Still grouped rather than one single query, so a 504 on the roads group doesn't cost
// the admin group — each group caches independently and the run is resumable.
//
// Admin levels vary by emirate (surveyed live 2026-07-30): 4 = the 7 emirates,
// 5/6 = Abu Dhabi's city region and its three regions, 7 = Dubai's rural sectors,
// 8 = the community tier (374), 10 = sub-communities (129), 9 = unused. All of 4..10
// come back in one request and process-admin.mjs decides which tier each lands in.
const SURVEY_GROUPS = {
  'survey-admin-all': `relation[boundary=administrative][admin_level~"^(4|5|6|7|8|9|10)$"];`,

  // Named places: the settlement tier (city/town/village) and the district tier. The
  // UAE's district tier is mapped predominantly as place=suburb / neighbourhood (Dubai
  // "communities"), frequently WITHOUT an administrative relation — that is the long
  // tail of names buyers actually use. landuse=residential supplies a fallback
  // boundary where a community exists only as a point.
  'survey-places': `nwr[place~"^(city|town|village|suburb|neighbourhood|quarter|city_block)$"][name];`
    + `nwr[landuse=residential][name];`,

  // Anchors in groups by expected volume, so the heaviest class can't sink the rest.
  //
  // `secondary` is deliberately EXCLUDED. Measured over the UAE bbox: motorway 2,340 +
  // trunk 4,638 + primary 7,190 = 14,168 ways carrying 452 distinct road names, which
  // is the same order as Riyadh's 191 road anchors — while secondary alone adds 9,424
  // ways for anchors nobody describes a property by. Riyadh's dataset drew the line in
  // the same place (roads_major = motorway/trunk/primary, plus ring_roads).
  'survey-anchor-roads': `way[highway~"^(motorway|trunk|primary)$"][name];`,

  'survey-anchor-transit': `relation[route~"^(subway|light_rail|monorail|tram)$"];`
    + `nwr[railway=station];nwr[station~"^(subway|light_rail|monorail)$"];nwr[railway=tram_stop][name];`
    + `nwr[aeroway=aerodrome][name];nwr[amenity=bus_station][name];nwr[amenity=ferry_terminal][name];`,

  // Destinations were originally one group and it exhausted all 8 retries against
  // every mirror — too many `nwr` clauses in one request. Split three ways. The
  // splitting axis is request weight, not meaning; process-anchors.mjs assigns the
  // category per element from its tags, so regrouping never changes the output.
  'survey-anchor-retail': `nwr[shop=mall];nwr[shop=department_store][name];`
    + `nwr[amenity~"^(university|college)$"][name];`
    + `nwr[amenity=hospital][name];nwr[healthcare=hospital][name];`,

  'survey-anchor-leisure': `nwr[leisure~"^(park|garden|water_park|beach_resort|marina|golf_course)$"][name];`
    + `nwr[natural=beach][name];`,

  // `islands` is the one category added to Riyadh's 13: in the UAE the master-planned
  // islands (Palm Jumeirah, Yas, Saadiyat, Al Reem, Al Maryah) are primary real-estate
  // anchors, not scenery.
  'survey-anchor-landmarks': `nwr[tourism~"^(attraction|museum|theme_park|zoo|aquarium)$"][name];`
    + `nwr[man_made=tower][name];nwr[historic][name];`
    + `nwr[place=island][name];`,

  // Commercial/industrial land and free zones — the UAE's answer to KAFD.
  'survey-anchor-zones': `nwr[landuse~"^(commercial|industrial)$"][name];`
    + `nwr[name~"[Ff]ree [Zz]one"];nwr["name:en"~"[Ff]ree [Zz]one"];`,
};

async function survey() {
  console.log('\n── pass A: survey (tags + centroid, bbox-scoped) ──');
  for (const [name, selector] of Object.entries(SURVEY_GROUPS)) {
    await cached(name, () =>
      overpass(bboxQuery(selector, 'out tags center;'), { label: name, attempts: 8 }));
  }
}

// ── pass B: geometry for an explicit id list ────────────────────────────────
// Relations stay small — `out geom;` on a boundary relation expands every member way,
// which is what 504s. Plain ways are cheap by comparison (~700 KB per 800), and roads
// alone are 14,168 ways: at 200 per request that would be 71 round trips against
// mirrors that take minutes each.
const CHUNK = { relation: 40, way: 800, node: 800 };

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
    console.log('  (no geometry-plan.json — run the process scripts first)');
    return;
  }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const failed = [];
  for (const [batch, byType] of Object.entries(plan)) {
    for (const [osmType, ids] of Object.entries(byType)) {
      if (!Array.isArray(ids) || !ids.length) continue;
      const size = CHUNK[osmType] ?? 100;
      for (let i = 0; i < ids.length; i += size) {
        const slice = ids.slice(i, i + size);
        const name = `geom-${batch}-${osmType}-${String(Math.floor(i / size)).padStart(3, '0')}`;
        try {
          await cached(name, () =>
            overpass(`[out:json][timeout:${TIMEOUT}];${osmType}(id:${slice.join(',')});out geom;`,
              { label: name, attempts: 10 }),
          );
        } catch (err) {
          // A chunk that won't fetch must NOT abort the run. Geometry is an
          // enhancement: a district with no polygon keeps its centroid and still works
          // everywhere except containment, and the app already handles that (the Saudi
          // layer has 3,733 boundaries for 3,734 districts). Sibling chunks succeeded
          // where this one didn't, so the cause is usually one pathological relation
          // rather than load — and grinding the whole run to a halt over it would cost
          // every other boundary. Reported loudly, cached files untouched, so a re-run
          // retries ONLY what is missing.
          console.error(`  ✗ ${name}: giving up after 10 attempts — ${err.message}`);
          failed.push({ name, osmType, count: slice.length });
        }
      }
    }
  }
  if (failed.length) {
    const missing = failed.reduce((n, f) => n + f.count, 0);
    console.error(`\n  ${failed.length} chunk(s) failed — ${missing} element(s) have no geometry this run:`);
    for (const f of failed) console.error(`    ${f.name} (${f.count} ${f.osmType}s)`);
    console.error('  Re-run `fetch.mjs geometry` later; cached chunks are skipped, so only these are retried.');
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
