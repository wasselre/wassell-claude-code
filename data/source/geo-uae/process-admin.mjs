#!/usr/bin/env node
/**
 * Classify the raw OSM survey into the UAE's region → city → district tiers.
 *
 *   node data/source/geo-uae/process-admin.mjs
 *
 * Reads ONLY from `raw/` (never the network). Two-phase by design:
 *
 *   run 1 — no district geometry cached yet. Classifies everything, then writes
 *           `geometry-plan.json` naming the OSM ids whose boundaries are worth
 *           fetching. Run `fetch.mjs geometry` next.
 *   run 2 — district geometry present. Same classification (deterministic), plus
 *           real boundary polygons attached, and writes the deliverables.
 *
 * The Saudi layer arrived pre-tiered (SPL gave us region_id/city_id/district_id on
 * every row). OSM gives a flat bag, so the tiering is DERIVED here — and every
 * derivation is reported in `report-admin.md` rather than silently trusted, because
 * a district attached to the wrong city vanishes from the cascade (the district list
 * is filtered by city_lookup).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { elementGeometry, representativePoint, geomKind, coordCount } from './lib/overpass.mjs';
import {
  normalizeAr, normalizeEn, stripHayy, stripEmirate, stripEmirateAr,
  pointInGeometry, bboxOf, haversineKm, locateEmirate, nearestCity,
  isMappingArtifactName, nameAr, nameEn, extId,
} from './lib/classify.mjs';
import { EMIRATES } from './lib/emirates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');
const OUT = HERE;

const readRaw = (name) => {
  const p = join(RAW, `${name}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
};
const elementsOf = (name) => readRaw(name)?.elements ?? [];

const warn = [];
const note = (msg) => { warn.push(msg); console.warn(`  ! ${msg}`); };

// ── 1. regions = the 7 emirates (with polygons, for containment) ─────────────
console.log('── regions (emirates) ──');
const regions = [];
for (const em of EMIRATES) {
  const els = elementsOf(`geom-emirate-${em.code}`);
  const rel = els.find((e) => e.type === 'relation' && e.id === em.osm_id);
  if (!rel) { note(`emirate ${em.code}: no cached polygon (raw/geom-emirate-${em.code}.json missing) — containment will fall back to bbox`); }
  const geometry = rel ? elementGeometry(rel) : null;
  const centroid = representativePoint(geometry, rel);
  regions.push({
    region_id: `AE-${em.code}`,
    code: em.code,
    osm_id: em.osm_id,
    name_ar: stripEmirateAr((rel && nameAr(rel.tags)) || em.name_ar),
    name_en: stripEmirate((rel && nameEn(rel.tags)) || em.name_en),
    geometry,
    bbox: bboxOf(geometry),
    centroid,
    coord_count: coordCount(geometry),
  });
  console.log(`  ${em.code}: ${regions.at(-1).name_en} / ${regions.at(-1).name_ar} — ${coordCount(geometry)} coords`);
}
const withPoly = regions.filter((r) => r.geometry);
if (!withPoly.length) {
  console.error('No emirate polygons at all — run `node data/source/geo-uae/fetch.mjs emirates` first.');
  process.exit(1);
}

// The UAE national boundary — the gate that keeps foreign enclaves out. Without it a
// point in Al Buraimi, Oman lands inside Abu Dhabi's bounding box beside Al Ain and
// gets filed as an Abu Dhabi district.
const countryRel = elementsOf('geom-country-AE').find((e) => e.type === 'relation');
const countryGeom = countryRel ? elementGeometry(countryRel) : null;
if (!countryGeom) note('no UAE country polygon cached (raw/geom-country-AE.json) — inter-emirate seam points will be dropped instead of assigned, and only points within 3 km of an emirate edge are kept');
console.log(`  country polygon: ${countryGeom ? `${countryGeom.type}, ${coordCount(countryGeom)} coords` : 'MISSING'}`);

/** Emirate for a point, or null when it lands outside the UAE (Oman/Saudi spill). */
const emirateOf = (point) => locateEmirate(point, withPoly, { country: countryGeom })?.emirate ?? null;

