/**
 * Shared helpers for the api/files/* and api/share/* endpoints.
 *
 * Two flavors of Supabase client live here:
 *   - getJwtClient(req): anon-key client carrying the caller's JWT. Used by
 *     the authenticated endpoints so RLS applies. Mirror of api/sign-deck-url.ts.
 *   - getServiceClient(): service-role client. Used ONLY by the share-link
 *     endpoints because (a) the caller is anonymous and (b) we mint signed
 *     URLs across user prefixes (the path's first segment is the uploader's
 *     auth.uid(), not the share-link caller's).
 *
 * Never expose the service-role key client to the browser.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AuthError } from './auth.js';

export const FILES_BUCKET = 'wassel-files';
/** Signed URLs for authenticated in-app preview. 5-minute TTL — short enough
 *  that link sharing isn't useful, long enough for one preview/download. */
export const VIEW_URL_TTL_SECONDS = 60 * 5;
/** Signed URLs for the public /share/:token route. 10-minute TTL. */
export const SHARE_URL_TTL_SECONDS = 60 * 10;

/** Office documents that get a LibreOffice→PDF preview conversion on the Fly
 *  worker. KEEP IN SYNC with worker/src/runPreviewJob.ts (the worker is a
 *  standalone package and cannot import this module). */
export const OFFICE_PREVIEW_MIMES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export function isOfficePreviewMime(mime: string | null | undefined): boolean {
  return OFFICE_PREVIEW_MIMES.has((mime ?? '').toLowerCase());
}

/** Fire-and-forget /wake ping to the Fly worker so a freshly enqueued preview
 *  job skips the 3s polling latency. Missing env or a dead worker is fine —
 *  the poll loop catches the job anyway (same posture as /api/generate-deck). */
export function wakePreviewWorker(): void {
  const base = process.env.WASSEL_DECK_WORKER_URL;
  if (!base) return;
  void fetch(`${base.replace(/\/$/, '')}/wake`, { method: 'POST' }).catch(() => {
    // Best-effort by design — the worker's poll loop is the reliable path.
  });
}

export function getJwtClient(req: Request): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new AuthError(500, 'Supabase env vars missing (URL or anon key)');
  }
  const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

let serviceClientSingleton: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (serviceClientSingleton) return serviceClientSingleton;
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new AuthError(500, 'Supabase env vars missing (URL or service key)');
  }
  serviceClientSingleton = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  return serviceClientSingleton;
}

export function getAnonClient(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new AuthError(500, 'Supabase env vars missing (URL or anon key)');
  }
  return createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
}

/** Shape of a `files.id`. Record image fields can carry legacy public-URL
 *  strings instead — those must be rejected up-front, not fed to a uuid cast. */
const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFileIdShape(value: string): boolean {
  return FILE_ID_RE.test(value);
}

/**
 * Calls the SQL `wassell_can_access_file(file_id, kind)` helper under the
 * caller's JWT. Throws AuthError(403) on false. RLS is the authoritative
 * gate; this is the explicit check we do before minting signed URLs (since
 * the signing itself runs as service-role and bypasses RLS).
 */
export async function assertCanAccessFile(
  jwtClient: SupabaseClient,
  fileId: string,
  kind: 'view' | 'edit' | 'delete',
  actor?: { email?: string | null },
): Promise<void> {
  // A non-UUID can never be a files row — fail it as a clean 400 instead of
  // letting Postgres raise a uuid-cast error that every caller would surface
  // as a confusing 500 ("permission check failed: invalid input syntax for
  // type uuid: ...").
  if (!isFileIdShape(fileId)) throw new AuthError(400, 'invalid file id (expected a files.id uuid)');
  const { data, error } = await jwtClient.rpc('wassell_can_access_file', {
    p_file_id: fileId,
    p_kind: kind,
  });
  if (error) throw new AuthError(500, `permission check failed: ${error.message}`);
  if (!data) {
    // Record the denial in the audit trail. Previously a 403 left NO server-side
    // trace, so "why can't user X open this file?" reports were un-investigable.
    // (logFileActivityServer is a function declaration below — hoisted, safe to call here.)
    void logFileActivityServer({
      event_type: 'access_denied',
      summary_ar: `رُفض الوصول إلى ملف (${kind})`,
      summary_en: `File access denied (${kind})`,
      details: { file_id: fileId, kind },
      actor_email: actor?.email ?? null,
      status: 'warning',
    });
    throw new AuthError(403, 'not allowed');
  }
}

