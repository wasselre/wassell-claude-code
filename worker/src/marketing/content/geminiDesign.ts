// ============================================================================
// Design reads for competitor IMAGE posts, by Gemini (2026-10-05).
//
// The post reader (geminiRead.ts) copies an image's TEXT; nothing described how
// the image is DESIGNED. The design-read system built for the Post Creative
// Director (visual_design_reads + the SlideRead / PostRead contract) had the
// right shape but never produced a row: its runner/API lanes failed all 481 of
// their jobs and its flags are off. This module fills that same table.
//
// ONE gemini-3.8-flash call per post: every image (in carousel order) →
//   - one SlideRead per image  (subject 'competitor_media', level 'slide')
//   - one PostRead for the post (subject 'competitor_post', level 'post')
// each re-checked by the existing validators (creative/designRead/schemas.ts)
// before it is stored, plus a gemini-embedding-2 vector per image (the same
// 768-d visual model as the shot pipeline) for "find posts that look like this".
// Videos are not read here — their shots carry the creative reading.
//
// A failed read is STORED as status 'failed' with its reason and an attempt
// count (raw.attempts); the sweep retries it at most MAX_ATTEMPTS times.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { flashCostUsd, geminiPost, type GeminiUsage } from '../../ai/providers/geminiHttp.js';
import { embed } from '../../ai/index.js';
import { recordAiUsage } from '../../lib/aiUsage.js';
import { POST_READ_SCHEMA, SLIDE_READ_SCHEMA, postReadProblems, slideReadProblems } from '../../creative/designRead/schemas.js';
import { POST_READ_SYSTEM, SLIDE_READ_SYSTEM } from '../../creative/designRead/prompts.js';
import { upsertDesignRead } from '../../creative/designRead/persist.js';
import { fetchBytes } from './contentStore.js';
import { imageToBoundedJpeg } from './ffmpegMedia.js';

export const DESIGN_MODEL = 'gemini-3.8-flash';
/** visual_design_reads.model_used for these rows. */
export const DESIGN_MODEL_USED = `gemini:${DESIGN_MODEL}`;
export const DESIGN_RULE_VERSION = 'gemini-v1';
/** A carousel is read up to this many slides (the rest are rare and repeat the template). */
export const MAX_SLIDES = 10;
export const MAX_ATTEMPTS = 3;

type Json = Record<string, unknown>;

/**
 * The Anthropic-shaped schemas, reduced to what Gemini's structured output
 * accepts: no `additionalProperties`, no `pattern`, no open objects, integer
 * enums as ranges, nullable types as anyOf. The validators still apply the
 * full rules afterwards, so nothing the schema loses goes unchecked.
 */
export function geminiSafeSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(geminiSafeSchema);
  if (!s || typeof s !== 'object') return s;
  const o = s as Json;
  const out: Json = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'additionalProperties' || k === 'pattern') continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, geminiSafeSchema(pv)])) : geminiSafeSchema(v);
  }
  if (Array.isArray(out.type)) {
    const types = (out.type as string[]).filter((t) => t !== 'null');
    const { type: _t, enum: en, ...rest } = out;
    const base: Json = { ...rest, type: types[0] };
    if (Array.isArray(en)) base.enum = en.filter((x) => x !== null);
    return { anyOf: [base, { type: 'null' }] };
  }
  if (out.type === 'integer' && Array.isArray(out.enum)) {
    const nums = (out.enum as number[]);
    const { enum: _e, ...rest } = out;
    return { ...rest, minimum: Math.min(...nums), maximum: Math.max(...nums) };
  }
  if (out.type === 'object' && !out.properties) {
    // design_system.typography / image_strategy.mix are open maps in the contract.
    return { type: 'object', properties: { notes: { type: 'string' } } };
  }
  return out;
}