// ── 2. collect every candidate place ────────────────────────────────────────
// Each candidate keeps its provenance so the report can explain where a name came
// from and so dedup can prefer the richer source.
/** OSM element → candidate. `kind` is set per element from its tags, not per file,
 *  because the survey now arrives as a few fat grouped responses. */
function candidatesFrom(name) {
  return elementsOf(name).map((el) => {
    const tags = el.tags ?? {};
    const admin_level = tags.admin_level ? Number(tags.admin_level) : null;
    const source_kind =
      tags.boundary === 'administrative' && admin_level ? `admin-${admin_level}`
      : tags.place ? 'place'
      : tags.landuse === 'residential' ? 'landuse'
      : 'other';
    return {
      osm: `${el.type}/${el.id}`,
      osm_type: el.type,
      osm_id: el.id,
      source_kind,
      admin_level,
      place: tags.place ?? null,
      name: tags.name ?? '',
      name_ar: nameAr(tags),
      name_en: nameEn(tags),
      point: representativePoint(null, el),
      tags,
    };
  }).filter((c) => c.point && (c.name_ar || c.name_en || c.name));
}

const adminAll = candidatesFrom('survey-admin-all').filter((c) => c.admin_level);
const placesAll = candidatesFrom('survey-places');
// The settlement tier and the district tier come back in one response; split by tag.
const SETTLEMENT_PLACES = new Set(['city', 'town', 'village']);
const DISTRICT_PLACES = new Set(['suburb', 'neighbourhood', 'quarter', 'city_block']);
const admin = adminAll;
const settlements = placesAll.filter((c) => SETTLEMENT_PLACES.has(c.place));
const placeDistricts = placesAll.filter((c) => DISTRICT_PLACES.has(c.place));
const residential = placesAll.filter((c) => !c.place && c.tags.landuse === 'residential');

console.log(`\n── candidates ──`);
console.log(`  admin relations: ${admin.length} (levels ${[...new Set(admin.map((a) => a.admin_level))].sort((a, b) => a - b).join(', ')})`);
console.log(`  place=city|town|village: ${settlements.length}`);
console.log(`  place=suburb|neighbourhood|quarter: ${placeDistricts.length}`);
console.log(`  landuse=residential (named): ${residential.length}`);

// Stamp the emirate on every candidate; anything outside the UAE is dropped here.
let outsideUae = 0;
const stamp = (list) => list.filter((c) => {
  const em = emirateOf(c.point);
  if (!em) { outsideUae++; return false; }
  c.emirate_code = em.code;
  c.region_id = em.region_id;
  return true;
});
const adminIn = stamp(admin);
const settleIn = stamp(settlements);
const placeDistIn = stamp(placeDistricts);
const residIn = stamp(residential);
console.log(`  dropped (outside every emirate polygon): ${outsideUae}`);

// ── 3. cities ───────────────────────────────────────────────────────────────
// The city tier is the named settlements: place=city|town, plus place=village where
// it is the only settlement in its emirate's reach. Villages are otherwise excluded —
// there are hundreds and they would swamp a dropdown whose job is "pick your city".
console.log('\n── cities ──');
const CITY_PLACES = new Set(['city', 'town']);
const cityCands = settleIn.filter((c) => CITY_PLACES.has(c.place));

// Dedupe by (emirate, normalized name), preferring the richer record: an OSM
// relation/way over a bare node, and a bilingual name over a monolingual one.
const score = (c) =>
  (c.osm_type === 'relation' ? 4 : c.osm_type === 'way' ? 2 : 0) +
  (c.name_ar ? 1 : 0) + (c.name_en ? 1 : 0) +
  (c.place === 'city' ? 2 : 0);

function dedupe(list, keyFn) {
  const best = new Map();
  const dropped = [];
  for (const c of list) {
    const k = keyFn(c);
    const cur = best.get(k);
    if (!cur || score(c) > score(cur)) { if (cur) dropped.push(cur); best.set(k, c); }
    else dropped.push(c);
  }
  return { kept: [...best.values()], dropped };
}

