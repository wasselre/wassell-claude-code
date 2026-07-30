#!/usr/bin/env node
/**
 * Normalize the raw OSM survey into the UAE geo-intelligence anchor dataset.
 *
 *   node data/source/geo-uae/process-anchors.mjs
 *
 * Output schema is BYTE-COMPATIBLE with the Riyadh dataset
 * (`data/source/geo/riyadh-geo-intelligence.json`) so `wassell_import_geo_elements`
 * consumes it with no SQL change: id, name_ar, name_en, category, type, country,
 * region, city, latitude, longitude, geometry_type, geometry_geojson, source_url,
 * source_type, confidence_score, is_verified, is_approximate, notes.
 *
 * Two-phase like process-admin.mjs: run 1 classifies and writes the geometry plan,
 * run 2 attaches the real geometry fetched by `fetch.mjs geometry`.
 *
 * Categories stay deliberately close to Riyadh's 13 so the admin map's colour legend
 * keeps working. Exactly one is added — `islands` — because in the UAE the
 * master-planned islands (Palm Jumeirah, Yas, Saadiyat, Al Reem, Al Maryah) are
 * primary real-estate anchors, not scenery. Free zones fold into `business_zones`
 * with `type='free_zone'` rather than earning a category of their own.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { elementGeometry, representativePoint, geomKind, coordCount } from './lib/overpass.mjs';
import { normalizeAr, normalizeEn, bboxOf, locateEmirate, nearestCity, nameAr, nameEn } from './lib/classify.mjs';
import { EMIRATES } from './lib/emirates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = join(HERE, 'raw');

const readRaw = (n) => { const p = join(RAW, `${n}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
const elementsOf = (n) => readRaw(n)?.elements ?? [];

// ── emirate polygons (for the region/city stamp + rejecting bbox spill) ─────
const regions = EMIRATES.map((em) => {
  const rel = elementsOf(`geom-emirate-${em.code}`).find((e) => e.type === 'relation' && e.id === em.osm_id);
  const geometry = rel ? elementGeometry(rel) : null;
  return {
    code: em.code, region_id: `AE-${em.code}`,
    name_ar: em.name_ar, name_en: em.name_en,
    geometry, bbox: bboxOf(geometry), centroid: representativePoint(geometry, rel),
  };
}).filter((r) => r.geometry);
if (!regions.length) { console.error('No emirate polygons — run `fetch.mjs emirates` first.'); process.exit(1); }

// The UAE national boundary — see process-admin.mjs; it is what rejects Al Buraimi
// (Oman) instead of filing it under Abu Dhabi.
const countryRel = elementsOf('geom-country-AE').find((e) => e.type === 'relation');
const countryGeom = countryRel ? elementGeometry(countryRel) : null;
if (!countryGeom) console.warn('  ! no UAE country polygon cached — anchors in an inter-emirate seam will be dropped');

// Cities, so each anchor can carry the city name the Riyadh schema expects.
const geoPath = join(HERE, 'uae-geography.json');
const cities = existsSync(geoPath) ? JSON.parse(readFileSync(geoPath, 'utf8')).cities ?? [] : [];
if (!cities.length) console.warn('  ! uae-geography.json has no cities — run process-admin.mjs first; anchors will fall back to the emirate name');

/**
 * category/type resolution from OSM tags. Order matters: the first rule that
 * matches wins, so the specific tags come before the generic ones.
 */
