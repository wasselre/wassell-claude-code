#!/usr/bin/env node
/**
 * Fetch raw OpenStreetMap geo-intelligence for the Saudi cities listed in
 * cities.json, via the Overpass API.
 *
 *   node data/source/geo/fetch.mjs                 # all cities in cities.json
 *   node data/source/geo/fetch.mjs JED DMM         # only these prefixes
 *   node data/source/geo/fetch.mjs --force         # ignore the raw/ cache
 *
 * Writes one cached JSON per (city, group) to raw/<PREFIX>-<group>.json. Re-running
 * is a no-op for anything already cached, so a partial/interrupted run resumes
 * cheaply — Overpass is a donated public service and we do not re-ask for data we
 * already have.
 *
 * THREE grouped queries per city (not one per category): 20 cities x 3 = 60
 * requests total. Categories are NOT baked into the query — process.mjs derives
 * category/type from the OSM tags, so the taxonomy lives in exactly one place.
 *
 * Politeness: strictly sequential, PAUSE_MS between calls, exponential backoff on
 * 429 / 504 / gateway errors, and a hard cap on attempts. Do not parallelise this.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = join(__dirname, 'raw');
const CITIES = JSON.parse(readFileSync(join(__dirname, 'cities.json'), 'utf8'));

// Several independent Overpass mirrors. Rotated PER REQUEST, not just on retry:
// the public instances rate-limit per client IP, and this machine can have more
// than one geo extract running at once (a parallel worktree was mid-run against
// overpass-api.de during this build), so a single endpoint means both jobs queue
// behind the same quota. Measured before the rotation: ~3.75 min per group, almost
// all of it 429/504 backoff — a projected 3+ hours for 60 groups.
// ONLY mirrors carrying the WHOLE PLANET. This list is not a place to be creative:
// several public Overpass instances serve a REGIONAL extract, and they answer an
// out-of-region query with HTTP 200 + `{"elements":[]}` and no remark — a silent
// wrong answer that is indistinguishable from "this city genuinely has none".
// Measured 2026-07-30: overpass.osm.ch returned 2 hospitals for a Zurich bbox and
// 0 for Buraidah, both 200. It and overpass.osm.jp (Japan) were briefly in this
// pool and silently emptied 22 of 59 groups. Verify planet coverage against a
// known-populated foreign bbox before adding any endpoint here.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const PAUSE_MS = 1500;
// 3 mirrors x 3 full rounds. Needs to be a comfortable multiple of ENDPOINTS.length:
// confirming a genuinely-empty result costs TWO successful responses from distinct
// hosts, and under congestion most attempts are 504s that buy nothing.
const MAX_ATTEMPTS = 9;
const TIMEOUT_S = 300;
const COOLDOWN_MS = 90_000; // how long to skip an endpoint that just throttled us

// ── Selector groups ─────────────────────────────────────────────────────────
// Kept deliberately tag-explicit. Every selector requires the element to carry a
// name where an unnamed feature would be useless as a matching anchor (a nameless
// park cannot be referenced by a client rule); POI amenities are kept even when
// unnamed only if they have a real footprint, and process.mjs drops the rest.
const GROUPS = {
  transport: `
    way["highway"~"^(motorway|trunk|primary)$"]["name"](BBOX);
    way["highway"~"^(motorway|trunk|primary|secondary)$"]["name"~"[Rr]ing|دائري"](BBOX);
    relation["type"="route"]["route"="road"]["name"~"[Rr]ing|دائري"](BBOX);
    relation["route"~"^(subway|light_rail|monorail)$"](BBOX);
    node["railway"="station"](BBOX);
    way["railway"="station"](BBOX);
    node["railway"="halt"]["station"~"^(subway|light_rail)$"](BBOX);
    node["amenity"="bus_station"](BBOX);
    way["amenity"="bus_station"](BBOX);
    way["aeroway"="aerodrome"](BBOX);
    relation["aeroway"="aerodrome"](BBOX);
    node["aeroway"="aerodrome"](BBOX);
  `,
  pois: `
    node["shop"="mall"](BBOX);
    way["shop"="mall"](BBOX);
    relation["shop"="mall"](BBOX);
    node["amenity"="university"](BBOX);
    way["amenity"="university"](BBOX);
    relation["amenity"="university"](BBOX);
    node["amenity"="hospital"](BBOX);
    way["amenity"="hospital"](BBOX);
    relation["amenity"="hospital"](BBOX);
    way["leisure"="park"]["name"](BBOX);
    relation["leisure"="park"]["name"](BBOX);
    way["tourism"="theme_park"](BBOX);
    relation["tourism"="theme_park"](BBOX);
    way["leisure"="water_park"](BBOX);
    node["tourism"="museum"](BBOX);
    way["tourism"="museum"](BBOX);
    node["historic"]["name"](BBOX);
    way["historic"]["name"](BBOX);
    node["man_made"="tower"]["name"](BBOX);
    way["man_made"="tower"]["name"](BBOX);
    node["tourism"="attraction"]["name"](BBOX);
    way["tourism"="attraction"]["name"](BBOX);
  `,
  // Deliberately NOT `office=*`: that tag marks a single office building (a labour
  // office, a tax authority branch), not a business district. Including it filled
  // the category with government departments — 31 of Jazan's first 77 anchors. A
  // business zone must be a named commercial/retail LAND USE area.
  landuse: `
    way["landuse"~"^(commercial|retail)$"]["name"](BBOX);
    relation["landuse"~"^(commercial|retail)$"]["name"](BBOX);
  `,
};

function buildQuery(selectors, bbox) {
  const bb = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const body = selectors.trim().split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => '  ' + l.replace(/\(BBOX\)/g, `(${bb})`))
    .join('\n');
  // `out geom` returns tags + inline geometry for ways and relation members —
  // which is what lets process.mjs build real GeoJSON instead of bare centroids.
  return `[out:json][timeout:${TIMEOUT_S}];\n(\n${body}\n);\nout geom;`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── endpoint rotation with per-endpoint cooldown ────────────────────────────
let rr = 0;
const cooldownUntil = new Map();

/** Next endpoint that isn't cooling down; if all are, the one free soonest. */
function nextEndpoint() {
  const now = Date.now();
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const ep = ENDPOINTS[(rr + i) % ENDPOINTS.length];
    if ((cooldownUntil.get(ep) ?? 0) <= now) {
      rr = (rr + i + 1) % ENDPOINTS.length;
      return { endpoint: ep, waitMs: 0 };
    }
  }
  let best = ENDPOINTS[0], bestAt = cooldownUntil.get(ENDPOINTS[0]) ?? 0;
  for (const ep of ENDPOINTS) {
    const at = cooldownUntil.get(ep) ?? 0;
    if (at < bestAt) { best = ep; bestAt = at; }
  }
  return { endpoint: best, waitMs: Math.max(0, bestAt - now) };
}

