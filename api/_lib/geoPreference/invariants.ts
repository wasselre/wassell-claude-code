/**
 * Demote-only checks of the geography agent (design 2026-10-04, §2.5).
 *
 * A check can only turn a RESOLVED place into needs_confirm with a reason code
 * — it never picks another place, never rewrites a recipe — so adding a check
 * can only shrink the set of resolved mentions (a property test enforces it,
 * __tests__/invariants.test.ts). A demoted anchor is the existing unresolved
 * stub: every card and report renderer already prints its "needs confirm"
 * wording.
 *
 * The checks read FACTS, never phrasing:
 *   - about the MAP — how a road runs (wassell_geo_road_axis), which city an
 *     element / district / zone is in (the resolver's in-memory `facts` +
 *     cities.name_en), which catalogued names occur in the text
 *     (wassell_geo_names_in_text);
 *   - about the CONVERSATION — which cities the customer named elsewhere.
 *
 * Three levels, run by the orchestrator in this order:
 *   I9  conversation level, BEFORE resolution ({@link conversationCityCheck}):
 *       another active mention names a city other than the established one ⇒
 *       the established city may not be ASSUMED (a bare direction, an element
 *       lookup with no named scope ask — the resolver honours the flag).
 *   I5, U1, I8  anchor level, AFTER resolution ({@link enforceAnchorInvariants}):
 *       an element outside the city its lookup was scoped to; a district
 *       outside the city the same mention's zone NAMES («الروضة شمال جدة» is
 *       Jeddah's الروضة — added 2026-10-04 when the never-wrong corpus found
 *       the glued shape drawing Riyadh's); a place word that is only part of a
 *       longer catalogued name in the customer's text («الرياض» in «الرياض
 *       بارك») — for element picks too since repair round 1 («الملك فهد» in
 *       «مستشفى الملك فهد», or after «حي»).
 *   I4, M1, M2  merge level, on the merge trace, to a fixpoint
 *       ({@link checkMerged}): a standalone road side must run along its road
 *       (north / south of an east–west road, east / west of a north–south
 *       one); a clip's districts must be in the road's city and the road must
 *       run the right way INSIDE them. A failing DISTRIBUTED clip is never
 *       demoted — its band simply stays standalone (and is then checked by I4).
 *
 * Every map port THROWS on a database error (resolverDb.ts) and nothing here
 * catches: a check that cannot be run fails the whole review loudly instead of
 * silently passing. An answer of "no such road" (`found:false`) ASKS — it never
 * passes. Every demotion emits exactly ONE observability event with the rule,
 * the reason, the evidence id and the anchor type — never customer text.
 */

import type { AnchorToken, CardinalSide, Evidence, ResolutionResult } from './ontology.js';
import type { Conversation } from './extractor.js';
import type { MergeTrace } from './orchestrator.js';
import type { GeoObserver } from './observability.js';
import {
  locateAnchor, locatePhrase, mentionStrings, tokenize, foldWord,
  type MentionToken, type Occurrence, type PreparedMention,
} from './anchorPrep.js';
import {
  cityArabicName, sameCity, placeKey, parseDirection, spanReferent, stripDirectionClitic,
  type CityCandidate, type RegionCandidate, type ResolutionContext, type ResolverDb, type RoadAxis,
} from './resolver.js';
import { latinKey } from './latinNames.js';
import { DEFAULT_GEO_COUNTRY } from '../matchAgent.js';

/** Every check that can be switched off one at a time (test-only; the monotonicity property). */
export type CheckName =
  | 'grounding' | 'distance' | 'bare_direction' | 'referent_disagree' | 'region_owner'
  | 'merge_region_hold' | 'merge_two_cities' | 'or_not_and' | 'road_axis' | 'element_city'
  | 'clip_city' | 'venue_prefix' | 'names_in_text' | 'conversation_city' | 'namesake_veto'
  | 'union_city';

/** Every {@link CheckName}, for tests that switch them off one at a time. */
export const ALL_CHECKS: readonly CheckName[] = [
  'grounding', 'distance', 'bare_direction', 'referent_disagree', 'region_owner',
  'merge_region_hold', 'merge_two_cities', 'or_not_and', 'road_axis', 'element_city',
  'clip_city', 'venue_prefix', 'names_in_text', 'conversation_city', 'namesake_veto',
  'union_city',
];

