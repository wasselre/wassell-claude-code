// ============================================================================
// ONE Gemini call per video: it watches the (silent) video and returns every
// shot with its on-screen text, a bilingual description and the creative
// reading the Competitor Watch drawer shows.
//
// Chosen 2026-10-04 by a blind bake-off on 20 competitor videos (judged by 10
// independent reviewers): Gemini 3.8 Flash scored 8.8/10 on text accuracy and
// 9.7 on text coverage with 4 invented lines in total; the old Modal OCR scored
// 2.8 and 2.4 with 174 invented lines and was the worst on all 20 videos.
//
// Files ≤ 18 MB go inline (base64). Larger ones go through the Files API
// (resumable upload → wait until ACTIVE → reference by uri → delete).
// Every call is recorded in ai_usage with its exact cost (tokens × the cited
// rates in ai/providers/geminiHttp.ts), success or failure.
// ============================================================================
import { readFile } from 'node:fs/promises';
import { DAILY_QUOTA_MARK, flashCostUsd, geminiApiKey, geminiKeyFor, geminiPost, GEMINI_API_BASE, type GeminiUsage } from '../../../ai/providers/geminiHttp.js';
import { recordAiUsage } from '../../../lib/aiUsage.js';
import { vocabForPrompt, CV_VOCAB } from '../vocab.js';
import { CERTAIN_CUT_SCORE, HINT_CUT_SCORE, type DetectedCut } from './shots.js';
import type { TranscriptSegment } from '../types.js';

export const GEMINI_VIDEO_MODEL = 'gemini-3.8-flash';
export const ANALYSIS_VERSION_GEMINI = 'gemini-video-1';
const INLINE_MAX_BYTES = 18_000_000;

const DIFF = ['easy', 'moderate', 'hard'];
// Tags the model may use. purpose / motion / reproducibility are separate
// fields and are mirrored into tags afterwards (coerceShotAnalysis).
const TAG_GROUPS = ['shot_size', 'setting', 'subject', 'graphic', 'light'] as const;

export interface GeminiShot {
  start_s: number;
  end_s: number;
  continuous_take: boolean;
  transition_in: string;
  summary_ar: string;
  summary_en: string;
  on_screen_text: string[];
  footage: string;
  purpose: string;
  angle: string;
  camera_movement: string;
  pace: string;
  production_method: string;
  production_difficulty: string;
  production_resources: string[];
  reproducibility: string;
  suitable_platforms: string[];
  mood: string;
  tags: string[];
  confidence: number;
}

export interface GeminiVideoOutput { summary_ar: string; summary_en: string; shots: GeminiShot[] }