export function designSchema(): Json {
  const post = geminiSafeSchema(POST_READ_SCHEMA) as Json;
  // image_strategy.mix is "kind → share"; Gemini needs named keys.
  const props = post.properties as Json;
  const strat = props.image_strategy as Json;
  (strat.properties as Json).mix = {
    type: 'object',
    properties: { photo: { type: 'number' }, render: { type: 'number' }, illustration: { type: 'number' }, graphic: { type: 'number' } },
  };
  return {
    type: 'object',
    properties: {
      slides: { type: 'array', description: 'One SlideRead per attached image, in the same order.', items: geminiSafeSchema(SLIDE_READ_SCHEMA) },
      post: post,
    },
    required: ['slides', 'post'],
  };
}

/** Prompt for the combined read. Pure — tested. */
export function buildDesignPrompt(n: number, ctx: { platform?: string | null; org?: string | null }): string {
  return `${SLIDE_READ_SYSTEM}

${POST_READ_SYSTEM}

The ${n} attached image(s) are ONE ${n > 1 ? 'carousel post, in carousel order (image 1 = cover)' : 'single-image post'}${ctx.platform ? ` on ${ctx.platform}` : ''}${ctx.org ? `, published by ${ctx.org} (a competitor)` : ''}.
Return:
- slides: exactly ${n} SlideRead objects, slides[i] describing image i+1.
- post: the PostRead of the whole post (format "${n > 1 ? 'carousel' : 'single'}", slide_count ${n}, role_sequence and content_density_profile with ${n} entries each).
Free-text fields (hierarchy, notes, narrative_arc, strengths, weaknesses, learnable, summary) in Arabic. Describe what is visible; never invent text, prices or names.`;
}

/** Drop what the contract forbids and the model sometimes adds; normalise hexes. */
function tidySlide(r: Json): Json {
  const palette = Array.isArray(r.palette) ? (r.palette as Json[]).slice(0, 6).map((p) => ({ ...p, hex: typeof p.hex === 'string' ? p.hex.toUpperCase() : p.hex })) : r.palette;
  return { ...r, palette };
}
function tidyPost(r: Json): Json {
  const ds = (r.design_system ?? {}) as Json;
  const palette = Array.isArray(ds.palette) ? (ds.palette as Json[]).map((p) => ({ ...p, hex: typeof p.hex === 'string' ? p.hex.toUpperCase() : p.hex })) : ds.palette;
  return { ...r, design_system: { ...ds, palette } };
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  usageMetadata?: GeminiUsage;
  promptFeedback?: { blockReason?: string };
}

export interface DesignImage { mediaId: string; carouselIndex: number; url: string; jpeg: Buffer }

export interface DesignOutcome {
  slidesStored: number;
  slidesFailed: number;
  postStored: boolean;
  costUsd: number;
  failure: string | null;
}

/** The one Gemini call. Recorded in ai_usage either way; throws on any failure. */
async function callGemini(postId: string, images: DesignImage[], ctx: { platform?: string | null; org?: string | null }): Promise<{ obj: Json; costUsd: number }> {
  const started = Date.now();
  const track = { area: 'competitors' as const, callSite: 'worker/marketing/geminiDesign', operation: 'design_read', provider: 'gemini' as const, model: DESIGN_MODEL, entityKind: 'mkt_content_post', entityId: postId };
  const meta = { images: images.length };
  let replied = false;
  try {
    const parts: unknown[] = images.map((im) => ({ inline_data: { mime_type: 'image/jpeg', data: im.jpeg.toString('base64') } }));
    parts.push({ text: buildDesignPrompt(images.length, ctx) });
    const r = await geminiPost<GenerateResponse>(`/v1beta/models/${DESIGN_MODEL}:generateContent`, {
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json', responseJsonSchema: designSchema(), mediaResolution: 'MEDIA_RESOLUTION_HIGH', thinkingConfig: { thinkingLevel: 'low' }, maxOutputTokens: 32768 },
    }, { timeoutMs: 300_000, maxAttempts: 6, baseDelayMs: 5_000 });
    const u = r.usageMetadata ?? {};
    const inputTokens = Number(u.promptTokenCount ?? 0) || 0;
    const outputTokens = (Number(u.candidatesTokenCount ?? 0) || 0) + (Number(u.thoughtsTokenCount ?? 0) || 0);
    const cached = Number(u.cachedContentTokenCount ?? 0) || 0;
    const costUsd = flashCostUsd(inputTokens, outputTokens, cached);
    const cand = r.candidates?.[0];
    let fail: string | null = cand?.finishReason !== 'STOP' ? `provider:gemini finished with ${cand?.finishReason ?? 'none'}${r.promptFeedback?.blockReason ? ` (blocked: ${r.promptFeedback.blockReason})` : ''}` : null;
    let obj: Json | null = null;
    if (!fail) {
      const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
      try {
        const parsed: unknown = JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Json;
        else fail = 'provider:gemini design reply is not a JSON object';
      } catch (e) {
        fail = `provider:gemini returned unparseable JSON (${(e as Error).message})`;
      }
    }
    replied = true;
    await recordAiUsage({ ...track, status: fail ? 'error' : 'ok', error: fail, inputTokens: inputTokens - Math.min(cached, inputTokens), cacheReadTokens: cached, outputTokens, costUsd, latencyMs: Date.now() - started, units: images.length, unitKind: null, meta });
    if (fail || !obj) throw new Error(fail ?? 'provider:gemini design reply was empty');
    return { obj, costUsd };
  } catch (e) {
    if (!replied) await recordAiUsage({ ...track, status: 'error', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started, meta });
    throw e;
  }
}

