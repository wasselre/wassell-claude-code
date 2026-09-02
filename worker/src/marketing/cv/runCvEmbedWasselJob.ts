// ============================================================================
// cv_embed_wassel job (params {asset_id}): make a Wassel `mos_assets` row
// searchable in the same visual index as competitor shots — WITHOUT the LLM
// pass (Wassel assets are `usable`, not learning material; they only need
// vectors so scene_references_suggest can find "we already have this shot").
//
//   video  → mkt_cv_videos(owner='wassel', wassel_asset_id, content_media_id
//            NULL — the column is nullable UNIQUE) → Modal /process → chunked
//            ingest → per-shot embedding_visual = mean of keyframe vectors,
//            analysis_status='done', summary = asset title.
//   photo/ → Modal /embed_images([url]) → one video row (duration 0), one shot
//   design   (shot_no 0, is_micro FALSE so the default search filter keeps it),
//            one frame at ts 0 carrying the vector.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CvJob, CvVideoRow, ModalCvClient } from './types.js';
import { processVideoThroughModal } from './runCvProcessJob.js';
import { loadShots, loadShotFrames } from './runCvAnalyzeJob.js';
import { meanEmbedding, parseVector } from './embeddings.js';

export interface CvEmbedWasselDeps { sb: SupabaseClient; modal: ModalCvClient }
export interface CvEmbedWasselResult { asset_id: string; video_id: string; kind: 'video' | 'image'; shots: number; frames: number; embedded_shots: number }

interface AssetRow { id: string; kind: string; title: string; url: string | null; thumb_url: string | null; project_id: string | null; mime_type: string | null; archived_at: string | null }

async function loadAsset(sb: SupabaseClient, assetId: string): Promise<AssetRow> {
  const { data, error } = await sb.from('mos_assets').select('id, kind, title, url, thumb_url, project_id, mime_type, archived_at').eq('id', assetId).maybeSingle();
  if (error) throw new Error(`load mos_assets ${assetId} failed: ${error.message}`);
  if (!data) throw new Error(`permanent: mos_assets ${assetId} not found`);
  return data as AssetRow;
}

/** Find-or-create the owner='wassel' video row for an asset (idempotent on wassel_asset_id). */
async function ensureWasselVideo(sb: SupabaseClient, asset: AssetRow, sourceUrl: string): Promise<CvVideoRow> {
  const { data: existing, error: selErr } = await sb.from('mkt_cv_videos')
    .select('id, content_media_id, content_post_id, organization_id, owner, wassel_asset_id, source_url, duration_ms, status, shot_count, error')
    .eq('wassel_asset_id', asset.id).maybeSingle();
  if (selErr) throw new Error(`lookup wassel video failed: ${selErr.message}`);
  if (existing) {
    if ((existing as CvVideoRow).source_url !== sourceUrl) {
      const { error } = await sb.from('mkt_cv_videos').update({ source_url: sourceUrl, updated_at: new Date().toISOString() }).eq('id', (existing as CvVideoRow).id);
      if (error) throw new Error(`update wassel video url failed: ${error.message}`);
    }
    return { ...(existing as CvVideoRow), source_url: sourceUrl };
  }
  const { data, error } = await sb.from('mkt_cv_videos')
    .insert({ owner: 'wassel', wassel_asset_id: asset.id, content_media_id: null, content_post_id: null, organization_id: null, source_url: sourceUrl, status: 'queued' })
    .select('id, content_media_id, content_post_id, organization_id, owner, wassel_asset_id, source_url, duration_ms, status, shot_count, error')
    .single();
  if (error) throw new Error(`create wassel video failed: ${error.message}`);
  return data as CvVideoRow;
}

