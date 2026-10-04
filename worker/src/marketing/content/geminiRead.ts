// ============================================================================
// Gemini reads a competitor post and decides which project it promotes — the
// job the Claude runner did on the subscription lane until 2026-10-04.
//
//   readPostWithGemini  ONE call with the post's media (video, or every image)
//                       + caption + transcript + the short list of candidate
//                       projects → on-screen text per media item, the project
//                       pick with a verbatim quote, and the structured fields.
//   decidePostWithGemini  text-only call over stored evidence (no media) — used
//                       when the short list changes after the read (a project
//                       named only on screen) and by the re-check that runs
//                       when a project is added or renamed.
//
// Chosen by two blind 60-post tests on 2026-10-04: against the runner, Gemini
// read image text as accurately (9.4 vs 9.4), covered more (9.8 vs 9.5),
// invented nothing (0 vs 1) and was acceptable on content type more often
// (17 vs 11 of 23 disputed); against Kimi K3 it read video text better (judged
// better 18 vs 6, invented 0 vs 6) at about a tenth of the price.
//
// Every call is metered in ai_usage with its exact cost (implicit-cache
// discount included), success or failure. The decision rules below are a COPY
// of the "Critical attribution rules" and "offer" sections of
// .claude/skills/content-enrichment/SKILL.md — change both together.
// ============================================================================
import { readFile } from 'node:fs/promises';
import { flashCostUsd, geminiPost, type GeminiUsage } from '../../ai/providers/geminiHttp.js';
import { recordAiUsage } from '../../lib/aiUsage.js';
import { deleteFile, uploadFile } from '../cv/gemini/geminiVideo.js';
import type { EnrichAnswer, EnrichCandidate } from './enrichmentValidate.js';

export const READER_MODEL = 'gemini-3.8-flash';
/** Stored as mkt_content_enrichment.rule_version for Gemini decisions. */
export const GEMINI_RULE_VERSION = 'enrich-gemini-v1';
const INLINE_MAX_BYTES = 18_000_000;

export const ENRICH_RULES = `### Critical attribution rules
- The company's own name is NEVER project evidence. brand_tokens lists the publisher's name words and account handles. A post that only carries the brand (logo, tagline, a slogan with the company name) is -1, even when a candidate's name starts with that brand word.
- A sibling is not a candidate. If the post names a project in sibling_projects (or any other project) that is NOT in candidates, return -1 and put that name in mentioned_projects. Never map one project onto another because they share a word.
- A district is not a project. A place name counts only inside the project's actual name.
- Weak candidates (strength "word") need a concrete reference: choose the project only when the evidence carries the project's actual name/number or a unit/price/offer explicitly tied to it — and quote it.
- An advertising slogan that happens to contain a project-like phrase is not a project reference.
- Choose primary_project_index ONLY from the candidate list. If evidence doesn't clearly point to one candidate, return -1.
- attribution_locked true means a human already fixed this post's project. Still fill the structured fields; return -1 with an empty quote.
- Do NOT invent prices, offers, or districts not present in the evidence.

### What counts as an offer (be strict)
offer is for a commercial incentive the buyer receives: a discount, an installment or payment plan, cashback, a waived or free item, a gift, or a time-limited deal (e.g. «خصم 10%», «تقسيط حتى 60 شهر», «إعفاء من رسوم التسجيل», «دفعة أولى 5%»).
NOT offers: slogans («تملك الفخامة», «حياة برفاه») and sponsorship badges → selling_points; teasers («انتظرونا», «SOON») → selling_points + content_type teaser; features («تحكم ذكي», «مجتمع متكامل») → amenities; «مواقع حيوية» → selling_points.
Most posts contain no offer; an empty offer is the normal answer. financing and payment_plan follow the same rule: a real financing product or instalment structure, not a claim that a project is affordable.

### Fields
content_type: project_launch | offer | walkthrough | testimonial | teaser | brand | event.
is_general_branding: true for national days, sports support, leadership/allegiance, quality certification, company services, or pure brand-value content.
language: ar | en | mixed | none. campaign_message: one line. Use "" / [] when unknown, never invent.`;

const STR = ['objective', 'offer', 'financing', 'payment_plan', 'price', 'location', 'district', 'campaign_message'] as const;
const ARR = ['unit_types', 'amenities', 'selling_points', 'ctas', 'mentioned_projects'] as const;

const decisionProps = {
  primary_project_index: { type: 'integer' },
  evidence_quote: { type: 'string' },
  is_general_branding: { type: 'boolean' },
  content_type: { type: 'string', enum: ['project_launch', 'offer', 'walkthrough', 'testimonial', 'teaser', 'brand', 'event'] },
  language: { type: 'string', enum: ['ar', 'en', 'mixed', 'none'] },
  ...Object.fromEntries(STR.map((f) => [f, { type: 'string' }])),
  ...Object.fromEntries(ARR.map((f) => [f, { type: 'array', items: { type: 'string' } }])),
};
const decisionRequired = ['primary_project_index', 'evidence_quote', 'is_general_branding', 'content_type', 'language', ...STR, ...ARR];

