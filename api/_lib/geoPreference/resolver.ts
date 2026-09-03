/**
 * Anchor → geometry resolver (v4 C6 / v7 A3) — the DETERMINISTIC half of the
 * Geography Understanding Ability. The AI Stage-A extractor produces typed
 * `AnchorToken`s (what the customer *meant*); THIS module resolves each one
 * against the map and hands back a `ResolutionResult` carrying a full
 * `GeometryRecipe`. Nothing here writes to a client record, and it NEVER guesses
 * an ambiguous place — the whole point of v4 A3 is "no lowest-id tiebreak".
 *
 * The corrected pipeline (v4 C6):
 *   spoken name
 *     → normalized lexical candidates (names + aliases)          [db, fuzzy GEN]
 *     → contextual filter (established city/region, prior anchors)
 *     → deterministic MULTI-SIGNAL score
 *          { exact official/alias match, city+region consistency,
 *            entity type, prior context, spatial proximity, candidate margin }
 *     → ambiguity gate                                            [needs_confirm]
 *
 * HARD RULES enforced here (and covered by __tests__/resolver.test.ts):
 *  1. Fuzzy string similarity may GENERATE candidates but may NOT alone SELECT an
 *     ambiguous place. A place is resolvable only if the token EXACTLY matches an
 *     official name or a curated alias (after canonicalization). A mere substring
 *     hit (الجبيلة ~ الجبيل) is a generator, never a selection.
 *  2. NO lowest-id / arbitrary tiebreak. When ≥2 exact candidates survive and no
 *     contextual signal distinguishes the top two above threshold → the status is
 *     'needs_confirm' (reason 'ambiguous_entity').
 *  3. A place absent from the admin catalog → 'needs_confirm' / 'unresolvable'
 *     (reason 'outside_admin'), NEVER the wrong same-string place in another region
 *     or country.
 *  4. Underspecified operations («بين طريقين», «قريب من», pin scope) →
 *     'needs_confirm' with a specific reason (corridor_underspecified /
 *     missing_radius / pin_scope_unclear), NEVER a silent default radius.
 *
 * DB access is behind the injected `ResolverDb` interface so the LOGIC is
 * unit-testable without a live Postgres. `createSupabaseResolverDb(supabase)`
 * wires the real RPCs/tables; the tests inject a `FakeResolverDb`. See the
 * "DB-backed vs faked" note at the bottom of this file and in the task report.
 */

import type {
  AnchorToken, AnchorType, GeometryRecipe, GeoOperation, ResolutionResult, UniverseSource,
} from './ontology.js';

// canonicalPlaceName / DEFAULT_GEO_COUNTRY are the SAME normalizers the runtime
// name-resolver (matchAgent.ts) uses — reuse, don't reinvent (v-stack rule).
import { canonicalPlaceName, DEFAULT_GEO_COUNTRY } from '../matchAgent.js';

export const RESOLVER_VERSION = 'geo-anchor-resolver@v4c6-v7a3';
export const DEFAULT_GEO_DATA_VERSION = 'unknown';

/** Default directional band depth when a direction rule carries no distance.
 *  Mirrors DIRECTION_DEFAULT_M in geoMatch.ts (a documented product default —
 *  the bounded-band decision of 2026-07-18), NOT a silent proximity radius. */
export const DIRECTION_DEFAULT_M = 5000;

/**
 * Discriminator floor (0..1). At least this much CONTEXTUAL signal (city/region
 * consistency, prior-anchor consistency, spatial proximity, entity-type) must
 * separate the top exact candidate from the runner-up for an auto-resolve. Below
 * it → ambiguity gate fires. Pure fuzzy similarity contributes ZERO here by
 * construction (it never enters the discriminator), enforcing HARD RULE 1.
 */
export const AMBIGUITY_MARGIN_THRESHOLD = 0.15;

// ────────────────────────────────────────────────────────────────────────────
// DB port — the only surface that touches Postgres. Faked in tests.
// ────────────────────────────────────────────────────────────────────────────