const cityDedup = dedupe(cityCands, (c) => `${c.emirate_code}|${normalizeAr(c.name_ar) || normalizeEn(c.name_en)}`);
const cities = cityDedup.kept
  .sort((a, b) => a.emirate_code.localeCompare(b.emirate_code) || (a.name_en || '').localeCompare(b.name_en || ''))
  .map((c, i) => ({
    city_id: extId(c.emirate_code, 'C', i + 1),
    region_id: c.region_id,
    emirate_code: c.emirate_code,
    name_ar: c.name_ar || '',
    name_en: c.name_en || '',
    display_name: c.name_ar || c.name_en,
    point: c.point,
    osm: c.osm,
    place: c.place,
  }));
for (const em of regions) {
  const n = cities.filter((c) => c.emirate_code === em.code).length;
  console.log(`  ${em.code}: ${n} cities`);
  if (n === 0) note(`emirate ${em.code} has NO city — its districts would have no parent; a principal city is synthesised below`);
}

/**
 * Every emirate must own at least one city or its districts become unreachable in
 * the cascade. Where OSM has no place=city|town inside an emirate, synthesise one
 * from the emirate itself (which is how people speak anyway — "Ajman" is both).
 */
for (const em of regions) {
  if (cities.some((c) => c.emirate_code === em.code)) continue;
  cities.push({
    city_id: extId(em.code, 'C', 999),
    region_id: em.region_id,
    emirate_code: em.code,
    name_ar: em.name_ar,
    name_en: em.name_en,
    display_name: em.name_ar,
    point: em.centroid,
    osm: `relation/${em.osm_id}`,
    place: 'synthesised-from-emirate',
    synthesised: true,
  });
  console.log(`  ${em.code}: synthesised principal city ${em.name_en}`);
}

/** The emirate's principal city: place=city if present, else the first town. */
const principalCity = new Map();
for (const em of regions) {
  const own = cities.filter((c) => c.emirate_code === em.code);
  principalCity.set(em.code,
    own.find((c) => normalizeAr(c.name_ar) === normalizeAr(em.name_ar)) ??
    own.find((c) => c.place === 'city') ?? own[0]);
}

// ── 4. districts ────────────────────────────────────────────────────────────
// Sources, in preference order:
//   admin_level 8   — the community/sector tier (the bulk of it)
//   admin_level 10  — sub-communities and named villages inside a community
//   admin_level 7   — Dubai's rural sectors
//   place=suburb|neighbourhood|quarter — the long tail, usually point-only
//   landuse=residential — a named boundary where the suburb is only a point
//
// admin_level 8 also holds actual TOWNS (Kalba, Khor Fakkan). Anything whose name
// matches a city is dropped from the district tier: keeping it would give the
// cascade a "Kalba" district inside the "Kalba" city.
console.log('\n── districts ──');
const cityNameKeys = new Set(cities.flatMap((c) => [
  `${c.emirate_code}|${normalizeAr(c.name_ar)}`,
  `${c.emirate_code}|${normalizeEn(c.name_en)}`,
].filter((k) => !k.endsWith('|'))));

const DISTRICT_ADMIN_LEVELS = new Set([7, 8, 10]);
const districtCands = [
  ...adminIn.filter((c) => DISTRICT_ADMIN_LEVELS.has(c.admin_level)),
  ...placeDistIn,
  ...residIn,
];

let asCity = 0;
let asArtifact = 0;
const districtPool = districtCands.filter((c) => {
  const kAr = `${c.emirate_code}|${normalizeAr(c.name_ar)}`;
  const kEn = `${c.emirate_code}|${normalizeEn(c.name_en)}`;
  const isCity = (c.name_ar && cityNameKeys.has(kAr)) || (c.name_en && cityNameKeys.has(kEn));
  if (isCity) { asCity++; return false; }
  // OSM mapping artifacts — plot numbers and site descriptions carried on
  // landuse=residential polygons. These would reach a customer-facing dropdown.
  if (isMappingArtifactName(c.name_en, c.name_ar)) { asArtifact++; return false; }
  return true;
});
console.log(`  candidates: ${districtCands.length} → ${districtPool.length} (dropped ${asCity} naming a city, ${asArtifact} mapping artifacts)`);

