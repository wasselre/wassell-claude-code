/**
 * Intake helpers for the marketing library — kind detection, HEIC conversion,
 * byte formatting and folder-drop traversal.
 *
 * NOTE (Phase 0b, 2026-08-09): the browser-direct uploader that used to live
 * here (`uploadToStorage` + `storagePath`, writing to `marketing-assets/mos/`)
 * has been REMOVED. It produced a SECOND physical copy of every library file —
 * the bytes already existed as a `files` row — which is how ~1,252 assets came
 * to hold ~1.08 GB of duplicated storage.
 *
 * Library uploads now go through `./canonicalUpload`, which puts one object in
 * the private `wassel-files` bucket and references it from `mos_assets.file_id`.
 * Do not reintroduce a public-bucket upload path here.
 */
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
