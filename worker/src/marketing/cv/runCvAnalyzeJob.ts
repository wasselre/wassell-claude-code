// ============================================================================
// cv_analyze job: for every pending shot of a video, describe its keyframes
// then analyse the shot; finish with a video-level `structure`.
//
// Resumable: shots are processed in order and each one is committed as it
// completes, so a crash, a lease expiry or a budget stop leaves the finished
// shots done and only the rest pending. Micro shots (< 400 ms — flash cuts,
// transition frames) are closed without an LLM call, summarised from their
// neighbours. The daily budget is checked BEFORE every paid call; a stop
// throws `budget_exceeded:` (terminal for the job; the video stays at
// 'analyzing' with its finished shots persisted and is re-enqueued by the
// backfill/sweep the next day).
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CvAi, CvFrameRow, CvJob, CvShotRow, ShotAnalysis, VideoStructure } from './types.js';
import { analyzeFrames } from './analyzeFrames.js';
import { analyzeShot, type ShotContext } from './analyzeShot.js';
import { checkBudget, isBudgetExceeded } from './ledger.js';
import { loadVideo } from './runCvProcessJob.js';
import { parseVector, meanEmbedding } from './embeddings.js';

export const ANALYSIS_VERSION = 'cv-analysis-1';

export interface CvAnalyzeDeps { sb: SupabaseClient; ai: CvAi }
export interface CvAnalyzeResult {
  video_id: string; shots_total: number; shots_done: number; shots_failed: number; shots_micro: number; shots_skipped: number;
  frames_described: number; cost_usd: number; status: 'analyzed' | 'partial'; stopped: string | null;
}

const SHOT_COLS = 'id, video_id, shot_no, start_ms, end_ms, duration_ms, transition_in, transition_out, is_static, is_micro, internal_change, edit_pace_local, representative_frame_id, keyframe_ids, summary, analysis, analysis_status';
const FRAME_COLS = 'id, video_id, shot_id, ts_ms, is_keyframe, public_url, ocr, labels, embedding, analysis';

export async function loadShots(sb: SupabaseClient, videoId: string): Promise<CvShotRow[]> {
  const { data, error } = await sb.from('mkt_cv_shots').select(SHOT_COLS).eq('video_id', videoId).order('shot_no', { ascending: true }).range(0, 4999);
  if (error) throw new Error(`load shots for ${videoId} failed: ${error.message}`);
  return (data ?? []).map((r) => {
    const row = r as unknown as CvShotRow & { keyframe_ids: unknown };
    return { ...row, keyframe_ids: Array.isArray(row.keyframe_ids) ? (row.keyframe_ids as string[]) : [] };
  });
}

/** The shot's keyframes (falls back to the representative frame, then to every
 *  frame of the shot) in time order. */
export async function loadShotFrames(sb: SupabaseClient, shot: CvShotRow): Promise<CvFrameRow[]> {
  const ids = shot.keyframe_ids.length ? shot.keyframe_ids : (shot.representative_frame_id ? [shot.representative_frame_id] : []);
  let q = sb.from('mkt_cv_frames').select(FRAME_COLS);
  q = ids.length ? q.in('id', ids) : q.eq('shot_id', shot.id);
  const { data, error } = await q.order('ts_ms', { ascending: true }).range(0, 199);
  if (error) throw new Error(`load frames for shot ${shot.id} failed: ${error.message}`);
  return (data ?? []).map((r) => ({ ...(r as unknown as CvFrameRow), labels: Array.isArray((r as { labels?: unknown }).labels) ? ((r as { labels: string[] }).labels) : [] }));
}

interface VideoContext { transcriptSegments: unknown[]; transcriptLanguage: string | null; contentType: string | null; campaignMessage: string | null }