async function embedWasselVideo(deps: CvEmbedWasselDeps, asset: AssetRow, url: string): Promise<CvEmbedWasselResult> {
  const { sb } = deps;
  const video = await ensureWasselVideo(sb, asset, url);
  const processed = await processVideoThroughModal(deps, video);
  const shots = await loadShots(sb, video.id);
  let embedded = 0;
  for (const shot of shots) {
    const frames = await loadShotFrames(sb, shot);
    const vecs = frames.map((f) => parseVector(f.embedding)).filter((v): v is number[] => v !== null && v.length === 768);
    const vec = meanEmbedding(vecs);
    const { error } = await sb.from('mkt_cv_shots').update({
      embedding_visual: vec,
      summary: asset.title,
      analysis_status: 'done',
      analysis_error: vec ? null : 'no keyframe embeddings',
      analysis_role: { wassel_asset: true },
      updated_at: new Date().toISOString(),
    }).eq('id', shot.id);
    if (error) throw new Error(`write wassel shot ${shot.id} failed: ${error.message}`);
    if (vec) embedded++;
  }
  const { error: stErr } = await sb.from('mkt_cv_videos').update({ status: processed.partial ? 'partial' : 'analyzed', analyzed_at: new Date().toISOString(), analysis_version: 'wassel-embed-1', updated_at: new Date().toISOString() }).eq('id', video.id);
  if (stErr) throw new Error(`finalize wassel video failed: ${stErr.message}`);
  return { asset_id: asset.id, video_id: video.id, kind: 'video', shots: processed.shots, frames: processed.frames, embedded_shots: embedded };
}

async function embedWasselImage(deps: CvEmbedWasselDeps, asset: AssetRow, url: string): Promise<CvEmbedWasselResult> {
  const { sb, modal } = deps;
  const video = await ensureWasselVideo(sb, asset, url);
  const emb = await modal.embedImages([url]);
  const vec = emb.vectors[0];
  if (!vec || vec.length !== 768) throw new Error(`provider: modal /embed_images returned dim ${vec?.length ?? 0}, expected 768`);

  const { data: shotRow, error: shotErr } = await sb.from('mkt_cv_shots')
    .upsert({ video_id: video.id, shot_no: 0, start_ms: 0, end_ms: 0, transition_in: 'start', transition_out: 'end', is_static: true, is_micro: false, internal_change: false, summary: asset.title, embedding_visual: vec, analysis_status: 'done', analysis_error: null, analysis_role: { wassel_asset: true, image: true }, updated_at: new Date().toISOString() }, { onConflict: 'video_id,shot_no' })
    .select('id').single();
  if (shotErr) throw new Error(`upsert wassel image shot failed: ${shotErr.message}`);
  const shotId = (shotRow as { id: string }).id;

  const { data: frameRow, error: frameErr } = await sb.from('mkt_cv_frames')
    .upsert({ video_id: video.id, shot_id: shotId, frame_no: 0, ts_ms: 0, is_boundary: true, is_keyframe: true, public_url: url, embedding: vec, labels: [] }, { onConflict: 'video_id,ts_ms' })
    .select('id').single();
  if (frameErr) throw new Error(`upsert wassel image frame failed: ${frameErr.message}`);
  const frameId = (frameRow as { id: string }).id;

  const { error: linkErr } = await sb.from('mkt_cv_shots').update({ representative_frame_id: frameId, keyframe_ids: [frameId] }).eq('id', shotId);
  if (linkErr) throw new Error(`link wassel image frame failed: ${linkErr.message}`);

  const { error: vErr } = await sb.from('mkt_cv_videos').update({
    status: 'analyzed', duration_ms: 0, shot_count: 1, frame_count: 1, keyframe_count: 1, embedding_version: emb.version || emb.model,
    processed_at: new Date().toISOString(), analyzed_at: new Date().toISOString(), analysis_version: 'wassel-embed-1', error: null, updated_at: new Date().toISOString(),
  }).eq('id', video.id);
  if (vErr) throw new Error(`finalize wassel image video failed: ${vErr.message}`);
  return { asset_id: asset.id, video_id: video.id, kind: 'image', shots: 1, frames: 1, embedded_shots: 1 };
}

export async function runCvEmbedWasselJob(deps: CvEmbedWasselDeps, job: CvJob): Promise<CvEmbedWasselResult> {
  const assetId = typeof job.params.asset_id === 'string' ? job.params.asset_id : null;
  if (!assetId) throw new Error('permanent: cv_embed_wassel job has no params.asset_id');
  const asset = await loadAsset(deps.sb, assetId);
  if (asset.archived_at) throw new Error(`permanent: mos_assets ${assetId} is archived`);
  const url = asset.url ?? asset.thumb_url;
  if (!url) throw new Error(`permanent: mos_assets ${assetId} has no url`);
  if (asset.kind === 'video') return embedWasselVideo(deps, asset, url);
  if (asset.kind === 'photo' || asset.kind === 'design') return embedWasselImage(deps, asset, url);
  throw new Error(`permanent: mos_assets ${assetId} kind '${asset.kind}' is not embeddable`);
}
