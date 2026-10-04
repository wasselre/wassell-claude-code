// ============================================================================
// The Gemini visual pipeline for ONE video (replaced Modal on 2026-10-04).
//
//   download → probe → ffmpeg hard cuts → silent copy
//     analyze=true  (competitor videos): ONE Gemini 3.8 Flash call returns the
//                   shots, their on-screen text and the creative reading
//     analyze=false (our own videos):    shots come from the cuts alone
//   → keyframes (JPEG, 1 per shot, 3 for shots over 6 s) → public bucket
//   → Gemini embeddings: each keyframe (768, visual space) and, when analysed,
//     each shot's words (1024, text space)
//   → reset the video's old rows → mkt_cv_ingest_manifest / _frames /
//     finalize_video (the same RPCs Modal fed) → per-shot analysis + vectors
//   → video status analyzed | partial, structure, cost ledger.
//
// It writes the SAME tables and analysis keys as before, so the Visual
// library, the drawer and mkt_cv_search work unchanged. There is no separate
// cv_analyze step any more: the video is fully analysed when this returns.
//
// Re-running is safe: the video's previous shots / frames are deleted first
// (mkt_cv_reset_video) and its old frame images under content/frame/<id>/ that
// the new run did not rewrite are removed from the bucket.
// ============================================================================
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CvAi, CvShotRow, CvVideoRow, ShotAnalysis, ShotAnalyzerOutput, TranscriptSegment, VideoStructure } from '../types.js';
import { coerceShotAnalysis, embeddingText, summaryColumn } from '../analyzeShot.js';
import { loadVideoContext } from '../runCvAnalyzeJob.js';
import { segmentsForShot } from '../evidence.js';
import { meanEmbedding } from '../embeddings.js';
import { addCost, checkBudget } from '../ledger.js';
import { readCvSettings } from '../settings.js';
import { analyzeVideoWithGemini, ANALYSIS_VERSION_GEMINI, GEMINI_VIDEO_MODEL, type GeminiShot } from './geminiVideo.js';
import { detectCuts, downloadToFile, extractFrame, jpegSize, probeVideo, silentCopy } from './media.js';
import { keyframeTimes, normalizeShots, paceCutsPerMin, shotsFromCuts, type NormalizedShot } from './shots.js';

export const FRAME_BUCKET = 'marketing-assets';
export const DETECTOR_VERSION = 'ffmpeg-scdet-1';
export const EMBEDDING_VERSION = 'gemini-embedding-2';
/** Longer videos are analysed up to this point and marked partial. */
export const MAX_ANALYZED_MS = 15 * 60_000;
const FRAME_CHUNK = 150;
const UPLOAD_CONCURRENCY = 6;

export interface GeminiProcessDeps { sb: SupabaseClient; ai: CvAi }
export interface GeminiProcessOptions {
  /** true = one Gemini call describes every shot (competitor videos). */
  analyze: boolean;
  /** Used as every shot's summary when analyze=false (our own asset's title). */
  title?: string | null;
}
export interface GeminiProcessResult {
  video_id: string;
  shots: number;
  frames: number;
  keyframes: number;
  partial: boolean;
  partial_reason: string | null;
  cost_usd: number;
  gemini_via: 'inline' | 'file' | null;
}

interface PlannedShot {
  shot_no: number;
  start_ms: number;
  end_ms: number;
  transition_in: string;
  transition_out: string;
  internal_change: boolean;
  gemini: GeminiShot | null;
  keyframes: number[];
}

interface PlannedFrame { ts_ms: number; shot_no: number; path: string; url: string; width: number | null; height: number | null; bytes: number }

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** When two Gemini shots collapse into one, keep the first's reading and every line of text. */
function mergeShots(kept: GeminiShot, dropped: GeminiShot): GeminiShot {
  const text = [...strList(kept.on_screen_text)];
  for (const t of strList(dropped.on_screen_text)) if (!text.includes(t)) text.push(t);
  return { ...kept, end_s: dropped.end_s, on_screen_text: text };
}

