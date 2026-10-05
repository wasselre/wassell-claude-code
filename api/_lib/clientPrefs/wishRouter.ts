/**
 * Where does what the customer just said belong? Decided BEFORE the AI saves a
 * chat's preferences / places (readChat.ts → autoSave.ts).
 *
 *   same_wish     — refines a profile: merged into it (the union, as before).
 *   changed_mind  — replaces an earlier wish in that profile: the AI's own old
 *                   values for the changed fields go, a rep's stay.
 *   second_wish   — a separate, ADDITIONAL property (a villa to live in AND an
 *                   apartment to invest): a new profile, never made active.
 *
 * Live test 2026-10-05: everything heard was unioned into one profile — the
 * test client ended with every Riyadh zone, east both wanted and excluded, and
 * «شقة» kept after «غيرت رأيي، ابي دور». The operator: a customer can hold
 * several profiles, and separate profiles get their own process.
 *
 * Free when nothing heard conflicts with the client's only profile (no model
 * call). Otherwise one small DeepSeek call (Haiku fallback), and a destructive
 * answer (changed_mind / second_wish) must quote the CUSTOMER — a quote that is
 * not in their own messages falls back to same_wish (merge, nothing removed,
 * nothing created). Both providers failing THROWS: the caller leaves the
 * proposals for the rep, as for any failed save.
 */
import Anthropic from '@anthropic-ai/sdk';
import { deepseekJson, deepseekEnabled } from '../deepseek.js';
import { trackedAnthropic } from '../aiUsage.js';
import { logLlmFallback } from '../textLlm.js';
import { renderConversation, type Conversation } from '../geoPreference/extractor.js';
import { customerSaidIt } from './quoteMatch.js';
import { PREF_FIELD_KINDS, asSetValue, asRangeValue, valueEqual } from '../../../src/lib/clientPrefs/mergePrefs.js';
import { parseLocationItems, type LocationItem } from '../../../src/lib/geo/locationItems.js';
import { locationItemPlaceKey } from '../../geo-preference/review.js';
import { readStoredProfiles, profileValues, describeProfiles } from './profileTarget.js';

const CALL_SITE = 'api/_lib/clientPrefs/wishRouter';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

/** What a change of mind can be about. `location` = the places. */
export type WishField = 'unit_type' | 'budget' | 'bedrooms' | 'area' | 'readiness' | 'purpose' | 'amenities' | 'location';
export const SLUG_OF_FIELD: Readonly<Record<Exclude<WishField, 'location'>, string>> = {
  unit_type: 'preferred_unit_type', budget: 'budget', bedrooms: 'preferred_bedrooms', area: 'preferred_area',
  readiness: 'preferred_readiness', purpose: 'purchase_objective', amenities: 'preferred_amenities',
};
const FIELD_OF_SLUG: Readonly<Record<string, WishField>> = Object.fromEntries(Object.entries(SLUG_OF_FIELD).map(([f, s]) => [s, f as WishField]));
const WISH_FIELDS: readonly WishField[] = [...Object.keys(SLUG_OF_FIELD) as WishField[], 'location'];

export type WishRoute =
  | { kind: 'same'; profileId: string | null; why: string }
  | { kind: 'changed'; profileId: string | null; fields: WishField[]; quote: string; why: string }
  | { kind: 'second'; profileName: string; quote: string; why: string; values: Record<string, { value: unknown; quote: string }> };

export interface Heard {
  /** Verified preference suggestions (the quote guard already passed). */
  prefs: Record<string, { value: unknown; quote: string | null }>;
  /** Places the save would add. */
  places: LocationItem[];
  /** The customer's messages since the last read — where a new wish shows up first. */
  newTexts?: string[];
}

/**
 * «وكمان», «بعد ابي», «بالإضافة», «لولدي»… in the NEW messages. The chat
 * reader returns ONE set of wishes for the whole chat, so a second wish can
 * hide behind the first one's values (live test 2026-10-05: «وكمان ابي شقة
 * للاستثمار في دبي» came back as the old values) — this cue asks the router
 * anyway.
 */
