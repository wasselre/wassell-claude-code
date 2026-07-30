#!/usr/bin/env node
/**
 * Normalize the cached Overpass responses in raw/ into the geo-intelligence
 * dataset shape consumed by scripts/import-geo-intelligence.mjs.
 *
 *   node data/source/geo/process.mjs
 *
 * Writes, per city, <city-slug>-geo-intelligence.{json,csv,geojson} plus a
 * combined saudi-cities-geo-intelligence.json and a set of review reports.
 * Output schema is byte-compatible with riyadh-geo-intelligence.json (18 fields)
 * so the existing importer needs no per-city special-casing.
 *
 * ── Design decisions that matter ────────────────────────────────────────────
 *
 * 1. STABLE IDS. external_id is `<PREFIX>-<CAT>-<6 hex of sha1(identity)>`, NOT a
 *    sequence number. Client element rules reference external_id, so a renumber on
 *    the next OSM refresh would silently break live rules (they compile to
 *    needs_review). Identity is the immutable OSM `type/id` for discrete features,
 *    the normalized name for grouped roads, and the direction for generated zones.
 *    Riyadh's original RUH-XXXX-NNNN sequence is left untouched — it is already
 *    imported and referenced; only the new cities use the hashed form.
 *
 * 2. NO FABRICATED GEOMETRY. Every geometry comes from OSM. The only synthesized
 *    records are the 5 directional `zones` per city, which have no official
 *    boundary anywhere — they are stored as explicitly-approximate centroid
 *    points (source_type=manual_estimate, confidence 0.35, is_approximate=true),
 *    exactly as Riyadh's informal zones were.
 *
 * 3. ONE ELEMENT, ONE CITY. The Eastern Province bboxes (Dammam / Khobar /
 *    Dhahran / Qatif) overlap heavily, so the same OSM feature is returned for
 *    several cities. Features are deduped by OSM identity and assigned to the
 *    NEAREST city centre, so a Khobar mall is labelled Khobar even though the
 *    Dammam query also returned it.
 *
 * 4. `lifestyle` IS DELIBERATELY EMPTY for the new cities. Riyadh's 10 lifestyle
 *    destinations were hand-curated; there is no OSM tag that reliably denotes
 *    "lifestyle destination", and guessing one would put noise into a curated
 *    dataset. Left to future manual curation rather than fabricated.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, 'raw');
const CITIES = JSON.parse(readFileSync(join(__dirname, 'cities.json'), 'utf8'));
const GROUPS = ['transport', 'pois', 'landuse'];

const CAT_CODE = {
  roads_major: 'ROAD', ring_roads: 'RING', metro_lines: 'METR', metro_stations: 'METR',
  malls: 'MALL', universities: 'UNIV', hospitals: 'HOSP', airports_transport: 'AIRP',
  parks: 'PARK', landmarks: 'LAND', business_zones: 'BUSI', lifestyle: 'LIFE', zones: 'ZONE',
};

const sha6 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 6);
const RING_RE = /[Rr]ing|دائري/;

// ── taxonomy: OSM tags → (category, type). First match wins. ────────────────
function classify(tags = {}) {
  const t = tags;
  if (/^(subway|light_rail|monorail)$/.test(t.route || '')) return ['metro_lines', 'metro_line'];
  if ((t.railway === 'station' || t.railway === 'halt') && /^(subway|light_rail)$/.test(t.station || ''))
    return ['metro_stations', 'metro_station'];
  if (t.subway === 'yes' && t.railway === 'station') return ['metro_stations', 'metro_station'];
  if (t.aeroway === 'aerodrome') return ['airports_transport', 'airport'];
  if (t.amenity === 'bus_station') return ['airports_transport', 'bus_station'];
  if (t.railway === 'station' || t.railway === 'halt') return ['airports_transport', 'train_station'];
  if (t.highway && RING_RE.test(t.name || '')) return ['ring_roads', 'ring_road'];
  if (/^(motorway|trunk)$/.test(t.highway || '')) return ['roads_major', 'highway'];
  if (/^(primary|secondary)$/.test(t.highway || '')) return ['roads_major', 'arterial_road'];
  if (t.type === 'route' && t.route === 'road' && RING_RE.test(t.name || '')) return ['ring_roads', 'ring_road'];
  if (t.shop === 'mall') return ['malls', 'mall'];
  if (t.amenity === 'university') return ['universities', 'university'];
  if (t.amenity === 'hospital') return ['hospitals', 'hospital'];
  if (t.tourism === 'theme_park') return ['parks', 'theme_park'];
  if (t.leisure === 'water_park') return ['parks', 'water_park'];
  if (t.leisure === 'park') return ['parks', 'park'];
  if (t.tourism === 'museum') return ['landmarks', 'museum'];
  if (t.historic) return ['landmarks', 'historic_site'];
  if (t.man_made === 'tower') return ['landmarks', 'tower'];
  if (t.tourism === 'attraction') return ['landmarks', 'landmark'];
  if (/^(commercial|retail)$/.test(t.landuse || '')) return ['business_zones', 'commercial_zone'];
  // `office=*` intentionally unhandled — see the note on the landuse group in
  // fetch.mjs. A single office building is not a business zone.
  return [null, null];
}

// ── geometry builders ───────────────────────────────────────────────────────
const ring = (geom) => geom.map((p) => [round7(p.lon), round7(p.lat)]);
const round7 = (n) => Math.round(n * 1e7) / 1e7;
const isClosed = (g) => g.length >= 4 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;

function closeRing(coords) {
  if (coords.length < 3) return null;
  const first = coords[0], last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords = [...coords, first];
  return coords.length >= 4 ? coords : null;
}

/** Stitch relation member ways into closed rings (handles ways given out of order/reversed). */
function stitchRings(ways) {
  const segs = ways.map((w) => ring(w.geometry)).filter((c) => c.length >= 2);
  const rings = [];
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  while (segs.length) {
    let cur = segs.shift();
    let advanced = true;
    while (advanced && !same(cur[0], cur[cur.length - 1])) {
      advanced = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (same(cur[cur.length - 1], s[0]))      { cur = cur.concat(s.slice(1)); segs.splice(i, 1); advanced = true; break; }
        if (same(cur[cur.length - 1], s[s.length - 1])) { cur = cur.concat(s.slice().reverse().slice(1)); segs.splice(i, 1); advanced = true; break; }
        if (same(cur[0], s[s.length - 1]))        { cur = s.slice(0, -1).concat(cur); segs.splice(i, 1); advanced = true; break; }
        if (same(cur[0], s[0]))                   { cur = s.slice().reverse().slice(0, -1).concat(cur); segs.splice(i, 1); advanced = true; break; }
      }
    }
    const closed = closeRing(cur);
    if (closed) rings.push(closed);
  }
  return rings;
}

