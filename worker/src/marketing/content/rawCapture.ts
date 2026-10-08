// ============================================================================
// RAW CAPTURE — one goal-free, exhaustive description per IMAGE (2026-10-08).
//
// Every text copied exactly (with position, size, typeface, weight, colour,
// treatment), the scene, objects, people, lighting, camera, composition,
// colours with hex and share, typography, graphics, branding, materials, mood,
// a designer's description and a recreate brief — stored as-is in
// mkt_media_raw_capture. Nothing is classified here: agents and labels are
// built later from this text. (Operator: "we are classifying too early".)
//
// Model gpt-6-luna by default (mkt_settings content.raw_capture.model), chosen
// by a 20-image blind test vs gpt-6.1-sol. The image is sent as bytes, not a
// link — OpenAI failed to download 3 of 40 storage URLs in that test. Every
// call is recorded in ai_usage. An empty OpenAI balance (DAILY_QUOTA_MARK)
// is rethrown so the caller pauses the lane instead of looping.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { openaiChatJson, openaiCostUsd } from '../../ai/providers/openaiHttp.js';
import { DAILY_QUOTA_MARK } from '../../ai/providers/geminiHttp.js';
import { recordAiUsage } from '../../lib/aiUsage.js';
import { fetchBytes } from './contentStore.js';
import { imageToBoundedJpeg } from './ffmpegMedia.js';

export const RAW_CAPTURE_SCHEMA_VERSION = 'raw-v1';
export const RAW_CAPTURE_CALL_SITE = 'worker/marketing/rawCapture';
const MAX_ATTEMPTS = 3;
/** Images of one post captured at the same time (a carousel can hold 20). */
const PER_POST_CONCURRENCY = 4;

type Json = Record<string, unknown>;
const S = (d: string): Json => ({ type: 'string', description: d });
const obj = (props: Record<string, Json>): Json => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });
const arr = (items: Json): Json => ({ type: 'array', items });

/** The capture schema (OpenAI strict mode: every object closed, every field required). */
export const RAW_CAPTURE_SCHEMA: Json = obj({
  text_elements: arr(obj({
    text: S('The text EXACTLY as written, original language and spelling. Never translate or correct.'),
    language: S('ar, en, mixed, …'),
    function: S('What this text does in the image, in your own words (headline, price, legal line, slogan, contact, label on a product, …).'),
    position: S('Where it sits (e.g. top-right third, centred on the lower band).'),
    relative_size: S('Size relative to the other text and to the image.'),
    typeface: S('Describe the letterforms: Arabic style (naskh/kufi/modern geometric/calligraphic…) or Latin family look (serif/sans/display, condensed, rounded…), case, letter-spacing.'),
    weight: S('light / regular / medium / bold / black, as seen.'),
    color_hex: S('#RRGGBB of the text fill.'),
    alignment: S('left / right / centred / justified, and its relation to other elements.'),
    treatment: S('Anything applied to it: on a band or box, outline, shadow, gradient, underline, none.'),
  })),
  reading_order: arr(S('Each text, in the order the eye reads the image.')),
  copy_observations: S('How the words work: tone, register, formality, length, persuasion devices, rhythm, how text and image relate. Descriptive, not a verdict.'),
  scene: obj({
    summary: S('What the image shows, in two or three sentences.'),
    image_source: S('Real photograph, 3D render, illustration, flat graphic, collage, mixed — and how you can tell.'),
    setting: S('Place, environment, interior/exterior, architecture or landscape.'),
    subjects: arr(obj({ what: S('Object or element.'), details: S('Material, colour, shape, condition, brand marks.'), position: S('Where in the frame.') })),
    people: arr(obj({ description: S('Who appears (age range, gender presentation, count).'), clothing: S('Clothing and styling.'), pose_and_expression: S('Pose, gaze, expression, action.'), position: S('Where in the frame.') })),
    lighting: S('Light source, direction, quality (hard/soft), colour temperature, contrast.'),
    time_of_day: S('Daylight, golden hour, dusk, night, studio, unclear.'),
    camera: S('Angle, shot size, lens feel, depth of field, perspective, symmetry.'),
    post_processing: S('Grading, filters, retouching, grain, vignette, cut-outs, compositing.'),
  }),
  composition: obj({
    layout: S('How the frame is divided and arranged, in your own words.'),
    grid_and_alignment: S('Margins, columns, alignment lines, symmetry.'),
    focal_point: S('Where the eye lands first and why.'),
    visual_hierarchy: arr(S('Elements from most to least dominant.')),
    whitespace: S('How much empty space, where, and what it does.'),
    balance_and_depth: S('Visual weight distribution, layering, foreground/background.'),
    aspect_ratio: S('Approximate ratio and orientation.'),
  }),
  colors: arr(obj({ hex: S('#RRGGBB'), where: S('Where this colour appears.'), share_percent: { type: 'number', description: 'Approximate share of the image area, 0-100.' } })),
  color_story: S('The palette as a whole: harmony, temperature, contrast, saturation, how colour guides attention.'),
  typography_system: S('All type together: how many families and sizes, pairing of Arabic and Latin, hierarchy logic, numerals style.'),
  graphic_elements: arr(obj({ type: S('Shape, line, frame, band, icon, pattern, gradient, sticker, badge, …'), description: S('What it looks like.'), position: S('Where.'), color_hex: S('#RRGGBB or "multiple".') })),
  branding: obj({
    logo: S('Is there a logo; which version (symbol, wordmark, lockup), colour, size, exact placement; "none" if absent.'),
    brand_signals: S('Everything that identifies the brand without the logo: colours, motifs, type, photography style, tagline.'),
    how_branded: S('How strongly and in what way the brand is present.'),
  }),
  materials_and_textures: S('Surfaces and materials visible or evoked (marble, brushed metal, linen, glass, paper grain…).'),
  mood_and_style: obj({ keywords: arr(S('One word or short phrase.')), description: S('The feeling and the style references it brings to mind.') }),
  perceived_quality: S('What makes it look premium, mass-market, amateur or polished — the concrete cues.'),
  designer_description: S('A senior designer describing the whole image so precisely that another designer could picture it without seeing it. 120-250 words.'),
  how_to_recreate: S('Step-by-step brief to recreate this image: assets needed, layout, type, colours, effects.'),
  uncertain: arr(S('Anything you could not read or are unsure about.')),
});

