/**
 * The WhatsApp agent's reading of what the customer WANTS (unit type, budget,
 * bedrooms, size, purpose, features) — through the SAME preference extractor
 * the background reader uses to fill the CRM profile (api/_lib/prefExtract.ts,
 * rendered with the same `renderConversation`), with the same "the customer
 * said it" quote guard (`customerSaidIt`). Operator, 2026-10-05: "make it use
 * the same extractor" — before this the agent (Claude) read budget / type /
 * bedrooms itself while the profile was filled by a separate reader, so two
 * readers could interpret the same chat differently.
 *
 * Read-only: nothing is saved here (the background reader saves the profile).
 * The result drives search_projects (`applyCustomerReading`) and is shown to
 * the agent as state. A failed extraction never blocks the reply: the turn
 * goes on with the agent's own reading, and the failure is logged.
 *
 * Cached per conversation text for 10 minutes (a re-run turn costs nothing).
 */
import { createHash } from 'node:crypto';
import type { Conversation } from '../geoPreference/extractor.js';
import { renderConversation } from '../geoPreference/extractor.js';
import { extractPreferences, type PrefSuggestion } from '../prefExtract.js';
import { customerSaidIt } from '../clientPrefs/quoteMatch.js';
import { asRangeValue, asSetValue } from '../../../src/lib/clientPrefs/mergePrefs.js';
import { normalizeUnitType } from './decide.js';
import type { SearchCriteria } from './catalog.js';

export interface CustomerReading {
  unit_types: string[] | null;
  budget_max: number | null;
  bedrooms_min: number | null;
  area_min: number | null;
  purpose: string[] | null;
  /** Exactly one of ready / off_plan; null when unsaid or both. */
  readiness: 'ready' | 'off_plan' | null;
  amenities: string[] | null;
  /** One English state line for the agent; null when nothing was read. */
  line: string | null;
  model: string;
  /** Search fields whose quote is only in OLDER customer messages, not in the
   *  ones since our last reply. For those the agent's own reading of what they
   *  say NOW wins (applyCustomerReading). Live test 2026-10-05: «ابي دور في
   *  ظهرة لبن» became شقة from an earlier «ابي شقة…», and apartments were searched. */
  older_only?: ReadingField[];
}

export type ReadingField = 'unit_types' | 'budget_max' | 'bedrooms_min' | 'area_min' | 'readiness';

const FIELD_OF_SLUG: Record<string, ReadingField> = {
  preferred_unit_type: 'unit_types', budget: 'budget_max', preferred_bedrooms: 'bedrooms_min', preferred_area: 'area_min', preferred_readiness: 'readiness',
};

const EMPTY = (model: string): CustomerReading => ({
  unit_types: null, budget_max: null, bedrooms_min: null, area_min: null, purpose: null, readiness: null, amenities: null, line: null, model,
});

/** «انسى اللي قبل», «غيرت رأيي» — the customer starts over. */
const RESTART = /انس(ى|ا|ي)\s+(كل\s+)?(اللي|طلب|ما\s+قلت)|غيرت\s+ر(أ|ا)ي|بدلت\s+ر(أ|ا)ي|forget\s+(what|everything)|changed\s+my\s+mind/i;

/**
 * PURE — the turns the reader should read: from the customer's last restart on
 * (when there is one), and which of them are the CURRENT messages (the
 * customer's turns after our last reply).
 */
export function readingWindow(turns: Array<{ who: 'customer' | 'us'; text: string }>): {
  turns: Array<{ who: 'customer' | 'us'; text: string }>;
  current: string[];
} {
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.who === 'customer' && RESTART.test(turns[i]!.text)) { start = i; break; }
  }
  const win = turns.slice(start);
  const current: string[] = [];
  for (let i = win.length - 1; i >= 0 && win[i]!.who === 'customer'; i--) current.unshift(win[i]!.text);
  return { turns: win, current };
}

const PURPOSE_AR: Record<string, string> = { residential: 'سكن', investment: 'استثمار' };
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** PURE — the extractor's checked suggestions → search fields + the agent's state line. */
export function readingFromSuggestions(suggestions: Record<string, PrefSuggestion>, model: string): CustomerReading {
  const r = EMPTY(model);
  const types = asSetValue(suggestions.preferred_unit_type?.value).map(normalizeUnitType).filter((x): x is string => !!x);
  if (types.length) r.unit_types = [...new Set(types)];
  const budget = asRangeValue(suggestions.budget?.value);
  if (budget) r.budget_max = budget.max ?? null;
  const beds = asRangeValue(suggestions.preferred_bedrooms?.value);
  if (beds) r.bedrooms_min = beds.min ?? beds.max ?? null;
  const area = asRangeValue(suggestions.preferred_area?.value);
  if (area) r.area_min = area.min ?? area.max ?? null;
  const purpose = asSetValue(suggestions.purchase_objective?.value);
  if (purpose.length) r.purpose = purpose;
  const ready = asSetValue(suggestions.preferred_readiness?.value).filter((v) => v === 'ready' || v === 'off_plan');
  if (ready.length === 1) r.readiness = ready[0] as 'ready' | 'off_plan';
  const amen = asSetValue(suggestions.preferred_amenities?.value);
  if (amen.length) r.amenities = amen;

  const parts = [
    r.unit_types ? `unit type: ${r.unit_types.join('/')}` : null,
    r.budget_max ? `budget: up to ${fmt(r.budget_max)} SAR` : budget?.min ? `budget: from ${fmt(budget.min)} SAR` : null,
    r.bedrooms_min ? `bedrooms: ${r.bedrooms_min}+` : null,
    r.area_min ? `size: ${fmt(r.area_min)}+ m²` : null,
    r.readiness ? `${r.readiness === 'ready' ? 'ready only (جاهز)' : 'off-plan only (على الخارطة)'}` : null,
    r.purpose ? `purpose: ${r.purpose.map((p) => PURPOSE_AR[p] ?? p).join('/')}` : null,
    r.amenities ? `wants: ${r.amenities.join('، ')}` : null,
  ].filter(Boolean);
  if (parts.length) {
    r.line = `WHAT THE CUSTOMER SAID THEY WANT in this conversation (read by our preference reader — the same one that fills the CRM profile; search_projects applies it automatically): ${parts.join(' · ')}.`;
  }
  return r;
}