const CLASSIFIERS = [
  // transport network
  [(t) => t.route === 'subway', 'metro_lines', 'metro_line'],
  [(t) => t.route === 'light_rail', 'metro_lines', 'light_rail_line'],
  [(t) => t.route === 'monorail', 'metro_lines', 'monorail_line'],
  [(t) => t.route === 'tram', 'metro_lines', 'tram_line'],
  [(t) => t.railway === 'tram_stop', 'metro_stations', 'tram_stop'],
  [(t) => t.station === 'subway' || (t.railway === 'station' && t.subway === 'yes'), 'metro_stations', 'metro_station'],
  [(t) => t.station === 'monorail' || t.monorail === 'yes', 'metro_stations', 'monorail_station'],
  [(t) => t.station === 'light_rail' || t.light_rail === 'yes', 'metro_stations', 'light_rail_station'],
  [(t) => t.railway === 'station', 'metro_stations', 'train_station'],
  [(t) => t.aeroway === 'aerodrome', 'airports_transport', 'airport'],
  [(t) => t.amenity === 'bus_station', 'airports_transport', 'bus_station'],
  [(t) => t.amenity === 'ferry_terminal', 'airports_transport', 'ferry_terminal'],
  // roads — ring roads split out to match the Riyadh category set
  [(t) => t.highway && /ring\s*road|الدائري/i.test(t.name ?? ''), 'ring_roads', 'ring_road'],
  [(t) => t.highway === 'motorway', 'roads_major', 'highway'],
  [(t) => t.highway === 'trunk' || t.highway === 'primary', 'roads_major', 'arterial_road'],
  // No `secondary` rule on purpose — see fetch.mjs SURVEY_GROUPS. Any secondary way
  // still sitting in an older cached survey falls through to `unclassified` and is
  // counted in the report rather than silently becoming an anchor.
  // retail / institutions
  [(t) => t.shop === 'mall', 'malls', 'mall'],
  [(t) => t.shop === 'department_store', 'malls', 'department_store'],
  [(t) => t.amenity === 'university', 'universities', 'university'],
  [(t) => t.amenity === 'college', 'universities', 'college'],
  [(t) => t.amenity === 'hospital' || t.healthcare === 'hospital', 'hospitals', 'hospital'],
  // green + leisure
  [(t) => t.leisure === 'park', 'parks', 'park'],
  [(t) => t.leisure === 'garden', 'parks', 'garden'],
  [(t) => t.tourism === 'theme_park', 'lifestyle', 'theme_park'],
  [(t) => t.leisure === 'water_park', 'lifestyle', 'water_park'],
  [(t) => t.leisure === 'marina', 'lifestyle', 'marina'],
  [(t) => t.leisure === 'golf_course', 'lifestyle', 'golf_course'],
  [(t) => t.leisure === 'beach_resort' || t.natural === 'beach', 'lifestyle', 'beach'],
  // landmarks
  [(t) => t.tourism === 'museum', 'landmarks', 'museum'],
  [(t) => t.man_made === 'tower', 'landmarks', 'tower'],
  [(t) => t.historic, 'landmarks', 'historic_site'],
  [(t) => t.tourism === 'zoo' || t.tourism === 'aquarium', 'landmarks', 'attraction'],
  [(t) => t.tourism === 'attraction', 'landmarks', 'landmark'],
  // zones. Free zones are the UAE's answer to KAFD — the single most-cited
  // commercial anchor class — so they get their own `type` inside business_zones.
  [(t) => /free\s*zone|المنطقة الحرة|منطقة حرة/i.test(`${t.name ?? ''} ${t['name:en'] ?? ''} ${t['name:ar'] ?? ''}`), 'business_zones', 'free_zone'],
  [(t) => t.landuse === 'commercial', 'business_zones', 'commercial_zone'],
  // "near Al Quoz Industrial" is genuinely how Dubai property gets described, so
  // industrial land stays. `office=government` does NOT — it contributed 499 anchors
  // nobody locates a home by, and every one of them would show up in the client-facing
  // element search.
  [(t) => t.landuse === 'industrial', 'business_zones', 'industrial_zone'],
  // Islands: only `place=island`. `place=islet` added 227 natural sandbars — the
  // anchors that matter are the master-planned developments (Palm Jumeirah, Yas,
  // Saadiyat, Al Reem, Al Maryah, Bluewaters), and OSM tags every one of those as
  // `island`.
  [(t) => t.place === 'island', 'islands', 'island'],
];