const SHOT_SCHEMA = {
  type: 'object',
  properties: {
    start_s: { type: 'number' },
    end_s: { type: 'number' },
    continuous_take: { type: 'boolean' },
    transition_in: { type: 'string', enum: ['start', 'cut', 'fade', 'dissolve', 'graphic'] },
    summary_ar: { type: 'string' },
    summary_en: { type: 'string' },
    on_screen_text: { type: 'array', items: { type: 'string' } },
    footage: { type: 'string', enum: ['real', 'cgi', 'mixed', 'graphic'] },
    purpose: { type: 'string', enum: [...CV_VOCAB.purpose] },
    angle: { type: 'string' },
    camera_movement: { type: 'string', enum: [...CV_VOCAB.motion] },
    pace: { type: 'string', enum: ['slow', 'medium', 'fast'] },
    production_method: { type: 'string' },
    production_difficulty: { type: 'string', enum: DIFF },
    production_resources: { type: 'array', items: { type: 'string' } },
    reproducibility: { type: 'string', enum: DIFF },
    suitable_platforms: { type: 'array', items: { type: 'string', enum: ['instagram_reel', 'tiktok', 'snapchat', 'youtube_short', 'x', 'facebook'] } },
    mood: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['start_s', 'end_s', 'continuous_take', 'transition_in', 'summary_ar', 'summary_en', 'on_screen_text', 'footage', 'purpose', 'angle', 'camera_movement', 'pace', 'production_method', 'production_difficulty', 'production_resources', 'reproducibility', 'suitable_platforms', 'mood', 'tags', 'confidence'],
};

export const VIDEO_SCHEMA = {
  type: 'object',
  properties: { summary_ar: { type: 'string' }, summary_en: { type: 'string' }, shots: { type: 'array', items: SHOT_SCHEMA } },
  required: ['summary_ar', 'summary_en', 'shots'],
};

function fmtSecs(cuts: readonly DetectedCut[]): string {
  return cuts.length ? cuts.map((c) => (c.t_ms / 1000).toFixed(2)).join(', ') : '(none)';
}

function tagVocab(): string {
  return vocabForPrompt().split('\n').filter((l) => (TAG_GROUPS as readonly string[]).includes(l.split(':')[0]!)).join('\n');
}

export interface VideoPromptInput {
  durationMs: number;
  cuts: readonly DetectedCut[];
  transcript: readonly TranscriptSegment[];
  transcriptLanguage: string | null;
  contentType: string | null;
  campaignMessage: string | null;
  partialNote: string | null;
}

/** The prompt. Pure — tested. Wording was tuned on 3 test videos (walkthrough, montage, event). */
export function buildVideoPrompt(i: VideoPromptInput): string {
  const dur = (i.durationMs / 1000).toFixed(2);
  const certain = i.cuts.filter((c) => c.score >= CERTAIN_CUT_SCORE);
  const possible = i.cuts.filter((c) => c.score >= HINT_CUT_SCORE && c.score < CERTAIN_CUT_SCORE);
  const speech = i.transcript.length
    ? i.transcript.map((s) => `[${(s.start_ms / 1000).toFixed(1)}-${(s.end_ms / 1000).toFixed(1)}s] ${s.text}`).join('\n').slice(0, 8000)
    : '(no speech, or no transcript)';
  return `You are a senior video-ad analyst for Saudi real-estate marketing. Analyse this competitor video (${dur} s; the audio was removed — what was said is given below) shot by shot so a marketer can learn from it.${i.partialNote ? `\n${i.partialNote}` : ''}

SHOTS. A shot is one continuous camera take (or one graphic / slide) between two transitions. Decide the boundaries yourself by watching: transitions can be hard cuts, dissolves, fades, whip-pans, graphic wipes or slideshow changes, and every one of them starts a new shot. Every change of camera take is its own shot, even in a fast montage of half-second takes; never merge two different takes into one shot.
A frame-difference detector measured these hard cuts (seconds):
- certain: ${fmtSecs(certain)}
- possible (may be false alarms from flashes or fast motion): ${fmtSecs(possible)}
Use it to make your timing exact: when one of your boundaries is a hard cut near a listed time, use the listed time. It misses every soft transition, so it is NOT the shot list.
Long continuous takes: when one unbroken take (a walkthrough, a drone flight) moves into a clearly different space or subject — street to entrance, entrance to living room, living room to kitchen — split it there and set continuous_take=true on the later part, so each shot shows one place.
Shots must be in order, contiguous, start at 0 and end at ${dur}; never return a time beyond ${dur}.

For each shot:
- on_screen_text: every line of text visible on screen, copied EXACTLY in its original language and spelling. Never translate, correct, complete or invent text; skip what you cannot read. Ignore platform interface text (buttons, usernames, the caption bar).
- summary_ar (Saudi Arabic) and summary_en: ONE line each — what is shown and what it does in the ad.
- purpose, angle (the creative angle, a few words), camera_movement, pace, footage.
- production_method (drone, gimbal walkthrough, 3D render, motion graphic, phone selfie, …), production_difficulty, production_resources (short list), reproducibility for a mid-size Saudi agency, suitable_platforms, mood (a few words).
- tags: only from this vocabulary, written group:value —
${tagVocab()}
- confidence 0-1.
Keep every free-text field short (about 12 words at most). Facts only: never invent prices, names or offers that are not visible or spoken.
Also give a two-line summary of the whole video (summary_ar, summary_en).

What was said${i.transcriptLanguage ? ` (${i.transcriptLanguage})` : ''}:
${speech}

Post context: content_type=${i.contentType ?? 'unknown'}; campaign_message=${i.campaignMessage ?? 'unknown'}.`;
}

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  usageMetadata?: GeminiUsage;
  promptFeedback?: { blockReason?: string };
}

