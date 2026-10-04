// ============================================================================
// cv_embed_wassel job (params {asset_id}): make a Wassel `mos_assets` row
// searchable in the same visual index as competitor shots — WITHOUT the LLM
// pass (Wassel assets are `usable`, not learning material; they only need
// vectors so scene_references_suggest can find "we already have this shot").
//
//   video  → mkt_cv_videos(owner='wassel', wassel_asset_id, content_media_id
//            NULL — the column is nullable UNIQUE) → the Gemini pipeline with
//            analyze=false (ffmpeg cuts + keyframes + Gemini image vectors, NO
//            model call) → per-shot embedding_visual = mean of keyframe
//            vectors, analysis_status='done', summary = asset title.
//   photo/ → embed('embed_image', [url]) (Gemini) → one video row (duration 0), one shot
//   design   (shot_no 0, is_micro FALSE so the default search filter keeps it),
//            one frame at ts 0 carrying the vector.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CvAi, CvJob, CvVideoRow } from './types.js';
import { processVideoWithGemini } from './gemini/process.js';
import { VISUAL_DIM } from '../../ai/providers/geminiEmbed.js';

export interface CvEmbedWasselDeps { sb: SupabaseClient; ai: CvAi }
export interface CvEmbedWasselResult { asset_id: string; video_id: string; kind: 'video' | 'image'; shots: number; frames: number; embedded_shots: number }

interface AssetRow { id: string; kind: string; title: string; url: string | null; thumb_url: string | null; project_id: string | null; mime_type: string | null; file_id: string | null; archived_at: string | null }

async function loadAsset(sb: SupabaseClient, assetId: string): Promise<AssetRow> {
  const { data, error } = await sb.from('mos_assets').select('id, kind, title, url, thumb_url, project_id, mime_type, file_id, archived_at').eq('id', assetId).maybeSingle();
  if (error) throw new Error(`load mos_assets ${assetId} failed: ${error.message}`);
  if (!data) throw new Error(`permanent: mos_assets ${assetId} not found`);
  return data as AssetRow;
}

const DIRECT_MEDIA = /\.(mp4|mov|webm|m4v|jpg|jpeg|png|webp|gif)(\?|$)/i;

/**
 * A URL the worker can actually download. OUR videos live PRIVATE in wassel-files
 * (no public url), so we mint a short-lived SIGNED url at process time — allowed
 * for our own assets (the "public only / no signed urls" rule was for COMPETITOR
 * videos). Photos usually already carry a public image url; use it directly.
 * A YouTube/page url (no direct-media extension, no file) is not fetchable here.
 */
async function resolveWasselSource(sb: SupabaseClient, asset: AssetRow): Promise<string | null> {
  if (asset.url && DIRECT_MEDIA.test(asset.url)) return asset.url;
  if (asset.file_id) {
    const { data: file, error } = await sb.from('files').select('storage_bucket, storage_path').eq('id', asset.file_id).maybeSingle();
    if (error) throw new Error(`resolve file ${asset.file_id} failed: ${error.message}`);
    const path = (file as { storage_bucket: string | null; storage_path: string | null } | null)?.storage_path;
    if (path) {
      const bucket = (file as { storage_bucket: string | null }).storage_bucket ?? 'wassel-files';
      const signed = await sb.storage.from(bucket).createSignedUrl(path, 7200);
      if (signed.error || !signed.data?.signedUrl) throw new Error(`sign asset ${asset.id} failed: ${signed.error?.message ?? 'no url'}`);
      return signed.data.signedUrl;
    }
  }
  // last resort for images with a non-standard-extension public url / thumbnail
  return asset.url ?? asset.thumb_url;
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
  const video = await ensureWasselVideo(deps.sb, asset, url);
  const r = await processVideoWithGemini(deps, video, { analyze: false, title: asset.title });
  return { asset_id: asset.id, video_id: video.id, kind: 'video', shots: r.shots, frames: r.frames, embedded_shots: r.shots };
}

async function embedWasselImage(deps: CvEmbedWasselDeps, asset: AssetRow, url: string): Promise<CvEmbedWasselResult> {
  const { sb, ai } = deps;
  const video = await ensureWasselVideo(sb, asset, url);
  const emb = await ai.embed('embed_image', { image_urls: [url] });
  const vec = emb.vectors[0];
  if (!vec || vec.length !== VISUAL_DIM) throw new Error(`provider:gemini embed_image returned dim ${vec?.length ?? 0}, expected ${VISUAL_DIM}`);

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
    processed_at: new Date().toISOString(), analyzed_at: new Date().toISOString(), analysis_version: 'wassel-embed-gemini-1', error: null, updated_at: new Date().toISOString(),
  }).eq('id', video.id);
  if (vErr) throw new Error(`finalize wassel image video failed: ${vErr.message}`);
  return { asset_id: asset.id, video_id: video.id, kind: 'image', shots: 1, frames: 1, embedded_shots: 1 };
}

export async function runCvEmbedWasselJob(deps: CvEmbedWasselDeps, job: CvJob): Promise<CvEmbedWasselResult> {
  const assetId = typeof job.params.asset_id === 'string' ? job.params.asset_id : null;
  if (!assetId) throw new Error('permanent: cv_embed_wassel job has no params.asset_id');
  const asset = await loadAsset(deps.sb, assetId);
  if (asset.archived_at) throw new Error(`permanent: mos_assets ${assetId} is archived`);
  const url = await resolveWasselSource(deps.sb, asset);
  if (!url) throw new Error(`permanent: mos_assets ${assetId} has no fetchable source`);
  if (asset.kind === 'video') return embedWasselVideo(deps, asset, url);
  if (asset.kind === 'photo' || asset.kind === 'design') return embedWasselImage(deps, asset, url);
  throw new Error(`permanent: mos_assets ${assetId} kind '${asset.kind}' is not embeddable`);
}
