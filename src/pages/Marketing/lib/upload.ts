/**
 * Browser-direct upload to the marketing-assets bucket — the engine behind
 * screen 23's intake queue.
 *
 * Files go straight from the browser to storage under `mos/<uuid>.<ext>`;
 * only the metadata row travels through /api/marketing-os afterwards. Two
 * reasons this is NOT an endpoint upload: a 1.2 GB drone clip would blow any
 * serverless body limit, and the XHR path is what gives the queue a real
 * percentage instead of a spinner.
 *
 * Storage RLS gates the write: INSERT under mos/ requires the module's
 * manage_assets capability (migration 2026-07-31_mos_asset_file_uploads).
 */
import { supabase } from '@/lib/supabase';
import { MosAsset } from '@/lib/marketingOS/client';

/** النوع يُكتشف ولا يُسأل عنه — kind is detected, correction is the exception. */
export function kindFromFile(file: File): MosAsset['kind'] {
  const mime = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (mime.startsWith('image/') || /\.(heic|heif|webp|avif)$/.test(name)) return 'photo';
  if (mime.startsWith('video/') || /\.(mov|mp4|mkv|webm|avi)$/.test(name)) return 'video';
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg)$/.test(name)) return 'audio';
  if (/\.(psd|ai|fig|sketch|afdesign)$/.test(name)) return 'design';
  return 'document';
}

/** Browsers can render these inline — used to decide thumb_url and previews. */
export function isBrowserImage(file: File): boolean {
  return /^image\/(jpeg|png|webp|gif|avif|svg\+xml)$/i.test(file.type);
}

export function formatBytes(bytes: number, isAr: boolean): string {
  const units = isAr ? ['بايت', 'كيلوبايت', 'ميجابايت', 'جيجابايت'] : ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const n = v >= 10 || u === 0 ? Math.round(v).toString() : v.toFixed(1);
  return `${n} ${units[u] ?? ''}`;
}

export interface UploadResult {
  path: string;
  publicUrl: string;
}

const BUCKET = 'marketing-assets';

/**
 * Upload one file with progress. Rejects loudly on any failure — a file that
 * silently vanished from a 184-file card offload is exactly the failure mode
 * that sends people back to Drive.
 */
export function uploadToStorage(
  file: File,
  path: string,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (!supabase) {
      reject(new Error('storage is not configured'));
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token;
      const baseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
      const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';
      if (!token || !baseUrl || !anonKey) {
        reject(new Error('storage session unavailable'));
        return;
      }

      const xhr = new XMLHttpRequest();
      const url = `${baseUrl}/storage/v1/object/${BUCKET}/${path}`;
      xhr.open('POST', url);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('apikey', anonKey);
      xhr.setRequestHeader('x-upsert', 'false');
      if (file.type) xhr.setRequestHeader('Content-Type', file.type);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({
            path,
            publicUrl: `${baseUrl}/storage/v1/object/public/${BUCKET}/${path}`,
          });
        } else {
          // Surface storage's own message (413 size cap, 42501 policy denial…)
          // rather than a generic failure.
          let message = `upload failed (${xhr.status})`;
          try {
            const body = JSON.parse(xhr.responseText) as { message?: string; error?: string };
            message = body.message ?? body.error ?? message;
          } catch {
            // Non-JSON error body — keep the status-code message. The failure
            // itself still propagates via reject below.
          }
          reject(new Error(message));
        }
      };
      xhr.onerror = () => reject(new Error('network error during upload'));
      xhr.onabort = () => reject(new Error('upload cancelled'));

      if (signal) {
        if (signal.aborted) {
          reject(new Error('upload cancelled'));
          return;
        }
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }

      xhr.send(file);
    });
  });
}

/** A storage-safe object name: uuid + the original extension. The human name
 *  lives on the asset row, never in the path. */
export function storagePath(assetId: string, fileName: string): string {
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() ?? 'bin' : 'bin';
  const safeExt = /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
  return `mos/${assetId}.${safeExt}`;
}