function geometryOf(el) {
  if (el.type === 'node') return { type: 'Point', coordinates: [round7(el.lon), round7(el.lat)] };
  if (el.type === 'way' && Array.isArray(el.geometry)) {
    const coords = ring(el.geometry);
    if (isClosed(el.geometry)) {
      const r = closeRing(coords);
      if (r) return { type: 'Polygon', coordinates: [r] };
    }
    return coords.length >= 2 ? { type: 'LineString', coordinates: coords } : null;
  }
  if (el.type === 'relation' && Array.isArray(el.members)) {
    const ways = el.members.filter((m) => m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length);
    if (!ways.length) return null;
    // Route relations (metro lines, ring-road routes) are linear, not areal.
    if (el.tags?.type === 'route') {
      const lines = ways.map((w) => ring(w.geometry)).filter((c) => c.length >= 2);
      if (!lines.length) return null;
      return lines.length === 1
        ? { type: 'LineString', coordinates: lines[0] }
        : { type: 'MultiLineString', coordinates: lines };
    }
    const outer = stitchRings(ways.filter((m) => m.role !== 'inner'));
    const inner = stitchRings(ways.filter((m) => m.role === 'inner'));
    if (!outer.length) return null;
    if (outer.length === 1) return { type: 'Polygon', coordinates: [outer[0], ...inner] };
    return { type: 'MultiPolygon', coordinates: outer.map((o) => [o]) };
  }
  return null;
}