export const READ_SCHEMA = {
  type: 'object',
  properties: {
    media_text: {
      type: 'array',
      description: 'One entry per attached media item, in order.',
      items: { type: 'object', properties: { media: { type: 'integer' }, lines: { type: 'array', items: { type: 'string' } } }, required: ['media', 'lines'] },
    },
    ...decisionProps,
  },
  required: ['media_text', ...decisionRequired],
};
export const DECIDE_SCHEMA = { type: 'object', properties: decisionProps, required: decisionRequired };

/** What the model sees about the post, taken from mkt_intelligence_evidence. */
export interface PostContext {
  post_id: string;
  organization_name?: string | null;
  account?: string | null;
  brand_tokens?: string[];
  sibling_projects?: string[];
  attribution_locked?: boolean;
  caption?: string | null;
  transcript?: string | null;
  ocr_text?: string | null;
  candidates?: EnrichCandidate[];
}

function candidateList(c: EnrichCandidate[] | undefined): string {
  const list = (c ?? []).map((x, i) => `  [${i}] ${x.nameAr ?? ''} / ${x.nameEn ?? ''} — strength=${x.strength ?? '?'}, ambiguous=${x.ambiguous === true}`);
  return list.length ? list.join('\n') : '  (none)';
}

function contextBlock(ctx: PostContext): string {
  return `Publisher: ${ctx.organization_name ?? 'unknown'} — account ${ctx.account ?? 'unknown'}. Brand words (NEVER project evidence on their own): ${(ctx.brand_tokens ?? []).join(', ')}
Publisher's other projects (siblings, NOT candidates unless listed below): ${(ctx.sibling_projects ?? []).join(', ') || '(none)'}
attribution_locked: ${ctx.attribution_locked === true}

CAPTION:
${ctx.caption || '(empty)'}

TRANSCRIPT (what is spoken):
${(ctx.transcript || '(none)').slice(0, 16000)}

CANDIDATE PROJECTS — the ONLY projects you may attribute to (pick by index):
${candidateList(ctx.candidates)}`;
}

const DECIDE_STEPS = `- primary_project_index: the index of the candidate this post primarily promotes, or -1 (general branding / no specific project / a project that is not a candidate).
- evidence_quote: REQUIRED when the index is not -1 — a short excerpt (6-200 characters) copied EXACTLY from the caption, the transcript or the on-screen text that names the chosen project concretely (its name, its number, or the name with its unit/price/offer). "" when -1.
- mentioned_projects: projects the post clearly promotes that are NOT candidates, the name as written.
- is_general_branding and the structured fields — only from the evidence, never invented.`;

/** Prompt for the media read. Pure — tested. */
export function buildReadPrompt(ctx: PostContext, mediaLabels: string[]): string {
  return `You are enriching ONE competitor social post for a Saudi real-estate marketing team. Its media is attached in this order: ${mediaLabels.map((l, i) => `[${i + 1}] ${l}`).join(', ')}. Videos have no sound — the transcript below is what is spoken.

${contextBlock(ctx)}

Do this:
- media_text: for EACH attached media item (media = its number above), every line of text visible in it, copied EXACTLY in its original language and spelling. Never translate, correct, complete or invent text; skip what you cannot read; ignore platform interface text (buttons, usernames, the caption bar).
${DECIDE_STEPS}

${ENRICH_RULES}`;
}

/** Prompt for the text-only decision. Pure — tested. */
export function buildDecidePrompt(ctx: PostContext): string {
  return `You are deciding which project ONE competitor social post promotes, for a Saudi real-estate marketing team. You get its words only.

${contextBlock(ctx)}

ON-SCREEN TEXT (read from its images/video):
${(ctx.ocr_text || '(none)').slice(0, 12000)}

Do this:
${DECIDE_STEPS}

${ENRICH_RULES}`;
}

/** A media item to attach. Videos should be the silent copy. */
export type ReadMedia =
  | { kind: 'image'; bytes: Buffer; mime: string; mediaId: string }
  | { kind: 'video'; path: string; bytes: number; mediaId: string };

export interface ReadResult {
  answer: EnrichAnswer;
  mediaText: Array<{ mediaId: string; lines: string[] }>;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  usageMetadata?: GeminiUsage;
  promptFeedback?: { blockReason?: string };
}

