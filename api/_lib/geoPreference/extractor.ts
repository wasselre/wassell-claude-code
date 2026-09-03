/**
 * Stage-A geo-preference EXTRACTOR (v7).
 *
 * Messy Arabic chat / call text ⇒ per-utterance {@link Evidence} + a typed
 * {@link EvidenceRelation} DAG, exactly as the v7 ontology defines them. This is
 * the FIRST stage of the Geography Understanding ability: the AI interprets what
 * the customer *meant* (one Evidence record per location mention, plus relations
 * between mentions). Everything downstream is deterministic — the anchor→geometry
 * resolver (`resolver.ts`), the Boolean compiler (`compiler.ts`), the independent
 * reference interpreter, the confidence gate.
 *
 * WHAT THIS MODULE DOES NOT DO (hard boundaries, encoded in the prompt too):
 *  - It never resolves geometry, picks a namesake, or emits coordinates. It emits
 *    referent TOKENS (typed {@link AnchorToken}) + relations only.
 *  - It never writes to a client record. It returns a value; callers decide.
 *
 * ROUTING: reuses the repo's text-LLM routing (`textLlm.ts`) — DeepSeek primary
 * (`llmText`), Claude the automatic fallback, `TEXT_LLM_PROVIDER=anthropic` the
 * kill switch. A STUB mode (env `WA_EXTRACT_STUB=1`, or no LLM key at all)
 * returns canned deterministic output so the module is testable fully offline.
 *
 * ROBUSTNESS: the LLM's JSON is validated + repaired against the ontology enums.
 * A mention that cannot be made valid is DROPPED rather than emitted as a broken
 * shape; a relation that references a dropped mention (or is otherwise malformed)
 * is dropped too. The function never throws for a model-output problem.
 *
 * HONESTY: extraction ACCURACY is gold-gated elsewhere and is NOT claimed here.
 * What this module guarantees is (a) well-formed ontology output and (b) that the
 * grammar-independence guardrails are stated to the model and enforced on parse.
 */

import Anthropic from '@anthropic-ai/sdk';
import { llmText, llmRoutingEnabled, logLlmFallback } from '../textLlm.js';
import { estimateExtractionTokens, type LlmBudget } from './llmBudget.js';
import type {
  Evidence,
  EvidenceRelation,
  AnchorToken,
  AnchorType,
  Speaker,
  PreferenceHolder,
  HolderRole,
  QuotedSpeaker,
  DialogueAct,
  Conditionality,
  TemporalReference,
  PreferenceApplicability,
  PreferenceRole,
  Commitment,
  HardnessEvidence,
  Modality,
  RelationKind,
  RelationMemberRef,
} from './ontology.js';

export const EXTRACTOR_VERSION = 'geo-extract/v7';
const CLAUDE_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

// ────────────────────────────────────────────────────────────────────────────
// Input shape — a speaker-labelled conversation (chat messages or call segments).
// ────────────────────────────────────────────────────────────────────────────
export interface ConversationTurn {
  speaker: Speaker;
  text: string;
  /** message_id (chat) or transcript_segment id (call). */
  ref?: string;
  /** ISO timestamp. */
  timestamp?: string;
}

export interface Conversation {
  channel: 'chat' | 'call';
  turns: ConversationTurn[];
  /** optional conversation id, only used for source.ref fallbacks. */
  id?: string;
}

export interface ExtractResult {
  evidence: Evidence[];
  relations: EvidenceRelation[];
}

export interface ExtractOptions {
  /**
   * Optional cost + rate-limit budget for the LLM path. When supplied, EVERY real
   * provider call is gated through it: a per-run call/token ceiling hit throws
   * `LlmBudgetExceededError` (so a backfill loop halts loudly), and concurrency +
   * rate limits are enforced. Stub mode never touches the budget. Omit it for the
   * live single-extraction path (a lone call has nothing to throttle).
   */
  budget?: LlmBudget;
}