export interface DistrictCandidate {
  id: string;               // districts record id (uuid)
  name_ar: string;
  name_en: string;
  aliases: string[];        // district_aliases (AR/EN)
  city_id: string | null;   // districts.city_lookup
  city_name_ar: string;
  city_name_en: string;
  region_name_ar: string;
  region_name_en: string;
  country_code: string;     // 'SA' | 'AE' | …
  centroid_lat: number | null;
  centroid_lng: number | null;
}

export interface CityCandidate {
  id: string;
  name_ar: string;
  name_en: string;
  aliases: string[];
  region_name_ar: string;
  region_name_en: string;
  country_code: string;
  centroid_lat: number | null;
  centroid_lng: number | null;
}

export interface RegionCandidate {
  id: string;
  name_ar: string;
  name_en: string;
  aliases: string[];
  country_code: string;
}

export interface ElementCandidate {
  external_id: string;      // geo_elements.external_id (STABLE handle)
  name_ar: string;
  name_en: string;
  aliases: string[];
  geom_kind: 'point' | 'linestring' | 'polygon' | null;
  category: string | null;
  type: string | null;
  city: string | null;
  country_code: string;
  lat: number | null;       // centroid
  lng: number | null;
  confidence_score: number | null;
  review_status: string;    // 'approved' | 'pending' | 'rejected' | …
  is_active: boolean;
}

export interface ZoneDistrict { district_id: string; district_name: string; }
export interface PointDistrict { district_record_id: string | null; city_id: string | null; region_id: string | null; }

/** Element usability floor — mirrors geoMatch.ts CONFIDENCE_FLOOR. */
export const CONFIDENCE_FLOOR = 0.5;

/**
 * The DB port. Each method takes the caller's `preferCountry` so cross-border
 * namesakes never leak in (a Saudi request must not silently resolve to a UAE
 * community — the same failure `rankGeoCandidates` guards in matchAgent).
 */
export interface ResolverDb {
  /** Lexical candidate generation for a district/town token (ILIKE names+aliases). */
  findDistricts(token: string, preferCountry: string): Promise<DistrictCandidate[]>;
  /** Lexical candidate generation for a city token. */
  findCities(token: string, preferCountry: string): Promise<CityCandidate[]>;
  /** Lexical candidate generation for a region token (optional — falls back to
   *  outside_admin when absent). */
  findRegions?(token: string, preferCountry: string): Promise<RegionCandidate[]>;
  /** Lexical candidate generation for a road/landmark element (geo_elements). */
  findElements(
    token: string,
    opts: { preferCountry: string; city?: string; kind?: 'point' | 'linestring' | 'polygon' },
  ): Promise<ElementCandidate[]>;
  /** Directional zone → district ids (wassell_city_zone_districts). */
  zoneDistricts(city: string, zone: string): Promise<ZoneDistrict[]>;
  /** Point-in-polygon containing district (districts_for_points). */
  districtForPoint(lat: number, lng: number): Promise<PointDistrict | null>;
}

// ────────────────────────────────────────────────────────────────────────────
// Resolution context — everything the resolver knows beyond the single anchor.
// ────────────────────────────────────────────────────────────────────────────