/** Gemini's shot → the ShotAnalyzerOutput the drawer contract (coerceShotAnalysis) expects. */
export function toAnalyzerOutput(g: GeminiShot): ShotAnalyzerOutput {
  return {
    summary_ar: String(g.summary_ar ?? ''),
    summary_en: String(g.summary_en ?? ''),
    purpose: String(g.purpose ?? ''),
    angle: String(g.angle ?? ''),
    camera_movement: String(g.camera_movement ?? ''),
    pace: (g.pace as ShotAnalyzerOutput['pace']) ?? 'medium',
    // Not asked of Gemini — nothing reads them (checked 2026-10-04); kept empty for the contract.
    visual_progression: '',
    emotional_effect: '',
    intended_audience: '',
    production_method: String(g.production_method ?? ''),
    production_difficulty: (g.production_difficulty as ShotAnalyzerOutput['production_difficulty']) ?? 'moderate',
    production_resources: strList(g.production_resources),
    reproducibility: (g.reproducibility as ShotAnalyzerOutput['reproducibility']) ?? 'moderate',
    suitable_platforms: strList(g.suitable_platforms),
    suitable_content_types: [],
    mood: String(g.mood ?? ''),
    confidence: Number(g.confidence),
    tags: strList(g.tags),
  };
}

function footageOf(v: unknown): ShotAnalysis['footage'] {
  return v === 'real' || v === 'cgi' || v === 'mixed' || v === 'graphic' ? v : undefined;
}

async function setVideo(sb: SupabaseClient, id: string, patch: Record<string, unknown>, what: string): Promise<void> {
  const { error } = await sb.from('mkt_cv_videos').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`${what} failed: ${error.message}`);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  }));
  return out;
}

/** Remove frame images of this video that the new run did not write (old Modal .webp frames). */
async function pruneOldFrames(sb: SupabaseClient, videoId: string, keep: ReadonlySet<string>): Promise<number> {
  const prefix = `content/frame/${videoId}`;
  const stale: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb.storage.from(FRAME_BUCKET).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`list ${prefix} failed: ${error.message}`);
    for (const o of data ?? []) { const p = `${prefix}/${o.name}`; if (!keep.has(p)) stale.push(p); }
    if (!data || data.length < 1000) break;
  }
  for (let i = 0; i < stale.length; i += 500) {
    const { error } = await sb.storage.from(FRAME_BUCKET).remove(stale.slice(i, i + 500));
    if (error) throw new Error(`remove stale frames under ${prefix} failed: ${error.message}`);
  }
  return stale.length;
}