// Rank sources so dedup keeps the one that can carry a real boundary.
const SOURCE_RANK = { 'admin-8': 60, 'admin-10': 50, 'admin-7': 45, landuse: 30, place: 20 };
const dScore = (c) =>
  (SOURCE_RANK[c.source_kind] ?? 10) +
  (c.osm_type === 'relation' ? 8 : c.osm_type === 'way' ? 4 : 0) +
  (c.name_ar ? 2 : 0) + (c.name_en ? 2 : 0);

const dedupDistricts = (() => {
  const best = new Map();
  const dropped = [];
  for (const c of districtPool) {
    // Key on the emirate + normalized name. Two same-named communities in one
    // emirate genuinely happen (Al Nahda in Sharjah and Dubai) but not within one
    // emirate, and collapsing them is far better than showing duplicates.
    const k = `${c.emirate_code}|${normalizeAr(c.name_ar) || normalizeEn(c.name_en)}`;
    const cur = best.get(k);
    if (!cur || dScore(c) > dScore(cur)) { if (cur) dropped.push(cur); best.set(k, c); }
    else dropped.push(c);
  }
  return { kept: [...best.values()], dropped };
})();
console.log(`  after dedup: ${dedupDistricts.kept.length} (merged ${dedupDistricts.dropped.length} duplicates)`);

// City assignment: nearest place=city in the SAME emirate, else the nearest town,
// else the emirate's principal city. See nearestCity for why cities outrank towns.
let byCity = 0, byTown = 0, byPrincipal = 0;
const districts = dedupDistricts.kept
  .sort((a, b) => a.emirate_code.localeCompare(b.emirate_code) ||
                  (a.name_ar || a.name_en).localeCompare(b.name_ar || b.name_en, 'ar'))
  .map((c, i) => {
    const hit = nearestCity(c.point, cities, c.emirate_code);
    const city = hit?.city ?? principalCity.get(c.emirate_code);
    if (hit?.tier === 'city') byCity++; else if (hit) byTown++; else byPrincipal++;
    return {
      district_id: extId(c.emirate_code, 'D', i + 1),
      city_id: city?.city_id ?? null,
      region_id: c.region_id,
      emirate_code: c.emirate_code,
      name_ar: c.name_ar || '',
      name_en: c.name_en || '',
      display_name: stripHayy(c.name_ar || c.name_en),
      centroid_lng: c.point[0],
      centroid_lat: c.point[1],
      city_distance_km: hit ? Math.round(hit.km * 100) / 100 : null,
      city_assignment: hit ? `nearest_${hit.tier}` : 'emirate_principal_city',
      osm: c.osm,
      osm_type: c.osm_type,
      osm_id: c.osm_id,
      source_kind: c.source_kind,
      admin_level: c.admin_level,
      place: c.place,
    };
  });
console.log(`  city assignment: ${byCity} nearest place=city, ${byTown} nearest town, ${byPrincipal} fell back to the principal city`);

// ── 4b. prune cities that would be dead ends in the cascade ─────────────────
//
// Pruned AFTER district assignment, never before: every settlement has to stay a
// candidate for "nearest city", and a town that actually won districts is kept by the
// first clause below.
//
// OSM tags dozens of UAE hamlets as `place=town`, which is why the raw city tier is 152
// (59 in Abu Dhabi alone) while only 37 hold a district. A city dropdown of 152 entries
// where 114 lead to an empty district list is worse than useless. Keep a city if it
// holds districts, OR is a real `place=city`, OR was synthesised as an emirate's
// principal city. That is the same line the Saudi layer drew — its 152 cities are
// "district-bearing only" — and it keeps every genuine city plus district-bearing towns
// like Al Ruwais, Ghayathi and Dalma.
const citiesWithDistricts = new Set(districts.map((d) => d.city_id));
const keptCities = cities.filter((c) => citiesWithDistricts.has(c.city_id) || c.place === 'city' || c.synthesised);
const prunedCities = cities.length - keptCities.length;
console.log(`\n── cities pruned ──`);
console.log(`  ${cities.length} → ${keptCities.length} (dropped ${prunedCities} with no districts and no place=city tag)`);

