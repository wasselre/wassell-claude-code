/**
 * The sales agent's UNDERSTANDING sub-agent: reads what the customer just said
 * into structured answers (region / unit type / bedrooms / budget / intent).
 *
 * It never writes to the customer — texts.ts does. Routing mirrors the
 * preference extractor: DeepSeek primary (when routing is on) → Claude Haiku
 * fallback via trackedAnthropic; both failing THROWS (the turn job fails and is
 * retried) — never a silent empty. Every call is metered (area 'sales').
 */
import Anthropic from '@anthropic-ai/sdk';
import { trackedAnthropic } from '../aiUsage.js';
import { deepseekJson } from '../deepseek.js';
import { llmRoutingEnabled, logLlmFallback } from '../textLlm.js';
import { parseZone, normalizeUnitType, type Intent, type Slot, type Slots, type Understanding } from './decide.js';
import type { Gender, Lang, Zone } from './texts.js';
import { clip } from './clip.js';

const CALL_SITE = 'api/_lib/salesAgent/understand';
const HAIKU = 'claude-haiku-4-5-20251001';

export interface ChatTurn {
  who: 'customer' | 'us';
  text: string;
  /** Sent after our last reply — what this turn must answer. */
  isNew: boolean;
  /** Message time (ISO) — lets the brain mark where the current conversation starts. */
  at?: string;
}

const INTENTS: Intent[] = ['answer', 'more', 'interested', 'question', 'human', 'stop', 'other'];
const ZONES: Zone[] = ['north', 'south', 'east', 'west', 'center'];
const SLOTS: Slot[] = ['zone', 'unit_type', 'bedrooms', 'budget'];

const SHAPE = `{
  "intent": "answer" | "more" | "interested" | "question" | "human" | "stop" | "other",
  "zone": "north" | "south" | "east" | "west" | "center" | null,
  "unit_types": string[],
  "bedrooms_min": number | null,
  "budget_max": number | null,
  "skip": ("zone" | "unit_type" | "bedrooms" | "budget")[],
  "city": string | null,
  "gender": "m" | "f" | null,
  "lang": "ar" | "en"
}`;

const SYSTEM = `You read a Saudi real-estate WhatsApp chat for Wassel (وصل العقارية) and extract what the CUSTOMER said in their NEW messages (marked [NEW]). Earlier lines are context only.

We are qualifying the customer to recommend one of our residential projects in Riyadh. We ask, in order: region → unit type → bedrooms → budget.

Extract ONLY what the customer actually said — never guess or fill defaults:
- zone: the Riyadh direction they want. شمال→north, جنوب→south, شرق→east, غرب→west, وسط/قلب الرياض→center. A project NAME that merely contains a direction word (e.g. «المشرقية») is NOT a zone. null if not said.
- unit_types: from exactly these values: "شقة", "دور", "فيلا", "تاون هاوس", "دبلكس". Map plurals/synonyms (شقق→شقة, فلل→فيلا, أدوار→دور, تاون→تاون هاوس, apartment→شقة, villa→فيلا, floor→دور). [] if not said.
- bedrooms_min: the number of bedrooms they want (minimum). "4 غرف" → 4. null if not said.
- budget_max: their maximum price in SAR as a plain number. «مليون ونص» → 1500000, «800 ألف» → 800000, «2 مليون» → 2000000, «بحدود مليون» → 1000000. null if not said.
- skip: slots they said don't matter («ما يهم», «أي شي», «any»).
- city: only if they name a city other than Riyadh; else null.
- gender: "f" if the customer refers to herself with feminine forms (e.g. «مهتمة», «أنا حابة», «محتارة»), "m" if with masculine forms (e.g. «مهتم», «حاب»), else null.
- lang: "en" if the customer writes in English, else "ar".

intent (the NEW messages as a whole):
- "answer": gives preferences or answers our question.
- "more": wants another option, or says the project we sent doesn't suit them.
- "interested": likes a project we sent, wants to visit it, or wants a call about it.
- "question": asks about price, payment plan, down payment, location, delivery or details of a project.
- "human": asks for a person/sales agent/a call from someone, or complains.
- "stop": not interested, wants to stop.
- "other": greeting, thanks, anything unclear.`;

function render(turns: ChatTurn[]): string {
  return turns
    .map((t) => `${t.isNew ? '[NEW] ' : ''}${t.who === 'customer' ? 'العميل' : 'وصل'}: ${clip(t.text.replace(/\s+/g, ' '), 500)}`)
    .join('\n');
}

