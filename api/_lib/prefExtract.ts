/**
 * Preference extraction — the prompt + parser behind the chat auto-read's
 * preference agent (and, historically, /api/live-call/extract).
 *
 * Reads a speaker-labelled Arabic conversation — a phone call transcript
 * (`channel: 'call'`) or a WhatsApp chat (`channel: 'chat'`) — and returns the
 * client's property preferences mapped onto the clients-model field values,
 * each with the client's own quoted phrase and a confidence score.
 *
 * The prompt is the "v2" recipe validated on 16 real clients (measured against
 * what reps actually saved): budget 83%, unit_type 76%, area 58–67%. The key
 * lesson baked in: DO record a stated-but-casual preference ("فيلا أكيد يعني" →
 * ["فيلا"]); the ONLY forbidden thing is inventing a value the client never
 * said. An over-cautious "leave it blank if unsure" made the model refuse
 * rather than answer and cost ~6 points of recall. The chat variant adds the
 * rules the geography pipeline follows on chats: a rep's proposal is not the
 * customer's preference until the customer accepts it; a customer QUESTION is
 * interest (lower confidence); a transcribed voice note is the customer's words.
 *
 * ROUTING (mirrors api/_lib/geoPreference/extractor.ts exactly): STUB mode
 * (`WA_EXTRACT_STUB=1`, or no provider key at all — `extractionStubEnabled`)
 * → DeepSeek primary (`deepseek-chat`, DEEPSEEK_API_KEY, via textLlm routing;
 * `TEXT_LLM_PROVIDER=anthropic` is the kill switch) → Claude Haiku fallback
 * through `trackedAnthropic`. Both failing THROWS — an empty answer is never
 * returned as "the customer has no preferences".
 *
 * Model note: DeepSeek V4 Pro/Flash are REASONING models — reasoning tokens
 * count against max_tokens. Too small a budget returns an EMPTY string with
 * finish_reason:"length" (not an error). callDeepSeek retries larger, then
 * fails loudly rather than silently storing nothing.
 *
 * Location is NOT extracted here beyond raw district names, and callers DROP
 * those: the client's geography (city, districts, direction zones) is owned by
 * the chat geography card / geoPreference pipeline and lives in `location` +
 * `location_items`. The free-text direction field was retired 2026-09-27.
 */

import Anthropic from '@anthropic-ai/sdk';
import { recordAiUsage, openAiCompatTokens, openAiCompatModel, trackedAnthropic } from './aiUsage.js';
import { llmRoutingEnabled, logLlmFallback } from './textLlm.js';
import { extractionStubEnabled } from './geoPreference/extractor.js';

/** Bump when the prompt or the parse contract changes (stored on every proposal). */
export const PREF_EXTRACTOR_VERSION = 'pref-extract/v2-chat';

/** What the DeepSeek alias is called (same model the geo extractor uses via llmText). */
export const PREF_DEEPSEEK_MODEL = 'deepseek-chat';
/** The Claude fallback — the same model the geo extractor falls back to. */
export const PREF_CLAUDE_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

export type PrefChannel = 'chat' | 'call';

/**
 * The fields the extractor fills, with their allowed values. These are the
 * option API `value`s of the LIVE clients schema (docs/prd/models/clients.md,
 * checked 2026-09-27): purchase_objective stores `investment` / `residential`,
 * and preferred_amenities has NO «قبو» / «ملحق» option (only the unit type has
 * «ملحق»). The review endpoint re-validates against the live schema at save
 * time anyway, so a drift here drops a value loudly instead of saving junk.
 */
export const PREF_FIELDS = {
  preferred_unit_type: { kind: 'set', options: ['استوديو', 'تاون هاوس', 'دبلكس', 'دور', 'شقة', 'فيلا', 'ملحق'] },
  purchase_objective:  { kind: 'set', options: ['investment', 'residential'] },
  preferred_amenities: { kind: 'set', options: ['حوش', 'سطح', 'غرفة خادمة', 'غرفة سائق', 'مجلس', 'مسبح', 'مصعد'] },
  budget:              { kind: 'range' },
  preferred_area:      { kind: 'range' },
  preferred_bedrooms:  { kind: 'range' },
} as const;