/**
 * PURE — the reading is AUTHORITATIVE for the fields it fills (unit type,
 * budget, bedrooms, size, and ready/off-plan when exactly one was said): a value the
 * reader found replaces what the agent typed (so both sides read the customer
 * the same way); a field the reader left empty keeps the agent's value (e.g.
 * from the saved profile). Returns the criteria and the overrides, for the trace.
 */
export function applyCustomerReading(c: SearchCriteria, r: CustomerReading | null): { criteria: SearchCriteria; overrides: string[] } {
  if (!r) return { criteria: c, overrides: [] };
  const out: SearchCriteria = { ...c };
  const overrides: string[] = [];
  const older = new Set(r.older_only ?? []);
  // The reader's value comes only from older messages and the agent read
  // something else: the agent is reading what they say now — keep it.
  const keepAgent = (k: ReadingField, agentHas: boolean): boolean => {
    if (!older.has(k) || !agentHas) return false;
    overrides.push(`kept agent's ${k} (reader's quote is from an older message)`);
    return true;
  };
  if (r.unit_types && r.unit_types.length) {
    const same = (c.unit_types ?? []).length === r.unit_types.length && r.unit_types.every((t) => (c.unit_types ?? []).includes(t));
    if (!same && !keepAgent('unit_types', (c.unit_types ?? []).length > 0)) {
      overrides.push(`unit_types ${JSON.stringify(c.unit_types ?? [])}→${JSON.stringify(r.unit_types)}`);
      out.unit_types = r.unit_types;
    }
  }
  if (r.readiness && c.readiness !== r.readiness && !keepAgent('readiness', !!c.readiness)) {
    overrides.push(`readiness ${c.readiness ?? '-'}→${r.readiness}`);
    out.readiness = r.readiness;
  }
  for (const k of ['budget_max', 'bedrooms_min', 'area_min'] as const) {
    const v = r[k];
    if (v == null || c[k] === v) continue;
    if (keepAgent(k, c[k] != null)) continue;
    overrides.push(`${k} ${c[k] ?? '-'}→${v}`);
    out[k] = v;
  }
  return { criteria: out, overrides };
}

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: Promise<CustomerReading> }>();

/**
 * Read the customer's wants from the current conversation through the shared
 * extractor. Throws on extractor failure — the caller decides to go on without it.
 */
export function readCustomerWants(
  turns: Array<{ who: 'customer' | 'us'; text: string }>,
  chatWid: string,
): Promise<CustomerReading> {
  const win = readingWindow(turns.slice(-60));
  const conv: Conversation = {
    channel: 'chat',
    id: 'sales-agent',
    turns: win.turns.map((t) => ({ speaker: t.who === 'customer' ? 'client' : 'agent', text: t.text })),
  };
  const currentConv: Conversation = { channel: 'chat', id: 'sales-agent-now', turns: win.current.map((text) => ({ speaker: 'client', text })) };
  if (!conv.turns.some((t) => t.speaker === 'client')) return Promise.resolve(EMPTY('none'));
  const key = createHash('sha1').update(JSON.stringify(conv.turns)).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = (async () => {
    const ex = await extractPreferences({ channel: 'chat', transcript: renderConversation(conv), entity: { kind: 'chat', id: chatWid } });
    // Only what the customer provably said (the same guard as the profile save).
    const said: Record<string, PrefSuggestion> = {};
    for (const [slug, s] of Object.entries(ex.output.suggestions)) if (s && customerSaidIt(conv, s.quote)) said[slug] = s;
    const reading = readingFromSuggestions(said, ex.model);
    const older = Object.entries(said)
      .filter(([slug, s]) => FIELD_OF_SLUG[slug] && !customerSaidIt(currentConv, s.quote))
      .map(([slug]) => FIELD_OF_SLUG[slug]!);
    if (older.length) {
      reading.older_only = older;
      if (reading.line) reading.line += ` (${older.join(', ')}: from EARLIER messages only — if what they say now differs, follow what they say now)`;
    }
    return reading;
  })();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}