// ────────────────────────────────────────────────────────────────────────────
// Runtime enum sets — the ontology exports TYPES only; we need the value lists to
// validate + repair. Keep these EXACTLY in sync with ontology.ts.
// ────────────────────────────────────────────────────────────────────────────
const ANCHOR_TYPES: readonly AnchorType[] = [
  'district', 'city', 'region', 'town', 'direction', 'road', 'landmark', 'pin', 'relative_ref',
];
const SPEAKERS: readonly Speaker[] = ['client', 'agent', 'unknown'];
const PREFERENCE_HOLDERS: readonly PreferenceHolder[] = ['client', 'other_person', 'unknown'];
const HOLDER_ROLES: readonly HolderRole[] = [
  'buyer', 'co_decision_maker', 'beneficiary_occupant', 'influencer', 'unrelated_third_party', 'unknown',
];
const QUOTED_SPEAKERS: readonly QuotedSpeaker[] = ['client', 'agent', 'third_party', 'none', 'unknown'];
const DIALOGUE_ACTS: readonly DialogueAct[] = ['statement', 'question', 'request', 'answer'];
const CONDITIONALITIES: readonly Conditionality[] = ['asserted', 'hypothetical', 'conditional', 'unknown'];
const TEMPORAL_REFS: readonly TemporalReference[] = ['present', 'past', 'future', 'none_explicit'];
const APPLICABILITIES: readonly PreferenceApplicability[] = ['active', 'exploratory', 'counterfactual', 'unclear'];
const PREFERENCE_ROLES: readonly PreferenceRole[] = ['positive', 'negative', 'exploratory', 'none'];
const COMMITMENTS: readonly Commitment[] = ['required', 'preferred', 'acceptable', 'considered', 'unknown'];
const HARDNESS: readonly HardnessEvidence[] = ['explicit_force', 'implied', 'none'];
const MODALITIES: readonly Modality[] = ['explicit', 'inferred'];
const RELATION_KINDS: readonly RelationKind[] = [
  'any_of', 'all_of', 'ranked_alternative', 'exception', 'comparison',
];

