/**
 * The geo-preference VERIFIER — a second AI that checks the map against the
 * conversation.
 *
 * The ability (extract → resolve → compile → gate) ends with ONE pending
 * proposal per conversation. On live chats nobody grades each one, so this
 * module re-reads the SAME conversation next to the finished map — each
 * mention rendered as a plain Arabic sentence by `placementText.ts` — and says,
 * per mention, "right / wrong because …", plus any place the customer clearly
 * wanted that is missing from the list.
 *
 * ADVISORY ONLY. Its result is stored next to the proposal
 * (`geo_pref_proposals.verifier`) and shown in the grader. It never changes the
 * proposal, the gate, or any client record.
 *
 * ROUTING is identical to `extract()`: stub mode (`WA_EXTRACT_STUB=1`, or no
 * provider) → DeepSeek primary via `llmText` (metered with `track`) → Claude
 * fallback via `trackedAnthropic`. ONE call, no budget.
 *
 * HONESTY: if every provider fails (or returns output that cannot be parsed),
 * the result is `{status:'error', overall:'unknown'}` — NEVER 'agree'. A check
 * that did not run must never read as a check that passed. The function never
 * throws.
 */

import Anthropic from '@anthropic-ai/sdk';
import { trackedAnthropic } from '../aiUsage.js';
import { llmText, llmRoutingEnabled, logLlmFallback } from '../textLlm.js';
import { buildExtractionUserText, extractionStubEnabled, type Conversation } from './extractor.js';
import type { VerifierMention } from './placementText.js';

export const VERIFIER_VERSION = 'geo-verify/v2'; // v2 (2026-09-27): a customer's question about a place is interest
const CLAUDE_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
const DEEPSEEK_MODEL_LABEL = 'deepseek-chat';

export type VerifierVerdict = 'right' | 'wrong_place' | 'not_a_preference' | 'not_a_place' | 'wrong_polarity' | 'unsure';
const VERDICTS: readonly VerifierVerdict[] = ['right', 'wrong_place', 'not_a_preference', 'not_a_place', 'wrong_polarity', 'unsure'];

export interface VerifierResult {
  status: 'ok' | 'error';
  overall: 'agree' | 'doubt' | 'unknown';
  mentions: Array<{ evidence_id: string; verdict: VerifierVerdict; reason: string }>;
  missed: Array<{ span: string; reason: string }>;
  error?: string;
  model?: string;
}

export interface VerifyInput {
  conversation: Conversation;
  mentions: Array<VerifierMention & { mention_span: string }>;
  /** OUR project-name heads (projectGuard.ts) — named in the prompt as NOT places. Optional. */
  projectNames?: readonly string[];
}

export const VERIFY_SYSTEM_PROMPT = `أنت مراجعٌ صارم لفريق عقاري سعودي. نظامٌ آليّ قرأ محادثة واحدة مع عميل (شات واتساب أو مكالمة هاتفية)، واستخرج منها الأماكن التي يريدها العميل أو يرفضها، ثم وضعها على خريطة. مهمتك أن تقرأ المحادثة بنفسك، ثم تحكم على كل إشارة في القائمة: هل ما فعله النظام صحيح؟

لكل إشارة اسأل بالترتيب:
1. هل هي مكانٌ جغرافي فعلًا؟ ليست اسم مشروع عقاري، ولا كلمة تصف حالة الوحدة مثل «عظم» أو «تشطيب» أو «جاهز» أو «على الخارطة»، ولا كلمة عامة مثل «الموقع» أو «المكان». إن لم تكن مكانًا → not_a_place.
2. هل هي تفضيلٌ للعميل نفسه؟ ليست اقتراحًا من المندوب لم يقبله العميل، ولا مكانًا يذكره العميل للمقارنة أو لأنه يسكن فيه حاليًا. إن وضعها النظام على الخريطة وهي ليست تفضيلًا → not_a_preference.
   قاعدة الشركة (ملزمة): سؤال العميل عن مكان هو اهتمامٌ به ويُعدّ تفضيلًا مقبولًا. «عندكم شي في القدس؟»، «فيه الازدهار موجود؟»، «كم سعر اللي في الشرق؟»، «وين حي الفاروق؟» = العميل مهتم بهذا المكان، ووضعه على الخريطة كمكان يريده صحيح (right). لا تحكم عليه بـ not_a_preference لأنه جاء بصيغة سؤال. يسقط الاهتمام فقط إن رفضه العميل بعد ذلك صراحة («ما أبغى»)، فحينها يكون «لا يريد».
3. هل الاتجاه صحيح؟ «يريد» مقابل «لا يريد». إن انعكس → wrong_polarity.
4. هل ما وُضع على الخريطة هو المكان الذي قصده العميل؟ الحي الصحيح، المدينة الصحيحة، الجهة الصحيحة من الطريق، وليس أوسع أو أضيق بوضوح. إن لا → wrong_place.
- إشارة مكتوب عندها أن النظام لم يضع شيئًا على الخريطة: النظام قرّر أنها ليست تفضيلًا. إن وافقته (اقتراح من المندوب لم يتفاعل معه العميل، مقارنة، ليست مكانًا) → right. إن كان العميل يريد هذا المكان أو يرفضه فعلًا → wrong_place. لا تستخدم not_a_preference ولا not_a_place ولا wrong_polarity لإشارة لم توضع على الخريطة — هذه الأحكام لما وُضع على الخريطة فقط.
- الحكم على ما فعله النظام، لا على الإشارة نفسها: not_a_preference تعني «وضعها النظام على الخريطة وما كان يجب».
- إن كان كل شيء صحيحًا → right. إن لم تستطع الحكم من النص → unsure.

ثم ابحث عن أماكن أرادها العميل أو رفضها بوضوح في المحادثة ولم ترد في القائمة أبدًا → missed. لا تضع في missed مكانًا ذكره المندوب وحده، ولا اسم مشروع، ولا مكانًا ورد في القائمة بصيغة أخرى.

قواعد:
- احكم من نص المحادثة فقط. لا تخمّن ولا تفترض.
- السبب (reason) جملة عربية قصيرة واحدة تذكر الدليل من المحادثة.
- أعِد حكمًا لكل إشارة في القائمة، مستخدمًا رمزها كما هو (m1، m2، …).

أخرِج JSON فقط بهذا الشكل، دون أي نص أو أسوار markdown:
{"mentions":[{"id":"m1","verdict":"right","reason":"..."}],"missed":[{"span":"النص الحرفي من المحادثة","reason":"..."}]}

قيم verdict المسموحة: ${VERDICTS.join(' | ')}`;