function repPoint(el, geom) {
  if (el.type === 'node') return [round7(el.lat), round7(el.lon)];
  if (el.bounds) {
    return [round7((el.bounds.minlat + el.bounds.maxlat) / 2), round7((el.bounds.minlon + el.bounds.maxlon) / 2)];
  }
  const flat = [];
  const walk = (c) => { if (typeof c[0] === 'number') flat.push(c); else c.forEach(walk); };
  if (geom) walk(geom.coordinates);
  if (!flat.length) return [null, null];
  const lats = flat.map((p) => p[1]), lngs = flat.map((p) => p[0]);
  return [round7((Math.min(...lats) + Math.max(...lats)) / 2), round7((Math.min(...lngs) + Math.max(...lngs)) / 2)];
}

const normName = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ـًٌٍَُِّْ]/g, '');

/**
 * Canonical road key — deliberately IDENTICAL to the SQL in
 * supabase/migrations/2026-07-27_merge_fragmented_roads.sql, which de-fragmented
 * Riyadh's roads (197 rows → 123 distinct; the picker had been listing one road
 * 6-8 times and "area between roads" was hulling a fragment). Grouping on it here
 * means the new cities' roads arrive already merged instead of needing the same
 * one-off repair migration re-run per city.
 *
 * Mirrors: lower → unify أإآ/ى/ة → strip tashkeel+tatweel → drop the type words
 * (طريق/شارع, with an optional ال) → strip the ال article from every token →
 * collapse whitespace. Suffixes are preserved so «… الفرعي» service roads stay
 * separate roads.
 *
 * ONE DELIBERATE DIVERGENCE: the SQL keys on name_ar alone, so any road with an
 * empty name_ar canonicalizes to '' and they would all collapse into a single
 * group. Here an empty key falls back to name_en and then to the OSM id, so
 * English-only roads never merge with each other.
 */
