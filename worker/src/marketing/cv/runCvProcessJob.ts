// ============================================================================
// cv_process job: video → Modal /process → chunked ingest → enqueue cv_analyze.
//
// Idempotent end to end: every ingest step is an upsert keyed on
// (video_id, shot_no) / (video_id, ts_ms), and Modal is idempotent per
// (video_url checksum, versions), so a retry after a mid-way crash re-runs
// safely. A `partial: true` manifest is ingested in full and the video is
// left at status='partial' with the reason in `error` — analysis still runs
// on what we have (a partial library beats an empty one).
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CvJob, CvVideoRow, ModalCvClient, ModalProcessConfig } from './types.js';
import { ingestManifest, type IngestResult } from './ingest.js';
import { readCvSettings } from './settings.js';

export interface CvProcessDeps { sb: SupabaseClient; modal: ModalCvClient }

export interface CvProcessResult extends IngestResult { video_id: string; partial: boolean; partial_reason: string | null; cost_usd: number; analyze_job_id: string | null }

export const DEFAULT_PROCESS_CONFIG: Omit<ModalProcessConfig, 'max_frames'> = { frame_interval_ms: 500, min_shot_ms: 250, ocr: true, labels: true };

export async function loadVideo(sb: SupabaseClient, videoId: string): Promise<CvVideoRow> {
  const { data, error } = await sb.from('mkt_cv_videos')
    .select('id, content_media_id, content_post_id, organization_id, owner, wassel_asset_id, source_url, duration_ms, status, shot_count, error')
    .eq('id', videoId).maybeSingle();
  if (error) throw new Error(`load mkt_cv_videos ${videoId} failed: ${error.message}`);
  if (!data) throw new Error(`permanent: mkt_cv_videos ${videoId} not found`);
  return data as CvVideoRow;
}

/**
 * Shared by cv_process (competitor videos) and cv_embed_wassel (Wassel videos):
 * call Modal, ingest, mark partial. Does NOT enqueue analysis — the callers
 * decide (competitor videos get the LLM pass; Wassel assets only need vectors).
 */
export async function processVideoThroughModal(deps: CvProcessDeps, video: CvVideoRow): Promise<Omit<CvProcessResult, 'analyze_job_id'>> {
  const { sb, modal } = deps;
  if (!video.source_url) throw new Error(`permanent: video ${video.id} has no source_url`);
  const settings = await readCvSettings(sb);

  // Honest status while the long Modal call runs (the ingest RPC also sets it,
  // but that is after Modal returns — health should show 'processing' now).
  const { error: stErr } = await sb.from('mkt_cv_videos').update({ status: 'processing', error: null, updated_at: new Date().toISOString() }).eq('id', video.id);
  if (stErr) throw new Error(`mark processing failed: ${stErr.message}`);

  const config: ModalProcessConfig = { ...DEFAULT_PROCESS_CONFIG, max_frames: settings.maxFramesPerVideo };
  const t0 = Date.now();
  const manifest = await modal.process(video.id, video.source_url, config);
  console.log(`[cv] modal /process video=${video.id} shots=${manifest.shots.length} frames=${manifest.frames.length} partial=${manifest.partial === true} cost=${manifest.cost_usd} in ${Date.now() - t0}ms`);

  if (manifest.shots.length === 0 || manifest.frames.length === 0) {
    throw new Error(`permanent: modal returned an empty manifest (shots=${manifest.shots.length} frames=${manifest.frames.length})`);
  }

  const ingested = await ingestManifest(sb, video.id, manifest);

  const partial = manifest.partial === true;
  const partialReason = partial ? (manifest.partial_reason ?? 'modal reported a partial manifest') : null;
  if (partial) {
    // finalize just set frames_done; downgrade to partial and keep the reason visible.
    const { error } = await sb.from('mkt_cv_videos').update({ status: 'partial', error: `partial: ${partialReason}`.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', video.id);
    if (error) throw new Error(`mark partial failed: ${error.message}`);
  }
  return { video_id: video.id, ...ingested, partial, partial_reason: partialReason, cost_usd: manifest.cost_usd ?? 0 };
}

export async function runCvProcessJob(deps: CvProcessDeps, job: CvJob): Promise<CvProcessResult> {
  if (!job.videoId) throw new Error('permanent: cv_process job has no video_id');
  const video = await loadVideo(deps.sb, job.videoId);
  const result = await processVideoThroughModal(deps, video);

  const priority = typeof job.params.priority === 'number' ? job.params.priority : 100;
  const { data: analyzeId, error } = await deps.sb.rpc('mkt_cv_job_enqueue', { p_kind: 'cv_analyze', p_video_id: video.id, p_frame_id: null, p_params: {}, p_priority: priority });
  if (error) throw new Error(`enqueue cv_analyze failed: ${error.message}`);
  return { ...result, analyze_job_id: typeof analyzeId === 'string' ? analyzeId : null };
}