export interface CaptureContext { org: string | null; platform: string | null; slide: number; of: number; caption: string | null }

/** The capture prompt. Pure — tested. */
export function buildRawCapturePrompt(ctx: CaptureContext): string {
  return `You are cataloguing ONE image from a social media post for a design and copywriting library. Capture EVERYTHING about it — the words and the visuals — as raw, exhaustive description. Do not judge it against any goal and do not file it into categories: describe what is there, in detail, in your own words.

Rules:
- Copy every piece of visible text EXACTLY, in its original language and spelling (Arabic stays Arabic). Never translate, correct, complete or invent text. Write [unclear] for parts you cannot read and list them in "uncertain".
- Ignore platform interface overlays (usernames, buttons, progress bars) — only what is part of the image itself.
- Colours as #RRGGBB, best estimate from the pixels.
- Write every description field in English, except the copied text itself.
- If something is absent, say so ("none") rather than inventing it.

Context (do not extract it, it only helps you understand the image): published by ${ctx.org ?? 'unknown'} on ${ctx.platform ?? 'unknown'}; this is image ${ctx.slide} of ${ctx.of} in the post. Caption, for context only:
${(ctx.caption || '(none)').slice(0, 1500)}`;
}

export interface RawCaptureSettings { enabled: boolean; model: string; dailyBudgetUsd: number }

/** mkt_settings `content.raw_capture` — off unless explicitly enabled. */
export async function rawCaptureSettings(sb: SupabaseClient): Promise<RawCaptureSettings> {
  const { data, error } = await sb.from('mkt_settings').select('value').eq('key', 'content.raw_capture').maybeSingle();
  if (error) throw new Error(`content.raw_capture setting read failed: ${error.message}`);
  const v = ((data as { value?: unknown } | null)?.value ?? {}) as { enabled?: unknown; model?: unknown; daily_budget_usd?: unknown };
  const budget = Number(v.daily_budget_usd);
  return { enabled: v.enabled === true, model: typeof v.model === 'string' && v.model ? v.model : 'gpt-6-luna', dailyBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 40 };
}

export async function rawCapturePausedUntil(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb.from('mkt_settings').select('value').eq('key', 'content.raw_capture_paused_until').maybeSingle();
  if (error) throw new Error(`content.raw_capture_paused_until read failed: ${error.message}`);
  const t = Date.parse(String((data as { value?: unknown } | null)?.value ?? ''));
  return Number.isFinite(t) ? t : 0;
}