export interface GeminiVideoResult {
  output: GeminiVideoOutput;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  via: 'inline' | 'file';
}

export async function uploadFile(path: string, bytes: number, apiKey?: string): Promise<{ name: string; uri: string }> {
  const key = apiKey ?? geminiApiKey();
  const start = await fetch(`${GEMINI_API_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes),
      'X-Goog-Upload-Header-Content-Type': 'video/mp4',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'cv-video' } }),
    signal: AbortSignal.timeout(60_000),
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!start.ok || !uploadUrl) throw new Error(`provider:gemini file upload start HTTP ${start.status}: ${(await start.text()).slice(0, 300)}`);
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize', 'content-length': String(bytes) },
    body: await readFile(path),
    signal: AbortSignal.timeout(600_000),
  });
  if (!up.ok) throw new Error(`provider:gemini file upload HTTP ${up.status}: ${(await up.text()).slice(0, 300)}`);
  const file = ((await up.json()) as { file?: { name?: string; uri?: string; state?: string } }).file;
  if (!file?.name || !file.uri) throw new Error('provider:gemini file upload returned no file name/uri');
  // Videos are processed after upload; generateContent refuses them until ACTIVE.
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${GEMINI_API_BASE}/v1beta/${file.name}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`provider:gemini file status HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const st = ((await r.json()) as { state?: string }).state;
    if (st === 'ACTIVE') return { name: file.name, uri: file.uri };
    if (st === 'FAILED') throw new Error('provider:gemini uploaded video failed processing on Google');
    await new Promise((res) => setTimeout(res, 5_000));
  }
  throw new Error('provider:gemini uploaded video was not ready after 5 minutes');
}

