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
 *  5. A VETO only asks (2026-10-04): the namesake vetoes (a referent that may be
 *     a city or a district rather than a road), the venue prefix namesakes (I7)
 *     and the contradicted established city (I9) turn a pick into
 *     needs_confirm — they never choose another place. An `ask_reason` from
 *     the anchor preparation short-circuits everything.
 *
 * Every resolved result carries `facts` (the scope city, the element's city,
 * the districts' cities, where a radius came from) for the demote-only checks
 * in invariants.ts. Facts live in memory only — never in a recipe.
 *
 * DB access is behind the injected `ResolverDb` interface so the LOGIC is
 * unit-testable without a live Postgres. `createSupabaseResolverDb(supabase)`
 * wires the real RPCs/tables; the tests inject a `FakeResolverDb`. See the
 * "DB-backed vs faked" note at the bottom of this file and in the task report.
 */

import type {
  AnchorToken, AnchorType, CardinalSide, GeometryRecipe, GeoOperation, ResolutionFacts, ResolutionResult, UniverseSource,
} from './ontology.js';
import type { CheckName } from './invariants.js';

// canonicalPlaceName / DEFAULT_GEO_COUNTRY are the SAME normalizers the runtime
// name-resolver (matchAgent.ts) uses — reuse, don't reinvent (v-stack rule).
import { canonicalPlaceName, DEFAULT_GEO_COUNTRY } from '../matchAgent.js';
import { latinKey } from './latinNames.js';

/** Provenance only (stamped on every recipe). v5: city-first zones, namesake
 *  vetoes, venue clustering, the token union and the demote-only checks. */
export const RESOLVER_VERSION = 'geo-anchor-resolver@v5-checks';
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

/**
 * How a road runs (wassell_geo_road_axis): its east–west and north–south travel
 * in metres, measured inside the given districts (`scope 'district'`), else in a
 * window around them (`'window'`), else along the whole road (`'road'`).
 * `found:false` = no such active road — the checks ASK on it, never pass.
 */
export interface RoadAxis {
  found: boolean;
  scope?: 'district' | 'window' | 'road';
  ew_m?: number;
  ns_m?: number;
}

/** A catalogued element name / alias of 2+ words that occurs in a text (wassell_geo_names_in_text). */
export interface NameInText { external_id: string; name: string; category: string | null }

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
  /** Directional zone → district ids (wassell_city_zone_districts). THROWS on a
   *  database error — an empty list means "this city has no such zone". */
  zoneDistricts(city: string, zone: string): Promise<ZoneDistrict[]>;
  /** Point-in-polygon containing district (districts_for_points). THROWS on a database error. */
  districtForPoint(lat: number, lng: number): Promise<PointDistrict | null>;

  // The three ports below are REQUIRED on purpose: every fake must decide what
  // they answer (a compile error otherwise), and none may stub them as "always
  // valid" — an unwired check that passes is a silent hole.

  /** How a road runs, locally inside `districtIds` when given (see {@link RoadAxis}). THROWS on error. */
  roadAxis(externalId: string, districtIds?: string[]): Promise<RoadAxis>;
  /**
   * The ENGLISH label (cities.name_en — what geo_elements.city holds) of the
   * city an Arabic name names exactly (lexical variants), or of a Latin input
   * equal (case-insensitive) to some name_en; null when no city has that name.
   * THROWS on error.
   */
  cityLabel(cityAr: string): Promise<string | null>;
  /** Every catalogued element name / alias of 2+ words occurring in `text` (a candidate generator). THROWS on error. */
  namesInText(text: string): Promise<NameInText[]>;
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
  /**
   * Companion city: scopes every element (road / landmark) lookup to THIS city
   * instead of the established one, and is the zone referent of a BARE
   * direction («شمال جدة» split into [direction شمال, city جدة] → north
   * JEDDAH). A direction's own referent text («شمال الرياض», «غرب الملك فهد»)
   * always wins over it. anchorPrep.ts sets it from a city the customer named in
   * the same mention («بجدة شمال طريق الملك عبدالله»).
   */
  city?: string;
  /**
   * A district / town must lie in THIS city (the one the customer named beside
   * a road side or venue in the same mention). Candidates in other cities are
   * dropped; none left ⇒ needs_confirm('outside_admin'). anchorPrep.ts sets it,
   * so «الروضة شمال طريق الملك عبدالله بجدة» never clips Riyadh's الروضة by
   * Jeddah's road.
   */
  admin_city?: string;
  /**
   * The mention names SEVERAL cities («في الدمام او الخبر قريب من طريق الملك
   * فهد»): the element could be in either, so its lookup asks
   * (needs_confirm('ambiguous_entity')) rather than picking one city.
   */
  city_unclear?: boolean;
  /**
   * The direction's referent is a ROAD (a road anchor folded into it, a royal
   * short name «سلمان» → «الملك سلمان»): never try it as a city zone. Without
   * this, «شرق طريق الدمام» with normalized «الدمام» became the east of DAMMAM
   * CITY. A rest starting with «طريق / شارع / الطريق / الدائري» is treated the
   * same way without the flag ({@link isRoadReferentText}).
   */
  referent_is_road?: boolean;
  /**
   * The anchor preparation already decided this anchor must be ASKED about
   * (anchorPrep.ts: a referent it cannot tell, a distance not in the
   * customer's words, an anchor not in the text…). The orchestrator answers
   * needs_confirm(ask_reason) without resolving; {@link resolveAnchor} honours
   * it too, so no caller can resolve an anchor the preparation refused.
   */
  ask_reason?: string;
  /**
   * A BARE direction beside a city the customer named elsewhere in the mention
   * («في جدة بالشمال»): that city only CONFIRMS the established one — it never
   * moves the zone. The same city → the established zone; another city →
   * needs_confirm('zone_city_unclear') (Rule Z).
   */
  confirm_city?: string;
  /**
   * Another active mention of the conversation names a city other than the
   * established one (I9). Then the established city may not be ASSUMED: a bare
   * direction with no city of its own, and an element lookup with no named
   * scope, ask ('established_city_contradicted').
   */
  forbid_established?: boolean;
  /** TEST-ONLY: checks switched off (the monotonicity property). Never set in production. */
  disabled?: ReadonlySet<CheckName>;
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

/** A check is on unless a TEST switched it off ({@link ResolutionContext.disabled}). */
const enabled = (ctx: Pick<ResolutionContext, 'disabled'>, name: CheckName): boolean => !ctx.disabled?.has(name);

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

/** Pull a direction zone + the remaining referent text (a city OR a road) out of
 *  a span/token. Tolerates «الشمال» (article on the direction word) and the
 *  extractor's «شمال_الرياض» underscore artifact. */
export function parseDirection(text: string): { zone: string | null; rest: string } {
  const t = String(text ?? '').replace(/_/g, ' ').replace(/^\s*ال(?=(شمال|جنوب|شرق|غرب|وسط))/, '').trim();
  const norm = canonicalPlaceName(t);
  // longest match first (diagonals before cardinals)
  const keys = Object.keys(DIRECTION_WORDS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const nk = canonicalPlaceName(k);
    if (norm === nk) return { zone: DIRECTION_WORDS[k]!, rest: '' };
    if (norm.startsWith(nk + ' ')) return { zone: DIRECTION_WORDS[k]!, rest: t.slice(t.length - (norm.length - nk.length - 1)).trim() };
  }
  return { zone: null, rest: t };
}

const CARDINAL_ZONES = new Set(['north', 'south', 'east', 'west']);

/** The cardinal side of a parsed zone, else undefined (diagonals / «وسط» have no road side). */
export function cardinalSide(zone: string | null | undefined): CardinalSide | undefined {
  return zone && CARDINAL_ZONES.has(zone) ? (zone as CardinalSide) : undefined;
}

/** A direction's referent text that names a road by its road word («طريق الدمام», «الدائري الشمالي»). */
export function isRoadReferentText(rest: string): boolean {
  return /^(طريق|شارع|الطريق|الدائري)(\s|$)/.test(String(rest ?? '').replace(/ـ/g, '').trim());
}

/** A direction word (optionally with its article) followed by a space or the end. */
const DIRECTION_AHEAD = '(?:ال)?(?:شمال|جنوب|شرق|غرب|وسط)(?:\\s|$)';
const LEADING_PREPOSITION = new RegExp(`^(?:في|فى|على|علي|من)\\s+(?=${DIRECTION_AHEAD})`);
const LEADING_CLITIC = new RegExp(`^(?:و|ف)?(?:ب|ل)?(?=${DIRECTION_AHEAD})`);

/**
 * The customer's span with a leading preposition / clitic taken off its
 * direction word: «وجنوب سلمان» → «جنوب سلمان», «بالشمال» → «الشمال», «في
 * جنوب …» → «جنوب …». Only when a direction word follows, so «وسط» keeps its
 * «و» (the empty clitic is the only match that leaves a direction word after it).
 */
export function stripDirectionClitic(text: string): string {
  return String(text ?? '').trim().replace(LEADING_PREPOSITION, '').replace(LEADING_CLITIC, '');
}

/** The referent after the direction word in the customer's OWN span ('' when the span has no direction word). */
export function spanReferent(anchor: Pick<AnchorToken, 'span'>): string {
  const p = parseDirection(stripDirectionClitic(anchor.span ?? ''));
  return p.zone ? p.rest.trim() : '';
}

// ────────────────────────────────────────────────────────────────────────────
// Recipe builder.
// ────────────────────────────────────────────────────────────────────────────

function makeRecipe(
  operation: GeoOperation,
  sourceAnchors: AnchorToken[],
  resolvedElementIds: string[],
  ctx: ResolutionContext,
  extra: { radius_or_band_m?: number; universe_source?: UniverseSource; side?: CardinalSide } = {},
): GeometryRecipe {
  return {
    operation,
    source_anchors: sourceAnchors,
    resolved_element_ids: resolvedElementIds,
    radius_or_band_m: extra.radius_or_band_m,
    ...(extra.side ? { side: extra.side } : {}),
    universe_source: extra.universe_source ?? ctx.universe_hint,
    geo_data_version: ctx.geo_data_version ?? DEFAULT_GEO_DATA_VERSION,
    resolver_version: RESOLVER_VERSION,
    compiled_at: new Date().toISOString(),
  };
}

function resolved(recipe: GeometryRecipe, margin?: number, facts: ResolutionFacts = {}): ResolutionResult {
  return {
    status: 'resolved',
    // The side joins the fingerprint only when present, so every recipe without
    // one keeps the geometry id it always had. Facts never join it (in memory only).
    geometry_id: `geo:${fingerprint([recipe.operation, ...[...recipe.resolved_element_ids].sort(), recipe.radius_or_band_m, ...(recipe.side ? [recipe.side] : [])])}`,
    recipe,
    candidate_margin: margin,
    facts,
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

/**
 * Article-insensitive place key: the canonical fold (ة→ه, ى→ي, أإآ→ا, no «حي»)
 * with the definite article dropped, so «نرجس» ≡ «النرجس» and «المحمديه» ≡
 * «حي المحمدية». Customers drop «ال» and swap ة/ه constantly; the official name
 * never does. Still an EXACT key — «الجبيلة» ≠ «الجبيل» — so HARD RULE 1 holds.
 */
export function placeKey(s: string): string {
  return canonicalPlaceName(s).replace(/^ال(?=\S)/, '').trim();
}

/** Road key: placeKey without a leading road word, so «الملك فهد» ≡ «طريق الملك
 *  فهد» (but ≠ «طريق الملك فهد الفرعي»). */
export function roadKey(s: string): string {
  return placeKey(String(s ?? '').replace(/^\s*(طريق|شارع|محور|الدائري|دائري)\s+/, ''));
}

/** Exact = token equals an official name OR a curated alias, after canonicalization
 *  (article-insensitive). This is the SELECTION gate (HARD RULE 1): a fuzzy
 *  substring is not exact. */
function isExact(c: AdminCandidate, token: string): boolean {
  const want = placeKey(token);
  if (!want) return false;
  if (c.names.some((n) => placeKey(n) === want)) return true;
  if (c.aliases.some((a) => placeKey(a) === want)) return true;
  // A span typed in Latin letters («Malga») is compared on the transliteration
  // key against the English name («Al Malqa Dist.») — still exact, see latinNames.ts.
  const lk = latinKey(token);
  if (!lk) return false;
  return c.names.some((n) => latinKey(n) === lk) || c.aliases.some((a) => latinKey(a) === lk);
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

/**
 * The extractor's `normalized_token` is model output and occasionally mangled
 * («طريقالملكفهد», «نفس_المنطقه»); the `span` is verbatim customer text. Try the
 * normalized form first, then the span, and keep the first that resolves.
 */
async function resolveAdminPlace(
  anchor: AnchorToken,
  ctx: ResolutionContext,
  kind: 'district' | 'city' | 'region',
): Promise<ResolutionResult> {
  const tokens = Array.from(new Set([anchor.normalized_token, anchor.span].map((s) => (s ?? '').trim()).filter(Boolean)));
  if (tokens.length === 0) return unresolvable('outside_admin');
  let last: ResolutionResult | null = null;
  for (const token of tokens) {
    const r = await resolveAdminToken(anchor, token, ctx, kind);
    if (r.status === 'resolved') return r;
    last = last ?? r; // report the FIRST failure (the normalized form's), not the retry's
  }
  return last!;
}

async function resolveAdminToken(
  anchor: AnchorToken,
  token: string,
  ctx: ResolutionContext,
  kind: 'district' | 'city' | 'region',
): Promise<ResolutionResult> {
  const preferCountry = ctx.preferCountry || DEFAULT_GEO_COUNTRY;

  let candidates: AdminCandidate[];
  let op: GeoOperation;
  if (kind === 'city') {
    op = 'district_union'; // a city resolves to the union of its districts (recipe records the city id)
    candidates = (await ctx.db.findCities(token, preferCountry)).map(cityAdmin);
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
    candidates = (await ctx.db.findDistricts(token, preferCountry)).map(districtAdmin);
  }
  // Country scoping: never let a cross-border namesake even be a candidate.
  // The cross-border fallback exists for a client with NO established place
  // (a Dubai-only enquiry on a Saudi-default run). Once the client is anchored
  // in a city, a same-name district abroad is a wrong answer, not a fallback:
  // «الحمرة» from a Riyadh customer resolved to الحمرة in أم القيوين (calib-002,
  // 2026-09-27) because Riyadh has no district spelled exactly that. Ask instead.
  const scoped = candidates.filter((c) => (c.country_code || DEFAULT_GEO_COUNTRY) === preferCountry);
  if (scoped.length === 0 && ctx.established_city && kind === 'district') return needsConfirm('outside_admin');
  let pool = scoped.length ? scoped : candidates;
  // A district beside a road side / venue in a city the customer NAMED must be
  // in that city — never a namesake elsewhere clipped by that city's road.
  // Article-insensitive («جده» / «الرياض» vs «رياض»), like every other place key.
  if (kind === 'district' && ctx.admin_city) {
    const w = placeKey(ctx.admin_city);
    pool = pool.filter((c) => !!w && (placeKey(c.city_name_ar) === w || placeKey(c.city_name_en) === w));
    if (pool.length === 0) return needsConfirm('outside_admin');
  }
  // I9 in a namesake tie-break (added 2026-10-04 by the never-wrong corpus):
  // another active mention names another city, so the established city may
  // not decide between two exact namesakes — «ابي في جدة» … «الروضة» is
  // Jeddah's or Riyadh's? Ask. One exact match is not an assumption: it stands.
  if (kind === 'district' && !ctx.admin_city && ctx.forbid_established && enabled(ctx, 'conversation_city')
    && new Set(pool.filter((c) => isExact(c, token)).map((c) => c.id)).size > 1) {
    return needsConfirm('established_city_contradicted');
  }

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
  // The district's own city (English label) — what a clip's city check compares to its road's.
  const facts: ResolutionFacts = kind === 'district' ? { district_city_en: { [pick.id]: pick.city_name_en } } : {};
  return resolved(recipe, margin, facts);
}

// ────────────────────────────────────────────────────────────────────────────
// Direction → zone_union (a side of a city) or directional_band (a side of a road).
// ────────────────────────────────────────────────────────────────────────────

/** A zone lookup that returned districts, and the city name (as passed) that produced them. */
interface ZoneHit { rows: ZoneDistrict[]; city: string }

/**
 * A direction anchor. The referent after the direction word is either a CITY
 * («شمال الرياض» → the city's northern districts) or a ROAD («غرب الملك فهد» →
 * the band on that side of King Fahd Road). Riyadh has both a King Fahd Road and
 * a King Fahd District, but only a line has sides, so: city first, then the
 * namesake vetoes, then a road, then ASK. A district is never guessed as the
 * referent of a side. A referent known to be a road («طريق الدمام», a folded
 * road anchor, `referent_is_road`) never tries the city: «شرق طريق الدمام» is
 * not the east of Dammam city. With no referent («شمال», «الشمال») it is the
 * zone of the city that owns the word, of a confirmed established city, or of
 * the established city.
 */
async function resolveZoneUnion(anchor: AnchorToken, ctx: ResolutionContext): Promise<ResolutionResult> {
  const parsed = parseDirection(anchor.normalized_token || anchor.span || '');
  const zone = ctx.direction ? (parseDirection(ctx.direction).zone ?? ctx.direction) : parsed.zone;
  if (!zone) return needsConfirm('corridor_underspecified'); // no direction word understood
  const rest = parsed.rest.trim();
  return rest ? resolveSideOfReferent(anchor, ctx, zone, rest) : resolveBareZone(anchor, ctx, zone);
}

/** A direction WITH a referent («شمال الرياض», «غرب الملك فهد», «شرق العليا»). */
async function resolveSideOfReferent(
  anchor: AnchorToken, ctx: ResolutionContext, zone: string, rest: string,
): Promise<ResolutionResult> {
  // The customer's own referent («شرق طريق الدمام» when the model's token
  // dropped the road word to «شرق الدمام»): a road word in EITHER text means a
  // road — never the east of Dammam CITY.
  const spanRest = spanReferent(anchor);
  const roadReferent = ctx.referent_is_road === true || isRoadReferentText(rest) || isRoadReferentText(spanRest);
  if (!roadReferent) {
    // 1. City first, in every spelling the customer / the model gave.
    const hit = await zoneDistrictsOf(
      ctx.db, distinctTokens([rest, spanRest].flatMap((r) => (r ? cityNameVariants(r, '') : []))), zone,
    );
    if (hit) return zoneResolved(anchor, ctx, hit, 'explicit', 'named');
    // ...then the ONE city record the referent names exactly («north Riyadh»).
    // A city with no such zone asks — it never falls through to a road of its
    // name (north of Riyadh's Makkah Road for «شمال مكة»).
    const ar = await cityArabicName(ctx, rest);
    if (ar) {
      const rows = await ctx.db.zoneDistricts(ar, zone);
      if (!rows.length) return needsConfirm('outside_admin');
      return zoneResolved(anchor, ctx, { rows, city: ar }, 'explicit', 'named');
    }
    // 2. Not a city we can name exactly — but maybe still a city, or a district
    //    of the scope city: ask, never the road of that name.
    if (enabled(ctx, 'namesake_veto')) {
      const veto = await namesakeVeto(ctx, rest);
      if (veto) return veto;
    }
  }
  // 3. A road, looked up by the token AND the customer's own words.
  const { pick, result } = await resolveOneElement([rest, spanRest], ctx, 'linestring');
  if (pick) {
    // A road has two sides. A diagonal («شمال شرق طريق الملك فهد») or «وسط»
    // names neither, and a band without a side used to be saved as a 5 km
    // strip on BOTH sides of the whole road — a width and a shape the
    // customer never said. Ask instead.
    const side = cardinalSide(zone);
    if (!side) return needsConfirm('side_of_road_not_cardinal');
    return bandResolved(anchor, ctx, pick, side);
  }
  // Several cities named beside it (the road could be in either), or the
  // established city contradicted elsewhere: ask exactly that.
  if (result && (ctx.city_unclear || result.reason === 'established_city_contradicted')) return result;
  return needsConfirm('side_of_unknown_referent');
}

/** A BARE direction («شمال», «الشمال»): a zone of the owner city, a confirmed established city, or the established city. */
async function resolveBareZone(anchor: AnchorToken, ctx: ResolutionContext, zone: string): Promise<ResolutionResult> {
  const established = (ctx.established_city || '').trim();
  // 1. The city that OWNS the word (anchorPrep.ts: «شمال جدة» → `city` جدة) —
  //    a named city is never looked up as a road.
  const owner = (ctx.city || '').trim();
  if (owner) {
    let hit = await zoneDistrictsOf(ctx.db, cityNameVariants(owner, established), zone);
    if (!hit) {
      // The customer's spelling is not the districts table's («north Riyadh»,
      // «جده»): the ONE city record that spelling names exactly.
      const ar = await cityArabicName(ctx, owner);
      if (ar) {
        const rows = await ctx.db.zoneDistricts(ar, zone);
        if (rows.length) hit = { rows, city: ar };
      }
    }
    if (!hit) return needsConfirm('outside_admin');
    return zoneResolved(anchor, ctx, hit, 'explicit', 'named');
  }
  // 2. A city named elsewhere in the mention («في جدة بالشمال») only CONFIRMS
  //    the established city — it never moves the zone; another city asks.
  if (ctx.confirm_city) {
    if (!(await sameCity(ctx, ctx.confirm_city, established))) return needsConfirm('zone_city_unclear');
    const hit = await zoneDistrictsOf(ctx.db, [established], zone);
    if (!hit) return needsConfirm('outside_admin');
    return zoneResolved(anchor, ctx, hit, 'explicit', 'established');
  }
  // 3. Another active mention names another city: the established one may not be assumed (I9).
  if (ctx.forbid_established && enabled(ctx, 'conversation_city')) return needsConfirm('established_city_contradicted');
  // 4. The established city, as always.
  if (!established) return needsConfirm('missing_city_for_zone');
  const hit = await zoneDistrictsOf(ctx.db, [established], zone);
  if (!hit) return needsConfirm('outside_admin');
  return zoneResolved(anchor, ctx, hit, 'established_context', 'established');
}

function zoneResolved(
  anchor: AnchorToken, ctx: ResolutionContext, hit: ZoneHit, universe: UniverseSource, source: 'named' | 'established',
): ResolutionResult {
  const ids = hit.rows.map((r) => r.district_id).filter(Boolean);
  return resolved(makeRecipe('zone_union', [anchor], ids, ctx, { universe_source: universe }), undefined, {
    zone_city: hit.city, scope_city: hit.city, scope_source: source,
  });
}

/** A side of a picked road → directional_band (the stated depth, else the documented default). */
function bandResolved(anchor: AnchorToken, ctx: ResolutionContext, pick: ElementCandidate, side: CardinalSide): ResolutionResult {
  const stated = isNum(ctx.radius_m) ? ctx.radius_m : null;
  // The side rides on the recipe (review.ts reads it first) so it never has to
  // be re-guessed from names — «جنوب الدائري الشمالي» is SOUTH.
  const recipe = makeRecipe('directional_band', [anchor], [pick.external_id], ctx, {
    radius_or_band_m: stated ?? DIRECTION_DEFAULT_M,
    universe_source: stated !== null ? 'explicit' : 'organizational_default',
    side,
  });
  return resolved(recipe, undefined, { ...elementFacts(ctx, pick), radius_source: stated !== null ? 'stated' : 'default' });
}

/**
 * Spellings to try for a city the customer named. `wassell_city_zone_districts`
 * matches the city's Arabic name EXACTLY, and the extractor's token is folded
 * («جده» for «جدة») or may drop the article: the «ة» spelling is tried next,
 * and when the named city IS the established one (same name, article-
 * insensitive), the established spelling last — so naming the client's own
 * city never asks where leaving it out resolved.
 */
function cityNameVariants(named: string, established: string): string[] {
  const out = [named];
  if (/ه$/.test(named)) out.push(named.replace(/ه$/, 'ة'));
  if (established && placeKey(established) === placeKey(named)) out.push(established);
  return Array.from(new Set(out));
}

/** The zone's districts for the first spelling that has any, with that spelling; null when none does. */
async function zoneDistrictsOf(db: ResolverDb, cities: readonly string[], zone: string): Promise<ZoneHit | null> {
  for (const c of cities) {
    if (!c) continue;
    const rows = await db.zoneDistricts(c, zone);
    if (rows.length) return { rows, city: c };
  }
  return null;
}

/** What the city helpers need from a resolution context. */
export type CityLookupContext = Pick<ResolutionContext, 'db' | 'preferCountry'>;

const cityAdmin = (r: CityCandidate): AdminCandidate => ({
  id: r.id, names: [r.name_ar, r.name_en], aliases: r.aliases,
  city_id: r.id, city_name_ar: r.name_ar, city_name_en: r.name_en,
  region_name_ar: r.region_name_ar, region_name_en: r.region_name_en,
  country_code: r.country_code, lat: r.centroid_lat, lng: r.centroid_lng,
});

const districtAdmin = (r: DistrictCandidate): AdminCandidate => ({
  id: r.id, names: [r.name_ar, r.name_en], aliases: r.aliases,
  city_id: r.city_id, city_name_ar: r.city_name_ar, city_name_en: r.city_name_en,
  region_name_ar: r.region_name_ar, region_name_en: r.region_name_en,
  country_code: r.country_code, lat: r.centroid_lat, lng: r.centroid_lng,
});

/**
 * The Arabic name of the ONE city record `name` names EXACTLY — its official
 * name, a curated alias or its Latin form («Riyadh» → «الرياض»),
 * article-insensitive — in the preferred country. Null when no record or
 * several do: «مكة» is NOT «مكة المكرمة» (a leading-words namesake is never an
 * exact match), so it is null, and the caller asks.
 */
export async function cityArabicName(ctx: CityLookupContext, name: string): Promise<string | null> {
  const n = String(name ?? '').trim();
  if (!n) return null;
  const preferCountry = ctx.preferCountry || DEFAULT_GEO_COUNTRY;
  const exact = (await ctx.db.findCities(n, preferCountry))
    .filter((r) => (r.country_code || DEFAULT_GEO_COUNTRY) === preferCountry)
    .map(cityAdmin)
    .filter((c) => isExact(c, n));
  // One RECORD (the same row may come back for two spellings).
  return new Set(exact.map((c) => c.id)).size === 1 ? exact[0]!.city_name_ar || null : null;
}

/**
 * `a` and `b` name the same city: the same spelling (article-insensitive), or
 * `a` names exactly the ONE city record whose Arabic name is `b`.
 */
export async function sameCity(ctx: CityLookupContext, a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  if (placeKey(a) === placeKey(b)) return true;
  const ar = await cityArabicName(ctx, a);
  return !!ar && placeKey(ar) === placeKey(b);
}

/** The words of a place name, article-insensitive on the first («مكة المكرمة» → [مكه, المكرمه]). */
const placeWords = (s: string): string[] => placeKey(s).split(' ').filter(Boolean);

/** `name` starts with every word of `want`, in order (an exact match counts). */
const startsWithWords = (name: readonly string[], want: readonly string[]): boolean =>
  want.length > 0 && name.length >= want.length && want.every((w, i) => name[i] === w);

/**
 * The namesake VETOES for a direction's referent that is not a road word and
 * not a city we can name exactly. They only ASK — they never pick:
 *  - a CITY whose name starts with the referent's words («شمال مكة» →
 *    «مكة المكرمة»), or several exact cities → 'road_or_city_unclear' (the
 *    scope city's «طريق مكة» is not silently the answer);
 *  - a DISTRICT of the scope city with exactly that name («شرق العليا»: Olaya
 *    district, or Olaya Street?) → 'referent_road_or_district'.
 */
async function namesakeVeto(ctx: ResolutionContext, rest: string): Promise<ResolutionResult | null> {
  const preferCountry = ctx.preferCountry || DEFAULT_GEO_COUNTRY;
  const want = placeWords(rest);
  const cities = await ctx.db.findCities(rest, preferCountry);
  if (cities.some((c) => [c.name_ar, c.name_en, ...c.aliases].some((n) => startsWithWords(placeWords(n), want)))) {
    return needsConfirm('road_or_city_unclear');
  }
  const scope = placeKey(ctx.city || ctx.established_city || '');
  if (scope) {
    const districts = (await ctx.db.findDistricts(rest, preferCountry)).map(districtAdmin);
    const inScope = districts.some((d) => isExact(d, rest)
      && (placeKey(d.city_name_ar) === scope || placeKey(d.city_name_en) === scope));
    if (inScope) return needsConfirm('referent_road_or_district');
  }
  return null;
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

const distinctTokens = (ts: readonly (string | null | undefined)[]): string[] =>
  Array.from(new Set(ts.map((t) => String(t ?? '').trim()).filter(Boolean)));

const asTokens = (t: string | readonly string[]): string[] => distinctTokens(typeof t === 'string' ? [t] : t);

/** The city an element lookup is scoped to (the named one, else the established one). */
function scopeFacts(ctx: ResolutionContext): ResolutionFacts {
  const scope = (ctx.city || ctx.established_city || '').trim();
  if (!scope) return {};
  return { scope_city: scope, scope_source: (ctx.city || '').trim() ? 'named' : 'established' };
}

/** The scope plus the picked element's own city — what the element-in-scope check compares. */
function elementFacts(ctx: ResolutionContext, pick: ElementCandidate): ResolutionFacts {
  return { ...scopeFacts(ctx), element_city: pick.city };
}

/**
 * I9 in lookups: with no city NAMED in the mention while another mention names
 * a city other than the established one, the established city may not scope
 * the search — ask before searching.
 */
function scopeContradicted(ctx: ResolutionContext): ResolutionResult | null {
  return !(ctx.city || '').trim() && ctx.forbid_established && enabled(ctx, 'conversation_city')
    ? needsConfirm('established_city_contradicted')
    : null;
}

/**
 * The candidate rows for EVERY distinct spelling the customer / the model gave
 * (the folded token «حديقه …» and the span «حديقة …»): the live search is a
 * byte-wise ILIKE, so a folded token alone may find nothing. Rows are merged by
 * external id, so two spellings that name two different places surface as two
 * exact matches (an ask), never as whichever spelling happened to be tried first.
 */
async function findElementsFor(
  tokens: readonly string[], ctx: ResolutionContext, kind?: 'point' | 'linestring' | 'polygon',
): Promise<ElementCandidate[]> {
  const preferCountry = ctx.preferCountry || DEFAULT_GEO_COUNTRY;
  const city = ctx.city || ctx.established_city;
  const byId = new Map<string, ElementCandidate>();
  for (const t of tokens) {
    const rows = await ctx.db.findElements(t, { preferCountry, city, ...(kind ? { kind } : {}) });
    for (const e of rows) if (!byId.has(e.external_id)) byId.set(e.external_id, e);
  }
  return [...byId.values()];
}

async function resolveOneElement(
  tokenOrTokens: string | readonly string[],
  ctx: ResolutionContext,
  kind: 'point' | 'linestring' | 'polygon',
): Promise<{ pick: ElementCandidate | null; result?: ResolutionResult }> {
  // Several cities named in the mention: never pick one of them for the customer.
  if (ctx.city_unclear) return { pick: null, result: needsConfirm('ambiguous_entity') };
  const contradicted = scopeContradicted(ctx);
  if (contradicted) return { pick: null, result: contradicted };
  const tokens = asTokens(tokenOrTokens);
  if (!tokens.length) return { pick: null, result: needsConfirm('outside_admin') };
  const preferCountry = ctx.preferCountry || DEFAULT_GEO_COUNTRY;
  const rows = await findElementsFor(tokens, ctx, kind);
  if (!rows.length) return { pick: null, result: needsConfirm('outside_admin') };
  const usable = rows
    .filter(elementUsable)
    .filter((e) => (e.country_code || DEFAULT_GEO_COUNTRY) === preferCountry)
    .filter((e) => !e.geom_kind || e.geom_kind === kind); // a road query never picks a point
  // Roads compare without the road word + article («الملك فهد» ≡ «طريق الملك فهد»);
  // points/polygons without the article only. A row is exact when its key
  // equals ANY spelling's key; two exact rows are two places → ask.
  const key = kind === 'linestring' ? roadKey : placeKey;
  const wanted = new Set(tokens.map(key).filter(Boolean));
  const hit = (n: string): boolean => wanted.has(key(n));
  const exact = usable.filter((e) => hit(e.name_ar) || hit(e.name_en) || e.aliases.some(hit));
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
      const { pick, result } = await resolveOneElement([r.normalized_token, r.span], ctx, 'linestring');
      if (!pick) return result!;
      resolvedIds.push(pick.external_id);
    }
    const recipe = makeRecipe('corridor', [anchor, ...roads], resolvedIds, ctx, { universe_source: 'explicit' });
    return resolved(recipe, undefined, scopeFacts(ctx));
  }

  const { pick, result } = await resolveOneElement([anchor.normalized_token, anchor.span], ctx, 'linestring');
  if (!pick) return result!;

  // Direction + road → directional_band (bounded band; documented default depth).
  const dir = ctx.direction ? parseDirection(ctx.direction).zone : null;
  if (dir) {
    // A diagonal / «وسط» names no side of a road — ask (see resolveSideOfReferent).
    const side = cardinalSide(dir);
    if (!side) return needsConfirm('side_of_road_not_cardinal');
    return bandResolved(anchor, ctx, pick, side);
  }

  // Proximity «قريب من الطريق» — needs an explicit radius, NEVER a silent default.
  if (ctx.proximity || isNum(ctx.radius_m)) {
    if (!isNum(ctx.radius_m)) return needsConfirm('missing_radius');
    const recipe = makeRecipe('within_distance', [anchor], [pick.external_id], ctx, {
      radius_or_band_m: ctx.radius_m, universe_source: 'explicit',
    });
    return resolved(recipe, undefined, { ...elementFacts(ctx, pick), radius_source: 'stated' });
  }

  // A bare road with no operation is underspecified as a geometry.
  return needsConfirm('corridor_underspecified');
}

/** Exact namesakes this close together (km) are ONE venue drawn twice (a mall's point + its shape). */
export const SAME_VENUE_KM = 2;

/** Venue words too generic to tell one place from another on their own («مول», «جامعة»…). */
const GENERIC_VENUE_WORDS = new Set(
  ['مول', 'جامعة', 'مستشفى', 'حديقة', 'بارك', 'مركز', 'سوق', 'اسواق', 'مطار', 'برج', 'فندق', 'مدرسة', 'مسجد', 'جامع']
    .map(canonicalPlaceName),
);

/**
 * A candidate is a PREFIX namesake of what the customer said when one of its
 * names / aliases is LONGER and starts with the spoken words («جامعة الأميرة
 * نورة» → «جامعة الأميرة نورة بنت عبدالرحمن», «العثيم مول» → «العثيم مول
 * الربوة»). Only for a spoken name of 2+ words with at least one non-generic
 * word: «مول» alone would prefix every mall in the city.
 */
function isPrefixNamesake(e: ElementCandidate, spokenSets: readonly string[][]): boolean {
  const names = [e.name_ar, e.name_en, ...e.aliases].map(placeWords).filter((w) => w.length > 0);
  return spokenSets.some((spoken) =>
    spoken.length >= 2
    && spoken.some((w) => !GENERIC_VENUE_WORDS.has(w))
    && names.some((n) => n.length > spoken.length && startsWithWords(n, spoken)));
}

/**
 * How many distinct PLACES the candidates are: single linkage at
 * {@link SAME_VENUE_KM} on their coordinates. A candidate without coordinates
 * cannot be shown to be the same place as another, so it is a place of its own.
 */
function venueClusters(cands: readonly ElementCandidate[]): number {
  const parent = cands.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r]! !== r) r = parent[r]!;
    return r;
  };
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i]!;
    if (!isNum(a.lat) || !isNum(a.lng)) continue;
    for (let j = i + 1; j < cands.length; j++) {
      const b = cands[j]!;
      if (!isNum(b.lat) || !isNum(b.lng)) continue;
      if (haversineKm(a.lat, a.lng, b.lat, b.lng) <= SAME_VENUE_KM) parent[find(j)] = find(i);
    }
  }
  return new Set(cands.map((_, i) => find(i))).size;
}

