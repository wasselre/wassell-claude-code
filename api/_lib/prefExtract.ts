/**
 * Preference extraction — the prompt + parser behind /api/live-call/extract.
 *
 * Reads a speaker-labelled Arabic call transcript and returns the client's
 * property preferences mapped onto the clients-model field values, each with
 * the client's own quoted phrase and a confidence score.
 *
 * The prompt is the "v2" recipe validated on 16 real clients (measured against
 * what reps actually saved): budget 83%, unit_type 76%, area 58–67%. The key
 * lesson baked in: DO record a stated-but-casual preference ("شمال أكيد يعني" →
 * ["شمال"]); the ONLY forbidden thing is inventing a value the client never
 * said. An over-cautious "leave it blank if unsure" made the model refuse
 * rather than answer and cost ~6 points of recall.
 *
 * Model note: DeepSeek V4 Pro/Flash are REASONING models — reasoning tokens
 * count against max_tokens. Too small a budget returns an EMPTY string with
 * finish_reason:"length" (not an error). callDeepSeek retries larger, then
 * fails loudly rather than silently storing nothing.
 */

/** The fields the extractor fills, with their allowed values (clients model). */
export const PREF_FIELDS = {
  preferred_unit_type: { kind: 'set', options: ['استوديو', 'تاون هاوس', 'دبلكس', 'دور', 'شقة', 'فيلا', 'ملحق'] },
  preferred_direction: { kind: 'set', options: ['جنوب', 'جنوب شرق', 'جنوب غرب', 'شرق', 'شمال', 'شمال شرق', 'شمال غرب', 'غرب'] },
  purchase_objective:  { kind: 'set', options: ['investment', 'residential'] },
  preferred_amenities: { kind: 'set', options: ['حوش', 'سطح', 'غرفة خادمة', 'غرفة سائق', 'قبو', 'مجلس', 'مسبح', 'مصعد', 'ملحق'] },
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

export const EXTRACT_SYSTEM_PROMPT = `أنت مساعد لفريق مبيعات عقاري سعودي. تقرأ نص مكالمة هاتفية مع عميل — مُصنّفة حسب المتحدث (المندوب / العميل) — وتستخرج تفضيلات العميل العقارية فقط.

القواعد:
- استخدم القيم العربية الحرفية من القوائم أدناه فقط، لا تترجمها للإنجليزية (عدا purchase_objective الذي قيمه investment/residential).
- المهم ما يريده العميل ويوافق عليه، لا ما يقترحه المندوب.
- إذا لم يُذكر شيء عن حقل ما إطلاقًا، اترك قيمته null.
- لكن إذا ذكر العميل تفضيلًا ولو بشكل عابر أو غير مؤكد، سجّله. «شمال أكيد يعني» = ["شمال"]، «أي حي عادي بس شمال» = ["شمال"]، «ما يتجاوز الثلاثة مليون» = budget.max 3000000، «حوالي ميتين متر» = area حول 200. لا تتردد في تسجيل ما قاله العميل فعلًا.
- الممنوع الوحيد هو الاختلاق: لا تسجّل قيمة لم تُذكر ولا يمكن استنتاجها من كلام العميل.
- الأرقام بالعامية: «مليونين ونص» = 2500000، «ميتين متر» = 200، «ثلاث مية» = 300، «مليون وستمية» = 1600000.
- لكل حقل تستخرجه، أرفق «quote» = العبارة الحرفية التي قالها العميل، و«confidence» من 0 إلى 100.

الحقول والقيم المسموحة (استخدم القيم حرفيًا):
- preferred_unit_type: مصفوفة من [${setOptions('preferred_unit_type').join(', ')}]
- preferred_direction: مصفوفة من [${setOptions('preferred_direction').join(', ')}]
- purchase_objective: مصفوفة من [investment, residential]
- preferred_amenities: مصفوفة من [${setOptions('preferred_amenities').join(', ')}]
- budget: {"min": رقم أو null, "max": رقم أو null} بالريال
- preferred_area: {"min": رقم أو null, "max": رقم أو null} بالمتر المربع
- preferred_bedrooms: {"min": رقم أو null, "max": رقم أو null}
- districts: مصفوفة نصية بأسماء الأحياء التي ذكرها العميل (مثل: النرجس، الياسمين)

أعد JSON فقط بهذا الشكل بدون أي نص آخر. اترك أي حقل غير مذكور = null:
{
  "preferred_unit_type": {"value": [], "quote": "", "confidence": 0} أو null,
  "preferred_direction": null,
  "purchase_objective": null,
  "preferred_amenities": null,
  "budget": {"value": {"min": null, "max": null}, "quote": "", "confidence": 0} أو null,
  "preferred_area": null,
  "preferred_bedrooms": null,
  "districts": []
}`;

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

/** Parse the model's raw content into validated suggestions. Never throws. */
export function parseExtraction(raw: string): ExtractionOutput {
  let text = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a === -1 || b === -1) return { suggestions: {}, districts: [] };

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return { suggestions: {}, districts: [] };
  }

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

/**
 * Call DeepSeek and return the raw content.
 *
 * `fast` (mid-call, on a small sliding window of recent transcript) adds
 * reasoning_effort:'low' + JSON response_format so a short input returns in
 * ~1–3s instead of the 15–50s a heavy-reasoning pass takes on a full
 * transcript. The non-fast path (the end-of-call sweep, `final`) keeps full
 * reasoning for accuracy — latency doesn't matter once the call has ended.
 *
 * Reasoning models can spend the whole budget thinking and return empty with
 * finish_reason:"length" — we retry once at a larger budget, then throw so the
 * caller fails loudly (never stores empty as a "no preferences" answer).
 */
export async function callDeepSeek(input: {
  apiKey: string;
  model: string;
  transcript: string;
  fast?: boolean;
  baseUrl?: string;
}): Promise<string> {
  const base = (input.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
  const attempt = async (maxTokens: number): Promise<{ content: string; finish: string | null }> => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
          { role: 'user', content: `نص المكالمة:\n${input.transcript}` },
        ],
        ...(input.fast
          ? { reasoning_effort: 'low', response_format: { type: 'json_object' } }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
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