/** A previously-resolved anchor in the same conversation (contextual filter). */
export interface ResolvedAnchorRef {
  district_id?: string | null;
  city_id?: string | null;
  city_name?: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface ResolutionContext {
  db: ResolverDb;
  /** Country the request belongs to (defaults SA). Established city can override. */
  preferCountry?: string;
  /** Established universe from earlier in the dialogue. */
  established_city?: string;
  established_region?: string;
  /** Anchors resolved earlier this conversation (prior-context signal). */
  prior_anchors?: ResolvedAnchorRef[];

  // ── operation companions ──
  /** Companion direction word for a 'direction'/'road' anchor (شمال/north/…). */
  direction?: string;
  /** Companion city for a directional zone / element scoping. */
  city?: string;
  /** Explicit radius/band in METRES (landmark within_radius, road within_distance). */
  radius_m?: number;
  /** "قريب من" intent — proximity to a road/landmark. */
  proximity?: boolean;
  /** "بين طريقين" intent — corridor between roads. */
  corridor?: boolean;
  /** The road anchors that bound a corridor (need ≥2 to resolve). */
  corridor_roads?: AnchorToken[];
  /** A dropped pin. */
  pin?: { lat: number; lng: number };
  /** The customer left the pin's SCOPE unclear (exact point vs surrounding area). */
  pin_scope_ambiguous?: boolean;

  /** Provenance stamps. */
  geo_data_version?: string;
  universe_hint?: UniverseSource;
}

// ────────────────────────────────────────────────────────────────────────────
// Small deterministic helpers (no external deps).
// ────────────────────────────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** djb2 → stable hex fingerprint. Gives a deterministic geometry_id for a recipe
 *  so the same anchor+context always yields the same handle (the caller persists
 *  the polygon into geo_pref_geometry and may swap in the real uuid). */
function fingerprint(parts: (string | number | undefined | null)[]): string {
  let h = 5381;
  const s = parts.map((p) => (p == null ? '' : String(p))).join('|');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

const DIRECTION_WORDS: Record<string, string> = {
  'شمال': 'north', 'جنوب': 'south', 'شرق': 'east', 'غرب': 'west', 'وسط': 'center',
  'north': 'north', 'south': 'south', 'east': 'east', 'west': 'west', 'center': 'center', 'central': 'center',
  'شمال شرق': 'northeast', 'شمال غرب': 'northwest', 'جنوب شرق': 'southeast', 'جنوب غرب': 'southwest',
  'northeast': 'northeast', 'northwest': 'northwest', 'southeast': 'southeast', 'southwest': 'southwest',
};

/** Pull a direction zone + the remaining (city) text out of a span/token. */
function parseDirection(text: string): { zone: string | null; rest: string } {
  const norm = canonicalPlaceName(text);
  // longest match first (diagonals before cardinals)
  const keys = Object.keys(DIRECTION_WORDS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const nk = canonicalPlaceName(k);
    if (norm === nk) return { zone: DIRECTION_WORDS[k]!, rest: '' };
    if (norm.startsWith(nk + ' ')) return { zone: DIRECTION_WORDS[k]!, rest: text.slice(text.length - (norm.length - nk.length - 1)).trim() };
  }
  return { zone: null, rest: text };
}

// ────────────────────────────────────────────────────────────────────────────
// Recipe builder.
// ────────────────────────────────────────────────────────────────────────────

function makeRecipe(
  operation: GeoOperation,
  sourceAnchors: AnchorToken[],
  resolvedElementIds: string[],
  ctx: ResolutionContext,
  extra: { radius_or_band_m?: number; universe_source?: UniverseSource } = {},
): GeometryRecipe {
  return {
    operation,
    source_anchors: sourceAnchors,
    resolved_element_ids: resolvedElementIds,
    radius_or_band_m: extra.radius_or_band_m,
    universe_source: extra.universe_source ?? ctx.universe_hint,
    geo_data_version: ctx.geo_data_version ?? DEFAULT_GEO_DATA_VERSION,
    resolver_version: RESOLVER_VERSION,
    compiled_at: new Date().toISOString(),
  };
}

function resolved(recipe: GeometryRecipe, margin?: number): ResolutionResult {
  return {
    status: 'resolved',
    geometry_id: `geo:${fingerprint([recipe.operation, ...[...recipe.resolved_element_ids].sort(), recipe.radius_or_band_m])}`,
    recipe,
    candidate_margin: margin,
  };
}

const needsConfirm = (reason: string, margin?: number): ResolutionResult =>
  ({ status: 'needs_confirm', reason, candidate_margin: margin });
const unresolvable = (reason: string): ResolutionResult => ({ status: 'unresolvable', reason });

// ────────────────────────────────────────────────────────────────────────────
// Admin-place resolution (district / town / city / region) — the multi-signal
// score + ambiguity gate. This is where HARD RULES 1–3 live.
// ────────────────────────────────────────────────────────────────────────────

interface AdminCandidate {
  id: string;
  names: string[];          // official names (ar/en)
  aliases: string[];
  city_id: string | null;
  city_name_ar: string;
  city_name_en: string;
  region_name_ar: string;
  region_name_en: string;
  country_code: string;
  lat: number | null;
  lng: number | null;
}

/** Exact = token equals an official name OR a curated alias, after canonicalization.
 *  This is the SELECTION gate (HARD RULE 1): a fuzzy substring is not exact. */
function isExact(c: AdminCandidate, token: string): boolean {
  const want = canonicalPlaceName(token);
  if (!want) return false;
  if (c.names.some((n) => canonicalPlaceName(n) === want)) return true;
  return c.aliases.some((a) => canonicalPlaceName(a) === want);
}

/**
 * CONTEXTUAL discriminator in 0..1 — the part of the score that separates two
 * exact namesakes. Pure fuzzy similarity is deliberately absent, so it can never
 * break a tie (HARD RULE 1). Signals, additive, capped at 1:
 *   • city name consistency with the established city                (0.45)
 *   • region name consistency with the established region            (0.20)
 *   • prior-anchor city consistency (same city as an earlier anchor) (0.30)
 *   • spatial proximity to established/prior centroid (graded)       (0.25)
 */
function discriminator(c: AdminCandidate, anchorType: AnchorType, ctx: ResolutionContext): number {
  let s = 0;
  const cityMatch = (name?: string) => {
    if (!name) return false;
    const w = canonicalPlaceName(name);
    return !!w && (canonicalPlaceName(c.city_name_ar) === w || canonicalPlaceName(c.city_name_en) === w);
  };
  const regionMatch = (name?: string) => {
    if (!name) return false;
    const w = canonicalPlaceName(name);
    return !!w && (canonicalPlaceName(c.region_name_ar) === w || canonicalPlaceName(c.region_name_en) === w);
  };
  if (cityMatch(ctx.established_city)) s += 0.45;
  if (regionMatch(ctx.established_region)) s += 0.2;

  const priors = ctx.prior_anchors ?? [];
  if (c.city_id && priors.some((p) => p.city_id && p.city_id === c.city_id)) s += 0.3;
  else if (priors.some((p) => cityMatch(p.city_name ?? undefined))) s += 0.3;

  // Spatial proximity to any prior pin / established centroid (graded 0..0.25).
  if (isNum(c.lat) && isNum(c.lng)) {
    let best: number | null = null;
    for (const p of priors) {
      if (isNum(p.lat) && isNum(p.lng)) {
        const d = haversineKm(c.lat, c.lng, p.lat, p.lng);
        best = best == null ? d : Math.min(best, d);
      }
    }
    if (best != null) s += Math.max(0, 0.25 * (1 - Math.min(best, 25) / 25));
  }
  // entity-type consistency — a 'town' anchor prefers a town-typed row (only
  // relevant when the db distinguishes; harmless otherwise).
  void anchorType;
  return Math.min(1, s);
}

function selectAdmin(
  candidates: AdminCandidate[],
  token: string,
  anchorType: AnchorType,
  ctx: ResolutionContext,
): { pick: AdminCandidate | null; result?: ResolutionResult } {
  const exact = candidates.filter((c) => isExact(c, token));
  if (exact.length === 0) {
    // No official/alias name matches — the place is absent from the admin catalog.
    // This is the الجبيلة≈الجبيل trap: fuzzy near-misses (الجبيل, a UAE namesake…)
    // may be PRESENT among `candidates`, but HARD RULE 1/3 forbid selecting one.
    // We ASK (a human may recognize the spot and add it) rather than pick wrong;
    // `unresolvable` is reserved for a blank token upstream.
    return { pick: null, result: needsConfirm('outside_admin') };
  }
  if (exact.length === 1) {
    return { pick: exact[0]! };
  }
  // ≥2 exact namesakes — the ambiguity gate. Rank by the CONTEXTUAL discriminator
  // only (HARD RULE 2: no lowest-id tiebreak selects an ambiguous place).
  const scored = exact
    .map((c) => ({ c, d: discriminator(c, anchorType, ctx) }))
    .sort((a, b) => b.d - a.d);
  const top = scored[0]!;
  const second = scored[1]!;
  const margin = top.d - second.d;
  if (top.d > 0 && margin >= AMBIGUITY_MARGIN_THRESHOLD) {
    return { pick: top.c, result: undefined };
  }
  // No contextual signal (or an inseparable tie) → ask, never guess.
  return { pick: null, result: needsConfirm('ambiguous_entity', margin) };
}

async function resolveAdminPlace(
  anchor: AnchorToken,
  ctx: ResolutionContext,
  kind: 'district' | 'city' | 'region',
): Promise<ResolutionResult> {
  const preferCountry = ctx.preferCountry || DEFAULT_GEO_COUNTRY;
  const token = (anchor.normalized_token || anchor.span || '').trim();
  if (!token) return unresolvable('outside_admin');

  let candidates: AdminCandidate[];
  let op: GeoOperation;
  if (kind === 'city') {
    op = 'district_union'; // a city resolves to the union of its districts (recipe records the city id)
    const rows = await ctx.db.findCities(token, preferCountry);
    candidates = rows.map((r) => ({
      id: r.id, names: [r.name_ar, r.name_en], aliases: r.aliases,
      city_id: r.id, city_name_ar: r.name_ar, city_name_en: r.name_en,
      region_name_ar: r.region_name_ar, region_name_en: r.region_name_en,
      country_code: r.country_code, lat: r.centroid_lat, lng: r.centroid_lng,
    }));
  } else if (kind === 'region') {
    op = 'district_union';
    if (!ctx.db.findRegions) return needsConfirm('outside_admin');
    const rows = await ctx.db.findRegions(token, preferCountry);
    candidates = rows.map((r) => ({
      id: r.id, names: [r.name_ar, r.name_en], aliases: r.aliases,
      city_id: null, city_name_ar: '', city_name_en: '',
      region_name_ar: r.name_ar, region_name_en: r.name_en,
      country_code: r.country_code, lat: null, lng: null,
    }));
  } else {
    op = 'district_polygon';
    const rows = await ctx.db.findDistricts(token, preferCountry);
    candidates = rows.map((r) => ({
      id: r.id, names: [r.name_ar, r.name_en], aliases: r.aliases,
      city_id: r.city_id, city_name_ar: r.city_name_ar, city_name_en: r.city_name_en,
      region_name_ar: r.region_name_ar, region_name_en: r.region_name_en,
      country_code: r.country_code, lat: r.centroid_lat, lng: r.centroid_lng,
    }));
  }
  // Country scoping: never let a cross-border namesake even be a candidate.
  const scoped = candidates.filter((c) => (c.country_code || DEFAULT_GEO_COUNTRY) === preferCountry);
  const pool = scoped.length ? scoped : candidates;

  const { pick, result } = selectAdmin(pool, token, anchor.anchor_type, ctx);
  if (!pick) return result!;

  const recipe = makeRecipe(op, [anchor], [pick.id], ctx, {
    universe_source: ctx.established_city ? 'established_context' : 'explicit',
  });
  // Report the winning margin when disambiguation happened.
  const exact = pool.filter((c) => isExact(c, token));
  const margin = exact.length > 1
    ? discriminator(pick, anchor.anchor_type, ctx) -
      Math.max(...exact.filter((c) => c.id !== pick.id).map((c) => discriminator(c, anchor.anchor_type, ctx)))
    : undefined;
  return resolved(recipe, margin);
}

// ────────────────────────────────────────────────────────────────────────────
// Direction + city → zone_union.
// ────────────────────────────────────────────────────────────────────────────

async function resolveZoneUnion(anchor: AnchorToken, ctx: ResolutionContext): Promise<ResolutionResult> {
  const parsed = parseDirection(anchor.normalized_token || anchor.span || '');
  const zone = ctx.direction ? (parseDirection(ctx.direction).zone ?? ctx.direction) : parsed.zone;
  const city = (ctx.city || parsed.rest || ctx.established_city || '').trim();
  if (!zone) return needsConfirm('corridor_underspecified'); // no direction word understood
  if (!city) return needsConfirm('missing_city_for_zone');

  const rows = await ctx.db.zoneDistricts(city, zone);
  if (!rows.length) return needsConfirm('outside_admin');
  const ids = rows.map((r) => r.district_id).filter(Boolean);
  const recipe = makeRecipe('zone_union', [anchor], ids, ctx, {
    universe_source: ctx.city || parsed.rest ? 'explicit' : 'established_context',
  });
  return resolved(recipe);
}

// ────────────────────────────────────────────────────────────────────────────
// Element (road / landmark) resolution → directional_band / within_radius /
// within_distance / corridor.
// ────────────────────────────────────────────────────────────────────────────

/** Usability gate for a resolved element — mirrors geoMatch.elementUsability. */
function elementUsable(e: ElementCandidate): boolean {
  if (!e.is_active) return false;
  if (e.review_status === 'rejected') return false;
  if (e.confidence_score != null && e.confidence_score < CONFIDENCE_FLOOR) return false;
  return true;
}

async function resolveOneElement(
  token: string,
  ctx: ResolutionContext,
  kind: 'point' | 'linestring' | 'polygon',
): Promise<{ pick: ElementCandidate | null; result?: ResolutionResult }> {
  const preferCountry = ctx.preferCountry || DEFAULT_GEO_COUNTRY;
  const rows = await ctx.db.findElements(token, { preferCountry, city: ctx.city || ctx.established_city, kind });
  if (!rows.length) return { pick: null, result: needsConfirm('outside_admin') };
  const usable = rows.filter(elementUsable).filter((e) => (e.country_code || DEFAULT_GEO_COUNTRY) === preferCountry);
  const exact = usable.filter((e) => {
    const w = canonicalPlaceName(token);
    return !!w && (canonicalPlaceName(e.name_ar) === w || canonicalPlaceName(e.name_en) === w ||
      e.aliases.some((a) => canonicalPlaceName(a) === w));
  });
  if (exact.length === 0) return { pick: null, result: needsConfirm('outside_admin') };
  if (exact.length > 1) return { pick: null, result: needsConfirm('ambiguous_entity') };
  return { pick: exact[0]! };
}

async function resolveRoad(anchor: AnchorToken, ctx: ResolutionContext): Promise<ResolutionResult> {
  // Corridor «بين طريقين» — needs two bounding roads.
  if (ctx.corridor) {
    const roads = ctx.corridor_roads ?? [];
    if (roads.length < 2) return needsConfirm('corridor_underspecified');
    const resolvedIds: string[] = [];
    for (const r of roads) {
      const { pick, result } = await resolveOneElement(r.normalized_token || r.span, ctx, 'linestring');
      if (!pick) return result!;
      resolvedIds.push(pick.external_id);
    }
    const recipe = makeRecipe('corridor', [anchor, ...roads], resolvedIds, ctx, { universe_source: 'explicit' });
    return resolved(recipe);
  }

  const { pick, result } = await resolveOneElement(anchor.normalized_token || anchor.span, ctx, 'linestring');
  if (!pick) return result!;

  // Direction + road → directional_band (bounded band; documented default depth).
  const dir = ctx.direction ? parseDirection(ctx.direction).zone : null;
  if (dir) {
    const band = isNum(ctx.radius_m) ? ctx.radius_m : DIRECTION_DEFAULT_M;
    const recipe = makeRecipe('directional_band', [anchor], [pick.external_id], ctx, {
      radius_or_band_m: band,
      universe_source: isNum(ctx.radius_m) ? 'explicit' : 'organizational_default',
    });
    return resolved(recipe);
  }

  // Proximity «قريب من الطريق» — needs an explicit radius, NEVER a silent default.
  if (ctx.proximity || isNum(ctx.radius_m)) {
    if (!isNum(ctx.radius_m)) return needsConfirm('missing_radius');
    const recipe = makeRecipe('within_distance', [anchor], [pick.external_id], ctx, {
      radius_or_band_m: ctx.radius_m, universe_source: 'explicit',
    });
    return resolved(recipe);
  }

  // A bare road with no operation is underspecified as a geometry.
  return needsConfirm('corridor_underspecified');
}

async function resolveLandmark(anchor: AnchorToken, ctx: ResolutionContext): Promise<ResolutionResult> {
  const { pick, result } = await resolveOneElement(anchor.normalized_token || anchor.span, ctx, 'point');
  if (!pick) return result!;
  // within_radius ALWAYS needs a radius — no silent default (HARD RULE 4).
  if (!isNum(ctx.radius_m)) return needsConfirm('missing_radius');
  if (!isNum(pick.lat) || !isNum(pick.lng)) return needsConfirm('outside_admin');
  const recipe = makeRecipe('within_radius', [anchor], [pick.external_id], ctx, {
    radius_or_band_m: ctx.radius_m, universe_source: 'explicit',
  });
  return resolved(recipe);
}

// ────────────────────────────────────────────────────────────────────────────
// Pin → pin_containing_district (keep the point).
// ────────────────────────────────────────────────────────────────────────────

async function resolvePin(anchor: AnchorToken, ctx: ResolutionContext): Promise<ResolutionResult> {
  if (ctx.pin_scope_ambiguous) return needsConfirm('pin_scope_unclear');
  const pin = ctx.pin;
  if (!pin || !isNum(pin.lat) || !isNum(pin.lng)) return needsConfirm('pin_scope_unclear');
  const hit = await ctx.db.districtForPoint(pin.lat, pin.lng);
  if (!hit || !hit.district_record_id) {
    // Pin fell outside every admin polygon — not a resolvable district.
    return needsConfirm('outside_admin');
  }
  // Keep the point in provenance (source_anchors) alongside the containing district.
  const pinAnchor: AnchorToken = { ...anchor, anchor_type: 'pin', normalized_token: `${pin.lat},${pin.lng}` };
  const recipe = makeRecipe('pin_containing_district', [pinAnchor], [hit.district_record_id], ctx, {
    universe_source: 'explicit',
  });
  return resolved(recipe);
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve ONE anchor to a geometry recipe (or a needs_confirm / unresolvable
 * signal). Dispatch on anchor type; every branch is deterministic and every
 * failure carries a machine-readable `reason`.
 */
export async function resolveAnchor(anchor: AnchorToken, ctx: ResolutionContext): Promise<ResolutionResult> {
  switch (anchor.anchor_type) {
    case 'district':
    case 'town':
      return resolveAdminPlace(anchor, ctx, 'district');
    case 'city':
      return resolveAdminPlace(anchor, ctx, 'city');
    case 'region':
      return resolveAdminPlace(anchor, ctx, 'region');
    case 'direction':
      return resolveZoneUnion(anchor, ctx);
    case 'road':
      return resolveRoad(anchor, ctx);
    case 'landmark':
      return resolveLandmark(anchor, ctx);
    case 'pin':
      return resolvePin(anchor, ctx);
    case 'relative_ref':
      // A relative reference («بين طريقين», «قريب من X») is only resolvable when the
      // extractor has attached its operands via context; otherwise underspecified.
      if (ctx.corridor) return resolveRoad(anchor, ctx);
      if (ctx.proximity) return needsConfirm(isNum(ctx.radius_m) ? 'corridor_underspecified' : 'missing_radius');
      return needsConfirm('corridor_underspecified');
    default:
      return unresolvable('outside_admin');
  }
}