async function overpass(query, label) {
  let lastErr;
  // Distinct hosts that returned a clean empty result for THIS query.
  const emptyHosts = new Set();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { endpoint, waitMs } = nextEndpoint();
    if (waitMs > 0) {
      console.warn(`[fetch] ${label} — every mirror cooling down, waiting ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'wassel-crm-geo-intelligence/1.0 (real-estate matching; contact r.abanumay@wassel.re)',
        },
        body: new URLSearchParams({ data: query }),
      });
      if (res.status === 429 || res.status === 504 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} from ${new URL(endpoint).host}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const json = await res.json();
      if (!Array.isArray(json?.elements)) throw new Error('no elements array in response');

      // Overpass reports RUNTIME failures — query timeout, dispatcher error, out of
      // memory — as HTTP 200 with an empty `elements` array and an error string in
      // `remark`. Accepting that as success is how 22 of 59 groups silently came
      // back empty on the first full run (Buraidah with zero POIs *and* zero
      // transport, Dammam with zero landuse). Treat it as the failure it is.
      const remark = typeof json.remark === 'string' ? json.remark : '';
      if (/error|timed out|timeout|exceeded|abort/i.test(remark)) {
        throw new Error(`overpass remark: ${remark.slice(0, 200)}`);
      }

      // A clean, remark-free empty result is AMBIGUOUS: genuinely empty (most
      // cities have no metro) or a quietly unhealthy instance. Distinguish by
      // asking a DIFFERENT mirror — only believe empty once two distinct hosts
      // independently agree. Never silently accept the first empty answer.
      if (json.elements.length === 0) {
        emptyHosts.add(new URL(endpoint).host);
        if (emptyHosts.size < 2 && attempt < MAX_ATTEMPTS) {
          throw new Error(`empty result from ${new URL(endpoint).host} — confirming on another mirror`);
        }
        console.log(`[fetch] ${label} — empty confirmed by ${[...emptyHosts].join(' + ')}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      // Park the endpoint that just refused us and move straight to another
      // mirror instead of sleeping on the same one. Only pause when we've been
      // round the whole pool, which is the signal that we're genuinely over
      // quota everywhere rather than just unlucky with one instance.
      // The empty-confirmation probe is not a fault — that mirror answered fine,
      // we just want a second opinion. Don't cool it down or we'd burn the pool.
      const isConfirmProbe = /confirming on another mirror/.test(err.message);
      if (!isConfirmProbe) cooldownUntil.set(endpoint, Date.now() + COOLDOWN_MS);
      console.warn(`[fetch] ${label} attempt ${attempt}/${MAX_ATTEMPTS} on ${new URL(endpoint).host} ${isConfirmProbe ? 'returned empty' : 'failed'}: ${err.message}`);
      if (attempt < MAX_ATTEMPTS && attempt % ENDPOINTS.length === 0) {
        const backoff = Math.min(60000, 5000 * 2 ** (attempt / ENDPOINTS.length - 1));
        console.warn(`[fetch] whole pool refused — backing off ${backoff / 1000}s`);
        await sleep(backoff);
      }
    }
  }
  throw new Error(`${label}: exhausted ${MAX_ATTEMPTS} attempts — last error: ${lastErr?.message}`);
}