function classify(tags) {
  for (const [test, category, type] of CLASSIFIERS) {
    try { if (test(tags)) return { category, type }; } catch { /* a missing tag is a non-match, not an error */ }
  }
  return null;
}

/**
 * Confidence, mirroring the Riyadh scale so a rule written against one dataset means
 * the same thing against the other:
 *   0.90+  polygon POI or exact point POI
 *   0.80   lines and most points
 *   0.60   generic commercial/industrial landuse (named after its occupant)
 *   +0.05  the element carries a Wikidata id
 * The matcher's CONFIDENCE_FLOOR is 0.5, so nothing here is auto-disqualified —
 * `is_approximate` is what flags weak geometry.
 */
function confidence({ category, type }, kind, tags, segments) {
  let c = 0.8;
  if (kind === 'polygon') c = 0.9;
  else if (kind === 'point') c = category === 'metro_stations' ? 0.9 : 0.85;
  if (type === 'commercial_zone' || type === 'industrial_zone') c = 0.6;
  if (segments > 8) c = Math.min(c, 0.75);
  if (tags.wikidata) c = Math.min(1, c + 0.05);
  return Math.round(c * 100) / 100;
}

// ── collect + group ─────────────────────────────────────────────────────────
// The survey arrives as four grouped responses (see fetch.mjs SURVEY_GROUPS); the
// per-element category comes from CLASSIFIERS below, not from which file it was in.
const SURVEYS = [
  'survey-anchor-roads', 'survey-anchor-transit', 'survey-anchor-retail',
  'survey-anchor-leisure', 'survey-anchor-landmarks', 'survey-anchor-zones',
];

const raw = [];
const seenOsm = new Set();
let unclassified = 0, outside = 0, unnamed = 0;
for (const s of SURVEYS) {
  for (const el of elementsOf(s)) {
    const key = `${el.type}/${el.id}`;
    if (seenOsm.has(key)) continue; // the same element matches several surveys
    seenOsm.add(key);
    const tags = el.tags ?? {};
    const ar = nameAr(tags), en = nameEn(tags);
    if (!ar && !en) { unnamed++; continue; }
    const cls = classify(tags);
    if (!cls) { unclassified++; continue; }
    const point = representativePoint(null, el);
    if (!point) continue;
    const hit = locateEmirate(point, regions, { country: countryGeom });
    if (!hit) { outside++; continue; }
    raw.push({ osm_type: el.type, osm_id: el.id, tags, ar, en, point, cls, emirate: hit.emirate });
  }
}
console.log(`── anchors ──`);
console.log(`  collected: ${raw.length} (skipped ${unnamed} unnamed, ${unclassified} unclassified, ${outside} outside the UAE)`);

/**
 * Roads arrive as hundreds of individual OSM ways sharing one name. Grouped by
 * (name, emirate) into a single anchor whose geometry is every segment — the same
 * treatment the Riyadh dataset applied, including its honesty flag: a road merged
 * from more than 8 segments is marked `is_approximate` because the merge may join
 * disjoint stretches that happen to share a name.
 */
const LINE_CATEGORIES = new Set(['roads_major', 'ring_roads']);

/**
 * Road grouping is a UNION over BOTH names, not a single key.
 *
 * Keying on one language splits a road whenever OSM disagrees with itself in that
 * language. Measured: 13 of 352 road groups were split, including Sheikh Zayed Road —
 * one segment carries «شارع الشيخ زاي», a typo missing the final د, while every
 * segment's English is identical. Keying on English instead would just move the
 * failure to roads whose English varies.
 *
 * So a segment joins a group if EITHER its normalized Arabic OR its normalized English
 * already belongs to one, and if the two land in different groups those groups merge.
 * Scoped per (category, emirate), so «Corniche Road» in Abu Dhabi and Sharjah stay
 * separate anchors.
 */