/** Folder twin of assertCanAccessFile — calls wassell_can_access_folder under
 *  the caller's JWT before any service-role folder operation. */
export async function assertCanAccessFolder(
  jwtClient: SupabaseClient,
  folderId: string,
  kind: 'view' | 'edit' | 'delete',
): Promise<void> {
  const { data, error } = await jwtClient.rpc('wassell_can_access_folder', {
    p_folder_id: folderId,
    p_kind: kind,
  });
  if (error) throw new AuthError(500, `permission check failed: ${error.message}`);
  if (!data) throw new AuthError(403, 'not allowed');
}

export interface FileMetadata {
  id: string;
  storage_bucket: string;
  storage_path: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
  /** Office-preview cache state (2026-06-11 migration). Null = never requested. */
  preview_status: 'pending' | 'ready' | 'failed' | null;
  preview_storage_path: string | null;
  preview_error: string | null;
}

/** Load file metadata via service-role (used after a permission check passes). */
export async function loadFileBypassRls(fileId: string): Promise<FileMetadata | null> {
  const svc = getServiceClient();
  const { data, error } = await svc
    .from('files')
    .select(
      'id, storage_bucket, storage_path, original_name, mime_type, size_bytes, kind, preview_status, preview_storage_path, preview_error',
    )
    .eq('id', fileId)
    .maybeSingle();
  if (error) throw new AuthError(500, `file lookup failed: ${error.message}`);
  return (data as FileMetadata) ?? null;
}

/**
 * Build the user-facing download filename for a file.
 *
 * Rules (PRD "Download Filename Issues"):
 *   - Use the display name (original_name / renamed name), never the storage
 *     UUID. The storage_path's `<uid>/<id>.<ext>` form must never reach the user.
 *   - Guarantee the correct extension is present. The authoritative extension
 *     is the one on the storage_path (set at upload from the MIME→ext map), so
 *     a renamed-without-extension file ("Contract" ← "Contract.pdf") still
 *     downloads as "Contract.pdf" and opens in the right app.
 *   - Non-ASCII (Arabic) names pass through untouched — Supabase Storage's
 *     `download` option RFC-5987-encodes the Content-Disposition filename, so
 *     we hand it the raw UTF-8 string and let the storage server encode it.
 */
export function downloadFilenameFor(meta: { original_name: string; storage_path: string }): string {
  const name = (meta.original_name || '').trim() || 'file';
  const dot = meta.storage_path.lastIndexOf('.');
  const pathExt = dot >= 0 ? meta.storage_path.slice(dot + 1).toLowerCase() : '';
  if (!pathExt) return name;
  // Already carries the right extension (case-insensitive)? leave it alone.
  if (name.toLowerCase().endsWith(`.${pathExt}`)) return name;
  return `${name}.${pathExt}`;
}

/**
 * Mint a signed URL via the service-role client. Service role bypasses bucket
 * RLS so a permission-grantee can read a file under another user's `auth.uid()`
 * prefix. Caller must have already done the permission check.
 */
export async function signFileUrl(
  bucket: string,
  path: string,
  ttlSeconds: number,
  download?: string,
): Promise<string> {
  const svc = getServiceClient();
  const { data, error } = await svc.storage
    .from(bucket)
    .createSignedUrl(path, ttlSeconds, download ? { download } : undefined);
  if (error || !data?.signedUrl) {
    throw new AuthError(500, `signed url failed: ${error?.message ?? 'unknown'}`);
  }
  return data.signedUrl;
}

/** Server-side activity_log writer (bypasses RLS via service-role). */
export async function logFileActivityServer(input: {
  event_type: string;
  summary_ar: string;
  summary_en: string;
  details: Record<string, unknown>;
  actor_user_id?: string | null;
  actor_email?: string | null;
  status?: 'success' | 'error' | 'warning' | 'info';
}): Promise<void> {
  const svc = getServiceClient();
  const { error } = await svc.from('activity_log').insert({
    category: 'file',
    event_type: input.event_type,
    summary_ar: input.summary_ar,
    summary_en: input.summary_en,
    details: input.details,
    actor_user_id: input.actor_user_id ?? null,
    actor_email: input.actor_email ?? null,
    status: input.status ?? 'info',
  });
  if (error) {
    console.error('[files] activity log insert failed:', error.message);
  }
}