/** «north / south of» a road is meaningful only when ew/(ew+ns) ≥ this (the road runs east–west enough). */
export const AXIS_NS_SIDE_MIN_EW_SHARE = 0.40;
/** «east / west of» a road is meaningful only when ew/(ew+ns) ≤ this (the road runs north–south enough). */
export const AXIS_EW_SIDE_MAX_EW_SHARE = 0.60;

/** A check is on unless a TEST switched it off (`RunContext.disabledChecks`, guarded test-only by the orchestrator). */
export function enabled(disabled: ReadonlySet<CheckName> | undefined, name: CheckName): boolean {
  return !disabled?.has(name);
}

/** One resolution to demote: its index in the run's resolutions, the check, the reason code. */
export interface Demotion { index: number; rule: CheckName; reason: string }

/** The non-PII meta every demotion event carries. */
export interface CheckMeta { client_id?: string; checkpoint_id?: string | null }

/** Where resolution `index` came from: its mention and anchor (resolutions are in evidence × anchor order). */
export interface ResolutionOrigin { evidence_id: string; evidence_index: number; anchor: AnchorToken }

/** Map every resolution index to its mention + anchor. */
export function resolutionOrigins(evidence: readonly Evidence[]): ResolutionOrigin[] {
  const out: ResolutionOrigin[] = [];
  evidence.forEach((e, i) => e.anchors.forEach((a) => out.push({ evidence_id: e.id, evidence_index: i, anchor: a })));
  return out;
}

/** The one observability event a demotion emits (rule, reason, evidence id, anchor type — no customer text). */
export function emitDemotion(
  obs: GeoObserver, meta: CheckMeta, origin: ResolutionOrigin | undefined, rule: string, reason: string,
  result: 'demoted' | 'not_distributed' = 'demoted',
): void {
  obs.event({
    stage: 'resolution', outcome: 'ok', ...meta, result,
    detail: { rule, reason, evidence_id: origin?.evidence_id ?? null, anchor_type: origin?.anchor.anchor_type ?? null },
  });
}

/** A resolved result turned into an ask; the facts are kept (in memory only), the recipe is not. */
export function demoted(r: ResolutionResult | undefined, reason: string): ResolutionResult {
  return { status: 'needs_confirm', reason, ...(r?.facts ? { facts: r.facts } : {}) };
}

const lowerTrim = (s: string | null | undefined): string => String(s ?? '').trim().toLowerCase();