function groupRoads(items) {
  const arIndex = new Map();
  const enIndex = new Map();
  const groupsById = new Map();
  let nextId = 0;

  for (const r of items) {
    const scope = `${r.cls.category}|${r.emirate.code}`;
    const arKey = normalizeAr(r.ar) ? `${scope}|ar:${normalizeAr(r.ar)}` : null;
    const enKey = normalizeEn(r.en) ? `${scope}|en:${normalizeEn(r.en)}` : null;
    const hits = [arKey && arIndex.get(arKey), enKey && enIndex.get(enKey)].filter((x) => x != null);

    let gid;
    if (!hits.length) {
      gid = nextId++;
      groupsById.set(gid, { lead: r, members: [] });
    } else {
      gid = hits[0];
      // Both names already known but in DIFFERENT groups → fold the second into the
      // first. This is the case that actually merges the Sheikh Zayed Road halves.
      for (const other of hits.slice(1)) {
        if (other === gid) continue;
        const from = groupsById.get(other);
        if (!from) continue;
        groupsById.get(gid).members.push(...from.members);
        groupsById.delete(other);
        for (const idx of [arIndex, enIndex]) {
          for (const [k, v] of idx) if (v === other) idx.set(k, gid);
        }
      }
    }
    groupsById.get(gid).members.push(r);
    if (arKey) arIndex.set(arKey, gid);
    if (enKey) enIndex.set(enKey, gid);
  }

  // The lead should be the member with the fullest bilingual name, so the anchor isn't
  // titled by the typo'd variant.
  for (const g of groupsById.values()) {
    g.lead = g.members.reduce((best, m) =>
      ((m.ar ? 1 : 0) + (m.en ? 1 : 0) + m.ar.length / 1000) >
      ((best.ar ? 1 : 0) + (best.en ? 1 : 0) + best.ar.length / 1000) ? m : best, g.members[0]);
  }
  return [...groupsById.values()];
}

const groups = new Map();
for (const r of raw.filter((x) => !LINE_CATEGORIES.has(x.cls.category))) {
  groups.set(`${r.osm_type}/${r.osm_id}`, { key: `${r.osm_type}/${r.osm_id}`, lead: r, members: [r] });
}
for (const g of groupRoads(raw.filter((x) => LINE_CATEGORIES.has(x.cls.category)))) {
  groups.set(`road:${g.lead.osm_type}/${g.lead.osm_id}`, { key: `road:${g.lead.osm_id}`, ...g });
}
console.log(`  grouped: ${groups.size} anchors (roads merged by name across both languages, within an emirate)`);

// ── geometry (run 2) ────────────────────────────────────────────────────────
const geomFiles = existsSync(RAW) ? readdirSync(RAW).filter((f) => /^geom-anchors-/.test(f)) : [];
const geomById = new Map();
for (const f of geomFiles) {
  for (const el of JSON.parse(readFileSync(join(RAW, f), 'utf8')).elements ?? []) geomById.set(`${el.type}/${el.id}`, el);
}
console.log(`  cached geometry: ${geomFiles.length} files / ${geomById.size} elements`);

/** Merge several geometries into one; same-type parts collapse into a Multi*. */
function mergeGeometries(geoms) {
  const parts = geoms.filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  const lines = [], polys = [], points = [];
  for (const g of parts) {
    if (g.type === 'LineString') lines.push(g.coordinates);
    else if (g.type === 'MultiLineString') lines.push(...g.coordinates);
    else if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
    else if (g.type === 'Point') points.push(g.coordinates);
  }
  if (polys.length) return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  if (lines.length) return lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines };
  if (points.length) return { type: 'Point', coordinates: points[0] };
  return null;
}

const counters = new Map();
const CAT_ABBR = {
  roads_major: 'ROAD', ring_roads: 'RING', metro_lines: 'METR', metro_stations: 'STAT',
  malls: 'MALL', universities: 'UNIV', hospitals: 'HOSP', airports_transport: 'TRAN',
  parks: 'PARK', landmarks: 'LAND', business_zones: 'BUSI', lifestyle: 'LIFE', islands: 'ISLE',
};

