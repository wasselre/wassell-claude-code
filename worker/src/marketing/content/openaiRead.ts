// ============================================================================
// OpenAI (gpt-6-luna) reads a competitor post and decides its project — the
// twin of geminiRead.ts behind mkt_settings `content.reader = 'openai'`.
//
// Same prompt (buildReadPrompt / buildDecidePrompt), same schemas, same
// candidates, and the caller runs the same proof checker on the answer. The
// one difference is video: OpenAI takes no video input, so a video arrives as
// FRAMES_PER_VIDEO still frames in time order (the transcript carries the
// speech). Chosen by a 30-post blind bake-off on 2026-10-06: project pick right
// on 29/30 (Gemini 30/30), screen-text accuracy 7.8 vs Gemini 7.6, 4 invented
// lines vs 26, at $0.0018 per post vs Gemini's $0.0096.
//
// Every call is recorded in ai_usage with its tokens and its cost at the cited
// rate (openaiCostUsd), success or failure.
// ============================================================================
import { openaiChatJson, openaiCostUsd, openaiStrictSchema, type OpenAiUsage } from '../../ai/providers/openaiHttp.js';
import { recordAiUsage } from '../../lib/aiUsage.js';
import { buildDecidePrompt, buildReadPrompt, DECIDE_SCHEMA, READ_SCHEMA, toAnswer, type PostContext, type ReadResult } from './geminiRead.js';
import type { EnrichAnswer } from './enrichmentValidate.js';

export const OPENAI_READER_MODEL = 'gpt-6-luna';
/** Frames sampled from each video (the bake-off used 8). */
export const FRAMES_PER_VIDEO = 8;

const READ_STRICT = openaiStrictSchema(READ_SCHEMA);
const DECIDE_STRICT = openaiStrictSchema(DECIDE_SCHEMA);

/** One media item: an image (one JPEG) or a video (its frames, in time order). */
export interface OpenAiReadMedia { mediaId: string; kind: 'image' | 'video'; jpegs: Buffer[] }

/** The read prompt with every attached picture labelled; a video's frames are labelled as frames of that video. Pure — tested. */
export function buildOpenAiReadPrompt(ctx: PostContext, media: OpenAiReadMedia[]): { prompt: string; owner: number[] } {
  const labels: string[] = [];
  const owner: number[] = []; // picture number (0-based) → media index
  media.forEach((m, mi) => {
    if (m.kind === 'image') { labels.push('image'); owner.push(mi); return; }
    m.jpegs.forEach((_, fi) => { labels.push(`frame ${fi + 1} of ${m.jpegs.length} from video ${mi + 1}`); owner.push(mi); });
  });
  const hasVideo = media.some((m) => m.kind === 'video');
  const prompt = buildReadPrompt(ctx, labels).replace(
    'Videos have no sound — the transcript below is what is spoken.',
    hasVideo
      ? 'A video is shown as still frames sampled evenly in time order (it has no sound; the transcript below is what is spoken). Treat the frames of one video together as that one video.'
      : 'Videos have no sound — the transcript below is what is spoken.',
  );
  return { prompt, owner };
}

function parseObject(text: string): Record<string, unknown> {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let o: unknown;
  try { o = JSON.parse(t); } catch (e) {
    throw new Error(`provider:openai_compat returned unparseable JSON (${(e as Error).message}): ${t.slice(0, 200)}`);
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('provider:openai_compat reply is not a JSON object');
  return o as Record<string, unknown>;
}

/** One structured call, recorded once in ai_usage either way. */
async function call(content: unknown[], schemaName: string, schema: unknown, operation: string, postId: string, meta: Record<string, unknown>): Promise<{ obj: Record<string, unknown>; costUsd: number; usage: OpenAiUsage }> {
  const started = Date.now();
  const track = { area: 'competitors' as const, callSite: 'worker/marketing/openaiRead', operation, provider: 'openai' as const, model: OPENAI_READER_MODEL, entityKind: 'mkt_content_post', entityId: postId };
  try {
    const r = await openaiChatJson(OPENAI_READER_MODEL, content, schemaName, schema);
    const costUsd = openaiCostUsd(OPENAI_READER_MODEL, r.usage) ?? 0;
    let obj: Record<string, unknown> | null = null;
    let fail: string | null = r.finishReason !== 'stop' ? `provider:openai_compat finished with ${r.finishReason}` : null;
    if (!fail) { try { obj = parseObject(r.text); } catch (e) { fail = (e as Error).message; } }
    await recordAiUsage({ ...track, status: fail ? 'error' : 'ok', error: fail, inputTokens: Number(r.usage.prompt_tokens ?? 0), outputTokens: Number(r.usage.completion_tokens ?? 0), costUsd, latencyMs: Date.now() - started, units: 1, unitKind: null, meta });
    if (fail || !obj) throw new Error(fail ?? 'provider:openai_compat reply was empty');
    return { obj, costUsd, usage: r.usage };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A reply that came back was already recorded above; record only a call that never answered.
    if (!/finished with|unparseable JSON|not a JSON object|reply was empty/.test(msg)) {
      await recordAiUsage({ ...track, status: 'error', error: msg, latencyMs: Date.now() - started, meta });
    }
    throw e;
  }
}

export async function readPostWithOpenAI(ctx: PostContext, media: OpenAiReadMedia[]): Promise<ReadResult> {
  if (media.length === 0 || media.every((m) => m.jpegs.length === 0)) throw new Error('permanent: readPostWithOpenAI needs at least one picture');
  const { prompt, owner } = buildOpenAiReadPrompt(ctx, media);
  const parts: unknown[] = media.flatMap((m) => m.jpegs.map((b) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b.toString('base64')}`, detail: 'high' } })));
  parts.push({ type: 'text', text: prompt });
  const r = await call(parts, 'post_read', READ_STRICT, 'read_post', ctx.post_id, { pictures: owner.length, videos: media.filter((m) => m.kind === 'video').length, candidates: ctx.candidates?.length ?? 0 });
  // media_text is per PICTURE; fold a video's frames back onto that video.
  const byMedia = new Map<number, string[]>();
  for (const e of Array.isArray(r.obj.media_text) ? r.obj.media_text : []) {
    const it = e as { media?: unknown; lines?: unknown };
    const n = Number(it.media);
    if (!Number.isInteger(n) || n < 1 || n > owner.length) continue;
    const mi = owner[n - 1]!;
    const lines = Array.isArray(it.lines) ? it.lines.filter((x): x is string => typeof x === 'string') : [];
    byMedia.set(mi, [...(byMedia.get(mi) ?? []), ...lines]);
  }
  const mediaText = media.map((m, i) => ({ mediaId: m.mediaId, lines: [...new Set((byMedia.get(i) ?? []).map((l) => l.trim()).filter(Boolean))] }));
  return {
    answer: toAnswer(ctx.post_id, r.obj), mediaText, costUsd: r.costUsd,
    inputTokens: Number(r.usage.prompt_tokens ?? 0), outputTokens: Number(r.usage.completion_tokens ?? 0),
  };
}

export async function decidePostWithOpenAI(ctx: PostContext): Promise<{ answer: EnrichAnswer; costUsd: number }> {
  const r = await call([{ type: 'text', text: buildDecidePrompt(ctx) }], 'post_decision', DECIDE_STRICT, 'decide_post', ctx.post_id, { candidates: ctx.candidates?.length ?? 0 });
  return { answer: toAnswer(ctx.post_id, r.obj), costUsd: r.costUsd };
}