const SECOND_CUE = /(^|\s)(و?كمان|و?بعد\s+(ابي|أبي|ابغى|أبغى|نبي)|بالإضافة|بالاضافة|غير\s+كذا|ثاني(ة)?\s+(لـ?|ل)|لولدي|لبنتي|لأخوي|لاخوي|لأهلي|لاهلي|also|another\s+one)/i;
export function hasSecondWishCue(texts: readonly string[]): boolean {
  return texts.some((t) => SECOND_CUE.test(t));
}

/**
 * PURE — the fields where what was heard differs from what this profile holds
 * (a new value next to a saved one, a different range, a place flipped, or a new
 * place next to saved ones). Empty = nothing to decide: a plain merge.
 */
export function conflictingFields(values: Record<string, unknown>, heard: Heard): WishField[] {
  const out = new Set<WishField>();
  for (const [slug, s] of Object.entries(heard.prefs)) {
    const f = FIELD_OF_SLUG[slug];
    const kind = PREF_FIELD_KINDS[slug];
    if (!f || !kind) continue;
    if (kind === 'set') {
      const cur = asSetValue(values[slug]);
      if (cur.length && asSetValue(s.value).some((v) => !cur.includes(v))) out.add(f);
    } else {
      const cur = asRangeValue(values[slug]);
      const next = asRangeValue(s.value);
      if (cur && next && !valueEqual(cur, next)) out.add(f);
    }
  }
  if (heard.places.length) {
    const cur = parseLocationItems(values.location_items);
    const polarity = new Map(cur.map((it) => [locationItemPlaceKey(it), it.polarity]));
    const hasIncludes = cur.some((it) => it.polarity === 'include');
    for (const it of heard.places) {
      const p = polarity.get(locationItemPlaceKey(it));
      if ((p && p !== it.polarity) || (!p && it.polarity === 'include' && hasIncludes)) { out.add('location'); break; }
    }
  }
  return [...out];
}

function summarize(values: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [f, slug] of Object.entries(SLUG_OF_FIELD)) {
    const v = values[slug];
    if (PREF_FIELD_KINDS[slug] === 'set') { const a = asSetValue(v); if (a.length) parts.push(`${f}: ${a.join('/')}`); }
    else { const r = asRangeValue(v); if (r) parts.push(`${f}: ${r.min ?? '…'}–${r.max ?? '…'}`); }
  }
  const items = parseLocationItems(values.location_items);
  const label = (it: LocationItem) => ('district_label' in it && it.district_label) || ('label' in it && typeof it.label === 'string' && it.label) || it.kind;
  const inc = [...new Set(items.filter((i) => i.polarity === 'include').map(label))].slice(0, 8);
  const exc = [...new Set(items.filter((i) => i.polarity === 'exclude').map(label))].slice(0, 8);
  if (inc.length) parts.push(`places wanted: ${inc.join('، ')}`);
  if (exc.length) parts.push(`places excluded: ${exc.join('، ')}`);
  return parts.join(' · ');
}

function heardLines(heard: Heard): string {
  const lines = Object.entries(heard.prefs).map(([slug, s]) => `- ${FIELD_OF_SLUG[slug] ?? slug}: ${JSON.stringify(s.value)}${s.quote ? ` (customer: «${s.quote}»)` : ''}`);
  const label = (it: LocationItem) => ('district_label' in it && it.district_label) || ('label' in it && typeof it.label === 'string' && it.label) || it.kind;
  const places = [...new Set(heard.places.map((it) => `${it.polarity === 'exclude' ? 'NOT ' : ''}${label(it)}`))];
  if (places.length) lines.push(`- places: ${places.slice(0, 12).join('، ')}`);
  return lines.join('\n');
}