const rows = [];
for (const g of [...groups.values()].sort((a, b) =>
  a.lead.cls.category.localeCompare(b.lead.cls.category) ||
  a.lead.emirate.code.localeCompare(b.lead.emirate.code) ||
  (a.lead.en || a.lead.ar).localeCompare(b.lead.en || b.lead.ar))) {
  const { lead, members } = g;
  const geoms = members.map((m) => {
    const el = geomById.get(`${m.osm_type}/${m.osm_id}`);
    if (el) return elementGeometry(el);
    // A NODE's geometry is its own coordinates — nothing to fetch. The geometry plan
    // only lists relations and ways (they need their member/child geometry expanded),
    // so node-mapped anchors would otherwise arrive with geom NULL and be rejected by
    // the NOT NULL constraint on geo_elements.geom. This is the real OSM geometry, not
    // a synthesised stand-in: metro stations, landmarks and many POIs are legitimately
    // mapped as nodes, and Riyadh's dataset carries 232 such points.
    if (m.osm_type === 'node' && m.point) return { type: 'Point', coordinates: m.point };
    return null;
  });
  const fetched = mergeGeometries(geoms);
  // `geo_elements.geom` is NOT NULL, and a handful of OSM relations expose no usable
  // member geometry at all (13 of 3,237 — including real anchors like Dubai Airport
  // Free Zone). Rather than drop them, fall back to the survey's representative point,
  // which is the only spatial fact OSM offers for them. This mirrors the Riyadh
  // dataset, whose 9 informal zones are stored the same way — and like those, the row
  // must NOT claim to be verified: `is_verified` means "real geometry sourced from
  // OSM", so it stays false and `is_approximate` stays true.
  const geometry = fetched ?? (lead.point ? { type: 'Point', coordinates: lead.point } : null);
  const geometryIsFallback = !fetched && !!geometry;
  const kind = geomKind(geometry);
  const point = representativePoint(geometry, null) ?? lead.point;
  const segments = members.length;
  const cityHit = nearestCity(point, cities, lead.emirate.code, { capKm: 80 });
  const abbr = CAT_ABBR[lead.cls.category] ?? 'MISC';
  const n = (counters.get(`${lead.emirate.code}|${abbr}`) ?? 0) + 1;
  counters.set(`${lead.emirate.code}|${abbr}`, n);

  // An area POI that OSM mapped as a bare node has an exact point but no footprint;
  // a road merged from >8 segments may join disjoint stretches. Both are usable for
  // distance matching and both must be labelled as weaker than ideal.
  const wantsArea = ['malls', 'parks', 'universities', 'hospitals', 'business_zones', 'islands', 'airports_transport'].includes(lead.cls.category);
  const isApproximate = (wantsArea && kind !== 'polygon') || segments > 8 || geometryIsFallback;

  const notes = [
    `osm:${members.map((m) => `${m.osm_type}/${m.osm_id}`).slice(0, 5).join(',')}${segments > 5 ? `,+${segments - 5}` : ''}`,
    segments > 8 ? `merged from ${segments} OSM segments sharing this name — may include disjoint stretches` : null,
    wantsArea && kind !== 'polygon' ? `mapped as ${kind} in OSM; a footprint polygon is wanted for containment` : null,
    geometryIsFallback ? 'OSM exposes no usable geometry for this element — approximate centroid point' : null,
    lead.tags.wikidata ? `wikidata:${lead.tags.wikidata}` : null,
  ].filter(Boolean).join(' | ');

  rows.push({
    // Same shape as the Riyadh ids (`RUH-BUSI-0658`) — emirate code, category
    // abbreviation, sequence. Element RULES reference this handle, not the row uuid,
    // so it must stay stable across re-runs.
    id: `${lead.emirate.code}-${abbr}-${String(n).padStart(4, '0')}`,
    name_ar: lead.ar || '',
    name_en: lead.en || '',
    category: lead.cls.category,
    type: lead.cls.type,
    country: 'United Arab Emirates',
    region: lead.emirate.name_en,
    city: cityHit?.city ? (cityHit.city.name_en || cityHit.city.name_ar) : lead.emirate.name_en,
    latitude: point[1],
    longitude: point[0],
    geometry_type: kind,
    geometry_geojson: geometry,
    source_url: `https://www.openstreetmap.org/${lead.osm_type}/${lead.osm_id}`,
    source_type: 'openstreetmap',
    confidence_score: confidence(lead.cls, kind, lead.tags, segments),
    is_verified: !!fetched,
    is_approximate: isApproximate,
    notes,
  });
}