/** Transcript (prefer an Arabic row) + enrichment context for the video's post. */
export async function loadVideoContext(sb: SupabaseClient, contentMediaId: string | null, contentPostId: string | null): Promise<VideoContext> {
  const ctx: VideoContext = { transcriptSegments: [], transcriptLanguage: null, contentType: null, campaignMessage: null };
  if (contentMediaId) {
    const { data, error } = await sb.from('mkt_transcripts').select('language, segments, text, created_at').eq('content_media_id', contentMediaId).eq('status', 'done').order('created_at', { ascending: false });
    if (error) throw new Error(`load transcripts failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ language: string | null; segments: unknown; text: string | null }>;
    const withSegs = rows.filter((r) => Array.isArray(r.segments) && (r.segments as unknown[]).length > 0);
    const pick = withSegs.find((r) => (r.language ?? '').toLowerCase().startsWith('ar')) ?? withSegs[0] ?? null;
    if (pick) { ctx.transcriptSegments = pick.segments as unknown[]; ctx.transcriptLanguage = pick.language; }
  }
  if (contentPostId) {
    const { data, error } = await sb.from('mkt_content_enrichment').select('result').eq('content_post_id', contentPostId).maybeSingle();
    if (error) throw new Error(`load enrichment failed: ${error.message}`);
    const result = ((data as { result?: Record<string, unknown> } | null)?.result ?? {}) as Record<string, unknown>;
    ctx.contentType = typeof result.content_type === 'string' ? result.content_type : null;
    ctx.campaignMessage = typeof result.campaign_message === 'string' ? result.campaign_message : null;
  }
  return ctx;
}

/** Micro shots are closed from neighbour context — no model call. */
export function microSummary(shot: CvShotRow, prev: string | null, next: string | null): string {
  const around = [prev ? `after: ${prev.split('\n')[0]}` : null, next ? `before: ${next.split('\n')[0]}` : null].filter(Boolean).join('; ');
  return `لقطة خاطفة (${shot.duration_ms} ms، ${shot.transition_in ?? 'cut'}→${shot.transition_out ?? 'cut'})\nMicro shot (${shot.duration_ms} ms, ${shot.transition_in ?? 'cut'}→${shot.transition_out ?? 'cut'})${around ? ` — ${around}` : ''}`;
}

/** Ordered purposes → run-length collapsed recipe + pace. Pure — tested. */
export function buildStructure(shots: readonly Pick<CvShotRow, 'is_micro' | 'analysis_status' | 'analysis' | 'duration_ms'>[], durationMs: number | null): VideoStructure {
  const purposes: string[] = [];
  let failed = 0; let micro = 0; let analyzed = 0;
  for (const s of shots) {
    if (s.is_micro) { micro++; continue; }
    if (s.analysis_status === 'failed') { failed++; continue; }
    if (s.analysis_status === 'done') { analyzed++; if (s.analysis?.purpose) purposes.push(s.analysis.purpose); }
  }
  const seq = purposes.filter((p, i) => i === 0 || purposes[i - 1] !== p);
  const cuts = Math.max(0, shots.length - 1);
  const pace = durationMs && durationMs > 0 ? Math.round((cuts / (durationMs / 60000)) * 10) / 10 : null;
  return { version: ANALYSIS_VERSION, shot_count: shots.length, micro_count: micro, analyzed_count: analyzed, failed_count: failed, duration_ms: durationMs, pace_cuts_per_min: pace, purposes, purpose_sequence: seq };
}

async function markShotFailed(sb: SupabaseClient, shotId: string, reason: string): Promise<void> {
  const { error } = await sb.from('mkt_cv_shots').update({ analysis_status: 'failed', analysis_error: reason.slice(0, 1000), updated_at: new Date().toISOString() }).eq('id', shotId);
  if (error) throw new Error(`mark shot ${shotId} failed: ${error.message}`);
}

async function closeMicroShot(sb: SupabaseClient, shot: CvShotRow, frames: readonly CvFrameRow[], prev: string | null, next: string | null): Promise<string> {
  const summary = microSummary(shot, prev, next);
  const vecs = frames.map((f) => parseVector(f.embedding)).filter((v): v is number[] => v !== null && v.length === 768);
  const [summary_ar, summary_en] = summary.split('\n') as [string, string];
  const analysis: ShotAnalysis = {
    micro: true, summary_ar, summary_en, purpose: 'feature', angle: '', camera_movement: 'static', pace: 'fast',
    pace_cpm: shot.edit_pace_local == null ? null : Number(shot.edit_pace_local), transitions: { in: shot.transition_in, out: shot.transition_out },
    visual_progression: 'flash frame / transition', emotional_effect: 'rhythm', intended_audience: '', production_method: 'edit', production_difficulty: 'easy',
    production_resources: [], reproducibility: 'easy', suitable_platforms: [], suitable_content_types: [], mood: '', confidence: 1,
  };
  const { error } = await sb.from('mkt_cv_shots').update({
    analysis, summary, tags: [], embedding_visual: meanEmbedding(vecs), analysis_status: 'done', analysis_error: null, analysis_role: { micro: true }, updated_at: new Date().toISOString(),
  }).eq('id', shot.id);
  if (error) throw new Error(`close micro shot ${shot.id} failed: ${error.message}`);
  return summary;
}

export async function runCvAnalyzeJob(deps: CvAnalyzeDeps, job: CvJob): Promise<CvAnalyzeResult> {
  const { sb } = deps;
  if (!job.videoId) throw new Error('permanent: cv_analyze job has no video_id');
  const video = await loadVideo(sb, job.videoId);
  if (!['frames_done', 'analyzing', 'analyzed', 'partial'].includes(video.status)) {
    throw new Error(`permanent: video ${video.id} is at status '${video.status}' — frames are not ingested`);
  }
  // A video that came out of processing as 'partial' keeps that label after
  // analysis: the reason (long video, Modal stopped early) is still true.
  const processPartial = video.status === 'partial' && (video.error ?? '').startsWith('partial:');

  const { error: stErr } = await sb.from('mkt_cv_videos').update({ status: 'analyzing', updated_at: new Date().toISOString() }).eq('id', video.id);
  if (stErr) throw new Error(`mark analyzing failed: ${stErr.message}`);

  const result: CvAnalyzeResult = { video_id: video.id, shots_total: 0, shots_done: 0, shots_failed: 0, shots_micro: 0, shots_skipped: 0, frames_described: 0, cost_usd: 0, status: 'analyzed', stopped: null };
  const shots = await loadShots(sb, video.id);
  result.shots_total = shots.length;
  if (shots.length === 0) throw new Error(`permanent: video ${video.id} has no shots`);
  const vctx = await loadVideoContext(sb, video.content_media_id, video.content_post_id);

  // running summaries by shot index (existing 'done' rows seed the neighbours)
  const summaries: Array<string | null> = shots.map((s) => (s.analysis_status === 'done' ? s.summary : null));

  let stopped: string | null = null;
  for (let i = 0; i < shots.length && stopped === null; i++) {
    const shot = shots[i]!;
    if (shot.analysis_status === 'done') { result.shots_skipped++; continue; }
    const prev = summaries[i - 1] ?? null;
    const next = summaries[i + 1] ?? null;
    try {
      const frames = await loadShotFrames(sb, shot);
      if (shot.is_micro) {
        summaries[i] = await closeMicroShot(sb, shot, frames, prev, next);
        shot.analysis_status = 'done';
        result.shots_micro++;
        continue;
      }
      if (frames.length === 0) {
        await markShotFailed(sb, shot.id, 'no keyframes');
        shot.analysis_status = 'failed';
        result.shots_failed++;
        continue;
      }
      await checkBudget(sb, `analyzing video ${video.id} shot ${shot.shot_no}`);
      const fr = await analyzeFrames(deps, video.id, frames);
      result.frames_described += fr.described;
      result.cost_usd += fr.cost_usd;

      await checkBudget(sb, `analyzing video ${video.id} shot ${shot.shot_no} (shot pass)`);
      const ctx: ShotContext = { ...vctx, prevSummary: prev, nextSummary: next, videoDurationMs: video.duration_ms, shotCount: shots.length };
      const sr = await analyzeShot(deps, shot, frames, ctx);
      result.cost_usd += sr.cost_usd;
      summaries[i] = sr.summary;
      shot.analysis_status = 'done';
      shot.analysis = { ...(shot.analysis ?? ({} as ShotAnalysis)), purpose: sr.purpose ?? 'feature' } as ShotAnalysis;
      result.shots_done++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isBudgetExceeded(e)) { stopped = msg; break; }
      // One bad shot (a refused image, a malformed model reply) must not sink
      // the other 40. Record it on the row and keep going; the video ends at
      // 'partial' so the failure stays visible.
      console.error(`[cv] shot ${shot.id} (#${shot.shot_no}) analysis failed: ${msg}`);
      await markShotFailed(sb, shot.id, msg);
      shot.analysis_status = 'failed';
      result.shots_failed++;
    }
  }

  if (stopped !== null) {
    // Leave the video at 'analyzing' with the reason: partial progress is on
    // the shot rows; the next day's enqueue resumes from the pending ones.
    const { error } = await sb.from('mkt_cv_videos').update({ error: stopped.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', video.id);
    if (error) throw new Error(`record budget stop failed: ${error.message}`);
    result.stopped = stopped;
    throw new Error(stopped);
  }

  const structure = buildStructure(shots, video.duration_ms);
  const finalStatus = processPartial || result.shots_failed > 0 ? 'partial' : 'analyzed';
  result.status = finalStatus;
  const patch: Record<string, unknown> = { status: finalStatus, structure, analyzed_at: new Date().toISOString(), analysis_version: ANALYSIS_VERSION, updated_at: new Date().toISOString() };
  if (!processPartial) patch.error = result.shots_failed > 0 ? `partial: ${result.shots_failed} shot(s) failed analysis` : null;
  const { error: finErr } = await sb.from('mkt_cv_videos').update(patch).eq('id', video.id);
  if (finErr) throw new Error(`finalize video ${video.id} failed: ${finErr.message}`);
  return result;
}
