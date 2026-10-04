/**
 * Per-mention ANCHOR PREPARATION — the LEGACY path between the extractor's
 * typed anchors and the resolver (added 2026-10-03; rebuilt 2026-10-04 by the
 * binding design «Geo agent: road sides, landmarks and distances», §2.1).
 *
 * WHY: the resolver's operation branches (a side of a road, «قريب من X» with a
 * distance) read companions from the ResolutionContext — `radius_m`,
 * `proximity`, `city` — that only the mention's own words can supply. This
 * module derives them FROM THE CUSTOMER'S TEXT and reshapes the anchors into
 * the shapes the resolver already handles.
 *
 * TWO KINDS OF RULE (design §1). An ENABLING rule turns an ask into a place
 * (a fold, a royal short name, a city owning a direction, a retyped road, a
 * scope city, a venue built from a city word) and needs POSITIVE textual
 * evidence: adjacency in the customer's own words, or an exact match. A VETO
 * only sets `ask_reason` — the orchestrator then answers needs_confirm without
 * resolving. Nothing here ever falls back to the established city, a default
 * radius for a distance the customer said, the first road, or a namesake: when
 * a rule cannot decide, it asks.
 *
 * The rules, in their BINDING order (P7 runs after P8):
 *
 *   P0  TEXTS. The mention's words are `mention_span` plus, when the
 *       conversation is supplied, the customer's own turns attributed to the
 *       mention (same `source.ref`; every turn of an unlabelled call). Adjacency
 *       rules read `mention_span` only; grounding (P11) and distance (P10)
 *       accept any of the texts.
 *   P1  A `direction` anchor with NO direction word whose text starts with a
 *       road word («طريق الملك فهد») is retyped `road` (enabling).
 *   P2  Repeated words: a city / region / bare cardinal whose every occurrence
 *       lies strictly inside a longer road, venue, relative reference or road
 *       side is part of that name and dropped («الدمام» in «طريق الدمام») —
 *       but the city a direction is OF stays («الرياض» in «شمال الرياض»). A
 *       bare cardinal left with no occurrence while its twin has one is
 *       dropped too. A dropped anchor's distance moves to its container.
 *   P3  Proximity, per anchor: its role (proximity / near / along / على) or a
 *       proximity phrase right before it. Soft punctuation (quotes, brackets)
 *       and one English «the» may stand between; hard punctuation breaks it.
 *   P4  FOLD (enabling, strict): a bare cardinal immediately followed by a road
 *       (or a bare royal name) — nothing between, or exactly one «طريق /
 *       شارع», no punctuation, the road's word bare or with «ل» — becomes ONE
 *       road side whose span is the customer's own words. Never across «على»
 *       / «من», never a «near» road, never a corridor bound.
 *   P5  A direction WITH a referent is read span-first: «حي …» asks
 *       (side_of_district); a road-like referent is a road (a bare royal name
 *       becomes «الملك …»); a span referent that is not road-like while the
 *       model's token is asks (referent_road_word_disagrees); otherwise the
 *       customer's referent replaces the token's. A span with no referent is
 *       BARE — but a referent only the TOKEN carries is never dropped: a road /
 *       district one asks (referent_only_in_token), any other only CONFIRMS
 *       (`confirm_city`, Rule Z) and is a named place (repair round 1). A span
 *       with no direction word takes its side from the token, and that side
 *       must be said somewhere in the customer's words (checked in P11).
 *   P6  OWNER (enabling, strict): a bare cardinal immediately followed by a
 *       city («شمال جدة», «شمال مدينة جدة», «شمال بجدة») is that city's zone; by
 *       a region it asks (zone_of_region).
 *   P8  CITY → VENUE: a city that is itself a «near» target or carries a
 *       distance becomes the venue named by the words after it («قريب من
 *       الرياض بارك» → landmark «الرياض بارك»); with nothing after it, it asks
 *       (proximity_to_city). A direction owned by such a city is no longer
 *       owned.
 *   P7  BARE DIRECTIONS — the closed set BD1–BD5 that replaced all conjunction
 *       logic. A bare direction neither folded nor owned asks beside a region
 *       (BD1) or beside any non-admin place / road side / owned direction
 *       (BD2); right next to a district (or not in the text beside one) it is
 *       that district's side and asks (BD4 — checked BEFORE BD3 since repair
 *       round 1, so a city word never cancels it); beside named cities it only
 *       CONFIRMS the established city (BD3); otherwise it is the established
 *       city's zone (BD5).
 *   P9  SCOPE: exactly one named city scopes every element lookup (`city`) and
 *       every district (`admin_city`) — only when it QUALIFIES them (a «ب /
 *       في» before it, an owned direction, a direction's referent) and no
 *       disjunction word stands between it and the place; two or more leave
 *       the elements unclear. A city that qualifies nothing beside another
 *       place («الروضة او جدة», «الروضة، جدة») asks (city_role_unclear).
 *   P10 DISTANCE (HARD RULE 4, veto): a `distance_m` becomes `radius_m` only
 *       when the closed grammar (distanceText.ts) finds that number in the
 *       customer's words; otherwise it asks (distance_unverified).
 *   P11 GROUNDING (A1, veto): a structural anchor (road, venue, relative
 *       reference, road side, a retyped road) whose ORIGINAL words are in none
 *       of the texts asks (anchor_not_in_text) — the model assembled it.
 *
 * Every decision is made from the TEXT, by whole words, never by array
 * position or substring. Each anchor owns ITS OWN occurrence in the text: the
 * k-th anchor with a given text takes the k-th match.
 *
 * «بين طريقين» is NOT prepared: there is no "between two roads" geometry, so it
 * stays needs_confirm('corridor_underspecified').
 *
 * PURE: no IO, never mutates its input. The stored evidence rows are never
 * changed — like companyRules.ts, the preparation shapes the proposal only, so
 * a change here takes effect on a re-review without re-extraction.
 */

import type { AnchorToken, Evidence } from './ontology.js';
import { sanitizeDistanceM } from './ontology.js';
import type { Conversation } from './extractor.js';
import {
  parseDirection, placeKey, roadKey, isRoadReferentText, cardinalSide, stripDirectionClitic, spanReferent,
  type ResolutionContext,
} from './resolver.js';
import { distancesIn } from './distanceText.js';

/** The per-anchor companions this module derives (merged over the run context). */
export type AnchorContext = Pick<
  ResolutionContext,
  'radius_m' | 'proximity' | 'city' | 'admin_city' | 'city_unclear' | 'referent_is_road' | 'confirm_city' | 'ask_reason' | 'station'
>;

/** A city / region the mention NAMES (for the conversation check I9). */
export interface NamedPlace { kind: 'city' | 'region'; token: string }

export interface PreparedMention {
  anchors: AnchorToken[];
  /** Aligned 1:1 with `anchors`. */
  contexts: AnchorContext[];
  /** «او / أو / ولا / والا / ام / or / either» or «يا … يا» in `mention_span` (V8: or is not and; {@link isDisjunctive}). */
  disjunctive: boolean;
  /** 'structured' only in Phase B (geo-extract/v10); this module is the legacy path. */
  mode: 'legacy' | 'structured';
  /** Cities / regions this mention NAMES (for the conversation check I9). */
  named_places: NamedPlace[];
}

export interface PrepareOptions {
  /** The conversation the evidence was read from: the customer's attributed turns join the mention's texts (P0). */
  conversation?: Conversation;
}

// ────────────────────────────────────────────────────────────────────────────
// Whole-word text of a mention.
// ────────────────────────────────────────────────────────────────────────────

/** Fold a word for comparison: lower-case, no diacritics / tatweel, أإآ→ا, ة→ه, ى→ي. */
export function foldWord(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي');
}

