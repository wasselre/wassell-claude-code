#!/usr/bin/env node
/**
 * Fetch REAL administrative borders (country + region) from OpenStreetMap.
 *
 *   node data/source/geo/fetch-admin.mjs            # SA (+ AE if missing)
 *
 * WHY THIS EXISTS. `geo_admin_boundaries` originally derived every tier by
 * dissolving `district_boundaries` upward. That is correct for a CITY — a city's
 * extent genuinely is the union of its districts — but it is WRONG for a country
 * or a region: districts only exist inside built-up areas, so the "Saudi Arabia"
 * dissolve came out as 190 disconnected city blobs, not a national border. Country
 * and region outlines must come from a real boundary source.
 *
 * Source: OSM `boundary=administrative` relations, fetched BY ID (`out geom;`).
 * By-id relation queries are cheap and reliable even when the public instances are
 * refusing area queries — the same approach data/source/geo-uae/fetch.mjs used.
 *   Saudi Arabia  relation 307584   (admin_level 2)
 *   UAE           relation 307763   (admin_level 2)
 *   provinces     admin_level 4, discovered via their ISO3166-2 codes
 *
 * Writes data/source/geo/admin-boundaries.json:
 *   [{ level, country_code, ref_id, osm_id, name_ar, name_en, geometry_geojson }]
 * Cached per relation under raw-admin/ so a partial run resumes for free.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, 'raw-admin');

// Planet-only mirrors. See the note in fetch.mjs — regional extracts answer
// out-of-region queries with 200 + empty and would silently yield no borders.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const COUNTRIES = [
  { code: 'SA', osm_id: 307584, name_ar: 'السعودية', name_en: 'Saudi Arabia' },
  { code: 'AE', osm_id: 307763, name_ar: 'الإمارات العربية المتحدة', name_en: 'United Arab Emirates' },
];
const MAX_ATTEMPTS = 10;
const PAUSE_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rr = 0;
const cooldown = new Map();
function nextEndpoint() {
  const now = Date.now();
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const ep = ENDPOINTS[(rr + i) % ENDPOINTS.length];
    if ((cooldown.get(ep) ?? 0) <= now) { rr = (rr + i + 1) % ENDPOINTS.length; return { ep, wait: 0 }; }
  }
  let best = ENDPOINTS[0], at = cooldown.get(ENDPOINTS[0]) ?? 0;
  for (const e of ENDPOINTS) { const t = cooldown.get(e) ?? 0; if (t < at) { best = e; at = t; } }
  return { ep: best, wait: Math.max(0, at - now) };
}

async function overpass(query, label) {
  let last;
  for (let a = 1; a <= MAX_ATTEMPTS; a++) {
    const { ep, wait } = nextEndpoint();
    if (wait) { console.warn(`[admin] ${label}: all mirrors cooling, waiting ${Math.ceil(wait / 1000)}s`); await sleep(wait); }
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'wassel-crm-geo-intelligence/1.0 (real-estate matching; r.abanumay@wassel.re)',
        },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json?.elements)) throw new Error('no elements array');
      const remark = typeof json.remark === 'string' ? json.remark : '';
      if (/error|timed out|timeout|exceeded|abort/i.test(remark)) throw new Error(`remark: ${remark.slice(0, 160)}`);
      return json;
    } catch (err) {
      last = err;
      cooldown.set(ep, Date.now() + 60_000);
      console.warn(`[admin] ${label} attempt ${a}/${MAX_ATTEMPTS} on ${new URL(ep).host}: ${err.message}`);
      if (a % ENDPOINTS.length === 0) await sleep(Math.min(60_000, 5000 * 2 ** (a / ENDPOINTS.length - 1)));
    }
  }
  throw new Error(`${label}: exhausted ${MAX_ATTEMPTS} attempts (${last?.message})`);
}

async function cached(name, fn) {
  mkdirSync(RAW, { recursive: true });
  const p = join(RAW, `${name}.json`);
  if (existsSync(p)) { console.log(`[admin] ${name} — cached`); return JSON.parse(readFileSync(p, 'utf8')); }
  const data = await fn();
  writeFileSync(p, JSON.stringify(data));
  console.log(`[admin] ${name} — fetched (${data.elements?.length ?? 0} elements)`);
  await sleep(PAUSE_MS);
  return data;
}

/** Assemble a boundary relation's outer ways into a MultiPolygon. */
function relationToPolygon(rel) {
  const ways = (rel.members ?? []).filter(
    (m) => m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length >= 2 && m.role !== 'inner');
  if (!ways.length) return null;
  const segs = ways.map((w) => w.geometry.map((p) => [Math.round(p.lon * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6]));
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const rings = [];
  while (segs.length) {
    let cur = segs.shift();
    let moved = true;
    while (moved && !same(cur[0], cur[cur.length - 1])) {
      moved = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (same(cur[cur.length - 1], s[0])) { cur = cur.concat(s.slice(1)); segs.splice(i, 1); moved = true; break; }
        if (same(cur[cur.length - 1], s[s.length - 1])) { cur = cur.concat(s.slice().reverse().slice(1)); segs.splice(i, 1); moved = true; break; }
        if (same(cur[0], s[s.length - 1])) { cur = s.slice(0, -1).concat(cur); segs.splice(i, 1); moved = true; break; }
        if (same(cur[0], s[0])) { cur = s.slice().reverse().slice(0, -1).concat(cur); segs.splice(i, 1); moved = true; break; }
      }
    }
    if (!same(cur[0], cur[cur.length - 1])) cur.push(cur[0]); // close an open ring
    if (cur.length >= 4) rings.push([cur]);
  }
  if (!rings.length) return null;
  return rings.length === 1
    ? { type: 'Polygon', coordinates: rings[0] }
    : { type: 'MultiPolygon', coordinates: rings };
}