export type PrefSlug = keyof typeof PREF_FIELDS;

export interface PrefSuggestion {
  slug: string;
  value: unknown;          // string[] for set fields, { min?, max? } for range fields
  quote: string | null;    // the client's own words
  confidence: number;      // 0–100
}

export interface ExtractionOutput {
  suggestions: Record<string, PrefSuggestion>;
  districts: string[];
}

const setOptions = (slug: PrefSlug): readonly string[] =>
  PREF_FIELDS[slug].kind === 'set' ? (PREF_FIELDS[slug] as { options: readonly string[] }).options : [];

// ── prompt ───────────────────────────────────────────────────────────────────

const PROMPT_INTRO: Record<PrefChannel, string> = {
  call: 'أنت مساعد لفريق مبيعات عقاري سعودي. تقرأ نص مكالمة هاتفية مع عميل — مُصنّفة حسب المتحدث (المندوب / العميل) — وتستخرج تفضيلات العميل العقارية فقط.',
  // Matches renderConversation (geoPreference/extractor.ts): «[رقم] العميل: …» / «[رقم] المندوب: …».
  chat: 'أنت مساعد لفريق مبيعات عقاري سعودي. تقرأ محادثة واتساب بين المندوب والعميل — كل سطر بالشكل «[رقم] المتحدث: النص» والمتحدث هو العميل أو المندوب — وتستخرج تفضيلات العميل العقارية فقط.',
};

/** Extra rules for a WhatsApp chat — the same posture the geography pipeline takes. */
const CHAT_RULES = `
- ما يقترحه المندوب أو يعرضه ليس تفضيلًا للعميل إلا إذا وافق عليه العميل صراحة («إيه تمام»، «زين يناسبني»). عرض المندوب لمشروع أو سعر وحده لا يُسجَّل.
- سؤال العميل عن شيء («فيه فلل؟»، «كم سعر الشقة؟») يدل على اهتمامه: سجّله، لكن بثقة أقل (بين 40 و60).
- السطر الذي يبدأ بـ «(رسالة صوتية)» هو تفريغ لرسالة صوتية أرسلها العميل نفسه — كلامه هو، وعامله ككلام مكتوب منه.
- إذا غيّر العميل رأيه خلال المحادثة، اعتمد آخر ما قاله.`;