// ── main ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const only = argv.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase());
const targets = only.length ? CITIES.filter((c) => only.includes(c.prefix)) : CITIES;

if (!targets.length) {
  console.error(`No cities matched ${JSON.stringify(only)}. Known prefixes: ${CITIES.map((c) => c.prefix).join(', ')}`);
  process.exit(1);
}
mkdirSync(RAW, { recursive: true });

console.log(`[fetch] ${targets.length} cities x ${Object.keys(GROUPS).length} groups (force=${force})`);
let fetched = 0, cached = 0;
const failures = [];

for (const city of targets) {
  for (const [group, selectors] of Object.entries(GROUPS)) {
    const out = join(RAW, `${city.prefix}-${group}.json`);
    const label = `${city.prefix}/${group}`;
    if (!force && existsSync(out)) { cached++; console.log(`[fetch] ${label} — cached`); continue; }
    const query = buildQuery(selectors, city.bbox);
    try {
      const json = await overpass(query, label);
      writeFileSync(out, JSON.stringify({
        _meta: {
          city_prefix: city.prefix, spl_city_id: city.spl_city_id,
          name_en: city.name_en, group, bbox: city.bbox,
          fetched_at: new Date().toISOString(),
        },
        elements: json.elements,
      }, null, 1));
      fetched++;
      console.log(`[fetch] ${label} — ${json.elements.length} elements → ${out}`);
    } catch (err) {
      // Recorded and reported at the end, never swallowed: a missing group means
      // that city is under-covered and the operator must know which one to re-run.
      failures.push({ label, error: err.message });
      console.error(`[fetch] ${label} — FAILED: ${err.message}`);
    }
    await sleep(PAUSE_MS);
  }
}

console.log(`\n[fetch] done. fetched=${fetched} cached=${cached} failed=${failures.length}`);
if (failures.length) {
  console.error(`[fetch] FAILURES (re-run with the listed prefixes):`);
  for (const f of failures) console.error(`  - ${f.label}: ${f.error}`);
  process.exit(1);
}