const out = [];

for (const c of COUNTRIES) {
  // ── country ───────────────────────────────────────────────────────────────
  const cj = await cached(`country-${c.code}`, () =>
    overpass(`[out:json][timeout:300];relation(${c.osm_id});out geom;`, `country-${c.code}`));
  const crel = (cj.elements ?? []).find((e) => e.type === 'relation');
  const cgeom = crel ? relationToPolygon(crel) : null;
  if (cgeom) {
    out.push({
      level: 'country', country_code: c.code, ref_id: c.code, osm_id: c.osm_id,
      name_ar: crel.tags?.['name:ar'] || c.name_ar,
      name_en: crel.tags?.['name:en'] || c.name_en,
      geometry_geojson: cgeom,
    });
    console.log(`[admin] ${c.code} country → ${cgeom.type}`);
  } else {
    console.error(`[admin] ${c.code} country — NO GEOMETRY assembled`);
  }

  // ── regions (admin_level 4, discovered by ISO3166-2 prefix) ───────────────
  const rj = await cached(`regions-${c.code}`, () =>
    overpass(
      `[out:json][timeout:300];relation["boundary"="administrative"]["admin_level"="4"]["ISO3166-2"~"^${c.code}-"];out geom;`,
      `regions-${c.code}`));
  let n = 0;
  for (const rel of (rj.elements ?? []).filter((e) => e.type === 'relation')) {
    const g = relationToPolygon(rel);
    if (!g) { console.warn(`[admin] ${c.code} region ${rel.id} — no geometry, skipped`); continue; }
    out.push({
      level: 'region', country_code: c.code,
      ref_id: rel.tags?.['ISO3166-2'] ?? String(rel.id),
      osm_id: rel.id,
      name_ar: rel.tags?.['name:ar'] ?? rel.tags?.name ?? null,
      name_en: rel.tags?.['name:en'] ?? null,
      geometry_geojson: g,
    });
    n++;
  }
  console.log(`[admin] ${c.code} regions → ${n}`);
}

writeFileSync(join(__dirname, 'admin-boundaries.json'), JSON.stringify(out, null, 1));
console.log(`\n[admin] wrote ${out.length} boundaries → data/source/geo/admin-boundaries.json`);
console.log(out.map((o) => `  ${o.level} ${o.country_code} ${o.ref_id} ${o.name_ar ?? ''}`).join('\n'));