/** Previous failed attempts on this post's post-level Gemini read. */
async function priorAttempts(sb: SupabaseClient, postId: string): Promise<number> {
  const { data, error } = await sb.from('visual_design_reads').select('raw, status')
    .eq('subject_kind', 'competitor_post').eq('subject_id', postId).eq('level', 'post')
    .eq('model_used', DESIGN_MODEL_USED).eq('rule_version', DESIGN_RULE_VERSION).maybeSingle();
  if (error) throw new Error(`design read attempts lookup failed for ${postId}: ${error.message}`);
  const row = data as { raw?: { attempts?: unknown } | null; status?: string } | null;
  return row && row.status === 'failed' ? Number(row.raw?.attempts ?? 1) || 1 : 0;
}

/** Load the post's stored images (carousel order) as bounded JPEGs. */
export async function loadPostImages(sb: SupabaseClient, postId: string): Promise<DesignImage[]> {
  const { data, error } = await sb.from('mkt_content_media').select('id, carousel_index, media_kind, stored_url, download_status')
    .eq('content_post_id', postId).eq('download_status', 'stored').in('media_kind', ['image', 'video'])
    .order('carousel_index', { ascending: true });
  if (error) throw new Error(`load media for design read of ${postId} failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; carousel_index: number | null; media_kind: string; stored_url: string | null }>;
  if (rows.some((r) => r.media_kind === 'video')) return []; // shots read videos
  const out: DesignImage[] = [];
  for (const r of rows.filter((x) => x.media_kind === 'image' && x.stored_url).slice(0, MAX_SLIDES)) {
    const { bytes } = await fetchBytes(r.stored_url as string, 60_000);
    out.push({ mediaId: r.id, carouselIndex: r.carousel_index ?? out.length, url: r.stored_url as string, jpeg: await imageToBoundedJpeg(bytes, 'img') });
  }
  return out;
}

/**
 * Read, validate and store the design of one image post. Never throws for a
 * model or validation failure — that is stored as a failed row (with its
 * attempt count) and returned in `failure`. A per-day / monthly Gemini quota
 * is rethrown so the caller can pause instead of burning the attempt.
 */
export async function designReadPost(
  sb: SupabaseClient,
  post: { id: string; organization_id: string | null; platform: string | null; org_name?: string | null },
  images: DesignImage[],
): Promise<DesignOutcome> {
  const outcome: DesignOutcome = { slidesStored: 0, slidesFailed: 0, postStored: false, costUsd: 0, failure: null };
  if (images.length === 0) return outcome;
  const attempts = (await priorAttempts(sb, post.id)) + 1;
  const base = { post_id: post.id, organization_id: post.organization_id, model_used: DESIGN_MODEL_USED, rule_version: DESIGN_RULE_VERSION } as const;
  const storePostFailure = async (reason: string): Promise<void> => {
    await upsertDesignRead(sb, { ...base, subject_kind: 'competitor_post', subject_id: post.id, level: 'post', slide_index: null, model_task: 'design_read_post', read: {}, status: 'failed', failure: reason.slice(0, 500), raw: { attempts }, cost_usd: outcome.costUsd });
  };

  let obj: Json;
  try {
    const r = await callGemini(post.id, images, { platform: post.platform, org: post.org_name ?? null });
    obj = r.obj;
    outcome.costUsd = r.costUsd;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('daily_quota_exhausted')) throw e;
    outcome.failure = msg;
    await storePostFailure(msg);
    return outcome;
  }

  const slides = Array.isArray(obj.slides) ? (obj.slides as Json[]) : [];
  const share = images.length ? outcome.costUsd / (images.length + 1) : 0;
  for (let i = 0; i < images.length; i++) {
    const im = images[i]!;
    const read = slides[i] ? tidySlide(slides[i]!) : null;
    const problems = read ? slideReadProblems(read, `slides[${i}]`) : [`slides[${i}]: missing`];
    let embedding: number[] | null = null;
    if (problems.length === 0) {
      // The vector is a bonus for "looks like" search; its failure must not lose the read.
      try {
        embedding = (await embed('embed_image', { image_urls: [im.url] }, { sb })).vectors?.[0] ?? null;
      } catch (e) {
        console.error(`[design] embed_image failed for media ${im.mediaId} — storing the read without a vector:`, e instanceof Error ? e.message : e);
      }
    }
    await upsertDesignRead(sb, {
      ...base, subject_kind: 'competitor_media', subject_id: im.mediaId, level: 'slide', slide_index: im.carouselIndex, model_task: 'design_read_slide',
      read: problems.length === 0 ? (read as Json) : {}, status: problems.length === 0 ? 'done' : 'failed',
      failure: problems.length ? problems.join('; ').slice(0, 500) : null, raw: { attempts }, cost_usd: Math.round(share * 1e6) / 1e6, embedding,
    });
    if (problems.length === 0) outcome.slidesStored++; else outcome.slidesFailed++;
  }

  const postRead = obj.post && typeof obj.post === 'object' ? tidyPost(obj.post as Json) : null;
  const postProblems = postRead ? postReadProblems(postRead, 'post', images.length) : ['post: missing'];
  if (postProblems.length > 0) {
    outcome.failure = postProblems.join('; ');
    await storePostFailure(outcome.failure);
    return outcome;
  }
  await upsertDesignRead(sb, {
    ...base, subject_kind: 'competitor_post', subject_id: post.id, level: 'post', slide_index: null, model_task: 'design_read_post',
    read: postRead as Json, status: 'done', raw: { attempts }, cost_usd: Math.round(share * 1e6) / 1e6,
  });
  outcome.postStored = true;
  return outcome;
}

/** Load the post + its images and read them. Used inline after a read and by the design-only backfill. */
export async function designReadStoredPost(sb: SupabaseClient, postId: string): Promise<DesignOutcome & { images: number }> {
  const { data: post, error } = await sb.from('mkt_content_posts').select('id, organization_id, platform, mkt_organizations(name_ar, name_en)').eq('id', postId).maybeSingle();
  if (error) throw new Error(`load post ${postId} for design read failed: ${error.message}`);
  if (!post) throw new Error(`permanent: content post not found: ${postId}`);
  const p = post as { id: string; organization_id: string | null; platform: string | null; mkt_organizations?: { name_ar?: string | null; name_en?: string | null } | null };
  const images = await loadPostImages(sb, postId);
  const out = await designReadPost(sb, { id: p.id, organization_id: p.organization_id, platform: p.platform, org_name: p.mkt_organizations?.name_ar ?? p.mkt_organizations?.name_en ?? null }, images);
  return { ...out, images: images.length };
}