export interface MentionToken {
  /** The word as written. */
  raw: string;
  /** {@link foldWord} of it. */
  f: string;
  /** Punctuation of EITHER kind stands between this word and the previous one. */
  punctBefore: boolean;
  /** HARD punctuation («،», «.», «-», «/»…) stands between this word and the previous one. */
  hardPunctBefore: boolean;
}

/**
 * A word is letters, digits and combining marks — anything else separates
 * words. WhatsApp text carries emoji, bold / italic / strike markers («*», «_»,
 * «~») and direction marks glued to words («الرياض🙏», «*الرياض*»); those are
 * separators that do NOT count as punctuation, so «قريب من *الرياض* بارك»
 * still reads as one phrase.
 */
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
/** HARD punctuation: it ends a phrase everywhere (a fold, an owner, a venue name, a proximity phrase). */
const HARD_PUNCT = /[،,.!?؟؛;:…–—\-/\\]/;
/** SOFT punctuation: quotes and brackets. It blocks the enabling rules but not «قريب من "…"». */
const SOFT_PUNCT = /[()[\]{}«»"'‘’“”]/;

/** Split text into words, remembering where punctuation (and which kind) stood. */
export function tokenize(text: string): MentionToken[] {
  const s = String(text ?? '');
  const out: MentionToken[] = [];
  let last = 0;
  let pendingPunct = false;
  let pendingHard = false;
  WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(s)) !== null) {
    const gap = s.slice(last, m.index);
    last = m.index + m[0].length;
    const f = foldWord(m[0]);
    const hard: boolean = pendingHard || HARD_PUNCT.test(gap);
    const punct: boolean = pendingPunct || hard || SOFT_PUNCT.test(gap);
    if (!f) { pendingPunct = punct; pendingHard = hard; continue; } // a lone tatweel / diacritic
    const first = out.length === 0;
    out.push({ raw: m[0], f, punctBefore: !first && punct, hardPunctBefore: !first && hard });
    pendingPunct = false;
    pendingHard = false;
  }
  return out;
}

/** Where an anchor's words sit in the mention: token range [start, end) + the clitic on its first word. */
export interface Occurrence { start: number; end: number; prefix: string }

/** Clitics a word may carry in front of a place name: «و/ف» then «ب/ل/ك» («بالرياض», «ولطريق»). */
const CLITIC = /^(و|ف)?(ب|ل|ك)?$/;

/** The clitic `t` carries in front of `s` ('' for an exact word), or null when `t` is another word. */
function cliticPrefix(t: string, s: string): string | null {
  if (t === s) return '';
  if (t.length > s.length && t.endsWith(s)) {
    const p = t.slice(0, t.length - s.length);
    if (CLITIC.test(p)) return p;
  }
  // «للعليا» = ل + العليا: the article's alef drops after «ل».
  if (s.startsWith('ال') && t.length > s.length - 1 && t.endsWith(s.slice(1))) {
    const p = t.slice(0, t.length - (s.length - 1));
    if (p === 'ل' || p === 'ول' || p === 'فل') return p;
  }
  return null;
}

/** Every place `phrase` occurs in `tokens`, as whole words (its first word may carry a clitic). */
export function locatePhrase(tokens: readonly MentionToken[], phrase: string): Occurrence[] {
  const want = tokenize(phrase).map((t) => t.f);
  if (want.length === 0) return [];
  const out: Occurrence[] = [];
  for (let i = 0; i + want.length <= tokens.length; i++) {
    const prefix = cliticPrefix(tokens[i]!.f, want[0]!);
    if (prefix === null) continue;
    let ok = true;
    for (let k = 1; k < want.length; k++) {
      const t = tokens[i + k]!;
      if (t.f !== want[k] || t.punctBefore) { ok = false; break; }
    }
    if (ok) out.push({ start: i, end: i + want.length, prefix });
  }
  return out;
}

/** Where an anchor's words occur: by its span, else by its normalized token. */
export function locateAnchor(tokens: readonly MentionToken[], a: Pick<AnchorToken, 'span' | 'normalized_token'>): Occurrence[] {
  const bySpan = locatePhrase(tokens, a.span ?? '');
  if (bySpan.length) return bySpan;
  return a.normalized_token && a.normalized_token !== a.span ? locatePhrase(tokens, a.normalized_token) : [];
}

const occKey = (o: Occurrence): string => `${o.start}:${o.end}`;

/**
 * Each anchor's OWN occurrences. Anchors with the same text share one list of
 * matches; the k-th such anchor (in extraction order) takes the k-th match (in
 * text order) — the last one also keeps any matches left over, so ONE anchor
 * for a word said twice still sees both. Without this, two «شمال» anchors each
 * saw both «شمال»s, and a city owning one of them blocked the other's fold.
 */
