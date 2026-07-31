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

/* ------------------------------------------------------------------ */
/* HEIC → JPEG                                                        */
/* ------------------------------------------------------------------ */

export function isHeic(file: File): boolean {
  return /image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/**
 * Convert a HEIC/HEIF photo to JPEG in the browser. iPhones shoot HEIC by
 * default and browsers cannot render it, so an unconverted library would show
 * grey blocks for every phone photo. The codec (~1 MB of wasm) loads on
 * demand — batches with no HEIC never pay for it.
 *
 * Throws on failure; the caller decides whether to fall back to uploading the
 * original — a failed conversion must never silently drop the file.
 */
export async function heicToJpeg(file: File): Promise<File> {
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  const blob = Array.isArray(out) ? out[0] : out;
  if (!(blob instanceof Blob)) throw new Error('HEIC conversion returned nothing');
  const newName = file.name.replace(/\.hei[cf]$/i, '') + '.jpg';
  return new File([blob], newName, { type: 'image/jpeg' });
}

/* ------------------------------------------------------------------ */
/* Folder traversal — folder names become tags                        */
/* ------------------------------------------------------------------ */

export interface PickedFile {
  file: File;
  /** Folder segments above the file, e.g. Photos/Amenities → ['Photos','Amenities']. */
  folderTags: string[];
}

/** Tags from a relative path: every folder segment, cleaned, minus the file. */
export function tagsFromPath(relativePath: string): string[] {
  return relativePath
    .split('/')
    .slice(0, -1)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '__MACOSX');
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    // .DS_Store and friends are noise, not material.
    if (!file.name.startsWith('.')) {
      out.push({ file, folderTags: tagsFromPath(`${prefix}${file.name}`) });
    }
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns batches of ≤100 — a 200-file folder needs the loop.
    for (;;) {
      const batch = await readEntries(reader);
      if (batch.length === 0) break;
      for (const child of batch) {
        await walkEntry(child, `${prefix}${entry.name}/`, out);
      }
    }
  }
}

/**
 * Everything a drop brought — plain files AND whole folders, walked
 * recursively, each file carrying its folder path as tags.
 */
export async function collectDropped(items: DataTransferItemList): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const entries: FileSystemEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile();
      if (f) looseFiles.push(f);
    }
  }
  for (const entry of entries) await walkEntry(entry, '', out);
  for (const f of looseFiles) out.push({ file: f, folderTags: [] });
  return out;
}