// A district pointing at a pruned city would be invisible in the cascade. The keep-rule
// makes that impossible, so assert it rather than trusting the reasoning.
const keptIds = new Set(keptCities.map((c) => c.city_id));
const orphaned = districts.filter((d) => !keptIds.has(d.city_id));
if (orphaned.length) {
  console.error(`\nFATAL: ${orphaned.length} district(s) point at a pruned city — e.g. ${orphaned[0].name_en || orphaned[0].name_ar} → ${orphaned[0].city_id}`);
  process.exit(1);
}
for (const em of regions) {
  if (!keptCities.some((c) => c.emirate_code === em.code)) {
    console.error(`\nFATAL: emirate ${em.code} has no city left after pruning`);
    process.exit(1);
  }
}
cities.length = 0;
cities.push(...keptCities);

// ── 5. boundaries (run 2) ───────────────────────────────────────────────────
// Districts mapped as a relation or a closed way can carry a real polygon. Nodes
// cannot — they keep their exact point and no boundary, which is honest: the Saudi
// layer has 3,733 boundaries for 3,734 districts and the app already handles a
// district with a centroid but no polygon.
const geomFiles = existsSync(RAW) ? readdirSync(RAW).filter((f) => /^geom-districts-/.test(f)) : [];
const geomById = new Map();
for (const f of geomFiles) {
  for (const el of JSON.parse(readFileSync(join(RAW, f), 'utf8')).elements ?? []) {
    geomById.set(`${el.type}/${el.id}`, el);
  }
}
console.log(`\n── boundaries ──`);
console.log(`  cached geometry files: ${geomFiles.length} (${geomById.size} elements)`);

const boundaries = [];
let polyCount = 0, lineOnly = 0, noGeom = 0;
for (const d of districts) {
  const el = geomById.get(d.osm);
  if (!el) { noGeom++; continue; }
  const g = elementGeometry(el);
  const kind = geomKind(g);
  if (!g) { noGeom++; continue; }
  if (kind !== 'polygon') { lineOnly++; continue; }
  // Re-derive the centroid from the real polygon — it is a better representative
  // point than the survey's bbox centre.
  const c = representativePoint(g, el);
  if (c) { d.centroid_lng = c[0]; d.centroid_lat = c[1]; }
  d.geometry_type = g.type;
  d.coord_count = coordCount(g);
  boundaries.push({ district_id: d.district_id, city_id: d.city_id, region_id: d.region_id, geometry: g, geometry_type: g.type });
  polyCount++;
}
console.log(`  polygons: ${polyCount} · line-only (skipped): ${lineOnly} · no geometry: ${noGeom}`);

// ── 6. geometry plan for pass B ─────────────────────────────────────────────
const planPath = join(OUT, 'geometry-plan.json');
const plan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : {};
plan.districts = {
  relation: districts.filter((d) => d.osm_type === 'relation').map((d) => d.osm_id),
  way: districts.filter((d) => d.osm_type === 'way').map((d) => d.osm_id),
};
writeFileSync(planPath, JSON.stringify(plan, null, 2));
console.log(`\n  geometry-plan.json → districts: ${plan.districts.relation.length} relations, ${plan.districts.way.length} ways`);