const SYSTEM = `You file a Saudi real-estate customer's wishes into their CRM. A customer can hold several preference PROFILES, one per property they want (e.g. a villa to live in AND an apartment to invest). You get their profiles, the WhatsApp conversation, and what was just heard. Decide ONE:
- "same_wish": it refines or adds to one existing profile (give its profile_id). Use this when unsure. Accepting an ALTERNATIVE next to what they wanted is same_wish — both stand: «عادي دور بعد يمشي»، «ما يفرق شقة او دور»، «او بالياسمين»، a raised budget.
- "changed_mind": the customer DROPPED something they wanted before in that profile and put something else in its place («غيرت رأيي»، «انسى اللي قبل»، «لا خلاص ابي…»، «بدال…»، «ما عاد ابي…»). The earlier value must be given up, not just joined by another. List in "changed" only the fields they changed.
- "second_wish": they want an ADDITIONAL, SEPARATE property besides one a profile already holds — both still stand («وكمان»، «بعد ابي»، «غير كذا ابي»، «ثاني لولدي»، «بالإضافة»، a second purpose next to the first). Give a short Arabic name for it in "new_profile_name" (e.g. «شقة استثمار - دبي») and fill "values" with what the customer said about THAT second property only — each with the customer's exact words. The "JUST HEARD" list is read from the whole chat and may show the first property's values; trust the NEW MESSAGES.
A different value alone is NOT a second wish — customers change their minds; a second wish needs them to want both. "quote" = the customer's exact words that show the decision, copied from an «العميل» line. Fields: unit_type, budget, bedrooms, area, readiness, purpose, amenities, location.`;

const SHAPE = '{"decision": "same_wish" | "changed_mind" | "second_wish", "profile_id": "<an id from the list, or null>", "changed": ["unit_type", ...], "new_profile_name": "<Arabic, only for second_wish>", "values": {"unit_type": {"value": ["شقة"], "quote": "..."}, "budget": {"value": {"min": null, "max": 1000000}, "quote": "..."}, "bedrooms": {"value": {"min": 1, "max": 1}, "quote": "..."}, "area": {"value": {"min": null, "max": null}, "quote": "..."}, "readiness": {"value": ["ready" | "off_plan"], "quote": "..."}, "purpose": {"value": ["investment" | "residential"], "quote": "..."}, "amenities": {"value": [], "quote": "..."}} (only for second_wish, only fields they said), "quote": "<customer words>", "reason": "<one short line>"}';

interface RouterAnswer { decision?: unknown; profile_id?: unknown; changed?: unknown; new_profile_name?: unknown; values?: unknown; quote?: unknown; reason?: unknown }

