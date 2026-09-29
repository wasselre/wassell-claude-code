/**
 * The sales agent's decision logic — PURE (no I/O) so every path is unit-tested.
 *
 * The conversation is a short script the reps already run by hand: region →
 * unit type → bedrooms → budget → search → send the best project → "ناسبك؟" →
 * next option / a rep arranges the visit. The LLM (understand.ts) only reads the
 * customer's words into `Understanding`; everything below decides deterministically.
 */
import type { Gender, Lang, Zone } from './texts.js';

export type Slot = 'zone' | 'unit_type' | 'bedrooms' | 'budget';

export interface Slots {
  city?: string;
  zone?: Zone | null;
  unit_types?: string[];
  bedrooms_min?: number | null;
  budget_max?: number | null;
  /** Slots the customer said don't matter («ما يهم») — never asked again. */
  skipped?: Slot[];
  gender?: Gender;
  lang?: Lang;
  /** Name of the last project we sent — so a rep's notification can name it. */
  last_project_name?: string;
  /** Brain (v2) search criteria beyond v1's slots. */
  readiness?: 'ready' | 'off_plan' | null;
  districts?: string[];
  /** When the agent last handed this customer to a rep. */
  handed_off_at?: string;
  /** The last line we sent and when — a handoff line is never repeated. */
  last_reply?: string;
  last_reply_at?: string;
}

export type Intent =
  | 'answer'      // gives preferences / answers our question
  | 'more'        // wants another option / the sent project didn't suit
  | 'interested'  // likes a sent project / wants a visit or a call about it
  | 'question'    // asks about price, payment, location, details of a project
  | 'human'       // asks for a person, or complains
  | 'stop'        // not interested / asks us to stop
  | 'other';      // greeting, thanks, unclear

export interface Understanding {
  intent: Intent;
  zone: Zone | null;
  unit_types: string[];
  bedrooms_min: number | null;
  budget_max: number | null;
  skip: Slot[];
  city: string | null;
  gender: Gender | null;
  lang: Lang;
}

export type NextStep =
  | { kind: 'ask'; slot: Slot }
  | { kind: 'search' }
  | { kind: 'handoff'; reason: 'human' | 'question' | 'interested' | 'unclear' }
  | { kind: 'stop' };

/** The asking order the reps use. */
export const SLOT_ORDER: Slot[] = ['zone', 'unit_type', 'bedrooms', 'budget'];

/** Unit types the Finder + client schema understand. */
export const UNIT_TYPES = ['شقة', 'دور', 'فيلا', 'تاون هاوس', 'دبلكس'] as const;

const UNIT_ALIASES: Array<[RegExp, string]> = [
  [/^(شقه|شقة|شقق|apartment|apartments|flat|flats)$/i, 'شقة'],
  [/^(دور|ادوار|أدوار|floor|floors)$/i, 'دور'],
  [/^(فيلا|فيله|فلل|فلة|villa|villas)$/i, 'فيلا'],
  [/^(تاون ?هاوس|تاون|townhouse|townhouses|town house)$/i, 'تاون هاوس'],
  [/^(دبلكس|دوبلكس|duplex)$/i, 'دبلكس'],
];

export function normalizeUnitType(raw: string): string | null {
  const t = raw.trim();
  if ((UNIT_TYPES as readonly string[]).includes(t)) return t;
  for (const [re, v] of UNIT_ALIASES) if (re.test(t)) return v;
  return null;
}

// A direction word only counts as a WORD: at the start, after a non-letter, or
// after the article «ال» (also covers «بال…»). Without this guard «المشرقية» — a
// real project name — would read as "east" (it contains «شرق»).
const AR_WORD = (w: string) => new RegExp(`(?:^|[^\\u0621-\\u064A]|ال)${w}`);
const ZONE_WORDS: Array<[RegExp[], Zone]> = [
  [[AR_WORD('شمال'), /\bnorth/i], 'north'],
  [[AR_WORD('جنوب'), /\bsouth/i], 'south'],
  [[AR_WORD('شرق'), /\beast/i], 'east'],
  [[AR_WORD('غرب'), /\bwest/i], 'west'],
  [[AR_WORD('وسط'), /قلب الرياض/, /\b(central|middle|center|centre)\b/i], 'center'],
];