/** Short alias the model sees for mention i (0-based). UUIDs are easy for a model to garble; m1..mN are not. */
const alias = (i: number): string => `m${i + 1}`;

/** The user message: the conversation exactly as the extractor saw it, then the numbered mention list. */
export function buildVerifierUserText(input: VerifyInput): string {
  const convo = buildExtractionUserText(input.conversation, input.projectNames ?? []);
  const lines = input.mentions.map((m, i) => {
    const pol = m.on_map === false ? '' : m.polarity === 'exclude' ? ' (لا يريد)' : ' (يريد)';
    return `[${alias(i)}] قال: «${m.mention_span}» — وضع النظام على الخريطة: ${m.placed}${pol}`;
  });
  const list = lines.length ? lines.join('\n') : '(لم يستخرج النظام أي إشارة)';
  return `${convo}\n\nما استخرجه النظام ووضعه على الخريطة:\n${list}`;
}

function overallOf(mentions: VerifierResult['mentions'], missed: VerifierResult['missed']): 'agree' | 'doubt' {
  return mentions.some((m) => m.verdict !== 'right') || missed.length > 0 ? 'doubt' : 'agree';
}

const clip = (s: string, n = 500): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Parse + repair the model's JSON. Returns null when the output is not JSON at
 * all (the caller treats that as a failed call, never as agreement).
 *   - an unknown verdict → 'unsure'
 *   - an id that is not in the list → dropped
 *   - a listed mention the model omitted → 'unsure' with reason «لم يُراجَع»
 *   - a mention the system left OFF the map (`offMap`): its verdict is about
 *     that decision. «not a preference» / «not a place» there AGREES with the
 *     system (it also said so) → 'right'; «wrong polarity» there can only mean
 *     "the customer did want / refuse it" → 'wrong_place' (it belongs on the map).
 *     Measured on calib-002 (2026-09-27): 21 of 39 off-map mentions came back
 *     «not a preference» while the system had said exactly that.
 * `evidenceIds[i]` is the mention the model saw as m{i+1}; the raw evidence id
 * is accepted too.
 */