export async function processVideoWithGemini(deps: GeminiProcessDeps, video: CvVideoRow, opts: GeminiProcessOptions): Promise<GeminiProcessResult> {
  const { sb, ai } = deps;
  if (!video.source_url) throw new Error(`permanent: video ${video.id} has no source_url`);
  const settings = await readCvSettings(sb);
  if (opts.analyze) await checkBudget(sb, `processing video ${video.id}`);

  await setVideo(sb, video.id, { status: 'processing', error: null }, 'mark processing');
  const dir = await mkdtemp(join(tmpdir(), 'cv-gemini-'));
  let costUsd = 0;
  try {
    // ── 1. media ────────────────────────────────────────────────────────────
    const src = join(dir, 'src');
    await downloadToFile(video.source_url, src);
    const probe = await probeVideo(src);
    const partial = probe.durationMs > MAX_ANALYZED_MS;
    const durationMs = Math.min(probe.durationMs, MAX_ANALYZED_MS);
    const partialReason = partial ? `video is ${Math.round(probe.durationMs / 60000)} min; the first ${MAX_ANALYZED_MS / 60000} min were analysed` : null;
    const silent = await silentCopy(src, dir, durationMs);
    const cuts = (await detectCuts(silent.path)).filter((c) => c.t_ms < durationMs);

    // ── 2. shots ────────────────────────────────────────────────────────────
    let planned: PlannedShot[];
    let videoSummary: { ar: string; en: string } | null = null;
    let transcriptSegments: readonly unknown[] = [];
    let geminiVia: 'inline' | 'file' | null = null;
    if (opts.analyze) {
      const ctx = await loadVideoContext(sb, video.content_media_id, video.content_post_id);
      transcriptSegments = ctx.transcriptSegments;
      const transcript: TranscriptSegment[] = segmentsForShot(ctx.transcriptSegments, 0, durationMs);
      const res = await analyzeVideoWithGemini({
        videoPath: silent.path, videoBytes: silent.bytes, videoId: video.id, durationMs, cuts, transcript,
        transcriptLanguage: ctx.transcriptLanguage, contentType: ctx.contentType, campaignMessage: ctx.campaignMessage,
        partialNote: partial ? `Only the first ${MAX_ANALYZED_MS / 60000} minutes are shown.` : null,
      });
      geminiVia = res.via;
      costUsd += res.costUsd;
      await addCost(sb, 'cv_process', video.id, { role: 'shot_analyzer', provider: 'gemini', model: res.model, version: ANALYSIS_VERSION_GEMINI, cost_usd: res.costUsd, latency_ms: res.latencyMs });
      const norm: NormalizedShot<GeminiShot>[] = normalizeShots(res.output.shots, durationMs, cuts, mergeShots);
      if (norm.length === 0) throw new Error('provider:gemini returned no usable shots');
      videoSummary = { ar: res.output.summary_ar.trim(), en: res.output.summary_en.trim() };
      planned = norm.map((n) => ({ shot_no: n.shot_no, start_ms: n.start_ms, end_ms: n.end_ms, transition_in: n.transition_in, transition_out: n.transition_out, internal_change: n.internal_change, gemini: n.data, keyframes: keyframeTimes(n.start_ms, n.end_ms) }));
    } else {
      planned = shotsFromCuts(durationMs, cuts).map((s, i, all) => ({ ...s, transition_in: i === 0 ? 'start' : 'cut', transition_out: i === all.length - 1 ? 'end' : 'cut', internal_change: false, gemini: null, keyframes: keyframeTimes(s.start_ms, s.end_ms) }));
    }
    // Frame budget: drop the extra (quarter-point) keyframes first, never a shot's middle one.
    let total = planned.reduce((n, s) => n + s.keyframes.length, 0);
    for (const s of planned) {
      if (total <= settings.maxFramesPerVideo) break;
      if (s.keyframes.length > 1) { total -= s.keyframes.length - 1; s.keyframes = [s.keyframes[Math.floor(s.keyframes.length / 2)]!]; }
    }

    // ── 3. keyframes → bucket ───────────────────────────────────────────────
    const jobs = planned.flatMap((s) => s.keyframes.map((ts) => ({ ts, shot_no: s.shot_no })));
    const frames: PlannedFrame[] = await mapLimit(jobs, UPLOAD_CONCURRENCY, async ({ ts, shot_no }) => {
      const buf = await extractFrame(silent.path, ts, join(dir, `f${ts}.jpg`));
      const path = `content/frame/${video.id}/${String(ts).padStart(7, '0')}.jpg`;
      const { error } = await sb.storage.from(FRAME_BUCKET).upload(path, buf, { contentType: 'image/jpeg', upsert: true });
      if (error) throw new Error(`upload ${path} failed: ${error.message}`);
      const url = sb.storage.from(FRAME_BUCKET).getPublicUrl(path).data.publicUrl;
      const size = jpegSize(buf);
      return { ts_ms: ts, shot_no, path, url, width: size?.width ?? null, height: size?.height ?? null, bytes: buf.length };
    });

    // ── 4. embeddings ───────────────────────────────────────────────────────
    const img = await ai.embed('embed_image', { image_urls: frames.map((f) => f.url) });
    if (img.vectors.length !== frames.length) throw new Error(`provider:gemini embed_image returned ${img.vectors.length} vectors for ${frames.length} frames`);
    if (typeof img.cost_usd === 'number') {
      costUsd += img.cost_usd;
      await addCost(sb, 'embed', video.id, { role: 'embed_image', provider: img.provider ?? 'gemini', model: img.model, version: img.version, cost_usd: img.cost_usd, latency_ms: 0 });
    }
    const frameVec = new Map<number, number[]>();
    frames.forEach((f, i) => frameVec.set(f.ts_ms, img.vectors[i]!));

    const shotText = planned.map((s) => {
      const g = s.gemini;
      const segs = segmentsForShot(transcriptSegments, s.start_ms, s.end_ms);
      const ocr = g ? strList(g.on_screen_text).map((t) => t.trim()).filter(Boolean).join('\n') : '';
      return { segs, transcript: segs.map((x) => x.text).join(' '), ocr };
    });
    let textVecs: number[][] = [];
    if (opts.analyze) {
      const texts = planned.map((s, i) => embeddingText({ ar: s.gemini?.summary_ar ?? '', en: s.gemini?.summary_en ?? '' }, shotText[i]!.ocr, shotText[i]!.transcript));
      const tx = await ai.embed('embed_text', { texts });
      if (tx.vectors.length !== texts.length) throw new Error(`provider:gemini embed_text returned ${tx.vectors.length} vectors for ${texts.length} shots`);
      textVecs = tx.vectors;
      if (typeof tx.cost_usd === 'number') {
        costUsd += tx.cost_usd;
        await addCost(sb, 'embed', video.id, { role: 'embed_text', provider: tx.provider ?? 'gemini', model: tx.model, version: tx.version, cost_usd: tx.cost_usd, latency_ms: 0 });
      }
    }

    // ── 5. write ────────────────────────────────────────────────────────────
    const { error: resetErr } = await sb.rpc('mkt_cv_reset_video', { p_video_id: video.id });
    if (resetErr) throw new Error(`mkt_cv_reset_video failed: ${resetErr.message}`);
    const manifest = {
      video: { duration_ms: durationMs, fps: probe.fps, width: probe.width, height: probe.height, detector_version: DETECTOR_VERSION, embedding_version: EMBEDDING_VERSION, ocr_engine: opts.analyze ? GEMINI_VIDEO_MODEL : null },
      shots: planned.map((s) => ({ shot_no: s.shot_no, start_ms: s.start_ms, end_ms: s.end_ms, transition_in: s.transition_in, transition_out: s.transition_out, is_static: false, internal_change: s.internal_change })),
    };
    const { error: manErr } = await sb.rpc('mkt_cv_ingest_manifest', { p_video_id: video.id, p_manifest: manifest });
    if (manErr) throw new Error(`mkt_cv_ingest_manifest failed: ${manErr.message}`);

    const frameRows = frames.map((f, i) => ({
      frame_no: i, ts_ms: f.ts_ms, shot_no: f.shot_no, is_boundary: false, phash: null, storage_path: f.path, public_url: f.url,
      width: f.width, height: f.height, bytes: f.bytes, quality: null,
      // Gemini reads text per SHOT, not per frame: each keyframe carries its shot's lines.
      ocr: shotText[f.shot_no]!.ocr ? { text: shotText[f.shot_no]!.ocr, engine: GEMINI_VIDEO_MODEL, scope: 'shot' } : null,
      labels: [], embedding: frameVec.get(f.ts_ms),
    }));
    for (let i = 0; i < frameRows.length; i += FRAME_CHUNK) {
      const { error } = await sb.rpc('mkt_cv_ingest_frames', { p_video_id: video.id, p_frames: frameRows.slice(i, i + FRAME_CHUNK) });
      if (error) throw new Error(`mkt_cv_ingest_frames failed: ${error.message}`);
    }
    const shotKeyframes = planned.map((s) => ({ shot_no: s.shot_no, representative_ts_ms: s.keyframes[Math.floor(s.keyframes.length / 2)], keyframe_ts_ms: s.keyframes }));
    const { error: finErr } = await sb.rpc('mkt_cv_finalize_video', { p_video_id: video.id, p_groups: [], p_shot_keyframes: shotKeyframes, p_cost_usd: 0 });
    if (finErr) throw new Error(`mkt_cv_finalize_video failed: ${finErr.message}`);

    const { data: shotRows, error: shotErr } = await sb.from('mkt_cv_shots').select('id, shot_no, transition_in, transition_out, edit_pace_local, is_micro').eq('video_id', video.id).order('shot_no');
    if (shotErr) throw new Error(`reload shots failed: ${shotErr.message}`);
    const byNo = new Map((shotRows ?? []).map((r) => [(r as { shot_no: number }).shot_no, r as Pick<CvShotRow, 'id' | 'shot_no' | 'transition_in' | 'transition_out' | 'edit_pace_local' | 'is_micro'>]));

    const purposes: string[] = [];
    for (const s of planned) {
      const row = byNo.get(s.shot_no);
      if (!row) throw new Error(`shot ${s.shot_no} of video ${video.id} was not ingested`);
      const vecs = s.keyframes.map((t) => frameVec.get(t)).filter((v): v is number[] => Array.isArray(v));
      const patch: Record<string, unknown> = { embedding_visual: meanEmbedding(vecs), analysis_status: 'done', analysis_error: null, updated_at: new Date().toISOString() };
      if (s.gemini) {
        const { analysis, tags } = coerceShotAnalysis(toAnalyzerOutput(s.gemini), row);
        const full: ShotAnalysis = { ...analysis, footage: footageOf(s.gemini.footage), continuous_take: s.internal_change };
        purposes.push(analysis.purpose);
        const t = shotText[s.shot_no]!;
        Object.assign(patch, {
          analysis: full,
          summary: summaryColumn({ ar: analysis.summary_ar, en: analysis.summary_en }),
          tags,
          ocr_text: t.ocr || null,
          transcript_text: t.transcript || null,
          transcript_segments: t.segs,
          embedding_text: textVecs[s.shot_no] ?? null,
          analysis_cost_usd: 0,
          analysis_role: { pipeline: ANALYSIS_VERSION_GEMINI, model: GEMINI_VIDEO_MODEL, embed: EMBEDDING_VERSION },
        });
      } else {
        Object.assign(patch, { summary: opts.title ?? null, analysis_role: { pipeline: 'wassel-embed-gemini-1', embed: EMBEDDING_VERSION } });
      }
      const { error } = await sb.from('mkt_cv_shots').update(patch).eq('id', row.id);
      if (error) throw new Error(`write shot ${s.shot_no} of video ${video.id} failed: ${error.message}`);
    }

    // ── 6. finish ───────────────────────────────────────────────────────────
    const seq = purposes.filter((p, i) => i === 0 || purposes[i - 1] !== p);
    const micro = [...byNo.values()].filter((r) => r.is_micro).length;
    const structure: VideoStructure & { summary_ar?: string; summary_en?: string; pipeline: string } = {
      version: opts.analyze ? ANALYSIS_VERSION_GEMINI : 'wassel-embed-gemini-1',
      pipeline: 'gemini',
      shot_count: planned.length,
      micro_count: micro,
      analyzed_count: opts.analyze ? planned.length : 0,
      failed_count: 0,
      duration_ms: durationMs,
      pace_cuts_per_min: paceCutsPerMin(planned.map((s) => s.start_ms), cuts, durationMs),
      purposes,
      purpose_sequence: seq,
      ...(videoSummary ? { summary_ar: videoSummary.ar, summary_en: videoSummary.en } : {}),
    };
    await setVideo(sb, video.id, {
      status: partial ? 'partial' : 'analyzed',
      error: partial ? `partial: ${partialReason}` : null,
      structure,
      analyzed_at: new Date().toISOString(),
      analysis_version: structure.version,
    }, 'finalize video');

    const pruned = await pruneOldFrames(sb, video.id, new Set(frames.map((f) => f.path)));
    if (pruned > 0) console.log(`[cv] video=${video.id} removed ${pruned} old frame image(s)`);
    console.log(`[cv] gemini video=${video.id} shots=${planned.length} frames=${frames.length} cuts=${cuts.length} via=${geminiVia ?? '-'} cost=$${costUsd.toFixed(4)}${partial ? ' PARTIAL' : ''}`);
    return { video_id: video.id, shots: planned.length, frames: frames.length, keyframes: frames.length, partial, partial_reason: partialReason, cost_usd: Math.round(costUsd * 1e6) / 1e6, gemini_via: geminiVia };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((e: unknown) => console.error(`[cv] temp cleanup of ${dir} failed:`, e));
  }
}
