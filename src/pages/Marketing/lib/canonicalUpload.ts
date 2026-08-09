/**
 * Canonical intake for the marketing library.
 *
 * ONE set of bytes, ONE identity: the file goes to the private `wassel-files`
 * bucket and gets a real `files` row; the `mos_assets` row then REFERENCES it
 * through `file_id`. Nothing is written to `marketing-assets/mos/` any more —
 * that path produced a second physical copy of every upload (~1.08 GB of
 * duplicated bytes across ~1,252 assets before this changed).
 *
 * The byte transfer, the files row, the orphan compensation and the activity
 * log all come from the generic `uploadFile` helper — this module only adds the
 * pre-flight the library needs (a bucket the intake queue can actually accept
 * into) and turns every rejection into something a marketer can act on.
 *
 * Why a pre-flight at all: `marketing-assets` is an unrestricted public bucket,
 * `wassel-files` enforces a 31-entry MIME allowlist and a 500 MB cap. Formats
 * that used to sail through (AVIF, MKV, AVI, AAC, and the design formats
 * PSD/AI/FIG/SKETCH) are NOT accepted there. Widening the allowlist is out of
 * scope, so the honest answer is a visible, specific error naming the format —
 * never a silent drop.
 */
import { MAX_FILE_BYTES, uploadFile } from '@/lib/files/client';
import type { FileRow } from '@/types/files';

/**
 * Mirror of the `wassel-files` bucket allowlist (storage.buckets.allowed_mime_types).
 * Storage remains the enforcer — this exists only so the failure is legible
 * BEFORE a 200 MB video is pushed over the wire. Keep in sync with the bucket.
 */
export const WASSEL_FILES_MIMES = new Set([
  'application/gzip',
  'application/msword',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/zip',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-m4a',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/tiff',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

/** A rejection the user can act on, in both languages. */
export class UnsupportedAssetError extends Error {
  readonly ar: string;
  readonly en: string;
  constructor(ar: string, en: string) {
    super(en);
    this.name = 'UnsupportedAssetError';
    this.ar = ar;
    this.en = en;
  }
}

/** The message for whichever language is on screen. */
export function assetErrorText(e: unknown, isAr: boolean): string {
  if (e instanceof UnsupportedAssetError) return isAr ? e.ar : e.en;
  return e instanceof Error ? e.message : String(e);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * Reject what the canonical bucket cannot hold, with a specific reason.
 * Returns nothing; throws `UnsupportedAssetError` when the file can't be taken.
 */
export function assertCanonicalUploadable(file: File): void {
  if (file.size > MAX_FILE_BYTES) {
    throw new UnsupportedAssetError(
      `«${file.name}» حجمه ${mb(file.size)} ميجابايت ويتجاوز الحد المسموح (${MAX_FILE_BYTES / 1024 / 1024} ميجابايت). اضغط الملف أو ارفعه بجودة أقل.`,
      `“${file.name}” is ${mb(file.size)} MB, over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit. Compress it or upload a lower-quality version.`,
    );
  }
  const mime = (file.type || '').toLowerCase();
  if (!mime) {
    throw new UnsupportedAssetError(
      `تعذّر التعرّف على نوع الملف «${file.name}». أعد حفظه بصيغة معروفة (JPG أو PNG أو MP4 أو PDF) ثم أعد الرفع.`,
      `The file type of “${file.name}” could not be identified. Re-save it in a known format (JPG, PNG, MP4 or PDF) and upload again.`,
    );
  }
  if (!WASSEL_FILES_MIMES.has(mime)) {
    throw new UnsupportedAssetError(
      `صيغة «${file.name}» (${mime}) غير مدعومة في مكتبة المواد. حوّلها إلى JPG أو PNG أو MP4 أو PDF ثم أعد الرفع.`,
      `“${file.name}” (${mime}) is not a supported library format. Convert it to JPG, PNG, MP4 or PDF and upload again.`,
    );
  }
}

export interface CanonicalUploadOpts {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Upload one marketing file canonically and return its `files` row.
 *
 * Failure posture: `uploadFile` already removes the just-uploaded object when
 * the `files` INSERT fails, so a partial failure leaves neither an orphaned
 * object nor an orphaned row. Every attempt mints a FRESH file id, so retrying
 * a failed upload can never collide with, or duplicate, a previous attempt's
 * object (`upsert:false` would reject a same-path rewrite anyway).
 */
export async function uploadCanonicalAsset(
  file: File,
  opts: CanonicalUploadOpts = {},
): Promise<FileRow> {
  assertCanonicalUploadable(file);
  return uploadFile(file, {
    folderId: null,
    modelId: null,
    recordId: null,
    onProgress: opts.onProgress,
    signal: opts.signal,
  });
}

/**
 * The `mos_assets` columns that describe where an asset's bytes live.
 *
 * Canonical assets carry ONLY `file_id`. `url` / `thumb_url` / `file_path` are
 * explicitly null: they are the legacy public-copy fields, and a signed URL
 * must NEVER be persisted into them (it expires in five minutes and would
 * strand the asset permanently).
 */
export function canonicalAssetFields(row: FileRow): Record<string, unknown> {
  return {
    file_id: row.id,
    url: null,
    thumb_url: null,
    file_path: null,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    original_name: row.original_name,
  };
}