/** The system prompt for a channel. Only the first sentence (and, for chat, the extra rules) differ. */
export function buildExtractSystemPrompt(channel: PrefChannel): string {
  return `${PROMPT_INTRO[channel]}

القواعد:
- استخدم القيم العربية الحرفية من القوائم أدناه فقط، لا تترجمها للإنجليزية (عدا purchase_objective الذي قيمه investment/residential).
- المهم ما يريده العميل ويوافق عليه، لا ما يقترحه المندوب.
- إذا لم يُذكر شيء عن حقل ما إطلاقًا، اترك قيمته null.
- لكن إذا ذكر العميل تفضيلًا ولو بشكل عابر أو غير مؤكد، سجّله. «فيلا أكيد يعني» = ["فيلا"]، «أي شي عادي بس شقة» = ["شقة"]، «ما يتجاوز الثلاثة مليون» = budget.max 3000000، «حوالي ميتين متر» = area حول 200. لا تتردد في تسجيل ما قاله العميل فعلًا.
- الممنوع الوحيد هو الاختلاق: لا تسجّل قيمة لم تُذكر ولا يمكن استنتاجها من كلام العميل.
- الأرقام بالعامية: «مليونين ونص» = 2500000، «ميتين متر» = 200، «ثلاث مية» = 300، «مليون وستمية» = 1600000.
- لكل حقل تستخرجه، أرفق «quote» = العبارة الحرفية التي قالها العميل، و«confidence» من 0 إلى 100.${channel === 'chat' ? CHAT_RULES : ''}

الحقول والقيم المسموحة (استخدم القيم حرفيًا):
- preferred_unit_type: مصفوفة من [${setOptions('preferred_unit_type').join(', ')}]
- purchase_objective: مصفوفة من [investment, residential]
- preferred_amenities: مصفوفة من [${setOptions('preferred_amenities').join(', ')}]
- budget: {"min": رقم أو null, "max": رقم أو null} بالريال
- preferred_area: {"min": رقم أو null, "max": رقم أو null} بالمتر المربع
- preferred_bedrooms: {"min": رقم أو null, "max": رقم أو null}
- districts: مصفوفة نصية بأسماء الأحياء التي ذكرها العميل (مثل: النرجس، الياسمين)

أعد JSON فقط بهذا الشكل بدون أي نص آخر. اترك أي حقل غير مذكور = null:
{
  "preferred_unit_type": {"value": [], "quote": "", "confidence": 0} أو null,
  "purchase_objective": null,
  "preferred_amenities": null,
  "budget": {"value": {"min": null, "max": null}, "quote": "", "confidence": 0} أو null,
  "preferred_area": null,
  "preferred_bedrooms": null,
  "districts": []
}`;
}

/** The call prompt (kept under its historical name). */
export const EXTRACT_SYSTEM_PROMPT = buildExtractSystemPrompt('call');

/** The user turn: the rendered conversation under a channel-appropriate heading. */
export function buildExtractUserText(channel: PrefChannel, transcript: string): string {
  return channel === 'chat' ? `المحادثة:\n${transcript}` : `نص المكالمة:\n${transcript}`;
}

// ── parsing ──────────────────────────────────────────────────────────────────

function asStringArray(v: unknown, allowed: readonly string[]): string[] {
  // The model sometimes returns a bare scalar for a single-value multiselect
  // ("residential" instead of ["residential"]) — coerce it rather than drop it.
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  const set = new Set(allowed);
  return arr.map(String).map((s) => s.trim()).filter((s) => set.has(s));
}

function asRange(v: unknown): { min?: number; max?: number } | null {
  if (v == null || typeof v !== 'object') return null;
  const o = v as { min?: unknown; max?: unknown };
  const num = (x: unknown) => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const min = num(o.min), max = num(o.max);
  if (min === undefined && max === undefined) return null;
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

function clampConfidence(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 60;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Strip reasoning / code fences and cut to the outermost JSON object; null when there is none. */
function jsonSlice(raw: string): string | null {
  let text = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) return null;
  return text.slice(a, b + 1);
}

/** Parse the model's raw content into validated suggestions. Never throws. */
export function parseExtraction(raw: string): ExtractionOutput {
  const slice = jsonSlice(raw);
  if (slice === null) return { suggestions: {}, districts: [] };

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(slice) as Record<string, unknown>;
  } catch {
    // Documented contract: this lenient parser never throws. The provider path
    // uses parseExtractionStrict (below), which DOES fail on this case.
    return { suggestions: {}, districts: [] };
  }
  return fromObject(obj);
}

/**
 * Like {@link parseExtraction} but THROWS when the content is not a JSON
 * object — so an unparseable answer falls through to the next provider instead
 * of being stored as "no preferences".
 */
export function parseExtractionStrict(raw: string): ExtractionOutput {
  const slice = jsonSlice(raw);
  if (slice === null) throw new Error('model returned no JSON object');
  const obj = JSON.parse(slice) as unknown; // a SyntaxError propagates on purpose
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('model JSON is not an object');
  return fromObject(obj as Record<string, unknown>);
}

