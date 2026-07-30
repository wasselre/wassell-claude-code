/**
 * Overpass client + OSM→GeoJSON geometry assembly.
 *
 * Shared by fetch.mjs / process.mjs for the UAE geography build. Deliberately
 * dependency-free (node built-ins only) so it runs the same on a laptop and in CI.
 *
 * Why a hand-rolled client: the public overpass-api.de instance 504s on anything
 * country-wide and 406s without a User-Agent, so every request rotates across
 * mirrors with backoff. Raw responses are cached on disk (fetch.mjs) — re-running
 * the pipeline must never re-hammer the API.
 */
import { setTimeout as sleep } from 'node:timers/promises';

export const ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];

const UA = 'wassell-crm-geo-import/1.0 (+https://app.wassel.re; r.abanumay@wassel.re)';

/** UAE country relation 307763 → Overpass area id. */
export const UAE_AREA = 3600307763;

/**
 * POST an Overpass QL query, rotating mirrors on failure.
 * Throws only after every attempt fails — a silent empty result would look like
 * "the UAE has no districts" and quietly ship a broken dataset.
 */
export async function overpass(query, { attempts = 8, label = 'query' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ep = ENDPOINTS[i % ENDPOINTS.length];
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = new Error(`${label}: ${ep} → HTTP ${res.status}`);
        console.warn(`  ! ${lastErr.message} (attempt ${i + 1}/${attempts})`);
        await sleep(4000 + i * 3000);
        continue;
      }
      if (!text.trim().startsWith('{')) {
        lastErr = new Error(`${label}: ${ep} → non-JSON body (${text.slice(0, 120)})`);
        console.warn(`  ! ${lastErr.message}`);
        await sleep(4000 + i * 3000);
        continue;
      }
      const json = JSON.parse(text);
      if (json.remark && /timed out|out of memory/i.test(json.remark)) {
        lastErr = new Error(`${label}: ${ep} → remark: ${json.remark}`);
        console.warn(`  ! ${lastErr.message}`);
        await sleep(4000 + i * 3000);
        continue;
      }
      return json;
    } catch (err) {
      lastErr = new Error(`${label}: ${ep} → ${err.message}`);
      console.warn(`  ! ${lastErr.message} (attempt ${i + 1}/${attempts})`);
      await sleep(4000 + i * 3000);
    }
  }
  throw lastErr ?? new Error(`${label}: exhausted all endpoints`);
}

// ── geometry ────────────────────────────────────────────────────────────────

const round = (n) => Math.round(n * 1e7) / 1e7;
const pt = (p) => [round(p.lon), round(p.lat)];
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

/**
 * Stitch OSM way geometries into closed rings.
 *
 * Boundary relations hand back an unordered bag of ways whose endpoints happen to
 * match; a polygon only exists once they're chained. Ways that never close are
 * returned separately so the caller can decide (we degrade to a LineString or drop
 * to point-only rather than inventing a closure).
 */
export function stitchRings(ways) {
  const open = ways.map((w) => w.slice()).filter((w) => w.length >= 2);
  const rings = [];
  const leftovers = [];

  while (open.length) {
    let chain = open.shift();
    let progress = true;
    while (progress && !same(chain[0], chain[chain.length - 1])) {
      progress = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        const head = chain[0];
        const tail = chain[chain.length - 1];
        if (same(tail, w[0])) { chain = chain.concat(w.slice(1)); open.splice(i, 1); progress = true; break; }
        if (same(tail, w[w.length - 1])) { chain = chain.concat(w.slice(0, -1).reverse()); open.splice(i, 1); progress = true; break; }
        if (same(head, w[w.length - 1])) { chain = w.slice(0, -1).concat(chain); open.splice(i, 1); progress = true; break; }
        if (same(head, w[0])) { chain = w.slice(1).reverse().concat(chain); open.splice(i, 1); progress = true; break; }
      }
    }
    if (same(chain[0], chain[chain.length - 1]) && chain.length >= 4) rings.push(chain);
    else leftovers.push(chain);
  }
  return { rings, leftovers };
}

/** Signed area (shoelace) — used only to pick the largest ring as the outer one. */
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}