export function parseVerifierOutput(
  raw: string,
  evidenceIds: readonly string[],
  offMap: ReadonlySet<string> = new Set(),
): Omit<VerifierResult, 'status' | 'model'> | null {
  let text = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text.slice(a, b + 1));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch (err) {
    // Only a JSON SyntaxError is expected here; it means "not parseable", which the
    // caller turns into a failed call (status 'error'), never into agreement.
    if (err instanceof SyntaxError) return null;
    throw err;
  }

  const byKey = new Map<string, string>();
  evidenceIds.forEach((id, i) => { byKey.set(alias(i), id); byKey.set(id, id); });

  const got = new Map<string, { verdict: VerifierVerdict; reason: string }>();
  for (const m of Array.isArray(obj.mentions) ? obj.mentions : []) {
    if (m == null || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    const key = typeof o.id === 'string' ? o.id.trim() : typeof o.evidence_id === 'string' ? o.evidence_id.trim() : '';
    const evId = byKey.get(key);
    if (!evId || got.has(evId)) continue; // unknown id → dropped; duplicate → first wins
    let verdict: VerifierVerdict = typeof o.verdict === 'string' && (VERDICTS as readonly string[]).includes(o.verdict.trim())
      ? (o.verdict.trim() as VerifierVerdict) : 'unsure';
    if (offMap.has(evId)) {
      if (verdict === 'not_a_preference' || verdict === 'not_a_place') verdict = 'right';
      else if (verdict === 'wrong_polarity') verdict = 'wrong_place';
    }
    const reason = typeof o.reason === 'string' ? clip(o.reason.trim()) : '';
    got.set(evId, { verdict, reason });
  }
  const mentions = evidenceIds.map((id) => ({ evidence_id: id, ...(got.get(id) ?? { verdict: 'unsure' as const, reason: 'لم يُراجَع' }) }));

  const missed: VerifierResult['missed'] = [];
  for (const m of Array.isArray(obj.missed) ? obj.missed : []) {
    if (m == null || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    const span = typeof o.span === 'string' ? o.span.trim() : '';
    if (!span) continue;
    missed.push({ span: clip(span, 200), reason: typeof o.reason === 'string' ? clip(o.reason.trim()) : '' });
  }
  return { overall: overallOf(mentions, missed), mentions, missed };
}

async function claudeVerify(userText: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = trackedAnthropic(new Anthropic({ apiKey }), {
    area: 'sales', callSite: 'api/_lib/geoPreference/verifier', operation: 'verify',
    isFallback: llmRoutingEnabled(), fallbackFrom: llmRoutingEnabled() ? 'deepseek' : null,
  });
  const resp = await client.messages.create({
    model: CLAUDE_FALLBACK_MODEL,
    max_tokens: 3000,
    system: VERIFY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
  });
  return resp.content
    .filter((blk): blk is Anthropic.TextBlock => blk.type === 'text')
    .map((blk) => blk.text)
    .join('');
}

const errorResult = (error: string): VerifierResult => ({ status: 'error', overall: 'unknown', mentions: [], missed: [], error });

/**
 * Check one conversation's map. NEVER throws, NEVER reports 'agree' on a failure.
 */
export async function verifyConversationMap(input: VerifyInput): Promise<VerifierResult> {
  const conversation = input.conversation;
  if (!conversation || !Array.isArray(conversation.turns) || conversation.turns.length === 0) {
    return errorResult('empty conversation — nothing to check against');
  }
  const evidenceIds = input.mentions.map((m) => m.evidence_id);
  const offMap = new Set(input.mentions.filter((m) => m.on_map === false).map((m) => m.evidence_id));

  if (extractionStubEnabled()) {
    return {
      status: 'ok', overall: 'agree', missed: [], model: 'stub',
      mentions: evidenceIds.map((id) => ({ evidence_id: id, verdict: 'right', reason: 'stub' })),
    };
  }

  const userText = buildVerifierUserText(input);
  const errors: string[] = [];

  // 1. DeepSeek primary.
  if (llmRoutingEnabled()) {
    try {
      const raw = await llmText({
        track: { area: 'sales', callSite: 'api/_lib/geoPreference/verifier', operation: 'verify' },
        system: VERIFY_SYSTEM_PROMPT,
        user: userText,
        maxTokens: 3000,
        temperature: 0,
        json: true,
      });
      const parsed = parseVerifierOutput(raw, evidenceIds, offMap);
      if (!parsed) throw new Error('DeepSeek returned output that is not JSON');
      return { status: 'ok', ...parsed, model: DEEPSEEK_MODEL_LABEL };
    } catch (err) {
      errors.push(`deepseek: ${err instanceof Error ? err.message : String(err)}`);
      logLlmFallback('geoPreference/verify', err);
    }
  }

  // 2. Claude fallback.
  try {
    const raw = await claudeVerify(userText);
    const parsed = parseVerifierOutput(raw, evidenceIds, offMap);
    if (!parsed) throw new Error('Claude returned output that is not JSON');
    return { status: 'ok', ...parsed, model: CLAUDE_FALLBACK_MODEL };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`claude: ${msg}`);
    console.error('[geoPreference/verify] every provider failed:', errors.join(' | '));
    return errorResult(errors.join(' | '));
  }
}