export function anchorOccurrences(tokens: readonly MentionToken[], anchors: readonly AnchorToken[]): Occurrence[][] {
  const all = anchors.map((a) => locateAnchor(tokens, a));
  const groups = new Map<string, number[]>();
  all.forEach((occ, i) => {
    if (occ.length === 0) return;
    const key = occ.map(occKey).join(',');
    const g = groups.get(key);
    if (g) g.push(i); else groups.set(key, [i]);
  });
  const out = all.slice();
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const occ = all[idxs[0]!]!;
    idxs.forEach((i, k) => {
      out[i] = k < idxs.length - 1 ? (occ[k] ? [occ[k]!] : []) : occ.slice(k);
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// P0 — the mention's texts.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The customer's words for this mention, as plain strings: `[0]` is
 * `mention_span`; then each turn of the conversation attributed to the mention
 * (the turn's ref — or the conversation id for a turn without one, exactly as
 * the extractor attributes it — equals `source.ref`) that the CUSTOMER said:
 * `speaker === 'client'`, or any turn of a call whose speaker labels are absent
 * or 'none' (nobody can tell who spoke). Without a conversation (unit tests,
 * the harness) it is `[mention_span]` only.
 */
export function mentionStrings(e: Pick<Evidence, 'mention_span' | 'source'>, conversation?: Conversation): string[] {
  const out = [String(e.mention_span ?? '')];
  const ref = e.source?.ref;
  if (!conversation || !ref) return out;
  const unlabelledCall = conversation.channel === 'call'
    && (conversation.speaker_labels === undefined || conversation.speaker_labels === 'none');
  for (const t of conversation.turns ?? []) {
    if ((t.ref ?? conversation.id) !== ref) continue;
    if (t.speaker === 'client' || unlabelledCall) out.push(String(t.text ?? ''));
  }
  return out;
}

/** {@link mentionStrings}, tokenized. Positions used by adjacency rules always refer to `[0]` (`mention_span`). */
export function mentionTexts(e: Pick<Evidence, 'mention_span' | 'source'>, conversation?: Conversation): MentionToken[][] {
  return mentionStrings(e, conversation).map(tokenize);
}

// ────────────────────────────────────────────────────────────────────────────
// Adjacency.
// ────────────────────────────────────────────────────────────────────────────

/** The ONE word allowed between a direction and the road it folds with (P4). */
const FOLD_GAP_WORDS: ReadonlySet<string> = new Set(['طريق', 'الطريق', 'شارع', 'الشارع'].map(foldWord));
/** The ONE word allowed between a direction and the city that owns it (P6). */
const OWNER_GAP_WORDS: ReadonlySet<string> = new Set(['مدينة', 'محافظة'].map(foldWord));
/** Words that make a mention a disjunction (V8: «او» is not «و»). */
const DISJUNCTIONS: ReadonlySet<string> = new Set(['او', 'ولا', 'والا', 'ام', 'or', 'either'].map(foldWord));

/**
 * V8 — the mention offers ALTERNATIVES: one of {@link DISJUNCTIONS} as a whole
 * word («او / أو / ولا / وإلا / والّا / ام / or / either» — «وإلا» and «والّا»
 * fold to «والا»), or the «يا … يا» either/or construction (two «يا» words).
 * Over-reading a vocative «يا» only ever ASKS (a clip held, a band not
 * distributed, a city not taken as scope), so the test is deliberately loose.
 */
export function isDisjunctive(tokens: readonly MentionToken[]): boolean {
  if (tokens.some((t) => DISJUNCTIONS.has(t.f))) return true;
  return tokens.filter((t) => t.f === 'يا').length >= 2;
}

/**
 * The mention is OFFERED AS AN ALTERNATIVE in the customer's own words: some
 * occurrence of its `mention_span` in its texts (the span, then the attributed
 * customer turns) comes RIGHT AFTER a disjunction word («النرجس او شمال طريق
 * الملك سلمان» → the road side is «او …»). Used to keep a road side said as an
 * alternative from being distributed onto other mentions (2026-10-04). Only the
 * word right before counts: in «المعذر الشمالي او المحمديه او العليا (غرب الملك
 * فهد)» the «او» joins the DISTRICTS, and the road side applies to all of them.
 */
export function offeredAsAlternative(e: Pick<Evidence, 'mention_span' | 'source'>, conversation?: Conversation): boolean {
  const span = String(e.mention_span ?? '').trim();
  if (!span) return false;
  for (const tokens of mentionTexts(e, conversation)) {
    for (const o of locatePhrase(tokens, span)) {
      // The disjunction may sit a few FILLER words back — «او اي مكان شمال
      // طريق الملك سلمان», «او في شمال …» (2026-10-04: that phrasing was read
      // as "Narjis north of the road"). Only filler words are skipped; a place
      // name between (the «او» joins districts) still stops the walk.
      let k = o.start - 1;
      for (let skipped = 0; k >= 0 && skipped < ALT_FILLER_MAX && ALT_FILLER.has(tokens[k]!.f); skipped++) k -= 1;
      const prev = tokens[k];
      if (prev && DISJUNCTIONS.has(prev.f)) return true;
    }
  }
  return false;
}

/** Words that may stand between «او» and the alternative it offers («او اي مكان …», «او في …»). */
const ALT_FILLER: ReadonlySet<string> = new Set(
  ['اي', 'أي', 'مكان', 'حي', 'منطقة', 'جهة', 'في', 'بس', 'حتى', 'ولو', 'any', 'anywhere', 'in'].map(foldWord),
);
const ALT_FILLER_MAX = 3;

/** Words that put a city IN front of what it scopes («في جدة», «in Jeddah»). */
const IN_WORDS: ReadonlySet<string> = new Set(['في', 'فى', 'وفي', 'وفى', 'in', 'داخل', 'بداخل'].map(foldWord));

/**
 * A city occurrence INTRODUCED as a place-in: a «ب» clitic («بجدة», «وبجدة»), or
 * «في / in» right before it — optionally across ONE «مدينة / محافظة» («في مدينة
 * جدة», «بمدينة جدة»). No punctuation between. P9 takes a named city as the
 * scope of the mention's other places only when it is introduced this way (or
 * owns / is the referent of a direction): «الروضة او جدة», «الروضة، جدة» offer
 * Jeddah as ANOTHER place, not as Rawdah's city.
 */
function cityIntroduced(tokens: readonly MentionToken[], o: Occurrence): boolean {
  if (o.prefix.endsWith('ب')) return true;
  let k = o.start;
  if (k > 0 && !tokens[k]!.punctBefore) {
    const g = tokens[k - 1]!.f;
    for (const w of OWNER_GAP_WORDS) {
      const p = cliticPrefix(g, w);
      if (p === null) continue;
      if (p.endsWith('ب')) return true;
      k -= 1;
      break;
    }
  }
  return k > 0 && !tokens[k]!.punctBefore && IN_WORDS.has(tokens[k - 1]!.f);
}

/** Word stems of each cardinal (adjectives included: «شمالي», «الشرقية», «northern»). */
const ZONE_STEMS: Readonly<Record<string, readonly string[]>> = {
  north: ['شمال', 'north'], south: ['جنوب', 'south'], east: ['شرق', 'east'], west: ['غرب', 'west'],
  center: ['وسط', 'center', 'central'],
};
const DIAGONAL_PARTS: Readonly<Record<string, readonly [string, string]>> = {
  northeast: ['north', 'east'], northwest: ['north', 'west'], southeast: ['south', 'east'], southwest: ['south', 'west'],
};

/** `t` (a folded word) is a word of `zone`: its stem, after an optional «و/ف» + «ب/ل/ك» clitic and the article. */
function wordOfZone(t: string, zone: string): boolean {
  const bare = t.replace(/^(و|ف)?(ب|ل|ك)?(ال)?/, '');
  return (ZONE_STEMS[zone] ?? []).some((s) => t.startsWith(s) || bare.startsWith(s));
}

/**
 * The customer's words say `zone` somewhere («شمال», «بالشمال», «الشمالي»,
 * «northern»; a diagonal needs both of its words). Grounds a direction that
 * only the model's normalized token gave (P5 rule f, checked in P11).
 */
function zoneSaid(tokens: readonly MentionToken[], zone: string): boolean {
  const parts = DIAGONAL_PARTS[zone];
  if (parts) return parts.every((z) => tokens.some((t) => wordOfZone(t.f, z)));
  return tokens.some((t) => wordOfZone(t.f, zone));
}

/**
 * `y` comes after `x` with nothing between but `allowed` words (at most `max`)
 * and NO punctuation anywhere between — including right after `x`'s last word
 * («بالشمال، طريق …» is two phrases, not one).
 */
function followedBy(
  tokens: readonly MentionToken[], x: Occurrence, y: Occurrence, allowed: ReadonlySet<string>, max: number,
): boolean {
  if (y.start < x.end || y.start - x.end > max) return false;
  for (let k = x.end; k < y.start; k++) if (!allowed.has(tokens[k]!.f)) return false;
  for (let k = x.end; k <= y.start; k++) if (tokens[k]?.punctBefore) return false;
  return true;
}

/** The clitic the FOLLOWING anchor's first word may carry and still be the direction's road (P4) / city (P6). */
const ROAD_AFTER_PREFIXES: ReadonlySet<string> = new Set(['', 'ل']);
const CITY_AFTER_PREFIXES: ReadonlySet<string> = new Set(['', 'ل', 'ب']);

/**
 * BD4: a direction right next to a district, in either order — no word
 * between, or exactly «حي» (with or without a clitic: «شمال حي النرجس», «شمال
 * بحي النرجس»). Punctuation does NOT break it («النرجس، الشمال منه»).
 */
function besideDistrict(tokens: readonly MentionToken[], a: Occurrence, b: Occurrence): boolean {
  const gapOk = (from: number, to: number): boolean =>
    to === from || (to === from + 1 && !!tokens[from] && cliticPrefix(tokens[from]!.f, 'حي') !== null);
  return gapOk(a.end, b.start) || gapOk(b.end, a.start);
}

// ────────────────────────────────────────────────────────────────────────────
// P3 — proximity, per anchor, whole words only.
// ────────────────────────────────────────────────────────────────────────────

/** Phrases that make the anchor RIGHT AFTER them a «near X» target. */
export const PROXIMITY_PHRASES: readonly string[] = [
  'قريب من', 'قريبة من', 'قرب', 'بالقرب من', 'جنب', 'بجنب', 'بجانب', 'جوار', 'بجوار', 'مشي من',
  'near', 'close to', 'next to',
];
const PROXIMITY_WORDS = PROXIMITY_PHRASES.map((p) => tokenize(p).map((t) => t.f));

/**
 * The role names «near X» / «along X» (`proximity`, `constraint_proximity`,
 * `near`, `along`, «على») — as words, so «approximate» is not. «على طريق X» is
 * along the road, never a side of it: the resolver's road path then needs a
 * stated distance and asks otherwise.
 */
function isProximityRole(a: AnchorToken): boolean {
  const words = foldWord(String(a.role_in_relation ?? '')).split(/[^a-zء-ي]+/).filter(Boolean);
  return words.some((w) => w === 'proximity' || w === 'near' || w === 'along' || w === 'قرب' || w === 'قريب' || w === 'علي');
}

/** The role says «one of the two roads of a corridor» (`boundary_start` / `boundary_end`…). */
function isBoundaryRole(a: AnchorToken): boolean {
  const words = foldWord(String(a.role_in_relation ?? '')).split(/[^a-zء-ي]+/).filter(Boolean);
  return words.some((w) => w === 'boundary' || w === 'corridor' || w === 'between' || w === 'بين');
}

/**
 * One of `phrases` stands, as whole words, right before `o` (its first word may
 * carry «و»). Between the phrase and the place, SOFT punctuation («قريب من
 * "الرياض بارك"», «قريب من (…)») and ONE English article («near the Riyadh
 * Park») are ignored; HARD punctuation breaks it. Punctuation inside the
 * phrase breaks it.
 */
function precededBy(tokens: readonly MentionToken[], o: Occurrence, phrases: readonly (readonly string[])[]): boolean {
  if (!tokens[o.start] || tokens[o.start]!.hardPunctBefore) return false;
  let end = o.start;
  if (end > 0 && tokens[end - 1]!.f === 'the') {
    end -= 1;
    if (tokens[end]!.hardPunctBefore) return false;
  }
  return phrases.some((ph) => {
    const s = end - ph.length;
    if (s < 0) return false;
    for (let k = 0; k < ph.length; k++) {
      const t = tokens[s + k]!;
      if (k > 0 && t.punctBefore) return false;
      if (t.f !== ph[k] && !(k === 0 && t.f === `و${ph[k]}`)) return false;
    }
    return true;
  });
}

/** Words that say the venue is a STATION (folded). */
const STATION_WORD_SET: ReadonlySet<string> = new Set(['محطة', 'مترو', 'المترو', 'metro', 'station'].map(foldWord));
const STATION_PHRASES = ['محطة مترو', 'محطة المترو', 'محطة', 'مترو', 'المترو', 'metro station', 'station', 'metro']
  .map((p) => tokenize(p).map((t) => t.f));

/**
 * The customer said the venue is a station: a station word inside its span
 * («محطة مترو العليا»), or right before it in their words — the extractor
 * often keeps only the name («قريبة من محطة مستشفى الإيمان» → span «مستشفى
 * الإيمان»). Sets ResolutionContext.station (resolver: a metro station of
 * that name wins over a same-named hospital / district).
 */
export function saidAsStation(texts: readonly (readonly MentionToken[])[], a: Pick<AnchorToken, 'span' | 'normalized_token'>): boolean {
  if (tokenize(String(a.span ?? '')).some((t) => STATION_WORD_SET.has(t.f))) return true;
  return texts.some((tk) => locateAnchor(tk, a).some((o) => precededBy(tk, o, STATION_PHRASES)));
}

/** A proximity phrase stands, as whole words, right before one of `occ`. */
function precededByProximity(tokens: readonly MentionToken[], occ: readonly Occurrence[]): boolean {
  return occ.some((o) => precededBy(tokens, o, PROXIMITY_WORDS));
}

/** For each anchor of the mention: is it a «near X» target (P3)? */
export function proximityTargets(e: Pick<Evidence, 'mention_span' | 'anchors'>): boolean[] {
  const tokens = tokenize(e.mention_span ?? '');
  const occ = anchorOccurrences(tokens, e.anchors);
  return e.anchors.map((a, i) => isProximityRole(a) || precededByProximity(tokens, occ[i]!));
}

// ────────────────────────────────────────────────────────────────────────────
// Royal short road names.
// ────────────────────────────────────────────────────────────────────────────

/** Royal names customers say as a bare road name («جنوب سلمان» = south of King Salman Road). */
export const ROYAL_SHORT_NAMES: readonly string[] = ['سلمان', 'فهد', 'خالد', 'عبدالله', 'عبدالعزيز', 'فيصل', 'سعود'];

/** Folded, spaces dropped («عبد الله» ≡ «عبدالله») — but the ARTICLE is kept: «الفهد» is not «فهد». */
const royalKey = (s: string): string => foldWord(s).replace(/\s+/g, '');
const ROYAL_KEYS = new Map(ROYAL_SHORT_NAMES.map((n) => [royalKey(n), n] as const));

/** Words that make a text NOT a bare royal name («حي الملك سلمان», «طريق فهد», «الملك فهد»). */
const NOT_BARE_ROYAL = /(^|\s)(حي|طريق|شارع|الملك|ملك)(\s|$)/;
/** A place word anywhere in the anchor → the anchor names a district / road by it, never a bare name. */
const PLACE_WORD = /(^|\s)(حي|طريق|شارع)(\s|$)/;

/** The royal name a text is, exactly and without the article, else null. */
export function bareRoyalText(text: string): string | null {
  if (NOT_BARE_ROYAL.test(String(text ?? ''))) return null;
  return ROYAL_KEYS.get(royalKey(text ?? '')) ?? null;
}

/**
 * The bare royal name an anchor stands for, else null. Decided on the
 * customer's own word (the `span`; the normalized token only when there is no
 * span): «الفهد» — a real district in Najran, Bisha, Sharurah… — is never
 * «فهد». «حي / طريق / شارع» anywhere in span OR normalized token disqualifies
 * it (the extractor deletes «حي» from the normalized token, so «حي سلمان»
 * arrives normalized «سلمان»). «الملك» is checked on the span only: a
 * normalized token that is exactly the name or «الملك <name>» is the road
 * reading the extractor was told to write, not evidence of a district.
 */
export function bareRoyalName(a: Pick<AnchorToken, 'span' | 'normalized_token'>): string | null {
  const span = (a.span ?? '').trim();
  const norm = (a.normalized_token ?? '').trim();
  if (PLACE_WORD.test(`${span} ${norm}`)) return null;
  const name = bareRoyalText(span || norm);
  if (!name) return null;
  if (span && norm) {
    const k = royalKey(norm);
    if (k !== royalKey(name) && k !== royalKey(`الملك ${name}`)) return null;
  }
  return name;
}

// ────────────────────────────────────────────────────────────────────────────
// Directions — read span-first (design principle 3: the customer's span beats
// the model's token; the token only supplies lookup spellings).
// ────────────────────────────────────────────────────────────────────────────

/** The word written into a rebuilt normalized token for each parsed zone. */
const ZONE_WORD: Readonly<Record<string, string>> = {
  north: 'شمال', south: 'جنوب', east: 'شرق', west: 'غرب', center: 'وسط',
  northeast: 'شمال شرق', northwest: 'شمال غرب', southeast: 'جنوب شرق', southwest: 'جنوب غرب',
};

/** A referent without an English «of (the)» («north of Riyadh» → «Riyadh»). */
const cleanReferent = (rest: string): string => String(rest ?? '').trim().replace(/^of\s+(?:the\s+)?/i, '').trim();

/**
 * The direction a text states: from the clitic-stripped SPAN when it has a
 * direction word, else from the normalized token. `rest` is the referent after
 * the direction word ('' for a bare direction).
 */
function readDirection(a: Pick<AnchorToken, 'span' | 'normalized_token'>): { zone: string | null; rest: string; fromSpan: boolean } {
  const s = parseDirection(stripDirectionClitic(a.span ?? ''));
  if (s.zone) return { zone: s.zone, rest: cleanReferent(s.rest), fromSpan: true };
  const t = parseDirection(stripDirectionClitic(a.normalized_token ?? ''));
  return { zone: t.zone, rest: t.zone ? cleanReferent(t.rest) : '', fromSpan: false };
}

/** A direction with NO referent — a cardinal, a diagonal or «وسط» («شمال», «بالشمال», «الشمالي»). */
function isBareDirection(a: AnchorToken): boolean {
  if (a.anchor_type !== 'direction') return false;
  const r = readDirection(a);
  return r.zone !== null && r.rest === '';
}

/** A bare direction with a cardinal side (the ones that fold, are owned, or are repeated words). Span-first. */
function isBareCardinal(a: AnchorToken): boolean {
  return isBareDirection(a) && !!cardinalSide(readDirection(a).zone);
}

/** A direction's referent after the direction word, read from the normalized token ('' for a bare direction). */
function restOf(a: AnchorToken): string {
  return parseDirection(a.normalized_token || a.span || '').rest.trim();
}

/** The referent the model's normalized token gives after ITS direction word ('' when it has none). */
function tokenReferent(a: AnchorToken): string {
  const t = parseDirection(stripDirectionClitic(a.normalized_token ?? ''));
  return t.zone ? t.rest.trim() : '';
}

/** A referent that names a road: a road word («طريق …»), a bare royal name («سلمان») or «الملك <royal>». */
function roadLikeReferent(rest: string): boolean {
  const r = String(rest ?? '').trim();
  if (!r) return false;
  if (isRoadReferentText(r) || bareRoyalText(r) !== null) return true;
  const m = /^الملك\s+(.+)$/.exec(r);
  return !!m && bareRoyalText(m[1]!) !== null;
}

/**
 * The anchor with a normalized token that says `zone` + `rest`. The SAME object
 * when its token already says that (same zone; same referent under `key`), so a
 * stored row whose token agrees with its span is never copied.
 */
function retoken(a: AnchorToken, zone: string, rest: string, key: (s: string) => string): AnchorToken {
  const cur = parseDirection(stripDirectionClitic(a.normalized_token ?? ''));
  if (cur.zone === zone && key(cleanReferent(cur.rest)) === key(rest)) return a;
  const word = ZONE_WORD[zone] ?? zone;
  return { ...a, normalized_token: rest ? `${word} ${rest}` : word };
}

interface ReferentReading {
  anchor: AnchorToken;
  ctx: AnchorContext;
  /** Path d: the customer's referent, a place the mention may NAME (named_places). */
  named?: string;
}

/** P5 rules a–d on one referent (`said` = the customer's, `tok` = the model's). */
function referentRules(a: AnchorToken, zone: string, said: string, tok: string): ReferentReading {
  // a. «جنوب حي سلمان» — the customer named a DISTRICT: a district has no road side.
  if (/^حي(\s|$)/.test(said)) return { anchor: a, ctx: { ask_reason: 'side_of_district' } };
  // b. A road-like referent IS a road. A bare royal name is the King … Road.
  if (roadLikeReferent(said)) {
    const royal = bareRoyalText(said);
    const rest = royal ? `الملك ${royal}` : said;
    return { anchor: retoken(a, zone, rest, roadKey), ctx: { referent_is_road: true } };
  }
  // c. The customer's referent is not a road but the model's token made it one
  //    («شرق الدمام» → «شرق طريق الدمام», «شمال الفهد» → «شمال الملك فهد»): ask.
  if (roadLikeReferent(tok)) return { anchor: a, ctx: { ask_reason: 'referent_road_word_disagrees' } };
  // d. The customer's referent wins over the token's (city first in the resolver, then the namesake vetoes).
  return { anchor: retoken(a, zone, said, placeKey), ctx: {}, named: said };
}

/** P5 — one direction anchor that was not folded, read span-first (rules a–f). */
function directionReferent(a: AnchorToken): ReferentReading {
  const spanZone = parseDirection(stripDirectionClitic(a.span ?? '')).zone;
  if (spanZone) {
    const said = cleanReferent(spanReferent(a));
    if (!said) {
      // e. The span is bare. It stays bare (the side is the customer's) — but a
      //    referent the model put in the TOKEN is not thrown away (repair round
      //    1, 2026-10-04: dropping it drew the ESTABLISHED city's zone for «في
      //    جدة بالشمال» stored as [«بالشمال» / «شمال جدة»], and nothing — not
      //    BD3, not I9 — ever saw the city the customer named):
      //    - a road-like or district referent cannot be checked against the
      //      span → ask (referent_only_in_token);
      //    - any other referent only CONFIRMS (Rule Z: the established zone
      //      stands only when it names the established city, else the resolver
      //      asks) and is a NAMED place for I9.
      const tokRef = cleanReferent(tokenReferent(a));
      const bare = retoken(a, spanZone, '', placeKey);
      if (!tokRef) return { anchor: bare, ctx: {} };
      if (roadLikeReferent(tokRef) || /^حي(\s|$)/.test(tokRef)) return { anchor: a, ctx: { ask_reason: 'referent_only_in_token' } };
      return { anchor: bare, ctx: { confirm_city: tokRef }, named: tokRef };
    }
    return referentRules(a, spanZone, said, cleanReferent(restOf(a)));
  }
  // f. The span has no direction word (older rows): the token decides — the
  //    same rules on its referent (rule a too: asking is always allowed).
  const tok = parseDirection(stripDirectionClitic(a.normalized_token ?? ''));
  if (!tok.zone) return { anchor: a, ctx: {} }; // no direction word anywhere: the resolver asks
  const rest = cleanReferent(tok.rest);
  if (!rest) return { anchor: a, ctx: {} };
  return referentRules(a, tok.zone, rest, rest);
}

// ────────────────────────────────────────────────────────────────────────────
// P8 — city → venue name (rule e).
// ────────────────────────────────────────────────────────────────────────────

/** Words that end a venue name after the city word («الرياض بارك او …»). */
const VENUE_STOP = new Set(['و', 'او', 'في', 'فى', 'بس', 'مع', 'اللي'].map(foldWord));
/**
 * Words that end a venue name because what follows is a DISTANCE or a time
 * («الرياض بارك ٣ كيلو», «خلال», «بحدود») — a digit-led word ends it too.
 */
const DISTANCE_STOP = new Set([
  'كيلو', 'كيلوين', 'كيلومتر', 'كيلومترات', 'كيلوات', 'كم', 'متر', 'مترين', 'امتار',
  'خلال', 'بحدود', 'حدود', 'مسافة', 'بمسافة', 'حوالي', 'تقريبا', 'نص', 'نصف', 'ربع',
  'دقيقة', 'دقايق', 'دقائق', 'ساعة', 'ساعتين',
].map(foldWord));
/**
 * Venue words that merely START with «و» (not the conjunction). Any other
 * «و…» word ends the name («الرياض بارك وجامعة الملك سعود» is two places).
 */
const VENUE_W_WORDS = new Set(['وادي', 'واحة', 'واجهة', 'وورلد', 'ورلد', 'ووك', 'ويست'].map(foldWord));
const MAX_VENUE_TAIL_WORDS = 3;

/** Up to three words right after `occ`, stopping at a stop / distance word, a «و…» word, a number or punctuation. */
function tailAfter(tokens: readonly MentionToken[], occ: Occurrence): string {
  const words: string[] = [];
  for (let k = occ.end; k < tokens.length && words.length < MAX_VENUE_TAIL_WORDS; k++) {
    const t = tokens[k]!;
    if (t.punctBefore || VENUE_STOP.has(t.f) || DISTANCE_STOP.has(t.f)) break;
    if (/^\p{N}/u.test(t.raw)) break;
    if (t.f.startsWith('و') && !VENUE_W_WORDS.has(t.f)) break;
    words.push(t.raw);
  }
  return words.join(' ');
}

/**
 * The words right after the city word in the mention («قريب من الرياض بارك» →
 * «بارك»), as whole words. '' when the city word is not in the mention or
 * nothing follows it.
 */
export function venueTailAfter(mention: string, cityWord: string): string {
  const tokens = tokenize(mention);
  const occ = locatePhrase(tokens, cityWord)[0];
  return occ ? tailAfter(tokens, occ) : '';
}

/** Words a distance is stated FROM («خلال 3 كيلو من الرياض بارك»). */
const FROM_WORDS = [['من'], ['عن']];

// ────────────────────────────────────────────────────────────────────────────
// The preparation.
// ────────────────────────────────────────────────────────────────────────────

interface Item {
  a: AnchorToken;
  ctx: AnchorContext;
  /** The extractor's anchor this item came from (its ORIGINAL words, for P11); null when built here (P4, P8). */
  orig: AnchorToken | null;
  /** Where its words sit in `mention_span` (a fold spans its direction AND its road). */
  occ: Occurrence[];
  /** A «near X» target (P3). */
  prox: boolean;
  /** P1 retyped it from `direction` to `road`. */
  retyped: boolean;
  /** P4 built it from a bare direction + its road. */
  folded: boolean;
  /** P6: the city / region item that owns this bare direction, and its kind at the time. */
  owner?: Item;
  ownerKind?: 'city' | 'region';
  /** P5 path d: the referent the customer named. */
  named?: string;
  /** P8: a city kept as a city but marked «near» (it asks proximity_to_city) — never a scope. */
  proxCity?: boolean;
  /** P8: dropped as a duplicate of its own venue. */
  removed?: boolean;
}

const isCity = (a: AnchorToken) => a.anchor_type === 'city' || a.anchor_type === 'region';
const tokenOf = (a: AnchorToken): string => (a.normalized_token || a.span || '').trim();

/** P1 — a `direction` with no direction word whose text starts with a road word is a ROAD. */
function retypeRoad(a: AnchorToken): AnchorToken {
  if (a.anchor_type !== 'direction') return a;
  if (parseDirection(stripDirectionClitic(a.span ?? '')).zone) return a;
  if (parseDirection(stripDirectionClitic(a.normalized_token ?? '')).zone) return a;
  return isRoadReferentText(a.span ?? '') || isRoadReferentText(a.normalized_token ?? '') ? { ...a, anchor_type: 'road' } : a;
}

/**
 * P2 — `c`'s words can hold `inner` as part of ANOTHER name: a road, a venue,
 * a relative reference, or a direction with a referent — except a city /
 * region that IS that direction's referent («الرياض» in «شمال الرياض» is the
 * place itself; «الدمام» in «جنوب طريق الدمام» is part of a road's name).
 */
function canContain(c: AnchorToken, inner: AnchorToken): boolean {
  if (c.anchor_type === 'road' || c.anchor_type === 'landmark' || c.anchor_type === 'relative_ref') return true;
  if (c.anchor_type !== 'direction') return false;
  const r = readDirection(c);
  if (!r.zone || !r.rest) return false;
  if (inner.anchor_type === 'direction') return true;
  const ref = placeKey(r.rest);
  return ref !== placeKey(inner.span ?? '') && ref !== placeKey(inner.normalized_token ?? '');
}

/**
 * P2 — anchors that are not a separate place because they are the words of
 * another anchor. Returns the kept anchors, their occurrences, the index of
 * each in the input, and which kept venue absorbed a city's stated distance
 * (rule e's duplicate transfer: a distance stated FROM the venue's city word
 * is a «near» reading of the venue).
 */
function dropRepeatedWords(
  tokens: readonly MentionToken[], anchors: readonly AnchorToken[],
): { src: AnchorToken[]; occ: Occurrence[][]; from: number[]; proxCarry: boolean[] } {
  const occ = anchorOccurrences(tokens, anchors);
  const src = anchors.slice();
  const drop = new Set<number>();
  const proxCarry = anchors.map(() => false);
  const len = (o: Occurrence) => o.end - o.start;
  src.forEach((a, i) => {
    const containee = a.anchor_type === 'city' || a.anchor_type === 'region' || isBareCardinal(a);
    if (!containee) return;
    if (occ[i]!.length === 0) {
      // A repeated bare direction left with no occurrence of its own while its twin has one.
      const twin = isBareCardinal(a) && src.some((b, k) => k !== i && !drop.has(k) && occ[k]!.length > 0
        && isBareCardinal(b) && placeKey(tokenOf(b)) === placeKey(tokenOf(a)));
      if (twin) drop.add(i);
      return; // any other anchor with no occurrence is never dropped
    }
    let container = -1;
    const inside = occ[i]!.every((o) => {
      const k = src.findIndex((c, j) => j !== i && !drop.has(j) && canContain(c, a)
        && occ[j]!.some((co) => co.start <= o.start && o.end <= co.end && len(co) > len(o)));
      if (k >= 0 && container < 0) container = k;
      return k >= 0;
    });
    if (!inside || container < 0) return;
    drop.add(i);
    const d = sanitizeDistanceM(a.distance_m);
    if (d !== null && sanitizeDistanceM(src[container]!.distance_m) === null) {
      src[container] = { ...src[container]!, distance_m: d };
      if (src[container]!.anchor_type === 'landmark' && isCity(a)) proxCarry[container] = true;
    }
  });
  const keep = src.map((_, i) => i).filter((i) => !drop.has(i));
  return {
    src: keep.map((i) => src[i]!),
    occ: keep.map((i) => occ[i]!),
    from: keep,
    proxCarry: keep.map((i) => proxCarry[i]!),
  };
}

/** A distance the customer's words state (P10): within max(1 m, 1 %) of `d`. */
const statedIn = (said: readonly number[], d: number): boolean => said.some((v) => Math.abs(v - d) <= Math.max(1, 0.01 * d));

/**
 * Prepare ONE mention's anchors for resolution (P0–P11, in the binding order).
 * Returns the anchors to resolve (some folded / converted / dropped) and,
 * aligned 1:1, the per-anchor context companions. PURE.
 */
export function prepareMention(e: Evidence, opts: PrepareOptions = {}): PreparedMention {
  // P0 — the customer's words.
  const strings = mentionStrings(e, opts.conversation);
  const texts = strings.map(tokenize);
  const tokens = texts[0]!;

  // P1 — a road typed as a direction.
  const typed = e.anchors.map(retypeRoad);
  // P2 — repeated words.
  const { src, occ, from, proxCarry } = dropRepeatedWords(tokens, typed);
  // P3 — proximity, per anchor.
  const prox = src.map((a, i) => isProximityRole(a) || precededByProximity(tokens, occ[i]!) || proxCarry[i]!);

  // P4 — fold a bare cardinal with the road (or bare royal name) right after it.
  interface Fold { road: number; x: Occurrence; y: Occurrence }
  const folds = new Map<number, Fold>(); // direction idx → its road + the two occurrences
  const usedRoadOcc = new Map<number, Set<string>>(); // road idx → occurrences already folded
  src.forEach((d, i) => {
    if (!isBareCardinal(d) || occ[i]!.length === 0) return;
    const pick = (accept: (r: AnchorToken) => boolean): Fold | null => {
      for (let k = 0; k < src.length; k++) {
        const r = src[k]!;
        if (k === i || prox[k] || isBoundaryRole(r) || !accept(r)) continue;
        const used = usedRoadOcc.get(k);
        for (const x of occ[i]!) {
          for (const y of occ[k]!) {
            if (used?.has(occKey(y)) || !ROAD_AFTER_PREFIXES.has(y.prefix)) continue;
            if (followedBy(tokens, x, y, FOLD_GAP_WORDS, 1)) return { road: k, x, y };
          }
        }
      }
      return null;
    };
    const hit = pick((r) => r.anchor_type === 'road')
      ?? pick((r) => (r.anchor_type === 'district' || r.anchor_type === 'town') && bareRoyalName(r) !== null);
    if (!hit) return;
    const used = usedRoadOcc.get(hit.road) ?? new Set<string>();
    used.add(occKey(hit.y));
    usedRoadOcc.set(hit.road, used);
    folds.set(i, hit);
  });
  const consumed = new Set([...folds.values()].map((f) => f.road));

  let items: Item[] = [];
  src.forEach((a, i) => {
    if (consumed.has(i)) return; // folded into its direction(s)
    const f = folds.get(i);
    if (f) {
      const road = src[f.road]!;
      const royal = bareRoyalName(road);
      const zone = readDirection(a).zone!;
      const distance = sanitizeDistanceM(a.distance_m) ?? sanitizeDistanceM(road.distance_m);
      items.push({
        a: {
          anchor_type: 'direction',
          // The customer's own words, so grounding (P11) holds by construction.
          span: tokens.slice(f.x.start, f.y.end).map((t) => t.raw).join(' '),
          normalized_token: `${ZONE_WORD[zone] ?? zone} ${royal ? `الملك ${royal}` : tokenOf(road)}`,
          ...(a.role_in_relation ? { role_in_relation: a.role_in_relation } : {}),
          ...(distance !== null ? { distance_m: distance } : {}),
        },
        ctx: { referent_is_road: true },
        orig: null,
        occ: [{ start: f.x.start, end: f.y.end, prefix: f.x.prefix }],
        prox: false,
        retyped: false,
        folded: true,
      });
      return;
    }
    const k = from[i]!;
    items.push({
      a, ctx: {}, orig: typed[k]!, occ: occ[i]!, prox: prox[i]!, retyped: typed[k] !== e.anchors[k], folded: false,
    });
  });

  // P5 — a direction with a referent, span-first.
  for (const it of items) {
    if (it.folded || it.a.anchor_type !== 'direction') continue;
    const r = directionReferent(it.a);
    it.a = r.anchor;
    it.ctx = { ...it.ctx, ...r.ctx };
    if (r.named) it.named = r.named;
  }

  // P6 — a city / region right after a bare cardinal owns it.
  for (const it of items) {
    if (it.folded || it.ctx.ask_reason || !isBareCardinal(it.a) || it.occ.length === 0) continue;
    const c = items.find((o) => o !== it && isCity(o.a) && it.occ.some((x) => o.occ.some((y) =>
      CITY_AFTER_PREFIXES.has(y.prefix) && followedBy(tokens, x, y, OWNER_GAP_WORDS, 1))));
    if (!c) continue;
    it.owner = c;
    it.ownerKind = c.a.anchor_type === 'region' ? 'region' : 'city';
    if (it.ownerKind === 'region') it.ctx = { ...it.ctx, ask_reason: 'zone_of_region' };
  }

  // P8 — a city is a «near X» target only when IT is the target.
  for (const it of items) {
    if (it.removed || !isCity(it.a)) continue;
    // A distance stated FROM a city («خلال 3 كيلو من الرياض بارك») is a
    // proximity reading too — a city record with a radius means nothing.
    const ownDistance = sanitizeDistanceM(it.a.distance_m);
    if (!it.prox && ownDistance === null) continue;
    // The occurrence the customer measured from: after «قريب من …», else after
    // «من / عن», else the first («في الرياض فيلا خلال 3 كيلو من الرياض بارك»
    // measures from the SECOND «الرياض»).
    const at = it.occ.find((o) => precededBy(tokens, o, PROXIMITY_WORDS))
      ?? it.occ.find((o) => precededBy(tokens, o, FROM_WORDS))
      ?? it.occ[0];
    const tail = at ? tailAfter(tokens, at) : '';
    if (tail) {
      const name = `${it.a.span} ${tail}`.trim();
      const dup = items.find((o) => o !== it && !o.removed && o.a.anchor_type === 'landmark'
        && (placeKey(o.a.normalized_token || '') === placeKey(name) || placeKey(o.a.span) === placeKey(name)));
      if (dup) {
        // The venue is already its own landmark anchor: it keeps the distance the
        // city carried (never lost) and is the «near» target.
        if (ownDistance !== null && sanitizeDistanceM(dup.a.distance_m) === null) {
          dup.a = { ...dup.a, distance_m: ownDistance };
        }
        dup.prox = true;
        it.removed = true;
        continue;
      }
      // The venue built from the city word and the words after it (grounded by
      // construction). Its stated distance rides on the anchor; P10 verifies it.
      it.a = { ...it.a, anchor_type: 'landmark', span: name, normalized_token: name };
      it.orig = null;
      it.prox = true;
      continue;
    }
    it.ctx = { ...it.ctx, proximity: true }; // → needs_confirm('proximity_to_city')
    it.proxCity = true;
  }
  items = items.filter((it) => !it.removed);
  // A direction owned by a city that turned out to be a venue (or a «near» city)
  // is no longer owned: its referent is not a city.
  for (const it of items) {
    const o = it.owner;
    if (!o || it.ownerKind !== 'city') continue;
    if (o.removed || o.a.anchor_type !== 'city' || o.proxCity) { it.owner = undefined; it.ownerKind = undefined; continue; }
    if (!it.ctx.city) it.ctx = { ...it.ctx, city: tokenOf(o.a) };
  }

  // The cities the mention NAMES (after P2 and P8, owners included): the scope (P9) and BD3.
  const named = Array.from(new Map(items
    .filter((it) => it.a.anchor_type === 'city' && !it.proxCity && tokenOf(it.a))
    .map((it) => [placeKey(tokenOf(it.a)), tokenOf(it.a)] as const)).values());

  // P7 — bare directions: the closed set BD1–BD5.
  const elementLike = (it: Item): boolean => {
    const t = it.a.anchor_type;
    return (t === 'road' || t === 'landmark' || t === 'relative_ref') && !isBoundaryRole(it.a);
  };
  const withReferent = (it: Item): boolean => it.a.anchor_type === 'direction' && !isBareDirection(it.a);
  const nonAdmin = (it: Item): boolean => {
    const t = it.a.anchor_type;
    return t === 'road' || t === 'landmark' || t === 'relative_ref' || t === 'pin' || withReferent(it)
      || (t === 'direction' && !!it.owner);
  };
  const hasRegion = items.some((it) => it.a.anchor_type === 'region');
  const districts = items.filter((it) => it.a.anchor_type === 'district' || it.a.anchor_type === 'town');
  for (const it of items) {
    if (it.folded || it.owner || it.ctx.ask_reason || !isBareDirection(it.a)) continue;
    let ask: string | undefined;
    // BD4's two ASKING tests run BEFORE BD3 (repair round 1, 2026-10-04 — a
    // departure from the table's first-match order, toward asking): a city
    // word anywhere in the mention («ابي شمال حي النرجس بالرياض», even the
    // established city's own name) used to reach BD3 first and turn the side of
    // Narjis into the whole north of the city. A city never cancels the veto.
    const besideAny = districts.length > 0
      && (it.occ.length === 0 || districts.some((d) => it.occ.some((x) => d.occ.some((y) => besideDistrict(tokens, x, y)))));
    if (hasRegion) ask = 'zone_city_unclear'; // BD1
    else if (items.some((o) => o !== it && nonAdmin(o))) ask = 'direction_referent_unclear'; // BD2
    else if (besideAny) ask = 'side_of_district'; // BD4 (adjacent, or not in the text)
    else if (named.length >= 2) ask = 'zone_city_unclear'; // BD3, two cities
    else if (named.length === 1) { // BD3, Rule Z
      // A referent from the token (P5 rule e) that is not this city: two cities, ask.
      if (it.ctx.confirm_city && placeKey(it.ctx.confirm_city) !== placeKey(named[0]!)) ask = 'zone_city_unclear';
      else it.ctx = { ...it.ctx, confirm_city: named[0]! };
    }
    // BD4 not adjacent / BD5: nothing — the established zone (still subject to I9 and Rule Z).
    if (ask) it.ctx = { ...it.ctx, ask_reason: ask };
  }

  // P9 — scope (repair round 1, 2026-10-04: a named city is the SCOPE of the
  // mention's other places only when it QUALIFIES them, never when it is
  // offered as an alternative). A city item qualifies when it owns a direction
  // (P6), is the referent of a direction («شمال الرياض»), or is introduced as a
  // place-in («بجدة», «في جدة», «في مدينة جدة»). A city that does none of these
  // beside another (non-bare-direction) place — «الروضة او جدة», «الروضة، جدة»,
  // «شمال الرياض او جدة» — is either Rawdah's city or ANOTHER place: the text
  // cannot tell, so it asks (city_role_unclear) instead of drawing a namesake
  // in the other city or silently dropping the alternative. In a DISJUNCTIVE
  // mention nothing is scoped (V8: the city may qualify only one alternative).
  const disjunctive = isDisjunctive(tokens);
  const qualifies = (c: Item): boolean => {
    if (items.some((o) => o.owner === c)) return true;
    const keys = new Set([placeKey(tokenOf(c.a)), placeKey(c.a.span ?? '')].filter(Boolean));
    if (items.some((o) => o !== c && withReferent(o) && keys.has(placeKey(readDirection(o.a).rest)))) return true;
    return c.occ.some((o) => cityIntroduced(tokens, o));
  };
  const otherPlace = (it: Item): boolean => {
    const t = it.a.anchor_type;
    return t === 'district' || t === 'town' || t === 'road' || t === 'landmark' || t === 'relative_ref' || t === 'pin'
      || withReferent(it);
  };
  const cityItems = items.filter((it) => it.a.anchor_type === 'city' && !it.proxCity);
  for (const c of cityItems) {
    if (c.ctx.ask_reason || qualifies(c)) continue;
    if (items.some((o) => o !== c && otherPlace(o))) c.ctx = { ...c.ctx, ask_reason: 'city_role_unclear' };
  }
  const scopeItems = named.length === 1
    ? cityItems.filter((c) => placeKey(tokenOf(c.a)) === placeKey(named[0]!) && qualifies(c)) : [];
  // The disjunction words of `mention_span` (both «يا» of «يا … يا»).
  const yaCount = tokens.filter((t) => t.f === 'يا').length;
  const disjAt = tokens.map((t, i) => (DISJUNCTIONS.has(t.f) || (yaCount >= 2 && t.f === 'يا') ? i : -1)).filter((i) => i >= 0);
  const split = (x: Occurrence, y: Occurrence): boolean => {
    const [p, q] = x.start <= y.start ? [x, y] : [y, x];
    return disjAt.some((d) => d >= p.end && d < q.start);
  };
  /** The scope city of `it`: the qualifying named city, unless a disjunction word stands between them («النرجس او الشمال بالرياض»). */
  const scopeOf = (it: Item): string | null => {
    if (scopeItems.length === 0) return null;
    const cityOcc = scopeItems.flatMap((c) => c.occ);
    if (it.occ.length === 0 || cityOcc.length === 0) return disjunctive ? null : named[0]!;
    return it.occ.some((x) => cityOcc.some((y) => !split(x, y))) ? named[0]! : null;
  };
  // P10 — a stated distance; proximity reaches the element it qualifies.
  const said = distancesIn(strings);
  for (const it of items) {
    const t = it.a.anchor_type;
    const ctx: AnchorContext = { ...it.ctx };
    const radiusLike = elementLike(it) || withReferent(it);
    const scope = scopeOf(it);
    if (radiusLike) {
      if (named.length > 1) ctx.city_unclear = true;
      else if (scope && !ctx.city) ctx.city = scope;
    }
    // A district in a mention whose ONE named city qualifies it must be in that
    // city («الروضة شمال طريق الملك عبدالله بجدة», «الروضة بجدة» — Jeddah's الروضة).
    if ((t === 'district' || t === 'town') && scope) ctx.admin_city = scope;
    if (radiusLike) {
      const d = sanitizeDistanceM(it.a.distance_m);
      if (d !== null) {
        if (statedIn(said, d)) ctx.radius_m = d;
        else ctx.ask_reason = ctx.ask_reason ?? 'distance_unverified';
      }
    }
    if (elementLike(it) && it.prox) ctx.proximity = true;
    if (t === 'landmark' && saidAsStation(texts, it.a)) ctx.station = true;
    it.ctx = ctx;
  }

  // P11 — grounding: a structural anchor the model assembled from words the customer never said together.
  for (const it of items) {
    if (!it.orig) continue; // built by P4 / P8 from the customer's words
    const t = it.a.anchor_type;
    const structural = it.retyped || t === 'road' || t === 'landmark' || t === 'relative_ref' || withReferent(it);
    if (!structural) continue;
    const orig = it.orig;
    if (texts.some((tk) => locateAnchor(tk, orig).length > 0)) continue;
    if (!it.ctx.ask_reason) it.ctx = { ...it.ctx, ask_reason: 'anchor_not_in_text' };
  }
  // P11, rule f (repair round 1, 2026-10-04): a direction whose SPAN has no
  // direction word took its side from the model's token alone. Its span being
  // in the text proves nothing about the side: «ابي قريب من الملك فهد» stored
  // as [«الملك فهد» / «غرب الملك فهد»] drew a band WEST of the road. The side
  // must be said somewhere in the customer's words, or it asks.
  for (const it of items) {
    const orig = it.orig;
    if (!orig || it.retyped || orig.anchor_type !== 'direction' || it.ctx.ask_reason) continue;
    if (parseDirection(stripDirectionClitic(orig.span ?? '')).zone) continue;
    const zone = parseDirection(stripDirectionClitic(orig.normalized_token ?? '')).zone;
    if (!zone) continue;
    if (!texts.some((tk) => zoneSaid(tk, zone))) it.ctx = { ...it.ctx, ask_reason: 'anchor_not_in_text' };
  }

  // Outputs.
  const places = new Map<string, NamedPlace>();
  const addPlace = (kind: NamedPlace['kind'], token: string): void => {
    const k = `${kind}:${placeKey(token)}`;
    if (token && !places.has(k)) places.set(k, { kind, token });
  };
  named.forEach((c) => addPlace('city', c));
  items.filter((it) => it.a.anchor_type === 'region').forEach((it) => addPlace('region', tokenOf(it.a)));
  items.forEach((it) => { if (it.named) addPlace('city', it.named); });

  return {
    anchors: items.map((it) => it.a),
    contexts: items.map((it) => it.ctx),
    disjunctive,
    mode: 'legacy',
    named_places: Array.from(places.values()),
  };
}

/**
 * Prepare every mention. Returns NEW evidence objects (anchors replaced) for the
 * mentions that changed — the same object otherwise — and, per mention, its
 * {@link PreparedMention} (contexts aligned with the PREPARED anchors). This
 * prepared evidence must flow into BOTH the resolution loop and compile/merge:
 * the merge slices resolutions by `e.anchors.length`.
 */
export function prepareEvidence(
  evidence: readonly Evidence[], opts: PrepareOptions = {},
): { evidence: Evidence[]; prepared: PreparedMention[] } {
  const out: Evidence[] = [];
  const prepared: PreparedMention[] = [];
  for (const e of evidence) {
    const p = prepareMention(e, opts);
    const same = p.anchors.length === e.anchors.length && p.anchors.every((a, i) => a === e.anchors[i]);
    out.push(same ? e : { ...e, anchors: p.anchors });
    prepared.push(p);
  }
  return { evidence: out, prepared };
}