function parseObject(text: string): Record<string, unknown> {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let o: unknown;
  try { o = JSON.parse(t); } catch (e) {
    throw new Error(`provider:gemini returned unparseable JSON (${(e as Error).message}): ${t.slice(0, 200)}`);
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('provider:gemini reply is not a JSON object');
  return o as Record<string, unknown>;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** One generateContent call, recorded once in ai_usage with its tokens either way. */
async function generate(parts: unknown[], schema: unknown, operation: string, postId: string, meta: Record<string, unknown>): Promise<{ obj: Record<string, unknown>; costUsd: number; inputTokens: number; outputTokens: number }> {
  const started = Date.now();
  const track = { area: 'competitors' as const, callSite: 'worker/marketing/geminiRead', operation, provider: 'gemini' as const, model: READER_MODEL, entityKind: 'mkt_content_post', entityId: postId };
  let replied = false;
  try {
    const r = await geminiPost<GenerateResponse>(`/v1beta/models/${READER_MODEL}:generateContent`, {
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema, mediaResolution: 'MEDIA_RESOLUTION_HIGH', thinkingConfig: { thinkingLevel: 'low' }, maxOutputTokens: 16384 },
    }, { timeoutMs: 600_000, maxAttempts: 6, baseDelayMs: 5_000 });
    const u = r.usageMetadata ?? {};
    const inputTokens = Number(u.promptTokenCount ?? 0) || 0;
    const outputTokens = (Number(u.candidatesTokenCount ?? 0) || 0) + (Number(u.thoughtsTokenCount ?? 0) || 0);
    const cached = Number(u.cachedContentTokenCount ?? 0) || 0;
    const costUsd = flashCostUsd(inputTokens, outputTokens, cached);
    const cand = r.candidates?.[0];
    const finish = cand?.finishReason ?? 'none';
    let fail: string | null = finish !== 'STOP' ? `provider:gemini finished with ${finish}${r.promptFeedback?.blockReason ? ` (blocked: ${r.promptFeedback.blockReason})` : ''}` : null;
    let obj: Record<string, unknown> | null = null;
    if (!fail) {
      try { obj = parseObject((cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('')); } catch (e) { fail = (e as Error).message; }
    }
    replied = true;
    await recordAiUsage({ ...track, status: fail ? 'error' : 'ok', error: fail, inputTokens: inputTokens - Math.min(cached, inputTokens), cacheReadTokens: cached, outputTokens, costUsd, latencyMs: Date.now() - started, units: 1, unitKind: null, meta });
    if (fail || !obj) throw new Error(fail ?? 'provider:gemini reply was empty');
    return { obj, costUsd, inputTokens, outputTokens };
  } catch (e) {
    if (!replied) await recordAiUsage({ ...track, status: 'error', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started, meta });
    throw e;
  }
}

function toAnswer(postId: string, o: Record<string, unknown>): EnrichAnswer {
  const idx = Number(o.primary_project_index);
  return { ...o, post_id: postId, primary_project_index: Number.isInteger(idx) ? idx : -1 };
}

export async function readPostWithGemini(ctx: PostContext, media: ReadMedia[]): Promise<ReadResult> {
  if (media.length === 0) throw new Error('permanent: readPostWithGemini needs at least one media item');
  const uploaded: string[] = [];
  try {
    const parts: unknown[] = [];
    for (const m of media) {
      if (m.kind === 'image') {
        parts.push({ inline_data: { mime_type: m.mime, data: m.bytes.toString('base64') } });
      } else if (m.bytes <= INLINE_MAX_BYTES) {
        parts.push({ inline_data: { mime_type: 'video/mp4', data: (await readFile(m.path)).toString('base64') } });
      } else {
        const f = await uploadFile(m.path, m.bytes);
        uploaded.push(f.name);
        parts.push({ file_data: { mime_type: 'video/mp4', file_uri: f.uri } });
      }
    }
    const labels = media.map((m) => (m.kind === 'video' ? 'video' : 'image'));
    parts.push({ text: buildReadPrompt({ ...ctx, ocr_text: '' }, labels) });
    const r = await generate(parts, READ_SCHEMA, 'read_post', ctx.post_id, { media: labels.join(','), candidates: ctx.candidates?.length ?? 0 });
    const byIndex = new Map<number, string[]>();
    for (const e of Array.isArray(r.obj.media_text) ? r.obj.media_text : []) {
      const it = e as { media?: unknown; lines?: unknown };
      const n = Number(it.media);
      if (Number.isInteger(n) && n >= 1 && n <= media.length) byIndex.set(n, [...(byIndex.get(n) ?? []), ...strList(it.lines)]);
    }
    const mediaText = media.map((m, i) => ({ mediaId: m.mediaId, lines: (byIndex.get(i + 1) ?? []).map((l) => l.trim()).filter(Boolean) }));
    return { answer: toAnswer(ctx.post_id, r.obj), mediaText, costUsd: r.costUsd, inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  } finally {
    for (const name of uploaded) await deleteFile(name);
  }
}

export async function decidePostWithGemini(ctx: PostContext): Promise<{ answer: EnrichAnswer; costUsd: number }> {
  const r = await generate([{ text: buildDecidePrompt(ctx) }], DECIDE_SCHEMA, 'decide_post', ctx.post_id, { candidates: ctx.candidates?.length ?? 0 });
  return { answer: toAnswer(ctx.post_id, r.obj), costUsd: r.costUsd };
}