// ── 7. deliverables ─────────────────────────────────────────────────────────
const payload = {
  generated_at: new Date().toISOString(),
  source: 'OpenStreetMap via Overpass API (© OpenStreetMap contributors, ODbL)',
  country: { iso_code: 'AE', name_ar: 'الإمارات العربية المتحدة', name_en: 'United Arab Emirates' },
  regions: regions.map(({ geometry, bbox, ...r }) => r),
  cities,
  districts,
  counts: {
    regions: regions.length,
    cities: cities.length,
    districts: districts.length,
    boundaries: boundaries.length,
  },
};
writeFileSync(join(OUT, 'uae-geography.json'), JSON.stringify(payload, null, 1));
writeFileSync(join(OUT, 'uae-district-boundaries.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  features: boundaries.map((b) => ({
    type: 'Feature',
    properties: { district_id: b.district_id, city_id: b.city_id, region_id: b.region_id },
    geometry: b.geometry,
  })),
}));

const byEmirate = regions.map((r) => ({
  code: r.code,
  name: r.name_en,
  cities: cities.filter((c) => c.emirate_code === r.code).length,
  districts: districts.filter((d) => d.emirate_code === r.code).length,
  boundaries: boundaries.filter((b) => b.region_id === r.region_id).length,
}));

const md = [
  '# UAE administrative geography — build report',
  '',
  `- Generated: ${payload.generated_at}`,
  `- Source: OpenStreetMap via Overpass (© OpenStreetMap contributors, ODbL)`,
  `- **Regions (emirates): ${payload.counts.regions} · Cities: ${payload.counts.cities} · Districts: ${payload.counts.districts} · Boundaries: ${payload.counts.boundaries}**`,
  '',
  '## Per emirate',
  '',
  '| code | emirate | cities | districts | with boundary |',
  '|------|---------|-------:|----------:|--------------:|',
  ...byEmirate.map((e) => `| ${e.code} | ${e.name} | ${e.cities} | ${e.districts} | ${e.boundaries} |`),
  '',
  '## District sources',
  '',
  ...Object.entries(districts.reduce((a, d) => { a[d.source_kind] = (a[d.source_kind] || 0) + 1; return a; }, {}))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- \`${k}\`: ${v}`),
  '',
  '## Derivations (not source data — verify these)',
  '',
  `- City assignment (cap 60 km, same emirate): **${byCity}** to the nearest \`place=city\`, **${byTown}** to the nearest town (no city in range), **${byPrincipal}** fell back to the emirate's principal city.`,
  `- Dropped **${outsideUae}** candidates whose centroid fell outside every emirate polygon (bbox spill into Oman/Saudi).`,
  `- Dropped **${asCity}** district candidates whose name matches a city in the same emirate.`,
  `- Dropped **${asArtifact}** OSM mapping artifacts (leading plot numbers, "under construction", building counts).`,
  `- Pruned **${prunedCities}** cities that hold no district and carry no \`place=city\` tag — OSM tags UAE hamlets as towns, and they would be dead ends in the cascade's city step.`,
  `- Merged **${dedupDistricts.dropped.length}** duplicate district candidates (same emirate + normalized name).`,
  `- Districts with no polygon: **${districts.length - boundaries.length}** (point-only in OSM, or geometry not yet fetched).`,
  '',
  '## Warnings',
  '',
  ...(warn.length ? warn.map((w) => `- ${w}`) : ['- none']),
  '',
  '## Names missing a language',
  '',
  `- No Arabic name: ${districts.filter((d) => !d.name_ar).length} districts, ${cities.filter((c) => !c.name_ar).length} cities`,
  `- No English name: ${districts.filter((d) => !d.name_en).length} districts, ${cities.filter((c) => !c.name_en).length} cities`,
  '',
].join('\n');
writeFileSync(join(OUT, 'report-admin.md'), md);

console.log(`\n${payload.counts.regions} regions · ${payload.counts.cities} cities · ${payload.counts.districts} districts · ${payload.counts.boundaries} boundaries`);
console.log(`→ uae-geography.json, uae-district-boundaries.geojson, report-admin.md`);
if (!geomFiles.length) console.log(`\nNEXT: node data/source/geo-uae/fetch.mjs geometry  (then re-run this script)`);
