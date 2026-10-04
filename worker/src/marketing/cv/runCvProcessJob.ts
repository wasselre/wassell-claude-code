// ============================================================================
// cv_process job: one competitor video → the Gemini visual pipeline
// (gemini/process.ts) → fully analysed shots. Replaced the Modal /process +
// cv_analyze pair on 2026-10-04.
//
// Safe to re-run: the pipeline deletes the video's previous shots and frames
// before it writes the new ones.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CvAi, CvJob, CvVideoRow } from './types.js';
import { processVideoWithGemini, type GeminiProcessResult } from './gemini/process.js';

export interface CvProcessDeps { sb: SupabaseClient; ai: CvAi }

export type CvProcessResult = GeminiProcessResult;

export async function loadVideo(sb: SupabaseClient, videoId: string): Promise<CvVideoRow> {
  const { data, error } = await sb.from('mkt_cv_videos')
    .select('id, content_media_id, content_post_id, organization_id, owner, wassel_asset_id, source_url, duration_ms, status, shot_count, error')
    .eq('id', videoId).maybeSingle();
  if (error) throw new Error(`load mkt_cv_videos ${videoId} failed: ${error.message}`);
  if (!data) throw new Error(`permanent: mkt_cv_videos ${videoId} not found`);
  return data as CvVideoRow;
}

export async function runCvProcessJob(deps: CvProcessDeps, job: CvJob): Promise<CvProcessResult> {
  if (!job.videoId) throw new Error('permanent: cv_process job has no video_id');
  const video = await loadVideo(deps.sb, job.videoId);
  // One Gemini call analyses the whole video; there is no cv_analyze step after it.
  return processVideoWithGemini(deps, video, { analyze: true });
}