/** True when the text names ANY direction as a word (not inside «المشرقية»). */
export function hasDirectionWord(text: string): boolean {
  return ZONE_WORDS.some(([res]) => res.some((re) => re.test(text)));
}

/** Deterministic region parse — a safety net under the LLM, and the start-of-
 *  conversation parse of the ad button («…اخرى في شمال الرياض»). One region only:
 *  two different directions in one message is ambiguous → null (we ask). */
export function parseZone(text: string): Zone | null {
  const hits = new Set<Zone>();
  for (const [res, z] of ZONE_WORDS) if (res.some((re) => re.test(text))) hits.add(z);
  return hits.size === 1 ? [...hits][0]! : null;
}

function filled(s: Slots, slot: Slot): boolean {
  if (s.skipped?.includes(slot)) return true;
  switch (slot) {
    case 'zone': return !!s.zone;
    case 'unit_type': return !!s.unit_types && s.unit_types.length > 0;
    case 'bedrooms': return s.bedrooms_min != null && s.bedrooms_min > 0;
    case 'budget': return s.budget_max != null && s.budget_max > 0;
  }
}

export function nextMissingSlot(s: Slots): Slot | null {
  for (const slot of SLOT_ORDER) if (!filled(s, slot)) return slot;
  return null;
}

/** Merge what the customer just said into what we already know. A new non-empty
 *  value replaces the old one (people change their minds); nothing clears a slot. */
export function mergeSlots(prev: Slots, u: Understanding): { slots: Slots; changed: boolean } {
  const next: Slots = { ...prev, skipped: [...(prev.skipped ?? [])] };
  let changed = false;
  const set = <K extends keyof Slots>(k: K, v: Slots[K]) => {
    if (JSON.stringify(next[k]) !== JSON.stringify(v)) { next[k] = v; changed = true; }
  };
  if (u.zone) set('zone', u.zone);
  const types = u.unit_types.map(normalizeUnitType).filter((x): x is string => !!x);
  if (types.length) set('unit_types', [...new Set(types)]);
  if (u.bedrooms_min != null && u.bedrooms_min > 0 && u.bedrooms_min <= 10) set('bedrooms_min', Math.round(u.bedrooms_min));
  // Budgets under 100k are a unit slip («مليون» read as 1) — ignore rather than search nonsense.
  if (u.budget_max != null && u.budget_max >= 100_000) set('budget_max', Math.round(u.budget_max));
  if (u.city) set('city', u.city);
  for (const sk of u.skip) {
    if (!next.skipped!.includes(sk)) { next.skipped!.push(sk); changed = true; }
  }
  // Gender is sticky once feminine is detected; language follows the latest message.
  if (u.gender === 'f') next.gender = 'f';
  else if (!next.gender && u.gender) next.gender = u.gender;
  next.lang = u.lang;
  return { slots: next, changed };
}

/**
 * What to do with this turn.
 *  - stop / human always win.
 *  - Before any project is sent: keep qualifying (a mid-flow question doesn't
 *    derail the script — the rep follows up once a project is on the table).
 *  - Once everything is known: search when nothing is sent yet, when they want
 *    another option, or when their preferences just changed.
 *  - After a project: "interested" → a rep arranges the visit; a question → a rep.
 */
export function decideNext(
  slots: Slots,
  u: Understanding,
  ctx: { sentCount: number; slotsChanged: boolean },
): NextStep {
  if (u.intent === 'stop') return { kind: 'stop' };
  if (u.intent === 'human') return { kind: 'handoff', reason: 'human' };

  const missing = nextMissingSlot(slots);
  if (missing) {
    if (ctx.sentCount > 0 && u.intent === 'interested') return { kind: 'handoff', reason: 'interested' };
    return { kind: 'ask', slot: missing };
  }

  if (ctx.sentCount === 0) return { kind: 'search' };
  if (u.intent === 'more' || ctx.slotsChanged) return { kind: 'search' };
  if (u.intent === 'interested') return { kind: 'handoff', reason: 'interested' };
  if (u.intent === 'question') return { kind: 'handoff', reason: 'question' };
  return { kind: 'handoff', reason: 'unclear' };
}