export async function pauseRawCapture(sb: SupabaseClient, retryAfterSec: number, reason: string): Promise<void> {
  const until = new Date(Date.now() + Math.min(Math.max(retryAfterSec, 60), 48 * 3600) * 1000).toISOString();
  const { error } = await sb.from('mkt_settings').upsert({ key: 'content.raw_capture_paused_until', value: until, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`pausing raw capture failed: ${error.message}`);
  const day = new Date().toISOString().slice(0, 10);
  const { error: alertErr } = await sb.rpc('mkt_alert_emit', {
    p_kind: 'raw_capture_quota', p_dedup_key: `raw_capture_quota:${day}`,
    p_title: 'Image raw capture paused: the OpenAI balance is empty or over quota — top up platform.openai.com',
    p_severity: 'critical', p_subject_type: 'content', p_subject_id: day,
    p_body: `OpenAI refused the capture; it resumes by itself at ${until}. ${reason.slice(0, 300)}`,
    p_evidence: { until, reason: reason.slice(0, 1000) },
  });
  if (alertErr) console.error(`[raw-capture] mkt_alert_emit failed (quota alert not recorded): ${alertErr.message}`);
}

/** Raw-capture spend since Riyadh midnight, from the ai_usage ledger. */
export async function rawCaptureSpendToday(sb: SupabaseClient): Promise<number> {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const since = new Date(`${day}T00:00:00+03:00`).toISOString();
  let total = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('ai_usage').select('cost_usd').eq('call_site', RAW_CAPTURE_CALL_SITE).gte('created_at', since).order('id', { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`raw capture spend read failed: ${error.message}`);
    for (const r of data ?? []) total += Number((r as { cost_usd: unknown }).cost_usd) || 0;
    if (!data || data.length < 1000) break;
  }
  return total;
}

interface MediaRow { id: string; carousel_index: number | null; stored_url: string | null }

/** One image → one capture row (done or failed). Rethrows an OpenAI quota error. */
async function captureOne(sb: SupabaseClient, model: string, post: { id: string; organization_id: string | null; platform: string | null; caption: string | null; org: string | null }, m: MediaRow, index: number, of: number, priorAttempts: number): Promise<{ ok: boolean; cost: number }> {
  const started = Date.now();
  const track = { area: 'competitors' as const, callSite: RAW_CAPTURE_CALL_SITE, operation: 'raw_capture_image', provider: 'openai' as const, model, entityKind: 'mkt_content_media', entityId: m.id };
  const store = async (row: Json): Promise<void> => {
    const { error } = await sb.from('mkt_media_raw_capture').upsert({
      content_media_id: m.id, content_post_id: post.id, organization_id: post.organization_id, model, schema_version: RAW_CAPTURE_SCHEMA_VERSION,
      attempts: priorAttempts + 1, updated_at: new Date().toISOString(), ...row,
    }, { onConflict: 'content_media_id,model,schema_version' });
    if (error) throw new Error(`store raw capture for media ${m.id} failed: ${error.message}`);
  };
  let jpeg: Buffer;
  try {
    const { bytes } = await fetchBytes(m.stored_url as string, 60_000);
    jpeg = await imageToBoundedJpeg(bytes, 'img');
  } catch (e) {
    await store({ status: 'failed', capture: null, failure_reason: `image not readable: ${(e as Error).message}`.slice(0, 500) });
    return { ok: false, cost: 0 };
  }
  const content = [
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}`, detail: 'high' } },
    { type: 'text', text: buildRawCapturePrompt({ org: post.org, platform: post.platform, slide: index + 1, of, caption: post.caption }) },
  ];
  let replied = false;
  try {
    const r = await openaiChatJson(model, content, 'raw_image_capture', RAW_CAPTURE_SCHEMA);
    replied = true;
    const cost = openaiCostUsd(model, r.usage);
    let capture: Json | null = null;
    let fail: string | null = r.finishReason !== 'stop' ? `provider:openai_compat finished with ${r.finishReason}` : null;
    if (!fail) {
      try {
        const parsed: unknown = JSON.parse(r.text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) capture = parsed as Json; else fail = 'reply is not a JSON object';
      } catch (e) { fail = `unparseable JSON (${(e as Error).message})`; }
    }
    await recordAiUsage({ ...track, status: fail ? 'error' : 'ok', error: fail, inputTokens: Number(r.usage.prompt_tokens ?? 0), outputTokens: Number(r.usage.completion_tokens ?? 0), ...(cost !== null ? { costUsd: cost } : {}), latencyMs: Date.now() - started, units: 1, unitKind: null });
    await store(fail
      ? { status: 'failed', capture: null, failure_reason: fail.slice(0, 500), cost_usd: cost, input_tokens: r.usage.prompt_tokens ?? null, output_tokens: r.usage.completion_tokens ?? null }
      : { status: 'done', capture, failure_reason: null, cost_usd: cost, input_tokens: r.usage.prompt_tokens ?? null, output_tokens: r.usage.completion_tokens ?? null });
    return { ok: !fail, cost: cost ?? 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!replied) await recordAiUsage({ ...track, status: 'error', error: msg, latencyMs: Date.now() - started });
    if (msg.includes(DAILY_QUOTA_MARK)) throw e; // empty balance: pause the lane, keep the attempt
    await store({ status: 'failed', capture: null, failure_reason: msg.slice(0, 500) });
    return { ok: false, cost: 0 };
  }
}

export interface RawCaptureOutcome { images: number; captured: number; failed: number; costUsd: number }

/**
 * Capture every stored image of one post that has no capture yet for this
 * model + schema version (and fewer than MAX_ATTEMPTS failures).
 */
export async function rawCapturePost(sb: SupabaseClient, postId: string, model: string): Promise<RawCaptureOutcome> {
  const { data: post, error } = await sb.from('mkt_content_posts').select('id, organization_id, platform, caption, mkt_organizations(name_ar, name_en)').eq('id', postId).maybeSingle();
  if (error) throw new Error(`load post ${postId} for raw capture failed: ${error.message}`);
  if (!post) throw new Error(`permanent: content post not found: ${postId}`);
  const p = post as { id: string; organization_id: string | null; platform: string | null; caption: string | null; mkt_organizations?: { name_ar?: string | null; name_en?: string | null } | null };
  const { data: media, error: mErr } = await sb.from('mkt_content_media').select('id, carousel_index, stored_url')
    .eq('content_post_id', postId).eq('media_kind', 'image').eq('download_status', 'stored').order('carousel_index', { ascending: true });
  if (mErr) throw new Error(`load images of ${postId} failed: ${mErr.message}`);
  const all = ((media ?? []) as MediaRow[]).filter((m) => m.stored_url);
  const { data: existing, error: eErr } = await sb.from('mkt_media_raw_capture').select('content_media_id, status, attempts')
    .eq('content_post_id', postId).eq('model', model).eq('schema_version', RAW_CAPTURE_SCHEMA_VERSION);
  if (eErr) throw new Error(`load existing captures of ${postId} failed: ${eErr.message}`);
  const prior = new Map(((existing ?? []) as Array<{ content_media_id: string; status: string; attempts: number }>).map((r) => [r.content_media_id, r]));
  const todo = all.map((m, i) => ({ m, i })).filter(({ m }) => { const r = prior.get(m.id); return !r || (r.status !== 'done' && r.attempts < MAX_ATTEMPTS); });
  const out: RawCaptureOutcome = { images: todo.length, captured: 0, failed: 0, costUsd: 0 };
  const ctx = { id: p.id, organization_id: p.organization_id, platform: p.platform, caption: p.caption, org: p.mkt_organizations?.name_en ?? p.mkt_organizations?.name_ar ?? null };
  let quotaError: Error | null = null;
  const queue = [...todo];
  await Promise.all(Array.from({ length: Math.min(PER_POST_CONCURRENCY, queue.length) }, async () => {
    for (let job = queue.shift(); job && !quotaError; job = queue.shift()) {
      try {
        const r = await captureOne(sb, model, ctx, job.m, job.i, all.length, prior.get(job.m.id)?.attempts ?? 0);
        out.costUsd += r.cost;
        if (r.ok) out.captured++; else out.failed++;
      } catch (e) {
        if ((e instanceof Error ? e.message : String(e)).includes(DAILY_QUOTA_MARK)) { quotaError = e as Error; return; }
        throw e;
      }
    }
  }));
  if (quotaError) throw quotaError;
  return out;
}