/** Ray-casting point-in-ring, for nesting inner rings under the right outer ring. */
function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * OSM element (from `out geom;`) → GeoJSON geometry.
 * Returns null when the element carries no usable geometry — callers must handle
 * that (we fall back to the element's bbox centre as a point, flagged approximate).
 */
export function elementGeometry(el) {
  if (el.type === 'node') {
    if (typeof el.lat !== 'number' || typeof el.lon !== 'number') return null;
    return { type: 'Point', coordinates: [round(el.lon), round(el.lat)] };
  }
  if (el.type === 'way') {
    const coords = (el.geometry ?? []).filter(Boolean).map(pt);
    if (coords.length < 2) return null;
    if (coords.length >= 4 && same(coords[0], coords[coords.length - 1])) {
      return { type: 'Polygon', coordinates: [coords] };
    }
    return { type: 'LineString', coordinates: coords };
  }
  if (el.type === 'relation') {
    const members = el.members ?? [];
    const outerWays = [];
    const innerWays = [];
    const lineWays = [];
    for (const m of members) {
      if (m.type !== 'way' || !Array.isArray(m.geometry)) continue;
      const coords = m.geometry.filter(Boolean).map(pt);
      if (coords.length < 2) continue;
      if (m.role === 'inner') innerWays.push(coords);
      else if (m.role === 'outer' || m.role === '' || m.role == null) outerWays.push(coords);
      else lineWays.push(coords); // route relations: forward/backward/platform/stop…
    }

    // Area relation (boundary / multipolygon).
    if (outerWays.length) {
      const { rings: outers, leftovers } = stitchRings(outerWays);
      const { rings: inners } = stitchRings(innerWays);
      if (outers.length) {
        const polys = outers
          .sort((a, b) => ringArea(b) - ringArea(a))
          .map((o) => [o]);
        for (const hole of inners) {
          const probe = hole[0];
          const host = polys.find((p) => inRing(probe, p[0]));
          if (host) host.push(hole);
        }
        if (polys.length === 1) return { type: 'Polygon', coordinates: polys[0] };
        return { type: 'MultiPolygon', coordinates: polys };
      }
      // Nothing closed → treat what we have as lines rather than faking a polygon.
      const lines = leftovers.filter((l) => l.length >= 2);
      if (lines.length === 1) return { type: 'LineString', coordinates: lines[0] };
      if (lines.length > 1) return { type: 'MultiLineString', coordinates: lines };
      return null;
    }

    // Route relation (metro line, road route) → line work.
    const all = lineWays.length ? lineWays : [];
    if (all.length) {
      const { rings, leftovers } = stitchRings(all);
      const lines = [...rings, ...leftovers].filter((l) => l.length >= 2);
      if (lines.length === 1) return { type: 'LineString', coordinates: lines[0] };
      if (lines.length > 1) return { type: 'MultiLineString', coordinates: lines };
    }
    return null;
  }
  return null;
}

/** Representative centroid: exact for points, bbox centre for lines/areas. */
export function representativePoint(geometry, el) {
  if (!geometry) {
    if (el?.center) return [round(el.center.lon), round(el.center.lat)];
    if (el?.bounds) return [round((el.bounds.minlon + el.bounds.maxlon) / 2), round((el.bounds.minlat + el.bounds.maxlat) / 2)];
    if (typeof el?.lat === 'number') return [round(el.lon), round(el.lat)];
    return null;
  }
  if (geometry.type === 'Point') return geometry.coordinates;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
      return;
    }
    for (const x of c) walk(x);
  };
  walk(geometry.coordinates);
  if (!Number.isFinite(minX)) return null;
  return [round((minX + maxX) / 2), round((minY + maxY) / 2)];
}

/** point | linestring | polygon — the dataset's coarse geometry_type label. */
export function geomKind(geometry) {
  if (!geometry) return 'point';
  switch (geometry.type) {
    case 'Point': case 'MultiPoint': return 'point';
    case 'LineString': case 'MultiLineString': return 'linestring';
    case 'Polygon': case 'MultiPolygon': return 'polygon';
    default: return 'point';
  }
}

/** Coordinate count — a cheap proxy for "is this geometry substantive". */
export function coordCount(geometry) {
  if (!geometry) return 0;
  let n = 0;
  const walk = (c) => { if (typeof c[0] === 'number') { n++; return; } for (const x of c) walk(x); };
  walk(geometry.coordinates);
  return n;
}
