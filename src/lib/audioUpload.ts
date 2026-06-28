import { supabase } from './supabase';

const BUCKET = 'marketing-assets';
const FOLDER = 'voice-notes';

/**
 * Upload a recorded audio Blob (e.g. a coaching voice note) to the
 * `marketing-assets` Supabase Storage bucket and return its public URL.
 * Mirrors `uploadImage` in imageUpload.ts. Throws on any failure — never
 * silently swallows (per CLAUDE.md "Silent Failures").
 *
 * The path is stable: `voice-notes/<random-uuid>.<ext>`.
 */
export async function uploadAudio(blob: Blob, ext: string): Promise<string> {
  if (!supabase) {
    throw new Error('Supabase is not configured — cannot upload voice note.');
  }
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
  const path = `${FOLDER}/${crypto.randomUUID()}${cleanExt}`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, {
      contentType: blob.type || 'audio/webm',
      upsert: false,
    });
  if (uploadError) {
    throw new Error(`Voice note upload failed: ${uploadError.message}`);
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) {
    throw new Error('Voice note uploaded but public URL could not be resolved.');
  }
  return data.publicUrl;
}

/**
 * Pick the best-supported MediaRecorder audio mime type for this browser,
 * plus the matching file extension. Returns an empty mimeType (let the
 * browser default) when none of the explicit candidates are supported.
 */
export function pickAudioMime(): { mimeType: string; ext: string } {
  const candidates: { mimeType: string; ext: string }[] = [
    { mimeType: 'audio/webm;codecs=opus', ext: '.webm' },
    { mimeType: 'audio/webm', ext: '.webm' },
    { mimeType: 'audio/mp4', ext: '.mp4' },
    { mimeType: 'audio/ogg;codecs=opus', ext: '.ogg' },
  ];
  if (typeof MediaRecorder !== 'undefined') {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
    }
  }
  return { mimeType: '', ext: '.webm' };
}
