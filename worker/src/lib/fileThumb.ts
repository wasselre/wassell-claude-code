/**
 * Stored poster (files.thumb_path) for a VIDEO or PDF file.
 *
 * Images are thumbnailed on the fly by Storage's image transformer; a video or
 * a PDF has nothing to transform, so without a stored poster every grid shows a
 * grey icon. This writes one small JPEG at `thumbs/<file_id>.jpg` in the file's
 * OWN bucket and points files.thumb_path at it. /api/files/sign-view-urls signs
 * it under the file's own view check.
 *
 *   video → one frame at 20% of the duration (skips fade-ins / logo cards).
 *   pdf   → page 1.
 *
 * Called from the enrichment lane for every newly uploaded file. It is
 * DECORATION: the caller catches and logs a failure and carries on with the
 * enrichment — a missing poster degrades to the kind icon, it must never fail
 * the job. Existing files were swept by scripts/backfill-file-thumbs.mjs, which
 * is also the repair tool (keep the two recipes in step).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { toTempFile, cleanup, probeDurationMs, sampleFrames, imageToBoundedJpeg } from '../marketing/content/ffmpegMedia.js';
import { pdfToImages } from '../pdfToImages.js';

const MAX_VIDEO_BYTES = 400 * 1024 * 1024;
const MAX_PDF_BYTES = 150 * 1024 * 1024;

export interface ThumbTarget {
  fileId: string;
  kind: string;
  storageBucket: string;
  storagePath: string;
  sizeBytes: number;
}

export type ThumbOutcome = 'written' | 'exists' | 'not_applicable' | 'too_large';

export async function ensureFileThumb(supabase: SupabaseClient, f: ThumbTarget): Promise<ThumbOutcome> {
  if (f.kind !== 'video' && f.kind !== 'pdf') return 'not_applicable';
  if (f.sizeBytes > (f.kind === 'video' ? MAX_VIDEO_BYTES : MAX_PDF_BYTES)) return 'too_large';

  const { data: row, error: rowErr } = await supabase.from('files').select('thumb_path').eq('id', f.fileId).maybeSingle();
  if (rowErr) throw new Error(`thumb lookup failed: ${rowErr.message}`);
  if (row?.thumb_path) return 'exists';

  const { data: blob, error: dlErr } = await supabase.storage.from(f.storageBucket).download(f.storagePath);
  if (dlErr || !blob) throw new Error(`thumb download failed: ${dlErr?.message ?? 'no data'}`);
  const bytes = Buffer.from(await blob.arrayBuffer());

  let jpeg: Buffer;
  if (f.kind === 'video') {
    const tmp = await toTempFile(bytes, 'mp4');
    try {
      const durationMs = (await probeDurationMs(tmp.path)) ?? 0;
      // sampleFrames(…, 2) → frames at 5% and 20%; prefer the later one.
      const frames = await sampleFrames(tmp.path, Math.max(durationMs, 1000), 2);
      const frame = frames[frames.length - 1];
      if (!frame) throw new Error('no frame could be read from the video');
      jpeg = frame.jpeg;
    } finally {
      await cleanup(tmp.dir);
    }
  } else {
    const pages = await pdfToImages(bytes, { dpi: 60, maxPages: 1 });
    const first = pages[0];
    if (!first) throw new Error('the PDF rendered no page');
    jpeg = await imageToBoundedJpeg(Buffer.from(first.bytes), 'png');
  }

  const thumbPath = `thumbs/${f.fileId}.jpg`;
  const { error: upErr } = await supabase.storage.from(f.storageBucket).upload(thumbPath, jpeg, { contentType: 'image/jpeg', upsert: true });
  if (upErr) throw new Error(`thumb upload failed: ${upErr.message}`);
  const { error: dbErr } = await supabase.from('files').update({ thumb_path: thumbPath }).eq('id', f.fileId);
  if (dbErr) throw new Error(`thumb_path update failed: ${dbErr.message}`);
  return 'written';
}
