// ============================================================================
// Raw-asset analysis: OCR / transcript / description for an uploaded file.
//
// REUSES the content pipeline's own tools rather than adding a second copy:
//   extractVisualText  (vision.ts)      — images and sampled video frames
//   transcribeAudioUrl (falTranscribe)  — video and audio
//   ffmpegMedia                         — duration, audio extraction, frames
// A second OCR implementation would be a second thing to drift, and this
// codebase has already paid for that mistake with worker/api copies.
//
// HONEST TERMINAL STATES — the whole point of the queue:
//   completed   every applicable step produced something
//   degraded    partial: e.g. frames read but the audio track was silent
//   unsupported the file type has no analyser (a PDF today) — NOT a failure
//   failed      something broke and the operator should look
// `not_attempted` is never written here; it means the asset never reached us.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { extractVisualText, classifyVisionError, MAX_IMAGES } from '../content/vision.js';
import { transcribeAudioUrl } from '../content/falTranscribe.js';
import { toTempFile, cleanup, probeDurationMs, hasAudioStream, extractAudio, sampleFrames } from '../content/ffmpegMedia.js';
import { uploadBytes } from '../content/contentStore.js';
import { sha256Hex } from '../adIntel.js';

export interface AssetProcessStats {
  asset_id: string;
  kind: 'image' | 'video' | 'audio' | 'unsupported';
  ocr_chars: number;
  transcript_chars: number;
  frames_analyzed: number;
  status: 'completed' | 'degraded' | 'unsupported' | 'failed';
  cost_usd: number;
  notes: string[];
}

const FILES_BUCKET = 'wassel-files';

function kindOf(mime: string | null): AssetProcessStats['kind'] {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'unsupported';
}

/** Short, deterministic tags from what was actually read — no model call. */
function deriveTags(text: string): string[] {
  const t = text.toLowerCase();
  const hits: Array<[RegExp, string]> = [
    [/فيلا|villa/, 'villa'], [/شقة|apartment|flat/, 'apartment'],
    [/مخطط|floor ?plan/, 'floor_plan'], [/مسبح|pool/, 'pool'],
    [/واجهة|facade|elevation/, 'facade'], [/مطبخ|kitchen/, 'kitchen'],
    [/حديقة|garden|landscape/, 'garden'], [/غرفة نوم|bedroom/, 'bedroom'],
    [/استقبال|majlis|مجلس/, 'majlis'], [/درون|drone|aerial|جوي/, 'aerial'],
    [/سعر|price|ريال|sar/, 'price_shown'], [/خصم|عرض|offer|discount/, 'offer_shown'],
  ];
  return [...new Set(hits.filter(([re]) => re.test(t)).map(([, tag]) => tag))];
}

