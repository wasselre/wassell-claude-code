import { supabase } from './supabase';

export type ImageFolder = 'raw' | 'cleaned' | 'final' | 'reference';

const BUCKET = 'marketing-assets';

/**
 * Upload an image file to the `marketing-assets` Supabase Storage bucket
 * and return its public URL. Throws on any failure — never silently
 * swallows. Per CLAUDE.md "Silent Failures": fail loudly, never return a
 * tombstone or empty string when an upload didn't happen.
 *
 * The uploaded path is stable: `<folder>/<random-uuid>.<ext>`. We don't
 * collide-check on the assumption that `crypto.randomUUID()` is unique
 * enough — if upload returns a duplicate-key error the caller sees it.
 */
export async function uploadImage(file: File, folder: ImageFolder): Promise<string> {
  if (!supabase) {
    throw new Error('Supabase is not configured — cannot upload image.');
  }
  const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase();
  const path = `${folder}/${crypto.randomUUID()}${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, {
      contentType: file.type || 'image/png',
      upsert: false,
    });
  if (uploadError) {
    throw new Error(`Image upload failed: ${uploadError.message}`);
  }
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) {
    throw new Error('Image uploaded but public URL could not be resolved.');
  }
  return data.publicUrl;
}

/**
 * Best-effort delete of a previously-uploaded image by its public URL.
 * Throws if the URL doesn't look like one of ours; otherwise surfaces
 * any storage error from Supabase. Never silently ignores.
 */
export async function deleteImage(publicUrl: string): Promise<void> {
  if (!supabase) {
    throw new Error('Supabase is not configured — cannot delete image.');
  }
  const path = extractStoragePath(publicUrl);
  if (!path) {
    throw new Error(`Not a marketing-assets URL: ${publicUrl}`);
  }
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) {
    throw new Error(`Image delete failed: ${error.message}`);
  }
}

/**
 * Pull the bucket-relative path out of a public URL. Returns `null`
 * when the URL doesn't point at our bucket — caller decides what to do.
 */
function extractStoragePath(publicUrl: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const idx = publicUrl.indexOf(marker);
  if (idx === -1) return null;
  return publicUrl.slice(idx + marker.length);
}