/** A small per-run memo of the map ports (each answer is asked once per run; a rejection propagates). */
export class CheckCache {
  private readonly labels = new Map<string, Promise<string | null>>();
  private readonly axes = new Map<string, Promise<RoadAxis>>();
  constructor(private readonly db: ResolverDb) {}
  cityLabel(cityAr: string): Promise<string | null> {
    const k = cityAr.trim();
    let p = this.labels.get(k);
    if (!p) { p = this.db.cityLabel(k); this.labels.set(k, p); }
    return p;
  }
  roadAxis(road: string, districtIds?: readonly string[]): Promise<RoadAxis> {
    const ids = districtIds && districtIds.length > 0 ? [...districtIds].sort() : undefined;
    const k = `${road}|${ids?.join(',') ?? ''}`;
    let p = this.axes.get(k);
    if (!p) { p = this.db.roadAxis(road, ids); this.axes.set(k, p); }
    return p;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Road axis (I4, M2).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Whether `side` of a road that travels `ax` means anything. North / south
 * needs the road to run east–west enough (share ≥ {@link AXIS_NS_SIDE_MIN_EW_SHARE});
 * east / west needs it to run north–south enough (share ≤
 * {@link AXIS_EW_SIDE_MAX_EW_SHARE}). An unknown road, or one with no travel,
 * is `road_geometry_missing` — it asks, never passes.
 */
export function axisVerdict(ax: RoadAxis, side: CardinalSide): 'ok' | 'road_geometry_missing' | 'side_not_along_road' {
  if (!ax.found) return 'road_geometry_missing';
  const ew = Number(ax.ew_m);
  const ns = Number(ax.ns_m);
  if (!Number.isFinite(ew) || !Number.isFinite(ns) || ew < 0 || ns < 0 || ew + ns < 1) return 'road_geometry_missing';
  const share = ew / (ew + ns);
  if (side === 'north' || side === 'south') return share >= AXIS_NS_SIDE_MIN_EW_SHARE ? 'ok' : 'side_not_along_road';
  return share <= AXIS_EW_SIDE_MAX_EW_SHARE ? 'ok' : 'side_not_along_road';
}

// ────────────────────────────────────────────────────────────────────────────
// Anchor level: I5 (element in its scope city) and I8 (part of a longer name).
// ────────────────────────────────────────────────────────────────────────────

/** Recipes that come from an element pick (a road, a venue, a side of a road). */
const ELEMENT_OPS: ReadonlySet<string> = new Set(['directional_band', 'within_distance', 'within_radius']);
/** Anchor types whose resolved place I8 checks. */
const ADMIN_TYPES: ReadonlySet<string> = new Set(['district', 'town', 'city', 'region']);
/** Element anchor types whose pick I8 checks (repair round 1). */
const ELEMENT_TYPES: ReadonlySet<string> = new Set(['road', 'landmark', 'relative_ref']);
/** Words that may surround a place inside a name without making it ANOTHER place («حي النرجس», «مدينة الرياض», «شمال الرياض»). */
const NAME_FILLER_WORDS: ReadonlySet<string> = new Set([
  'حي', 'مدينة', 'منطقة', 'محافظة', 'شمال', 'جنوب', 'شرق', 'غرب', 'الشمالي', 'الجنوبي', 'الشرقي', 'الغربي', 'وسط',
  // Latin too (live gate 2026-10-04): «I want a villa in north Riyadh» was
  // demoted because the catalogue has a zone element named "North Riyadh".
  'north', 'south', 'east', 'west', 'central', 'northern', 'southern', 'eastern', 'western',
  'district', 'city', 'region', 'province', 'of', 'the',
].map(foldWord));

export interface AnchorInvariantOptions {
  disabled?: ReadonlySet<CheckName>;
  meta?: CheckMeta;
  cache?: CheckCache;
}

/**
 * For an ELEMENT pick, a road word around it is not another place either: «الملك
 * فهد» inside «طريق الملك فهد» is the road itself (or Khobar's namesake road,
 * which the scope check — not I8 — decides).
 */
const ROAD_FILLER_WORDS: ReadonlySet<string> = new Set([
  ...NAME_FILLER_WORDS, ...['طريق', 'الطريق', 'شارع', 'الشارع', 'محور', 'الدائري', 'دائري'].map(foldWord),
]);

/** A catalogued name's occurrence in the mention, with its words and its element. */
interface NameOccurrence { o: Occurrence; words: string[]; external_id: string }

/**
 * Every occurrence in `occ` lies STRICTLY inside a longer catalogued name whose
 * extra words are not mere `fillers` (I8) — and that is not the picked element
 * itself (`pick`, for an element anchor). No occurrence ⇒ false: without the
 * words in the text there is no evidence either way.
 */
function partOfLongerName(
  occ: readonly Occurrence[], names: readonly NameOccurrence[],
  fillers: ReadonlySet<string> = NAME_FILLER_WORDS, pick?: string,
): boolean {
  if (occ.length === 0) return false;
  return occ.every((o) => names.some(({ o: n, words, external_id }) => {
    if (pick !== undefined && external_id === pick) return false;
    if (!(n.start <= o.start && o.end <= n.end)) return false;
    if (n.end - n.start <= o.end - o.start) return false;
    const extra = words.filter((_, k) => k < o.start - n.start || k >= o.end - n.start);
    return extra.length > 0 && !extra.every((w) => fillers.has(w));
  }));
}

/**
 * Some occurrence of an element's words stands right after «حي» («قريب من حي
 * الملك فهد»): the customer named a DISTRICT, which is not a geo_element, so
 * namesInText cannot show it — a road or venue of the same words is not it.
 */
function afterDistrictWord(tokens: readonly MentionToken[], occ: readonly Occurrence[]): boolean {
  return occ.some((o) => {
    const prev = o.start > 0 ? tokens[o.start - 1] : undefined;
    if (!prev || tokens[o.start]!.hardPunctBefore) return false;
    return /^(و|ف)?(ب|ل)?حي$/.test(prev.f);
  });
}

/** The referent a one-anchor direction names («الرياض» in «شمال الرياض»), span-first. */
function directionReferentText(a: AnchorToken): string {
  const fromSpan = spanReferent(a);
  if (fromSpan) return fromSpan;
  const t = parseDirection(stripDirectionClitic(a.normalized_token ?? ''));
  return t.zone ? t.rest.trim() : '';
}

/**
 * I5 + U1 + I8, after resolution and before compile. Returns NEW resolutions (the
 * input is never mutated); a check only ever turns `resolved` into
 * needs_confirm. `prepared` is aligned with `evidence` (the PREPARED evidence).
 */
export async function enforceAnchorInvariants(
  evidence: readonly Evidence[],
  prepared: readonly PreparedMention[],
  resolutions: readonly ResolutionResult[],
  conversation: Conversation | undefined,
  db: ResolverDb,
  obs: GeoObserver,
  opts: AnchorInvariantOptions = {},
): Promise<ResolutionResult[]> {
  const out = resolutions.slice();
  const origins = resolutionOrigins(evidence);
  const cache = opts.cache ?? new CheckCache(db);
  const meta = opts.meta ?? {};
  const demote = (k: number, rule: CheckName, reason: string): void => {
    out[k] = demoted(out[k], reason);
    emitDemotion(obs, meta, origins[k], rule, reason);
  };

  // I5 — an element picked by a lookup must be in the city that lookup was
  // scoped to. The adapter already filters by city, so this is not expected to
  // fire; it pins the property should the adapter ever change.
  if (enabled(opts.disabled, 'element_city')) {
    for (let k = 0; k < out.length; k++) {
      const r = out[k]!;
      if (r.status !== 'resolved' || !r.recipe || !ELEMENT_OPS.has(r.recipe.operation)) continue;
      const f = r.facts ?? {};
      const scope = String(f.scope_city ?? '').trim();
      let reason: string | null = null;
      if (!scope) reason = 'scope_city_missing';
      else {
        const label = await cache.cityLabel(scope);
        if (label === null) reason = 'scope_city_unknown';
        else if (lowerTrim(label) !== lowerTrim(f.element_city)) reason = 'element_outside_scope_city';
      }
      if (reason) demote(k, 'element_city', reason);
    }
  }

  // U1 — the districts of a mention are in the city its zone NAMES. In
  // «الروضة شمال جدة» read as [district الروضة, direction «شمال جدة»] (no city
  // anchor of its own, so nothing scoped the district lookup) the established
  // city's namesake won: a Riyadh client got RIYADH's الروضة beside north
  // Jeddah. The zone's city is a fact of the map (the city whose zone returned
  // the districts); the district's city is its record's. Any difference — or
  // either side unknown — asks. Only zones of a city the customer NAMED count:
  // a bare direction's established zone («خزام … او في الشمال») says nothing
  // about where the district is.
  if (enabled(opts.disabled, 'union_city')) {
    const byMention = new Map<number, number[]>();
    origins.forEach((o, k) => {
      const list = byMention.get(o.evidence_index) ?? [];
      list.push(k);
      byMention.set(o.evidence_index, list);
    });
    for (const ks of byMention.values()) {
      const zones = ks.filter((k) => {
        const r = out[k]!;
        return r.status === 'resolved' && r.recipe?.operation === 'zone_union' && r.facts?.scope_source === 'named';
      });
      if (zones.length === 0) continue;
      const zoneLabels = new Set<string>();
      let zoneUnknown = false;
      for (const k of zones) {
        const zc = String(out[k]!.facts?.zone_city ?? '').trim();
        const label = zc ? await cache.cityLabel(zc) : null;
        if (label === null || !lowerTrim(label)) zoneUnknown = true;
        else zoneLabels.add(lowerTrim(label));
      }
      for (const k of ks) {
        const r = out[k]!;
        const t = origins[k]?.anchor.anchor_type;
        if (r.status !== 'resolved' || !r.recipe || (t !== 'district' && t !== 'town')) continue;
        const cities = r.recipe.resolved_element_ids.map((id) => lowerTrim(r.facts?.district_city_en?.[id]));
        let reason: string | null = null;
        if (zoneUnknown || zoneLabels.size !== 1 || cities.length === 0 || cities.some((c) => !c)) reason = 'union_city_unverified';
        else if (cities.some((c) => !zoneLabels.has(c))) reason = 'district_outside_named_city';
        if (reason) demote(k, 'union_city', reason);
      }
    }
  }

  // I8 — a place word that is only part of a longer catalogued name in the
  // customer's text («ابي حول الرياض بارك» read as the city «الرياض»).
  // Extended to ELEMENT picks (repair round 1, 2026-10-04): a road / venue
  // anchor whose words are only part of a longer catalogued name («الملك فهد»
  // in «مستشفى الملك فهد», «ملعب الملك فهد») or follow «حي» («حي الملك فهد»)
  // drew a distance rule around the wrong element. Demote only.
  if (enabled(opts.disabled, 'names_in_text')) {
    interface Candidate { k: number; occ: Occurrence[]; tokens: MentionToken[]; pick?: string }
    const candidates: Candidate[] = [];
    const tokensOf = new Map<number, MentionToken[]>();
    const tokens0 = (i: number): MentionToken[] => {
      let t = tokensOf.get(i);
      if (!t) { t = tokenize(evidence[i]!.mention_span ?? ''); tokensOf.set(i, t); }
      return t;
    };
    for (let k = 0; k < out.length; k++) {
      const r = out[k]!;
      const origin = origins[k];
      if (r.status !== 'resolved' || !r.recipe || !origin) continue;
      const a = origin.anchor;
      const tokens = tokens0(origin.evidence_index);
      if (ADMIN_TYPES.has(a.anchor_type)) {
        candidates.push({ k, occ: locateAnchor(tokens, a), tokens });
      } else if (a.anchor_type === 'direction' && r.recipe.operation === 'zone_union') {
        const referent = directionReferentText(a);
        if (referent) candidates.push({ k, occ: locatePhrase(tokens, referent), tokens });
      } else if (ELEMENT_OPS.has(r.recipe.operation)) {
        const pick = r.recipe.resolved_element_ids[0] ?? '';
        if (ELEMENT_TYPES.has(a.anchor_type)) {
          candidates.push({ k, occ: locateAnchor(tokens, a), tokens, pick });
        } else if (a.anchor_type === 'direction') {
          const referent = directionReferentText(a);
          if (referent) candidates.push({ k, occ: locatePhrase(tokens, referent), tokens, pick });
        }
      }
    }
    // «حي» right before an element's words: a district, never the element. No map call needed.
    const demotedHere = new Set<number>();
    for (const c of candidates) {
      if (c.pick !== undefined && afterDistrictWord(c.tokens, c.occ)) {
        demote(c.k, 'names_in_text', 'place_is_district_name');
        demotedHere.add(c.k);
      }
    }
    const live = candidates.filter((c) => c.occ.length > 0 && !demotedHere.has(c.k));
    if (live.length > 0) {
      // ONE call per run, over every text of every mention.
      const texts = Array.from(new Set(evidence.flatMap((e) => mentionStrings(e, conversation)).map((s) => s.trim()).filter(Boolean)));
      const names = await db.namesInText(texts.join(' | '));
      if (names.length > 0) {
        const occCache = new Map<MentionToken[], NameOccurrence[]>();
        for (const c of live) {
          let nameOcc = occCache.get(c.tokens);
          if (!nameOcc) {
            nameOcc = names.flatMap((n) => {
              const words = tokenize(n.name).map((t) => t.f);
              return locatePhrase(c.tokens, n.name).map((o) => ({ o, words, external_id: n.external_id }));
            });
            occCache.set(c.tokens, nameOcc);
          }
          const longer = c.pick === undefined
            ? partOfLongerName(c.occ, nameOcc)
            : partOfLongerName(c.occ, nameOcc, ROAD_FILLER_WORDS, c.pick);
          if (longer) demote(c.k, 'names_in_text', 'place_is_part_of_name');
        }
      }
    }
  }

  void prepared; // aligned with `evidence`; kept in the signature for the structured path (Phase B)
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Conversation level: I9.
// ────────────────────────────────────────────────────────────────────────────

const countryOf = (rctx: Pick<ResolutionContext, 'preferCountry'>): string => rctx.preferCountry || DEFAULT_GEO_COUNTRY;

/** `token` names this record exactly (official name or alias, article-insensitive, or its Latin form). */
function namesExactly(names: readonly string[], token: string): boolean {
  const want = placeKey(token);
  if (want && names.some((n) => placeKey(n) === want)) return true;
  const lk = latinKey(token);
  return !!lk && names.some((n) => latinKey(n) === lk);
}

/** The region record a token names exactly and uniquely, else null. */
async function exactRegion(rctx: ResolutionContext, token: string): Promise<RegionCandidate | null> {
  if (!rctx.db.findRegions) return null;
  const country = countryOf(rctx);
  const rows = (await rctx.db.findRegions(token, country))
    .filter((r) => (r.country_code || DEFAULT_GEO_COUNTRY) === country)
    .filter((r) => namesExactly([r.name_ar, r.name_en, ...r.aliases], token));
  return new Set(rows.map((r) => r.id)).size === 1 ? rows[0]! : null;
}

/** The region (Arabic name, placeKey) of the ONE city record `city` names exactly, else null. */
async function regionOfCity(rctx: ResolutionContext, city: string): Promise<string | null> {
  const country = countryOf(rctx);
  const rows: CityCandidate[] = (await rctx.db.findCities(city, country))
    .filter((c) => (c.country_code || DEFAULT_GEO_COUNTRY) === country)
    .filter((c) => namesExactly([c.name_ar, c.name_en, ...c.aliases], city));
  const regions = new Set(rows.map((c) => placeKey(c.region_name_ar)).filter(Boolean));
  return regions.size === 1 ? [...regions][0]! : null;
}

/** The words of a place name, article-insensitive on the first («مكة المكرمة» → [مكه, المكرمه]). */
const placeWords = (s: string): string[] => placeKey(s).split(' ').filter(Boolean);

/**
 * `token` names no city record exactly, but its words START the name of a city
 * record of the preferred country («مكة» → «مكة المكرمة», «المدينة» →
 * «المدينة المنورة»), and none of those records is the established city.
 */
async function leadingNamesakeOtherCity(rctx: ResolutionContext, token: string, established: string): Promise<boolean> {
  const want = placeWords(token);
  if (want.length === 0) return false;
  const country = countryOf(rctx);
  const rows = (await rctx.db.findCities(token, country))
    .filter((c) => (c.country_code || DEFAULT_GEO_COUNTRY) === country)
    .filter((c) => [c.name_ar, c.name_en, ...c.aliases].some((n) => {
      const w = placeWords(n);
      return w.length >= want.length && want.every((x, i) => w[i] === x);
    }));
  if (rows.length === 0) return false;
  for (const c of rows) {
    if (await sameCity(rctx, c.name_ar, established) || await sameCity(rctx, established, c.name_ar)) return false;
  }
  return true;
}

/**
 * I9 — before resolution. Does an active mention (preference role positive or
 * negative) NAME a place that is not the established city? A named CITY that
 * resolves to one record other than the established city ⇒ true; a token that
 * names no city exactly ⇒ true when its words start the name of a city record
 * that is not the established one («مكة», «المدينة»), else it is ignored. A named REGION that is not the
 * established city's region — or either side unknown ⇒ true. The flag only
 * stops the established city from being ASSUMED (a bare direction's zone, an
 * element lookup with no named scope); it never moves anything.
 */
export async function conversationCityCheck(
  evidence: readonly Evidence[],
  prepared: readonly PreparedMention[],
  rctx: ResolutionContext,
): Promise<boolean> {
  if (!enabled(rctx.disabled, 'conversation_city')) return false;
  const established = String(rctx.established_city ?? '').trim();
  if (!established) return false; // nothing to contradict — a bare direction asks for a city anyway
  const seen = new Set<string>();
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i]!;
    if (e.preference_role !== 'positive' && e.preference_role !== 'negative') continue;
    for (const p of prepared[i]?.named_places ?? []) {
      const key = `${p.kind}:${placeKey(p.token)}`;
      if (!p.token.trim() || seen.has(key)) continue;
      seen.add(key);
      if (p.kind === 'city') {
        const ar = await cityArabicName(rctx, p.token);
        if (!ar) {
          // Repair round 1 (2026-10-04) — a departure from the design's "a token
          // that does not resolve is ignored", toward asking. Customers say the
          // SHORT name («مكة», «المدينة») and city records carry no aliases, so
          // the token names no record exactly and was ignored: a bare direction
          // or a district namesake in another mention then fell back to the
          // established city (Riyadh's العزيزية for «ابي في مكة … العزيزية»).
          // A token whose words START a city record's name (the namesake veto's
          // test) that is not the established city forbids the assumption.
          if (await leadingNamesakeOtherCity(rctx, p.token, established)) return true;
          continue;
        }
        // Either spelling may be the record's: the established city can be stored in English.
        if (!(await sameCity(rctx, ar, established)) && !(await sameCity(rctx, established, ar))) return true;
      } else {
        const region = await exactRegion(rctx, p.token);
        const estRegion = await regionOfCity(rctx, established);
        if (!region || !estRegion || placeKey(region.name_ar) !== estRegion) return true;
      }
    }
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Merge level: I4, M1, M2 on the merge trace.
// ────────────────────────────────────────────────────────────────────────────

export interface MergeCheckOptions {
  disabled?: ReadonlySet<CheckName>;
  cache?: CheckCache;
}

/** A distributed band whose clip failed a check: the band stays standalone (keyed `${road}|${side}`). */
export interface NoDistribute { key: string; rule: CheckName; reason: string; band_index: number }

export interface MergeCheckResult {
  demote: Demotion[];
  noDistribute: NoDistribute[];
}

/** The city (English label) of each part of the clipped admin resolutions; null = unknown. */
async function adminPartCities(
  res: readonly ResolutionResult[], adminIndices: readonly number[], cache: CheckCache,
): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (const ai of adminIndices) {
    const r = res[ai];
    if (!r || r.status !== 'resolved' || !r.recipe) { out.push(null); continue; }
    if (r.recipe.operation === 'zone_union') {
      const zc = String(r.facts?.zone_city ?? '').trim();
      out.push(zc ? await cache.cityLabel(zc) : null);
      continue;
    }
    const ids = r.recipe.resolved_element_ids;
    if (ids.length === 0) out.push(null);
    for (const id of ids) out.push(r.facts?.district_city_en?.[id] ?? null);
  }
  return out;
}

/**
 * The merge-level checks over ONE merge's trace. A failing standalone band or
 * in-mention clip demotes the band's resolution; a failing DISTRIBUTED clip
 * only returns its distribute key (the band then stays standalone and is
 * checked by I4 on the next round). Pure apart from the read-only map ports.
 */
export async function checkMerged(
  trace: readonly MergeTrace[],
  res: readonly ResolutionResult[],
  db: ResolverDb,
  opts: MergeCheckOptions = {},
): Promise<MergeCheckResult> {
  const cache = opts.cache ?? new CheckCache(db);
  const demote: Demotion[] = [];
  const noDistribute: NoDistribute[] = [];
  const demotedIdx = new Set<number>();
  const keys = new Set<string>();
  const fail = (t: MergeTrace, rule: CheckName, reason: string): void => {
    if (t.kind === 'distributed_clip') {
      const key = t.distribute_key ?? `${t.road}|${t.side ?? ''}`;
      if (!keys.has(key)) { keys.add(key); noDistribute.push({ key, rule, reason, band_index: t.band_index }); }
      return;
    }
    if (!demotedIdx.has(t.band_index)) { demotedIdx.add(t.band_index); demote.push({ index: t.band_index, rule, reason }); }
  };

  for (const t of trace) {
    if (t.kind === 'band') {
      // I4 — a standalone side must run along its road (whole-road measure).
      if (!enabled(opts.disabled, 'road_axis')) continue;
      if (!t.side) { fail(t, 'road_axis', 'side_of_road_not_cardinal'); continue; }
      const v = axisVerdict(await cache.roadAxis(t.road), t.side);
      if (v !== 'ok') fail(t, 'road_axis', v);
      continue;
    }
    // M1 — the clipped districts are in the road's city.
    if (enabled(opts.disabled, 'clip_city')) {
      const roadCity = lowerTrim(res[t.band_index]?.facts?.element_city);
      const parts = await adminPartCities(res, t.admin_indices, cache);
      if (!roadCity) { fail(t, 'clip_city', 'clip_city_unverified'); continue; }
      if (parts.some((p) => !!lowerTrim(p) && lowerTrim(p) !== roadCity)) { fail(t, 'clip_city', 'clip_mixed_cities'); continue; }
      if (parts.length === 0 || parts.some((p) => p === null || !lowerTrim(p))) { fail(t, 'clip_city', 'clip_city_unverified'); continue; }
    }
    // M2 — the road runs the right way INSIDE (or around) those districts.
    if (enabled(opts.disabled, 'road_axis')) {
      if (!t.side) { fail(t, 'road_axis', 'side_of_road_not_cardinal'); continue; }
      const v = axisVerdict(await cache.roadAxis(t.road, t.district_ids), t.side);
      if (v !== 'ok') fail(t, 'road_axis', v);
    }
  }
  return { demote, noDistribute };
}