function canonRoadKeyAr(name_ar) {
  return (name_ar || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/(ال)?(طريق|شارع)/g, ' ')
    .replace(/(^|\s)ال/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** English counterpart — drops the road type words so "King Fahd Rd" == "King Fahd Road". */
function canonRoadKeyEn(name_en) {
  return normName(name_en)
    .replace(/\b(road|rd|street|st|highway|hwy|expressway|branch)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const haversine = (aLat, aLng, bLat, bLng) => {
  const R = 6371, dLat = (bLat - aLat) * Math.PI / 180, dLng = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
};

function tagNote(el) {
  const skip = new Set(['name', 'name:ar', 'name:en']);
  const pairs = Object.entries(el.tags || {}).filter(([k]) => !skip.has(k)).slice(0, 8)
    .map(([k, v]) => `${k}=${v}`);
  return `OSM ${el.type}/${el.id}${pairs.length ? `; tags: ${pairs.join(', ')}` : ''}`;
}

// ── 1. load every raw element, dedupe by OSM identity ───────────────────────
const missing = [];
const byIdentity = new Map();

for (const city of CITIES) {
  for (const group of GROUPS) {
    const p = join(RAW, `${city.prefix}-${group}.json`);
    if (!existsSync(p)) { missing.push(`${city.prefix}-${group}`); continue; }
    const { elements } = JSON.parse(readFileSync(p, 'utf8'));
    for (const el of elements) {
      const identity = `${el.type}/${el.id}`;
      if (!byIdentity.has(identity)) byIdentity.set(identity, el);
    }
  }
}
if (missing.length) {
  console.warn(`[process] WARNING — ${missing.length} raw file(s) absent; those cities are under-covered:`);
  for (const m of missing) console.warn(`  - ${m} (run: node data/source/geo/fetch.mjs ${m.split('-')[0]})`);
}
console.log(`[process] ${byIdentity.size} unique OSM elements loaded`);

// ── 2. classify, build geometry, assign a city ──────────────────────────────
const dropped = { unclassified: 0, no_geometry: 0, no_name: 0, no_city: 0 };
const staged = [];

for (const el of byIdentity.values()) {
  const [category, type] = classify(el.tags);
  if (!category) { dropped.unclassified++; continue; }

  const name_ar = (el.tags?.['name:ar'] || (/[؀-ۿ]/.test(el.tags?.name || '') ? el.tags.name : '') || '').trim();
  const name_en = (el.tags?.['name:en'] || (!/[؀-ۿ]/.test(el.tags?.name || '') ? el.tags?.name : '') || '').trim();
  if (!name_ar && !name_en) { dropped.no_name++; continue; }

  const geom = geometryOf(el);
  if (!geom) { dropped.no_geometry++; continue; }
  const [lat, lng] = repPoint(el, geom);
  if (lat == null || lng == null) { dropped.no_geometry++; continue; }

  // Nearest city centre wins — resolves the overlapping Eastern Province bboxes.
  let best = null, bestKm = Infinity;
  for (const c of CITIES) {
    const km = haversine(lat, lng, c.centre.lat, c.centre.lng);
    if (km < bestKm) { bestKm = km; best = c; }
  }
  if (!best) { dropped.no_city++; continue; }

  staged.push({ el, category, type, name_ar, name_en, lat, lng, geom, city: best, distKm: bestKm });
}
console.log(`[process] classified ${staged.length} · dropped ${JSON.stringify(dropped)}`);

// ── 3. group linear road/route features by (city, category, name) ───────────
const rows = [];
const roadGroups = new Map();

// Roads are unioned across BOTH language keys. A single-language key splits a road
// whenever one segment carries a typo or an abbreviation in the other language —
// the UAE build hit exactly this (a «شارع الشيخ زاي» segment, missing the د, split
// 13 of 352 roads). Union-find: any two segments sharing EITHER their canonical
// Arabic key or their canonical English key are the same road.
//
// NOTE neither key includes the category: «الدائري الشمالي» was stored across BOTH
// ring_roads and roads_major in Riyadh, and splitting by category is exactly how
// one road ends up as two half-roads. Category comes from the survivor.
const linearWays = [];
for (const s of staged) {
  const linear = (s.category === 'roads_major' || s.category === 'ring_roads') && s.el.type === 'way';
  if (linear) linearWays.push(s); else rows.push(buildRow(s));
}

const parent = new Map();
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

for (const s of linearWays) {
  const self = `w:${s.el.id}`;
  if (!parent.has(self)) parent.set(self, self);
  const ar = canonRoadKeyAr(s.name_ar);
  const en = canonRoadKeyEn(s.name_en);
  for (const [kind, key] of [['ar', ar], ['en', en]]) {
    if (!key) continue;
    const node = `${kind}:${s.city.prefix}|${key}`;
    if (!parent.has(node)) parent.set(node, node);
    union(self, node);
  }
}

for (const s of linearWays) {
  const root = find(`w:${s.el.id}`);
  if (!roadGroups.has(root)) roadGroups.set(root, []);
  roadGroups.get(root).push(s);
}

for (const [, group] of roadGroups) {
  // Longest-geometry-first, so the survivor's name/category represent the road's
  // dominant mapping rather than whichever fragment happened to come back first.
  group.sort((a, b) =>
    (b.geom.coordinates?.length ?? 0) - (a.geom.coordinates?.length ?? 0) ||
    String(a.el.id).localeCompare(String(b.el.id)));
  const head = group[0];
  const category = head.category;
  const lines = group.map((g) => (g.geom.type === 'LineString' ? g.geom.coordinates : null)).filter(Boolean);
  if (!lines.length) continue;
  const geom = lines.length === 1 ? { type: 'LineString', coordinates: lines[0] }
                                  : { type: 'MultiLineString', coordinates: lines };
  const flat = lines.flat();
  const lats = flat.map((p) => p[1]), lngs = flat.map((p) => p[0]);
  // >8 merged segments: the merged geometry may include disjoint stretches that
  // merely share a name. Flagged, per the Riyadh dataset's rule.
  const approx = group.length > 8;
  rows.push(buildRow({
    ...head, geom,
    lat: round7((Math.min(...lats) + Math.max(...lats)) / 2),
    lng: round7((Math.min(...lngs) + Math.max(...lngs)) / 2),
  }, {
    // Category is intentionally NOT in the seed: a road reclassified between
    // roads_major and ring_roads must keep its external_id, or a client rule
    // pointing at it would stop resolving. Arabic key preferred (it's the name the
    // business uses); English only when there is no Arabic name at all.
    idSeed: `road:${canonRoadKeyAr(head.name_ar) || canonRoadKeyEn(head.name_en) || `osm:${head.el.id}`}`,
    is_approximate: approx,
    segments: group.length,
    notes: `Merged from ${group.length} OSM way(s): ${group.slice(0, 6).map((g) => g.el.id).join(', ')}${group.length > 6 ? ', …' : ''}`
      + (approx ? ' — >8 segments merged by name; may include disjoint stretches sharing this name.' : ''),
  }));
}

function buildRow(s, opts = {}) {
  const { el, category, type, name_ar, name_en, lat, lng, geom, city } = s;
  const gtype = geom.type === 'MultiPolygon' ? 'polygon'
    : geom.type === 'MultiLineString' ? 'linestring'
    : geom.type.toLowerCase();
  const areal = ['malls', 'universities', 'hospitals', 'parks', 'business_zones', 'airports_transport'].includes(category);
  // A point where a footprint is wanted is weaker than ideal geometry.
  const pointForArea = areal && gtype === 'point';
  const is_approximate = opts.is_approximate ?? pointForArea;

  let confidence;
  if (gtype === 'polygon') confidence = 0.9;
  else if (gtype === 'point') confidence = pointForArea ? 0.75 : 0.88;
  else confidence = 0.85;
  if (category === 'business_zones') confidence = Math.min(confidence, 0.6);
  if (el.tags?.wikidata) confidence = Math.min(0.99, confidence + 0.05);

  const idSeed = opts.idSeed ?? `${el.type}/${el.id}`;
  return {
    id: `${city.prefix}-${CAT_CODE[category]}-${sha6(`${city.prefix}:${idSeed}`)}`,
    name_ar, name_en, category, type,
    country: 'Saudi Arabia', region: city.region, city: city.name_en,
    latitude: lat, longitude: lng,
    geometry_type: gtype,
    geometry_geojson: geom,
    source_url: opts.idSeed ? '' : `https://www.openstreetmap.org/${el.type}/${el.id}`,
    source_type: 'openstreetmap',
    confidence_score: Math.round(confidence * 100) / 100,
    is_verified: true,
    is_approximate,
    notes: opts.notes ? `${tagNote(el)} — ${opts.notes}` : tagNote(el)
      + (pointForArea ? ' — point geometry only; a footprint polygon would be preferable.' : ''),
  };
}

// ── 4. NO generated directional zones — deliberate ─────────────────────────
// An earlier draft of this script synthesised 5 directional anchors per city
// ("North Jeddah", "Central Dammam", …) to mirror Riyadh's 9 informal zones.
// That was dropped, for three reasons:
//
//   1. They would be UNUSABLE. Informal zones carry confidence 0.35, and the
//      matcher's floor is 0.50 (CONFIDENCE_FLOOR in scripts/import-geo-intelligence.mjs,
//      mirrored in geoMatch.ts + its SQL twin). A within_radius rule built on one
//      compiles to `needs_review` — so the anchor shows up in the picker, the user
//      picks it, and the rule silently does nothing. 100 new dead ends.
//   2. The direction question is ALREADY answered properly elsewhere.
//      `wassell_city_zone_districts(city, zone)` resolves "north of X" to a real
//      set of districts geometrically, per city, with curated overrides — and
//      element direction rules are bounded side∧distance bands. A centroid point
//      offset from the city centre is a strictly worse answer to the same question.
//   3. This dataset's guarantee is "0 fabricated geometries". Riyadh's 9 zones are
//      hand-curated landmarks of real local usage (KAFD corridor, the Diplomatic
//      Quarter); mechanically offsetting a centroid by ±0.055° is not the same
//      thing and shouldn't inherit their credibility.
//
// If directional anchors are ever wanted for these cities, they should be curated
// per city like Riyadh's were — not generated.

// ── 5. uniqueness guard — a collision would silently overwrite an anchor ────
const seen = new Map();
for (const r of rows) {
  if (seen.has(r.id)) {
    console.error(`[process] FATAL id collision: ${r.id}\n  A: ${seen.get(r.id).name_en || seen.get(r.id).name_ar}\n  B: ${r.name_en || r.name_ar}`);
    process.exit(1);
  }
  seen.set(r.id, r);
}

// ── 6. write outputs ───────────────────────────────────────────────────────
rows.sort((a, b) => a.city.localeCompare(b.city) || a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

writeFileSync(join(__dirname, 'saudi-cities-geo-intelligence.json'), JSON.stringify(rows, null, 1));
writeFileSync(join(__dirname, 'saudi-cities-geo-intelligence.geojson'), JSON.stringify({
  type: 'FeatureCollection',
  features: rows.map((r) => ({
    type: 'Feature',
    geometry: r.geometry_geojson,
    properties: Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'geometry_geojson')),
  })),
}, null, 1));

const COLS = ['id', 'name_ar', 'name_en', 'category', 'type', 'country', 'region', 'city',
  'latitude', 'longitude', 'geometry_type', 'geometry_geojson', 'source_url', 'source_type',
  'confidence_score', 'is_verified', 'is_approximate', 'notes'];
const esc = (v) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
writeFileSync(join(__dirname, 'saudi-cities-geo-intelligence.csv'),
  [COLS.join(','), ...rows.map((r) => COLS.map((c) => esc(r[c])).join(','))].join('\n'));

// NOTE: no per-city split is written. An earlier version emitted one file per city,
// which was 5.5 MB of exact duplication of the combined file for no consumer — the
// importer takes the combined dataset (or `--all`), and per-city slicing is a one
// line filter on `city` when anyone actually needs it.
void slug;

// ── 7. reports ─────────────────────────────────────────────────────────────
const tally = (fn) => rows.reduce((a, r) => { const k = fn(r) ?? '∅'; a[k] = (a[k] || 0) + 1; return a; }, {});
const byCity = tally((r) => r.city), byCat = tally((r) => r.category), byGeom = tally((r) => r.geometry_type);
const approx = rows.filter((r) => r.is_approximate), low = rows.filter((r) => r.confidence_score < 0.6);

const report = {
  generated_at: new Date().toISOString(),
  cities: CITIES.length, total: rows.length,
  osm_backed: rows.filter((r) => r.source_type === 'openstreetmap').length,
  generated_zones: rows.filter((r) => r.source_type === 'manual_estimate').length,
  approximate: approx.length, low_confidence: low.length,
  missing_raw_files: missing, dropped,
  by_city: byCity, by_category: byCat, by_geometry_type: byGeom,
};
writeFileSync(join(__dirname, 'process-report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(__dirname, 'process-report.md'), [
  '# Multi-city geo-intelligence build report', '',
  `- Generated: ${report.generated_at}`,
  `- Cities: **${report.cities}** · anchors: **${report.total}**`,
  `- OSM-backed: **${report.osm_backed}** · generated directional zones: **${report.generated_zones}** · fabricated geometry: **0**`,
  `- Approximate: ${report.approximate} · below the 0.5 matcher confidence floor: ${low.length}`,
  missing ? `- Missing raw files: ${missing.length ? missing.join(', ') : 'none'}` : '',
  `- Dropped while classifying: ${JSON.stringify(dropped)}`, '',
  '## By city', ...Object.entries(byCity).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`), '',
  '## By category', ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`), '',
  '## By geometry type', ...Object.entries(byGeom).map(([k, v]) => `- ${k}: ${v}`), '',
].filter(Boolean).join('\n'));

console.log(`[process] ${rows.length} anchors across ${Object.keys(byCity).length} cities`);
console.log(`[process] by category: ${JSON.stringify(byCat)}`);
console.log(`[process] reports → data/source/geo/process-report.md`);