function pick<T extends string>(allowed: readonly T[], v: unknown, fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
/** Same as pick, but returns null (⇒ drop the mention) when the value is invalid. */
function pickStrict<T extends string>(allowed: readonly T[], v: unknown): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

// ────────────────────────────────────────────────────────────────────────────
// The prompt. The GUARDRAILS below are the whole point of Stage A — they force
// the model to separate GRAMMAR (act / conditionality / tense) from SEMANTICS
// (whether the preference is live). Written bilingually: rules the model must
// reason with are in Arabic (the input is Arabic); the JSON contract in English.
// ────────────────────────────────────────────────────────────────────────────
export const EXTRACT_SYSTEM_PROMPT = `أنت محلّل دلالي لفريق عقاري سعودي. تقرأ محادثة (شات أو مكالمة) مُصنّفة حسب المتحدث (العميل/المندوب)، وتُخرِج — لكل *إشارة إلى موقع جغرافي* ذكرها العميل أو نُقلت عنه — سجلّ Evidence كاملًا وفق النظام أدناه، بالإضافة إلى علاقات EvidenceRelation المكتوبة بين الإشارات.

مبدأ حاكم — القواعد النحوية لا تُقرّر المعنى أبدًا (grammar-independence):
- السؤال قد يكون تفضيلًا إيجابيًا. «عندكم فلل بالنرجس؟» = preference_role='positive' للنرجس، وليس 'none'. لا تجعل صيغة السؤال (dialogue_act='question') تُلغي التفضيل.
- الشرط لا يعني «غير فعّال». «إذا مو شمال الرياض ما يناسبني» شرطٌ لكنه تفضيل *فعّال وصارم*: conditionality='conditional' لكن preference_applicability='active'، hardness_evidence='explicit_force'، commitment='required'.
- غياب الزمن الصريح لا يعني أن التفضيل غير فعّال. temporal_reference='none_explicit' لا يفرض preference_applicability إلا 'active' إن كان المعنى تفضيلًا قائمًا.
- الإجابة المجرّدة على سؤال «أي حي؟» تُسجَّل commitment='acceptable' افتراضيًا (ذكرها = مقبولة على الأقل)، لا تتركها 'unknown'.
- الاستكشاف الحقيقي فقط (يتخيّل/يفترض ولا يلتزم) هو preference_applicability='exploratory' أو 'counterfactual'.

مبدأ حاكم — العائلة ليست بالضرورة صاحبة القرار (holder ≠ speaker ≠ decision-maker):
- preference_holder: صاحب التفضيل نفسه (client / other_person / unknown)، منفصلٌ عمّن نطق به.
- holder_role: سلطة الشراء — buyer / co_decision_maker / beneficiary_occupant / influencer / unrelated_third_party / unknown. «زوجتي تبي شمال» غالبًا co_decision_maker أو influencer، وليست buyer تلقائيًا. «أمي بتسكن معنا وتفضّل كذا» = beneficiary_occupant. طرفٌ لا علاقة له = unrelated_third_party.
- quoted_speaker: إن كان الكلام منقولًا (client / agent / third_party / none).

مبدأ حاكم — أنت تُخرِج رموز المرجع + العلاقات فقط:
- لا تحلّ الإحداثيات، لا تختار «أي حي باسم كذا»، لا تُخمّن جغرافيا. أخرِج anchors كرموز typed فقط.
- كل anchor: { anchor_type, span (النص الحرفي كما قاله), normalized_token (بعد طيّ ة→ه، ى→ي، حذف «حي» والتطويل), role_in_relation? }.
- anchor_type ∈ [district, city, region, town, direction, road, landmark, pin, relative_ref].

العلاقات (EvidenceRelation) بين الإشارات:
- any_of: بدائل «أو» متكافئة. all_of: شروط «و» مجتمعة. ranked_alternative: بدائل مرتّبة (الأفضل أولًا في ordering). exception: استثناء من هدفٍ (target). comparison: مقارنة بين موقعين (مثل «المهدية أفضل من الجبيلة» أو طرحهما للمقارنة).
- أعضاء العلاقة RelationMemberRef: { type:'evidence'|'relation', id }. استخدم id سجلّات Evidence التي أنشأتها.

أخرِج JSON فقط بهذا الشكل، دون أي نص أو أسوار markdown:
{
  "evidence": [
    {
      "id": "e1",
      "mention_span": "النص الحرفي للإشارة",
      "anchors": [ { "anchor_type": "district", "span": "النرجس", "normalized_token": "النرجس", "role_in_relation": "" } ],
      "speaker": "client",
      "preference_holder": "client",
      "holder_role": "buyer",
      "quoted_speaker": "none",
      "dialogue_act": "question",
      "conditionality": "asserted",
      "temporal_reference": "none_explicit",
      "preference_applicability": "active",
      "preference_role": "positive",
      "commitment": "acceptable",
      "hardness_evidence": "none",
      "modality": "explicit"
    }
  ],
  "relations": [
    { "id": "r1", "relation": "comparison", "members": [ {"type":"evidence","id":"e2"}, {"type":"evidence","id":"e3"} ], "ordering": [], "source_span": "النص", "explicit_or_inferred": "explicit" }
  ]
}

قِيَم مسموحة (استخدمها حرفيًا):
- speaker: ${SPEAKERS.join(' | ')}
- preference_holder: ${PREFERENCE_HOLDERS.join(' | ')}
- holder_role: ${HOLDER_ROLES.join(' | ')}
- quoted_speaker: ${QUOTED_SPEAKERS.join(' | ')}
- dialogue_act: ${DIALOGUE_ACTS.join(' | ')}
- conditionality: ${CONDITIONALITIES.join(' | ')}
- temporal_reference: ${TEMPORAL_REFS.join(' | ')}
- preference_applicability: ${APPLICABILITIES.join(' | ')}
- preference_role: ${PREFERENCE_ROLES.join(' | ')}
- commitment: ${COMMITMENTS.join(' | ')}
- hardness_evidence: ${HARDNESS.join(' | ')}
- modality: ${MODALITIES.join(' | ')}
- relation: ${RELATION_KINDS.join(' | ')}
- anchor_type: ${ANCHOR_TYPES.join(' | ')}

إن لم يذكر العميل أي موقع جغرافي، أعِد {"evidence": [], "relations": []}.`;

// ────────────────────────────────────────────────────────────────────────────
// Stub mode — deterministic, offline. Token-driven so it stays input-sensitive
// (empty conversation ⇒ empty output) while never calling an LLM. It demonstrates
// the grammar-independence guardrails on a fixed set of known referents.
// ────────────────────────────────────────────────────────────────────────────
export function extractionStubEnabled(): boolean {
  if ((process.env.WA_EXTRACT_STUB ?? '').trim() === '1') return true;
  // No provider available at all ⇒ fall back to stub so callers still get output.
  return !llmRoutingEnabled() && !process.env.ANTHROPIC_API_KEY?.trim();
}

interface StubToken {
  token: string;
  build: (idx: number, src: Evidence['source']) => Evidence;
  /** relation tag so we can wire relations only among tokens actually present. */
  tag?: 'primary' | 'comparison_alt';
}

const STUB_TOKENS: StubToken[] = [
  {
    // Question form — the guardrail case: a question is STILL a positive preference.
    token: 'النرجس',
    build: (idx, source) => baseEvidence(idx, 'عندكم فلل بالنرجس؟', source, {
      anchors: [anchor('district', 'النرجس')],
      dialogue_act: 'question',
      conditionality: 'asserted',
      temporal_reference: 'none_explicit',
      preference_applicability: 'active',
      preference_role: 'positive',
      commitment: 'acceptable', // bare interest ⇒ acceptable, not unknown
      hardness_evidence: 'none',
    }),
  },
  {
    // Primary choice.
    token: 'المهدية',
    tag: 'primary',
    build: (idx, source) => baseEvidence(idx, 'أبي المهدية', source, {
      anchors: [anchor('district', 'المهدية')],
      dialogue_act: 'statement',
      conditionality: 'asserted',
      temporal_reference: 'present',
      preference_applicability: 'active',
      preference_role: 'positive',
      commitment: 'preferred',
      hardness_evidence: 'implied',
    }),
  },
  {
    // Compared-against alternative.
    token: 'الجبيلة',
    tag: 'comparison_alt',
    build: (idx, source) => baseEvidence(idx, 'أو الجبيلة', source, {
      anchors: [anchor('district', 'الجبيلة', 'alternative')],
      dialogue_act: 'statement',
      conditionality: 'asserted',
      temporal_reference: 'present',
      preference_applicability: 'active',
      preference_role: 'positive',
      commitment: 'considered',
      hardness_evidence: 'none',
    }),
  },
  {
    // Conditional-active-HARD — grammar (conditional) ≠ semantics (active + hard).
    token: 'شمال الرياض',
    build: (idx, source) => baseEvidence(idx, 'إذا مو شمال الرياض ما يناسبني', source, {
      anchors: [anchor('direction', 'شمال الرياض', undefined, 'شمال الرياض'), anchor('city', 'الرياض')],
      dialogue_act: 'statement',
      conditionality: 'conditional',
      temporal_reference: 'none_explicit',
      preference_applicability: 'active',   // <-- the guardrail: conditional but ACTIVE
      preference_role: 'positive',
      commitment: 'required',
      hardness_evidence: 'explicit_force',  // «ما يناسبني» = hard constraint
    }),
  },
];

function anchor(anchor_type: AnchorType, span: string, role_in_relation?: string, normalized?: string): AnchorToken {
  return {
    anchor_type,
    span,
    normalized_token: normalized ?? normalizeToken(span),
    ...(role_in_relation ? { role_in_relation } : {}),
  };
}

/** Minimal fold matching the resolver's canonicalPlaceName (ة→ه, ى→ي, strip حي/tatweel). */
export function normalizeToken(s: string): string {
  return String(s ?? '')
    .replace(/^\s*حي\s+/, '')
    .replace(/ـ/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .trim();
}

function baseEvidence(
  idx: number,
  mention_span: string,
  source: Evidence['source'],
  over: Partial<Evidence> & { anchors: AnchorToken[] },
): Evidence {
  return {
    id: `stub-e${idx}`,
    mention_span,
    anchors: over.anchors,
    speaker: over.speaker ?? 'client',
    preference_holder: over.preference_holder ?? 'client',
    holder_role: over.holder_role ?? 'buyer',
    quoted_speaker: over.quoted_speaker ?? 'none',
    dialogue_act: over.dialogue_act ?? 'statement',
    conditionality: over.conditionality ?? 'asserted',
    temporal_reference: over.temporal_reference ?? 'none_explicit',
    preference_applicability: over.preference_applicability ?? 'active',
    preference_role: over.preference_role ?? 'positive',
    commitment: over.commitment ?? 'acceptable',
    hardness_evidence: over.hardness_evidence ?? 'none',
    modality: over.modality ?? 'explicit',
    source,
    extraction_version: EXTRACTOR_VERSION,
  };
}

function stubExtract(conversation: Conversation): ExtractResult {
  const text = conversation.turns.map((t) => t.text).join('\n');
  const firstRef = conversation.turns.find((t) => t.ref)?.ref ?? conversation.id ?? 'stub';
  const firstTs = conversation.turns.find((t) => t.timestamp)?.timestamp ?? '';
  const source: Evidence['source'] = { channel: conversation.channel, ref: firstRef, timestamp: firstTs };

  const evidence: Evidence[] = [];
  const byTag: Partial<Record<'primary' | 'comparison_alt', string>> = {};
  let idx = 1;
  for (const st of STUB_TOKENS) {
    if (!text.includes(st.token)) continue;
    const e = st.build(idx, source);
    evidence.push(e);
    if (st.tag) byTag[st.tag] = e.id;
    idx += 1;
  }

  const relations: EvidenceRelation[] = [];
  if (byTag.primary && byTag.comparison_alt) {
    relations.push({
      id: 'stub-r1',
      relation: 'comparison',
      members: [
        { type: 'evidence', id: byTag.primary },
        { type: 'evidence', id: byTag.comparison_alt },
      ],
      ordering: [
        { type: 'evidence', id: byTag.primary },
        { type: 'evidence', id: byTag.comparison_alt },
      ],
      source_span: 'المهدية أو الجبيلة',
      explicit_or_inferred: 'explicit',
    });
  }

  return { evidence, relations };
}

// ────────────────────────────────────────────────────────────────────────────
// Validate + repair the LLM's JSON against the ontology. Malformed mentions are
// DROPPED; never emit a broken shape.
// ────────────────────────────────────────────────────────────────────────────
function repairAnchors(raw: unknown): AnchorToken[] {
  if (!Array.isArray(raw)) return [];
  const out: AnchorToken[] = [];
  for (const a of raw) {
    if (a == null || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    const anchor_type = pickStrict(ANCHOR_TYPES, o.anchor_type);
    const span = typeof o.span === 'string' ? o.span.trim() : '';
    if (!anchor_type || !span) continue; // an anchor needs a type + a surface span
    const normalized_token =
      typeof o.normalized_token === 'string' && o.normalized_token.trim()
        ? o.normalized_token.trim()
        : normalizeToken(span);
    const role = typeof o.role_in_relation === 'string' && o.role_in_relation.trim()
      ? o.role_in_relation.trim()
      : undefined;
    out.push({ anchor_type, span, normalized_token, ...(role ? { role_in_relation: role } : {}) });
  }
  return out;
}

function repairEvidence(raw: unknown, index: number, source: Evidence['source']): Evidence | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const anchors = repairAnchors(o.anchors);
  const firstAnchor = anchors[0];
  if (!firstAnchor) return null; // a location mention with no anchors is not usable

  const mention_span = typeof o.mention_span === 'string' && o.mention_span.trim()
    ? o.mention_span.trim()
    : firstAnchor.span;

  const preference_role = pickStrict(PREFERENCE_ROLES, o.preference_role);
  if (!preference_role) return null; // core semantic field — unrepairable ⇒ drop

  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `e${index + 1}`;

  return {
    id,
    mention_span,
    anchors,
    speaker: pick(SPEAKERS, o.speaker, 'unknown'),
    preference_holder: pick(PREFERENCE_HOLDERS, o.preference_holder, 'client'),
    holder_role: pick(HOLDER_ROLES, o.holder_role, 'unknown'),
    quoted_speaker: pick(QUOTED_SPEAKERS, o.quoted_speaker, 'none'),
    dialogue_act: pick(DIALOGUE_ACTS, o.dialogue_act, 'statement'),
    conditionality: pick(CONDITIONALITIES, o.conditionality, 'unknown'),
    temporal_reference: pick(TEMPORAL_REFS, o.temporal_reference, 'none_explicit'),
    preference_applicability: pick(APPLICABILITIES, o.preference_applicability, 'unclear'),
    preference_role,
    commitment: pick(COMMITMENTS, o.commitment, 'unknown'),
    hardness_evidence: pick(HARDNESS, o.hardness_evidence, 'none'),
    modality: pick(MODALITIES, o.modality, 'inferred'),
    source,
    extraction_version: EXTRACTOR_VERSION,
  };
}

function repairMember(raw: unknown, validIds: Set<string>): RelationMemberRef | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const type = o.type === 'evidence' || o.type === 'relation' ? o.type : null;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null;
  if (!type || !id) return null;
  // We only guarantee evidence membership integrity here (relation-to-relation
  // nesting is validated structurally by the compiler); drop evidence refs that
  // point at a dropped mention.
  if (type === 'evidence' && !validIds.has(id)) return null;
  return { type, id };
}

function repairRelations(raw: unknown, validIds: Set<string>): EvidenceRelation[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceRelation[] = [];
  let n = 1;
  for (const r of raw) {
    if (r == null || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const relation = pickStrict(RELATION_KINDS, o.relation);
    if (!relation) continue;
    const members = Array.isArray(o.members)
      ? o.members.map((m) => repairMember(m, validIds)).filter((m): m is RelationMemberRef => m !== null)
      : [];
    if (members.length < 2) continue; // a relation needs at least two surviving members
    const ordering = Array.isArray(o.ordering)
      ? o.ordering.map((m) => repairMember(m, validIds)).filter((m): m is RelationMemberRef => m !== null)
      : undefined;
    const target = repairMember(o.target, validIds) ?? undefined;
    out.push({
      id: typeof o.id === 'string' && o.id.trim() ? o.id.trim() : `r${n}`,
      relation,
      members,
      ...(ordering && ordering.length ? { ordering } : {}),
      ...(target ? { target } : {}),
      source_span: typeof o.source_span === 'string' ? o.source_span.trim() : '',
      explicit_or_inferred: o.explicit_or_inferred === 'inferred' ? 'inferred' : 'explicit',
    });
    n += 1;
  }
  return out;
}

/** Parse raw model text ⇒ validated ExtractResult. Never throws. */
export function parseExtractorOutput(raw: string, source: Evidence['source']): ExtractResult {
  let text = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a === -1 || b <= a) return { evidence: [], relations: [] };

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>;
  } catch {
    return { evidence: [], relations: [] };
  }

  const rawEvidence = Array.isArray(obj.evidence) ? obj.evidence : [];
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  rawEvidence.forEach((e, i) => {
    const rep = repairEvidence(e, i, source);
    if (!rep) return;
    // Guarantee unique ids so relation refs are unambiguous.
    let id = rep.id;
    let k = 1;
    while (seen.has(id)) id = `${rep.id}_${k++}`;
    rep.id = id;
    seen.add(id);
    evidence.push(rep);
  });

  const relations = repairRelations(obj.relations, seen);
  return { evidence, relations };
}