async function askModel(user: string, clientId: string): Promise<RouterAnswer> {
  let deepseekError: string | null = null;
  if (deepseekEnabled()) {
    try {
      return await deepseekJson<RouterAnswer>({
        system: SYSTEM, user, shape: SHAPE, requiredKeys: ['decision'], maxTokens: 400, temperature: 0,
        track: { area: 'sales', callSite: CALL_SITE, operation: 'route_wish' }, entityKind: 'client', entityId: clientId,
      });
    } catch (err) {
      deepseekError = err instanceof Error ? err.message : String(err);
      logLlmFallback('wishRouter', err);
    }
  }
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error(`wish router: no provider answered (deepseek: ${deepseekError ?? 'not configured'}; ANTHROPIC_API_KEY missing)`);
  const client = trackedAnthropic(new Anthropic({ apiKey }), {
    area: 'sales', callSite: CALL_SITE, operation: 'route_wish',
    isFallback: deepseekError !== null, fallbackFrom: deepseekError !== null ? 'deepseek' : null, entityKind: 'client', entityId: clientId,
  });
  const resp = await client.messages.create({
    model: CLAUDE_MODEL, max_tokens: 400,
    system: `${SYSTEM}\n\nReply with ONLY one JSON object of this shape: ${SHAPE}`,
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error(`wish router: no JSON from either provider (deepseek: ${deepseekError ?? '-'})`);
  return JSON.parse(text.slice(a, b + 1)) as RouterAnswer;
}

/**
 * PURE — the model's answer as a route. Anything invalid or unquoted degrades
 * to the safe answer (same_wish on the active profile: merge, nothing removed,
 * nothing created).
 */
export function routeFromAnswer(
  ans: RouterAnswer, ctx: { profileIds: string[]; activeId: string; conversation: Conversation; conflicts: WishField[] },
): WishRoute {
  const pid = typeof ans.profile_id === 'string' && ctx.profileIds.includes(ans.profile_id) && ans.profile_id !== ctx.activeId ? ans.profile_id : null;
  const quote = typeof ans.quote === 'string' ? ans.quote.trim() : '';
  const why = typeof ans.reason === 'string' ? ans.reason.slice(0, 200) : '';
  const quoted = quote.length > 0 && customerSaidIt(ctx.conversation, quote);
  if (ans.decision === 'changed_mind' && quoted) {
    const said = Array.isArray(ans.changed) ? ans.changed.filter((f): f is WishField => WISH_FIELDS.includes(f as WishField)) : [];
    const fields = said.length ? said : ctx.conflicts;
    if (fields.length) return { kind: 'changed', profileId: pid, fields, quote, why };
  }
  if (ans.decision === 'second_wish' && quoted) {
    const name = typeof ans.new_profile_name === 'string' ? ans.new_profile_name.trim().slice(0, 40) : '';
    // Each value only with the customer's own words behind it.
    const values: Record<string, { value: unknown; quote: string }> = {};
    const raw = ans.values && typeof ans.values === 'object' ? (ans.values as Record<string, unknown>) : {};
    for (const [f, v] of Object.entries(raw)) {
      const slug = (SLUG_OF_FIELD as Record<string, string>)[f];
      const o = v && typeof v === 'object' ? (v as { value?: unknown; quote?: unknown }) : null;
      const q = typeof o?.quote === 'string' ? o.quote.trim() : '';
      if (!slug || !o || o.value == null || !q || !customerSaidIt(ctx.conversation, q)) continue;
      values[slug] = { value: o.value, quote: q };
    }
    return { kind: 'second', profileName: name, quote, why, values };
  }
  const degraded = (ans.decision === 'changed_mind' || ans.decision === 'second_wish') && !quoted;
  return { kind: 'same', profileId: pid, why: degraded ? `model said ${String(ans.decision)} without a customer quote — merged instead` : why };
}

/** Decide where `heard` goes for this client (fresh `data`). */
export async function routeWish(
  a: { clientId: string; data: Record<string, unknown>; conversation: Conversation; heard: Heard; log?: (m: string) => void },
): Promise<WishRoute> {
  const { profiles, activeId } = readStoredProfiles(a.data);
  const newTexts = a.heard.newTexts ?? [];
  const cue = hasSecondWishCue(newTexts);
  const nothingHeard = !Object.keys(a.heard.prefs).length && !a.heard.places.length && !cue;
  const conflicts = conflictingFields(profileValues(a.data, null), a.heard);
  if (nothingHeard || (profiles.length === 1 && conflicts.length === 0 && !cue)) {
    return { kind: 'same', profileId: null, why: nothingHeard ? 'nothing heard' : 'no conflict with the only profile' };
  }
  const user = [
    'PROFILES:',
    ...describeProfiles(a.data, summarize).map((p) => p.line),
    '',
    'CONVERSATION (newest last):',
    renderConversation({ ...a.conversation, turns: a.conversation.turns.slice(-40) }),
    '',
    ...(newTexts.length ? ['NEW MESSAGES from the customer (since the last read):', ...newTexts.map((t) => `- ${t}`), ''] : []),
    'JUST HEARD (read from the whole chat):',
    heardLines(a.heard) || '- nothing',
    conflicts.length ? `\nDiffers from the active profile in: ${conflicts.join(', ')}` : '',
  ].join('\n');
  const ans = await askModel(user, a.clientId);
  const route = routeFromAnswer(ans, { profileIds: profiles.map((p) => p.id), activeId, conversation: a.conversation, conflicts });
  a.log?.(`[wish-router] client=${a.clientId} → ${route.kind}${'profileId' in route && route.profileId ? ` profile=${route.profileId}` : ''}${route.kind === 'changed' ? ` fields=${route.fields.join(',')}` : ''}${route.kind === 'second' ? ` name=«${route.profileName}»` : ''} (${route.why})`);
  return route;
}
