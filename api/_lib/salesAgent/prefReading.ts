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
  amenities: string[] | null;
  /** One English state line for the agent; null when nothing was read. */
  line: string | null;
  model: string;
}

const EMPTY = (model: string): CustomerReading => ({
  unit_types: null, budget_max: null, bedrooms_min: null, area_min: null, purpose: null, amenities: null, line: null, model,
});

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
  const amen = asSetValue(suggestions.preferred_amenities?.value);
  if (amen.length) r.amenities = amen;

  const parts = [
    r.unit_types ? `unit type: ${r.unit_types.join('/')}` : null,
    r.budget_max ? `budget: up to ${fmt(r.budget_max)} SAR` : budget?.min ? `budget: from ${fmt(budget.min)} SAR` : null,
    r.bedrooms_min ? `bedrooms: ${r.bedrooms_min}+` : null,
    r.area_min ? `size: ${fmt(r.area_min)}+ m²` : null,
    r.purpose ? `purpose: ${r.purpose.map((p) => PURPOSE_AR[p] ?? p).join('/')}` : null,
    r.amenities ? `wants: ${r.amenities.join('، ')}` : null,
  ].filter(Boolean);
  if (parts.length) {
    r.line = `WHAT THE CUSTOMER SAID THEY WANT in this conversation (read by our preference reader — the same one that fills the CRM profile; search_projects applies it automatically): ${parts.join(' · ')}.`;
  }
  return r;
}

/**
 * PURE — the reading is AUTHORITATIVE for the four fields it fills: a value the
 * reader found replaces what the agent typed (so both sides read the customer
 * the same way); a field the reader left empty keeps the agent's value (e.g.
 * from the saved profile). Returns the criteria and the overrides, for the trace.
 */
export function applyCustomerReading(c: SearchCriteria, r: CustomerReading | null): { criteria: SearchCriteria; overrides: string[] } {
  if (!r) return { criteria: c, overrides: [] };
  const out: SearchCriteria = { ...c };
  const overrides: string[] = [];
  if (r.unit_types && r.unit_types.length) {
    const same = (c.unit_types ?? []).length === r.unit_types.length && r.unit_types.every((t) => (c.unit_types ?? []).includes(t));
    if (!same) overrides.push(`unit_types ${JSON.stringify(c.unit_types ?? [])}→${JSON.stringify(r.unit_types)}`);
    out.unit_types = r.unit_types;
  }
  for (const k of ['budget_max', 'bedrooms_min', 'area_min'] as const) {
    const v = r[k];
    if (v == null) continue;
    if (c[k] !== v) overrides.push(`${k} ${c[k] ?? '-'}→${v}`);
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
  const conv: Conversation = {
    channel: 'chat',
    id: 'sales-agent',
    turns: turns.slice(-60).map((t) => ({ speaker: t.who === 'customer' ? 'client' : 'agent', text: t.text })),
  };
  if (!conv.turns.some((t) => t.speaker === 'client')) return Promise.resolve(EMPTY('none'));
  const key = createHash('sha1').update(JSON.stringify(conv.turns)).digest('hex');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = (async () => {
    const ex = await extractPreferences({ channel: 'chat', transcript: renderConversation(conv), entity: { kind: 'chat', id: chatWid } });
    // Only what the customer provably said (the same guard as the profile save).
    const said: Record<string, PrefSuggestion> = {};
    for (const [slug, s] of Object.entries(ex.output.suggestions)) if (s && customerSaidIt(conv, s.quote)) said[slug] = s;
    return readingFromSuggestions(said, ex.model);
  })();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}