// ────────────────────────────────────────────────────────────────────────────
// LLM plumbing.
// ────────────────────────────────────────────────────────────────────────────
function renderConversation(conversation: Conversation): string {
  return conversation.turns
    .map((t) => {
      const who = t.speaker === 'client' ? 'العميل' : t.speaker === 'agent' ? 'المندوب' : 'غير معروف';
      return `${who}: ${t.text}`;
    })
    .join('\n');
}

function conversationSource(conversation: Conversation): Evidence['source'] {
  const firstRef = conversation.turns.find((t) => t.ref)?.ref ?? conversation.id ?? 'unknown';
  const firstTs = conversation.turns.find((t) => t.timestamp)?.timestamp ?? '';
  return { channel: conversation.channel, ref: firstRef, timestamp: firstTs };
}

async function claudeExtract(userText: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: CLAUDE_FALLBACK_MODEL,
    max_tokens: 4000,
    system: EXTRACT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
  });
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Stage-A extraction: conversation ⇒ Evidence[] + EvidenceRelation[].
 *
 * Order of operations:
 *   1. STUB mode (env or no provider) ⇒ deterministic canned output.
 *   2. DeepSeek primary (via textLlm routing) when enabled.
 *   3. Claude fallback when DeepSeek is off/failing and ANTHROPIC_API_KEY is set.
 * The model text is validated + repaired against the ontology before returning.
 */