function fromObject(obj: Record<string, unknown>): ExtractionOutput {
  const suggestions: Record<string, PrefSuggestion> = {};
  for (const slug of Object.keys(PREF_FIELDS) as PrefSlug[]) {
    const entry = obj[slug];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { value?: unknown; quote?: unknown; confidence?: unknown };
    const field = PREF_FIELDS[slug];
    const value = field.kind === 'set'
      ? asStringArray(e.value, setOptions(slug))
      : asRange(e.value);
    const present = Array.isArray(value) ? value.length > 0 : value !== null;
    if (!present) continue;
    suggestions[slug] = {
      slug,
      value,
      quote: typeof e.quote === 'string' && e.quote.trim() ? e.quote.trim() : null,
      confidence: clampConfidence(e.confidence),
    };
  }

  const districts = Array.isArray(obj.districts)
    ? Array.from(new Set(obj.districts.map(String).map((s) => s.trim()).filter(Boolean)))
    : [];

  return { suggestions, districts };
}

// ── model call ───────────────────────────────────────────────────────────────

export interface PrefEntityRef { kind: string; id: string }

const CALL_SITE = 'api/_lib/prefExtract';
const DEEPSEEK_TIMEOUT_MS = 90_000;

/**
 * Call DeepSeek and return the raw content.
 *
 * `fast` (mid-call, on a small sliding window of recent transcript) adds
 * reasoning_effort:'low' + JSON response_format so a short input returns in
 * ~1–3s instead of the 15–50s a heavy-reasoning pass takes on a full
 * transcript. The non-fast path keeps full reasoning for accuracy.
 *
 * Reasoning models can spend the whole budget thinking and return empty with
 * finish_reason:"length" — we retry once at a larger budget, then throw so the
 * caller fails loudly (never stores empty as a "no preferences" answer).
 *
 * Metering: one `ai_usage` row per ATTEMPT (success, HTTP error, or transport
 * failure), operation `extract_<channel>`, with the entity passed through.
 */
export async function callDeepSeek(input: {
  apiKey: string;
  model: string;
  transcript: string;
  fast?: boolean;
  baseUrl?: string;
  channel?: PrefChannel;
  entity?: PrefEntityRef | null;
  timeoutMs?: number;
}): Promise<string> {
  const base = (input.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const channel: PrefChannel = input.channel ?? 'call';
  const operation = `extract_${channel}`;
  const entity = { entityKind: input.entity?.kind ?? null, entityId: input.entity?.id ?? null };
  const attempt = async (maxTokens: number): Promise<{ content: string; finish: string | null }> => {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DEEPSEEK_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: buildExtractSystemPrompt(channel) },
            { role: 'user', content: buildExtractUserText(channel, input.transcript) },
          ],
          ...(input.fast
            ? { reasoning_effort: 'low', response_format: { type: 'json_object' } }
            : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // Transport failure (timeout, DNS, abort): no usage came back, but the
      // attempt still gets a row — a burst of these is a fallback storm.
      await recordAiUsage({
        area: 'sales', callSite: CALL_SITE, operation,
        provider: 'deepseek', model: input.model, status: 'error',
        error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - started, ...entity,
      });
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const err = new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await recordAiUsage({
        area: 'sales', callSite: CALL_SITE, operation,
        provider: 'deepseek', model: input.model, status: 'error',
        error: err.message, latencyMs: Date.now() - started, ...entity,
      });
      throw err;
    }
    const j = (await res.json()) as {
      /** What the alias actually resolved to — the name the vendor prices. */
      model?: string;
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
    };
    // One row per ATTEMPT: the retry-at-a-larger-budget path below makes a
    // second real call, and a per-call ledger has to show both.
    await recordAiUsage({
      area: 'sales', callSite: CALL_SITE, operation,
      provider: 'deepseek', model: openAiCompatModel(j, input.model), status: 'ok',
      latencyMs: Date.now() - started, ...entity,
      meta: { max_tokens: maxTokens, fast: Boolean(input.fast), channel },
      ...openAiCompatTokens(j),
    });
    const choice = j.choices?.[0];
    return { content: choice?.message?.content ?? '', finish: choice?.finish_reason ?? null };
  };

  // Fast passes get a smaller first budget (small input → small output).
  let out = await attempt(input.fast ? 3000 : 8000);
  const looksEmpty = !out.content.includes('{');
  if (looksEmpty && out.finish === 'length') out = await attempt(16000);
  if (!out.content.includes('{')) {
    throw new Error(`deepseek returned no JSON (finish=${out.finish})`);
  }
  return out.content;
}