/**
 * A named venue's element: POINT and POLYGON matches are gathered TOGETHER
 * (malls, parks, universities, hospitals… are mostly polygons — «الرياض بارك»
 * is one). The pool is every EXACT match plus every PREFIX namesake (I7, a
 * veto): it must be ONE place (single linkage at {@link SAME_VENUE_KM}) — then
 * the exact polygon, else the exact point. Two places → needs_confirm
 * ('ambiguous_entity'): «جامعة الملك سعود» is a metro-station point 11.7 km
 * from the campus (HARD RULE 2), and «العثيم مول» has branches all over the
 * city. Only prefix namesakes and no exact match → 'venue_name_partial' (the
 * customer said part of a longer name — which one?).
 */
async function resolveVenueElement(
  tokenOrTokens: string | readonly string[],
  ctx: ResolutionContext,
): Promise<{ pick: ElementCandidate | null; result?: ResolutionResult }> {
  if (ctx.city_unclear) return { pick: null, result: needsConfirm('ambiguous_entity') };
  const contradicted = scopeContradicted(ctx);
  if (contradicted) return { pick: null, result: contradicted };
  const tokens = asTokens(tokenOrTokens);
  if (!tokens.length) return { pick: null, result: needsConfirm('outside_admin') };
  const preferCountry = ctx.preferCountry || DEFAULT_GEO_COUNTRY;
  const candidates = (await findElementsFor(tokens, ctx))
    .filter(elementUsable)
    .filter((e) => (e.country_code || DEFAULT_GEO_COUNTRY) === preferCountry)
    .filter((e) => e.geom_kind !== 'linestring'); // a road is never a venue
  const wanted = new Set(tokens.map(placeKey).filter(Boolean));
  const hit = (n: string): boolean => wanted.has(placeKey(n));
  const exact = candidates.filter((e) => hit(e.name_ar) || hit(e.name_en) || e.aliases.some(hit));
  const spoken = tokens.map(placeWords);
  const prefix = enabled(ctx, 'venue_prefix')
    ? candidates.filter((e) => !exact.includes(e) && isPrefixNamesake(e, spoken))
    : [];
  if (exact.length === 0) {
    return { pick: null, result: needsConfirm(prefix.length > 0 ? 'venue_name_partial' : 'outside_admin') };
  }
  if (venueClusters([...exact, ...prefix]) !== 1) return { pick: null, result: needsConfirm('ambiguous_entity') };
  // One place: its shape when it has one (deterministic among duplicates of the
  // SAME place — every candidate here is linked to the others within SAME_VENUE_KM).
  const byId = (a: ElementCandidate, b: ElementCandidate) => a.external_id.localeCompare(b.external_id);
  const polygons = exact.filter((e) => e.geom_kind === 'polygon').sort(byId);
  return { pick: polygons[0] ?? [...exact].sort(byId)[0]! };
}