export async function deleteFile(name: string, apiKey?: string): Promise<void> {
  const r = await fetch(`${GEMINI_API_BASE}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': apiKey ?? geminiApiKey() }, signal: AbortSignal.timeout(30_000) });
  // A leftover file costs nothing and Google deletes it after 48 h — log, do not fail the video.
  if (!r.ok) console.error(`[cv/gemini] delete uploaded file ${name} failed: HTTP ${r.status}`);
}

/** Parse the model's JSON. Exported for tests. */
export function parseVideoOutput(text: string): GeminiVideoOutput {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let o: unknown;
  try { o = JSON.parse(t); } catch (e) {
    throw new Error(`provider:gemini returned unparseable JSON (${(e as Error).message}): ${t.slice(0, 200)}`);
  }
  const v = o as Partial<GeminiVideoOutput>;
  if (!v || typeof v !== 'object' || !Array.isArray(v.shots)) throw new Error('provider:gemini reply has no shots array');
  return { summary_ar: String(v.summary_ar ?? ''), summary_en: String(v.summary_en ?? ''), shots: v.shots as GeminiShot[] };
}

export interface AnalyzeVideoInput extends VideoPromptInput {
  videoPath: string;
  videoBytes: number;
  videoId: string;
}

export async function analyzeVideoWithGemini(input: AnalyzeVideoInput): Promise<GeminiVideoResult> {
  const started = Date.now();
  const via: 'inline' | 'file' = input.videoBytes <= INLINE_MAX_BYTES ? 'inline' : 'file';
  let uploaded: { name: string; uri: string } | null = null;
  // An uploaded file belongs to the project whose key uploaded it: upload and
  // call with the SAME key (2026-10-05: 403 "permission to access the File"
  // once a second project's key started taking calls).
  const pin = via === 'file' ? geminiKeyFor(GEMINI_VIDEO_MODEL) : null;
  if (via === 'file' && !pin) throw new Error(`provider:gemini ${DAILY_QUOTA_MARK} all keys at their daily quota for ${GEMINI_VIDEO_MODEL} — retry after 3600s`);
  let replied = false;
  const track = { area: 'competitors' as const, callSite: 'worker/cv/gemini_video', operation: 'analyze_video', provider: 'gemini' as const, model: GEMINI_VIDEO_MODEL, entityKind: 'mkt_cv_video', entityId: input.videoId };
  try {
    let videoPart: Record<string, unknown>;
    if (via === 'inline') {
      videoPart = { inline_data: { mime_type: 'video/mp4', data: (await readFile(input.videoPath)).toString('base64') } };
    } else {
      uploaded = await uploadFile(input.videoPath, input.videoBytes, pin!.key);
      videoPart = { file_data: { mime_type: 'video/mp4', file_uri: uploaded.uri } };
    }
    const r = await geminiPost<GenerateResponse>(`/v1beta/models/${GEMINI_VIDEO_MODEL}:generateContent`, {
      contents: [{ parts: [videoPart, { text: buildVideoPrompt(input) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: VIDEO_SCHEMA,
        mediaResolution: 'MEDIA_RESOLUTION_HIGH',
        thinkingConfig: { thinkingLevel: 'low' },
        maxOutputTokens: 65_536,
      },
    // Gemini answers 503 "high demand" in bursts (seen 2026-10-04: four tries
    // in 15 s all refused). Six tries over ~2.5 min ride most bursts out; the
    // job queue's own requeue covers the rest.
    }, { timeoutMs: 600_000, maxAttempts: 6, baseDelayMs: 5_000, ...(pin ? { pinKeyIndex: pin.index } : {}) });
    const u = r.usageMetadata ?? {};
    const inputTokens = Number(u.promptTokenCount ?? 0) || 0;
    const outputTokens = (Number(u.candidatesTokenCount ?? 0) || 0) + (Number(u.thoughtsTokenCount ?? 0) || 0);
    const cachedTokens = Number(u.cachedContentTokenCount ?? 0) || 0;
    const costUsd = flashCostUsd(inputTokens, outputTokens, cachedTokens);
    const cand = r.candidates?.[0];
    const finish = cand?.finishReason ?? 'none';
    const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('');
    // A reply is billed even when it is unusable, so decide usability first and
    // record exactly once, with the tokens either way.
    let fail: string | null = finish !== 'STOP'
      ? `provider:gemini finished with ${finish}${r.promptFeedback?.blockReason ? ` (blocked: ${r.promptFeedback.blockReason})` : ''}`
      : null;
    let output: GeminiVideoOutput | null = null;
    if (!fail) {
      try { output = parseVideoOutput(text); } catch (e) { fail = e instanceof Error ? e.message : String(e); }
    }
    replied = true;
    await recordAiUsage({ ...track, status: fail ? 'error' : 'ok', error: fail, inputTokens: inputTokens - Math.min(cachedTokens, inputTokens), cacheReadTokens: cachedTokens, outputTokens, costUsd, latencyMs: Date.now() - started, units: 1, unitKind: 'video', meta: { via, video_bytes: input.videoBytes, duration_ms: input.durationMs } });
    if (fail || !output) throw new Error(fail ?? 'provider:gemini reply was empty');
    return { output, model: GEMINI_VIDEO_MODEL, inputTokens, outputTokens, costUsd, latencyMs: Date.now() - started, via };
  } catch (e) {
    // A failure before any reply (upload, HTTP, timeout) is recorded here; a
    // reply was already recorded above with its tokens.
    if (!replied) await recordAiUsage({ ...track, status: 'error', error: e instanceof Error ? e.message : String(e), latencyMs: Date.now() - started });
    throw e;
  } finally {
    if (uploaded) await deleteFile(uploaded.name, pin?.key);
  }
}