/** Claude Haiku fallback leg — metered through trackedAnthropic. Throws on any failure. */
async function claudeExtract(channel: PrefChannel, transcript: string, entity: PrefEntityRef | null): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const routed = llmRoutingEnabled();
  const client = trackedAnthropic(new Anthropic({ apiKey }), {
    area: 'sales', callSite: CALL_SITE, operation: `extract_${channel}`,
    isFallback: routed, fallbackFrom: routed ? 'deepseek' : null,
    entityKind: entity?.kind ?? null, entityId: entity?.id ?? null,
  });
  const resp = await client.messages.create({
    model: PREF_CLAUDE_FALLBACK_MODEL,
    max_tokens: 2000,
    system: buildExtractSystemPrompt(channel),
    messages: [{ role: 'user', content: buildExtractUserText(channel, transcript) }],
  });
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Deterministic offline output (stub mode): the unit-type words the text contains. */
function stubExtraction(transcript: string): ExtractionOutput {
  const found = setOptions('preferred_unit_type').filter((o) => transcript.includes(o));
  if (found.length === 0) return { suggestions: {}, districts: [] };
  return {
    suggestions: {
      preferred_unit_type: { slug: 'preferred_unit_type', value: found, quote: found[0] ?? null, confidence: 50 },
    },
    districts: [],
  };
}

export interface PreferenceExtraction {
  output: ExtractionOutput;
  /** The model that produced it ('stub' in stub mode). */
  model: string;
  /** True when the Claude fallback leg answered after DeepSeek failed. */
  isFallback: boolean;
}

/**
 * Extract a client's preferences from ONE rendered conversation.
 *   1. STUB mode (env or no provider) ⇒ deterministic canned output.
 *   2. DeepSeek primary when routing is enabled.
 *   3. Claude Haiku fallback (logged via logLlmFallback).
 * Both providers failing THROWS with both errors — never a silent empty.
 */
export async function extractPreferences(input: {
  channel: PrefChannel;
  transcript: string;
  entity?: PrefEntityRef | null;
}): Promise<PreferenceExtraction> {
  const entity = input.entity ?? null;
  if (extractionStubEnabled()) {
    return { output: stubExtraction(input.transcript), model: 'stub', isFallback: false };
  }

  let deepseekError: string | null = null;
  if (llmRoutingEnabled()) {
    try {
      const raw = await callDeepSeek({
        apiKey: process.env.DEEPSEEK_API_KEY?.trim() ?? '',
        model: PREF_DEEPSEEK_MODEL,
        transcript: input.transcript,
        channel: input.channel,
        entity,
      });
      return { output: parseExtractionStrict(raw), model: PREF_DEEPSEEK_MODEL, isFallback: false };
    } catch (err) {
      deepseekError = err instanceof Error ? err.message : String(err);
      logLlmFallback(`prefExtract/${input.channel}`, err);
    }
  }

  try {
    const raw = await claudeExtract(input.channel, input.transcript, entity);
    return { output: parseExtractionStrict(raw), model: PREF_CLAUDE_FALLBACK_MODEL, isFallback: deepseekError !== null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[prefExtract/${input.channel}] Claude fallback failed:`, msg);
    throw new Error(
      deepseekError
        ? `preference extraction failed on both providers — deepseek: ${deepseekError}; claude: ${msg}`
        : `preference extraction failed — claude: ${msg}`,
    );
  }
}