// ── geometry plan for pass B ────────────────────────────────────────────────
const planPath = join(HERE, 'geometry-plan.json');
const plan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf8')) : {};
plan.anchors = {
  relation: [...new Set(raw.filter((r) => r.osm_type === 'relation').map((r) => r.osm_id))],
  way: [...new Set(raw.filter((r) => r.osm_type === 'way').map((r) => r.osm_id))],
};
writeFileSync(planPath, JSON.stringify(plan, null, 2));

// ── deliverables (same three shapes as the Riyadh dataset) ──────────────────
writeFileSync(join(HERE, 'uae-geo-intelligence.json'), JSON.stringify(rows, null, 1));
writeFileSync(join(HERE, 'uae-geo-intelligence.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  features: rows.filter((r) => r.geometry_geojson).map((r) => {
    const { geometry_geojson, ...props } = r;
    return { type: 'Feature', properties: props, geometry: geometry_geojson };
  }),
}));
const CSV_COLS = ['id', 'name_ar', 'name_en', 'category', 'type', 'country', 'region', 'city', 'latitude', 'longitude', 'geometry_type', 'geometry_geojson', 'source_url', 'source_type', 'confidence_score', 'is_verified', 'is_approximate', 'notes'];
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
writeFileSync(join(HERE, 'uae-geo-intelligence.csv'),
  [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => csvCell(r[c])).join(','))].join('\n'));

const tally = (fn) => rows.reduce((a, r) => { const k = fn(r); a[k] = (a[k] || 0) + 1; return a; }, {});
const byCat = tally((r) => r.category);
const md = [
  '# UAE geo-intelligence anchors — build report',
  '',
  `- Generated: ${new Date().toISOString()}`,
  '- Source: OpenStreetMap via Overpass (© OpenStreetMap contributors, ODbL)',
  `- **${rows.length} anchors** · ${rows.filter((r) => r.is_verified).length} with real geometry · ${rows.filter((r) => r.is_approximate).length} flagged approximate`,
  `- Geometry: ${rows.filter((r) => r.geometry_type === 'polygon').length} polygons · ${rows.filter((r) => r.geometry_type === 'point').length} points · ${rows.filter((r) => r.geometry_type === 'linestring').length} lines`,
  '',
  '## By category',
  '',
  '| category | anchors | approximate |',
  '|----------|--------:|------------:|',
  ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
    `| ${k} | ${v} | ${rows.filter((r) => r.category === k && r.is_approximate).length} |`),
  '',
  '## By emirate',
  '',
  ...Object.entries(tally((r) => r.region)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
  '',
  '## By type',
  '',
  ...Object.entries(tally((r) => r.type)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- \`${k}\`: ${v}`),
  '',
  '## Skipped',
  '',
  `- ${unnamed} elements with no name in either language`,
  `- ${unclassified} elements no classifier matched`,
  `- ${outside} elements whose centroid fell outside every emirate polygon (bbox spill into Oman/Saudi)`,
  '',
].join('\n');
writeFileSync(join(HERE, 'report-anchors.md'), md);

console.log(`\n  ${rows.length} anchors → uae-geo-intelligence.{json,geojson,csv}, report-anchors.md`);
console.log(`  geometry-plan.json → anchors: ${plan.anchors.relation.length} relations, ${plan.anchors.way.length} ways`);
if (!geomFiles.length) console.log(`\nNEXT: node data/source/geo-uae/fetch.mjs geometry  (then re-run this script)`);