export async function runAssetProcess(sb: SupabaseClient, assetId: string): Promise<AssetProcessStats> {
  const stats: AssetProcessStats = {
    asset_id: assetId, kind: 'unsupported', ocr_chars: 0, transcript_chars: 0,
    frames_analyzed: 0, status: 'failed', cost_usd: 0, notes: [],
  };

  const { data: asset } = await sb.from('mkt_raw_assets')
    .select('id, file_id, mime_type, asset_name, duration_ms').eq('id', assetId).maybeSingle();
  if (!asset) throw new Error(`asset not found: ${assetId}`);
  if (!asset.file_id) throw new Error(`asset ${assetId} has no file to analyse`);

  const { data: file } = await sb.from('files')
    .select('storage_bucket, storage_path, mime_type, original_name').eq('id', asset.file_id).maybeSingle();
  if (!file) throw new Error(`files row ${asset.file_id} missing for asset ${assetId}`);

  const mime = (asset.mime_type as string) ?? (file.mime_type as string) ?? null;
  stats.kind = kindOf(mime);

  if (stats.kind === 'unsupported') {
    stats.status = 'unsupported';
    stats.notes.push(`no analyser for ${mime ?? 'unknown type'}`);
    await sb.rpc('mkt_asset_processing_complete', {
      p_asset_id: assetId, p_status: 'unsupported', p_error: stats.notes[0] ?? null,
    });
    return stats;
  }

  // Bytes come from the private bucket with the worker's service role.
  const dl = await sb.storage.from((file.storage_bucket as string) ?? FILES_BUCKET)
    .download(file.storage_path as string);
  if (dl.error || !dl.data) throw new Error(`download failed: ${dl.error?.message ?? 'no data'}`);
  const bytes = Buffer.from(await dl.data.arrayBuffer());

  let ocrText = ''; let transcript = ''; let visionFailed = false;

  if (stats.kind === 'image') {
    try {
      const { results, costUsd } = await extractVisualText([{ buffer: bytes, mime }]);
      stats.cost_usd += costUsd;
      ocrText = results.map((r) => r.fields.visible_text ?? '').filter(Boolean).join(' ').trim();
      stats.ocr_chars = ocrText.length;
    } catch (e) {
      const c = classifyVisionError(e);
      visionFailed = true;
      stats.notes.push(`vision(${c.kind}): ${c.message}`);
    }
  } else {
    // video / audio → temp file, then the same helpers the post pipeline uses
    const tmp = await toTempFile(bytes, stats.kind === 'video' ? 'mp4' : 'm4a');
    try {
      const durationMs = (asset.duration_ms as number | null) ?? (await probeDurationMs(tmp.path));

      if (await hasAudioStream(tmp.path)) {
        try {
          const audio = await extractAudio(tmp.path);
          const checksum = sha256Hex(audio);
          const up = await uploadBytes(audio, 'content/audio', checksum, 'm4a', 'audio/mp4');
          const tx = await transcribeAudioUrl(up.storedUrl, durationMs);
          transcript = (tx.text ?? '').trim();
          stats.transcript_chars = transcript.length;
          stats.cost_usd += tx.costUsd;
        } catch (e) {
          stats.notes.push(`transcribe: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        // A silent clip is a FACT about the asset, not a broken step.
        stats.notes.push('no audio stream — silent asset');
      }

      if (stats.kind === 'video' && durationMs) {
        try {
          const frames = await sampleFrames(tmp.path, durationMs, Math.min(6, MAX_IMAGES));
          if (frames.length > 0) {
            const { results, costUsd } = await extractVisualText(
              frames.map((f) => ({ buffer: f.jpeg, mime: 'image/jpeg' })));
            stats.cost_usd += costUsd;
            stats.frames_analyzed = results.length;
            ocrText = results.map((r) => r.fields.visible_text ?? '').filter(Boolean).join(' ').trim();
            stats.ocr_chars = ocrText.length;
          }
        } catch (e) {
          const c = classifyVisionError(e);
          visionFailed = true;
          stats.notes.push(`vision(${c.kind}): ${c.message}`);
        }
      }
    } finally { await cleanup(tmp.dir); }
  }

  const combined = `${ocrText} ${transcript}`.trim();
  const tags = deriveTags(combined);

  // A one-line description built from what was READ, not invented: it says what
  // evidence exists, which is what a searcher actually needs.
  const description = combined
    ? `${stats.kind}${stats.frames_analyzed ? ` (${stats.frames_analyzed} frames)` : ''}: `
      + combined.slice(0, 240).replace(/\s+/g, ' ')
    : '';

  // Grade honestly: nothing read at all when something should have been read is
  // degraded, not completed.
  const expectedSomething = stats.kind === 'image'
    || stats.kind === 'audio'
    || (stats.kind === 'video');
  if (visionFailed) stats.status = 'degraded';
  else if (expectedSomething && !combined) stats.status = 'degraded';
  else if (stats.notes.length > 0) stats.status = 'degraded';
  else stats.status = 'completed';

  await sb.rpc('mkt_asset_processing_complete', {
    p_asset_id: assetId,
    p_status: stats.status,
    p_ocr_text: ocrText || null,
    p_transcript: transcript || null,
    p_ai_description: description || null,
    p_tags: tags.length ? tags : null,
    p_error: stats.notes.length ? stats.notes.slice(0, 3).join(' | ') : null,
  });

  stats.cost_usd = Math.round(stats.cost_usd * 10000) / 10000;
  return stats;
}