export async function extract(
  conversation: Conversation,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  if (!conversation || !Array.isArray(conversation.turns) || conversation.turns.length === 0) {
    return { evidence: [], relations: [] };
  }

  if (extractionStubEnabled()) {
    return stubExtract(conversation);
  }

  const source = conversationSource(conversation);
  const userText = `المحادثة (${conversation.channel === 'call' ? 'مكالمة' : 'شات'}):\n${renderConversation(conversation)}`;

  // Per-call token estimate for the budget. Over-estimates on purpose (see
  // estimateExtractionTokens) so the cost ceiling errs toward stopping early.
  const budget = opts.budget;
  const estTokens = estimateExtractionTokens(EXTRACT_SYSTEM_PROMPT.length, userText.length);

  // A ceiling hit throws LlmBudgetExceededError from `begin()` BEFORE the swallowing
  // try/catch, so it propagates out of extract() — a backfill can stop on it. Provider
  // errors inside the try still fall through to the next provider (unchanged behaviour).

  // 1. DeepSeek primary.
  if (llmRoutingEnabled()) {
    const release = budget ? await budget.begin(estTokens) : null;
    try {
      const raw = await llmText({
        system: EXTRACT_SYSTEM_PROMPT,
        user: userText,
        maxTokens: 4000,
        temperature: 0,
        json: true,
      });
      return parseExtractorOutput(raw, source);
    } catch (err) {
      logLlmFallback('geoPreference/extract', err);
    } finally {
      release?.();
    }
  }

  // 2. Claude fallback.
  const releaseFallback = budget ? await budget.begin(estTokens) : null;
  try {
    const raw = await claudeExtract(userText);
    return parseExtractorOutput(raw, source);
  } catch (err) {
    console.error('[geoPreference/extract] Claude fallback failed:', err instanceof Error ? err.message : String(err));
    // No provider succeeded — return well-formed empty rather than throwing.
    return { evidence: [], relations: [] };
  } finally {
    releaseFallback?.();
  }
}