/**
 * A named venue → a distance rule around it ({@link resolveVenueElement} picks
 * the place). A point ⇒ `within_radius` around it; a polygon ⇒
 * `within_distance` of the SHAPE (review.ts maps it to an element rule measured
 * to the geometry).
 */
async function resolveLandmark(anchor: AnchorToken, ctx: ResolutionContext): Promise<ResolutionResult> {
  const { pick, result } = await resolveVenueElement([anchor.normalized_token, anchor.span], ctx);
  if (!pick) return result!;
  // A distance rule ALWAYS needs a stated distance — no silent default (HARD RULE 4).
  if (!isNum(ctx.radius_m)) return needsConfirm('missing_radius');
  const facts: ResolutionFacts = { ...elementFacts(ctx, pick), radius_source: 'stated' };
  if (pick.geom_kind === 'polygon') {
    return resolved(makeRecipe('within_distance', [anchor], [pick.external_id], ctx, {
      radius_or_band_m: ctx.radius_m, universe_source: 'explicit',
    }), undefined, facts);
  }
  if (!isNum(pick.lat) || !isNum(pick.lng)) return needsConfirm('outside_admin');
  const recipe = makeRecipe('within_radius', [anchor], [pick.external_id], ctx, {
    radius_or_band_m: ctx.radius_m, universe_source: 'explicit',
  });
  return resolved(recipe, undefined, facts);
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
  // The preparation already decided to ASK about this anchor: no lookup can overrule it.
  if (ctx.ask_reason) return needsConfirm(ctx.ask_reason);
  switch (anchor.anchor_type) {
    case 'district':
    case 'town':
      return resolveAdminPlace(anchor, ctx, 'district');
    case 'city':
    case 'region':
      // «قريب من الرياض» is never the whole city: a proximity reading of a city /
      // region has no honest geometry (and «قريب من الرياض بارك» truncated to
      // «الرياض» resolved to the Riyadh CITY record — 2026-10-01). Ask instead.
      // anchorPrep.ts sets `proximity` on such anchors.
      if (ctx.proximity) return needsConfirm('proximity_to_city');
      return resolveAdminPlace(anchor, ctx, anchor.anchor_type);
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