function buildUser(turns: ChatTurn[], slots: Slots, asked: string | null): string {
  return [
    `What we already know: ${JSON.stringify({
      zone: slots.zone ?? null, unit_types: slots.unit_types ?? [], bedrooms_min: slots.bedrooms_min ?? null,
      budget_max: slots.budget_max ?? null,
    })}`,
    `Our last question: ${asked ?? 'none'}`,
    '',
    'Chat (oldest first):',
    render(turns),
  ].join('\n');
}

/** Coerce whatever the model returned into a well-typed Understanding. */
export function coerceUnderstanding(raw: Record<string, unknown>, fallbackLang: Lang): Understanding {
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const intent = INTENTS.includes(raw.intent as Intent) ? (raw.intent as Intent) : 'other';
  const zone = ZONES.includes(raw.zone as Zone) ? (raw.zone as Zone) : null;
  const unit_types = Array.isArray(raw.unit_types)
    ? (raw.unit_types as unknown[]).filter((x): x is string => typeof x === 'string').map(normalizeUnitType).filter((x): x is string => !!x)
    : [];
  const skip = Array.isArray(raw.skip) ? (raw.skip as unknown[]).filter((x): x is Slot => SLOTS.includes(x as Slot)) : [];
  const gender = raw.gender === 'f' || raw.gender === 'm' ? (raw.gender as Gender) : null;
  const lang: Lang = raw.lang === 'en' ? 'en' : raw.lang === 'ar' ? 'ar' : fallbackLang;
  const city = typeof raw.city === 'string' && raw.city.trim() && !/رياض|riyadh/i.test(raw.city) ? raw.city.trim() : null;
  return { intent, zone, unit_types, bedrooms_min: num(raw.bedrooms_min), budget_max: num(raw.budget_max), skip, city, gender, lang };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e <= s) throw new Error('no JSON object in the reply');
  const v = JSON.parse(text.slice(s, e + 1)) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('reply was not a JSON object');
  return v as Record<string, unknown>;
}

export async function understandTurn(
  turns: ChatTurn[],
  slots: Slots,
  asked: string | null,
  opts: { chatWid: string },
): Promise<{ u: Understanding; model: string; isFallback: boolean }> {
  const newText = turns.filter((t) => t.isNew && t.who === 'customer').map((t) => t.text).join(' ');
  const fallbackLang: Lang = /[؀-ۿ]/.test(newText) ? 'ar' : /[A-Za-z]{2,}/.test(newText) ? 'en' : (slots.lang ?? 'ar');
  const user = buildUser(turns, slots, asked);

  // Deterministic safety net: a direction word in the NEW customer text sets the
  // zone even if the model misses it (anchored — «المشرقية» is not "east").
  const withNet = (u: Understanding): Understanding => (u.zone ? u : { ...u, zone: parseZone(newText) });

  let deepseekError: string | null = null;
  if (llmRoutingEnabled()) {
    try {
      const raw = await deepseekJson<Record<string, unknown>>({
        system: SYSTEM, user, shape: SHAPE, requiredKeys: ['intent', 'lang'],
        maxTokens: 400, temperature: 0, timeoutMs: 25_000,
        track: { area: 'sales', callSite: CALL_SITE, operation: 'understand_turn' },
        entityKind: 'chat', entityId: opts.chatWid,
      });
      return { u: withNet(coerceUnderstanding(raw, fallbackLang)), model: 'deepseek', isFallback: false };
    } catch (err) {
      deepseekError = err instanceof Error ? err.message : String(err);
      logLlmFallback('salesAgent/understand', err);
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error(`sales agent understanding failed — deepseek: ${deepseekError ?? 'not routed'}; claude: ANTHROPIC_API_KEY missing`);
  const routed = llmRoutingEnabled();
  const client = trackedAnthropic(new Anthropic({ apiKey }), {
    area: 'sales', callSite: CALL_SITE, operation: 'understand_turn',
    isFallback: routed, fallbackFrom: routed ? 'deepseek' : null,
    entityKind: 'chat', entityId: opts.chatWid,
  });
  try {
    const resp = await client.messages.create({
      model: HAIKU,
      max_tokens: 400,
      system: `${SYSTEM}\n\nRespond with ONLY one JSON object of exactly this shape:\n${SHAPE}`,
      messages: [{ role: 'user', content: user }],
    });
    const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
    return { u: withNet(coerceUnderstanding(parseJsonObject(text), fallbackLang)), model: HAIKU, isFallback: deepseekError !== null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`sales agent understanding failed on both providers — deepseek: ${deepseekError ?? 'not routed'}; claude: ${msg}`);
  }
}
