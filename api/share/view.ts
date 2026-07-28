/**
 * POST /api/share/view  (ANONYMOUS — no withAuth)
 *
 * Body: { token: string, password?: string | null }
 *
 * Public entry point for the /share/:token page. Calls the
 * `get_shared_file(token, password)` SECURITY DEFINER RPC under the anon key,
 * which:
 *   - returns nothing if the token is missing/inactive/expired
 *   - returns one row with requires_password=true (and other fields NULL)
 *     when the link has a password and the supplied one is wrong/absent
 *   - returns one row with file metadata otherwise
 *
 * On success we mint a 10-minute signed URL via service-role and call
 * `record_shared_link_view` to bump the view counter + write an activity_log
 * entry. We never echo the token's existence — a wrong token returns the same
 * 404 as a revoked one.
 */

import { jsonError, jsonOk } from '../_lib/auth.js';
import {
  getAnonClient,
  getServiceClient,
  isOfficePreviewMime,
  signFileUrl,
  SHARE_URL_TTL_SECONDS,
  wakePreviewWorker,
} from '../_lib/files.js';

export const config = { runtime: 'edge' };

interface SharedFileRow {
  file_id: string | null;
  original_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  kind: string | null;
  allow_download: boolean;
  requires_password: boolean;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  let body: { token?: string; password?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, 'invalid JSON body');
  }
  if (!body.token) return jsonError(400, 'token is required');

  const anon = getAnonClient();
  const { data, error } = await anon.rpc('get_shared_file', {
    p_token: body.token,
    p_password: body.password ?? null,
  });
  if (error) return jsonError(500, `shared file lookup failed: ${error.message}`);

  const rows = (data ?? []) as SharedFileRow[];
  // Checking the element rather than the length narrows the type AND covers the
  // case a length check cannot: a first element that is itself absent.
  // Not found / inactive / expired all get the same uniform response.
  const row = rows[0];
  if (!row) return jsonError(404, 'link not available');
  if (row.requires_password) {
    return jsonOk({
      requires_password: true,
      allow_download: row.allow_download,
    });
  }
  if (!row.file_id) return jsonError(500, 'malformed share row');

  // Look up storage_path via service-role (anon can't read files table).
  const svc = getServiceClient();
  const { data: fileRow, error: fileErr } = await svc
    .from('files')
    .select('storage_bucket, storage_path, preview_status, preview_storage_path')
    .eq('id', row.file_id)
    .maybeSingle();
  if (fileErr || !fileRow) return jsonError(500, 'file metadata missing');

  const url = await signFileUrl(fileRow.storage_bucket, fileRow.storage_path, SHARE_URL_TTL_SECONDS);

  // Office documents: ship the cached PDF preview alongside, so the share
  // page renders inline instead of a download-only card. If the preview is
  // missing, warm it (fire-and-forget) — the NEXT viewer gets the inline
  // render. The share token already validated access; the enqueue RPC is
  // service-role-only so anon can't reach it any other way.
  let previewUrl: string | null = null;
  if (isOfficePreviewMime(row.mime_type)) {
    if (fileRow.preview_status === 'ready' && fileRow.preview_storage_path) {
      previewUrl = await signFileUrl(
        fileRow.storage_bucket,
        fileRow.preview_storage_path,
        SHARE_URL_TTL_SECONDS,
      );
    } else if (fileRow.preview_status !== 'failed') {
      void svc
        .rpc('file_preview_enqueue', { p_file_id: row.file_id, p_force: false })
        .then(({ error: enqErr }) => {
          if (enqErr) console.error('[share/view] preview warm enqueue failed:', enqErr.message);
          else wakePreviewWorker();
        });
    }
  }

  // Bump view counter + write activity_log. Fire-and-forget.
  void anon.rpc('record_shared_link_view', { p_token: body.token });

  return jsonOk({
    url,
    preview_url: previewUrl ?? undefined,
    original_name: row.original_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    kind: row.kind,
    allow_download: row.allow_download,
    expires_at: new Date(Date.now() + SHARE_URL_TTL_SECONDS * 1000).toISOString(),
  });
}
