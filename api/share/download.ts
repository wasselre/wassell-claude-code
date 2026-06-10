/**
 * POST /api/share/download  (ANONYMOUS — no withAuth)
 *
 * Body: { token: string, password?: string | null }
 *
 * Same shape as /api/share/view but the returned signed URL forces a
 * download (`?download=<name>`) and we refuse when `allow_download=false`.
 * (Note: `allow_download=false` is casual gating — a determined viewer
 * could still scrape the inline-preview URL. Document this in the PRD.)
 */

import { jsonError, jsonOk } from '../_lib/auth.js';
import {
  downloadFilenameFor,
  getAnonClient,
  getServiceClient,
  signFileUrl,
  SHARE_URL_TTL_SECONDS,
} from '../_lib/files.js';

export const config = { runtime: 'edge' };

interface SharedFileRow {
  file_id: string | null;
  original_name: string | null;
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
  if (rows.length === 0) return jsonError(404, 'link not available');
  const row = rows[0];
  if (row.requires_password) return jsonError(401, 'password required');
  if (!row.allow_download) return jsonError(403, 'downloads disabled for this link');
  if (!row.file_id) return jsonError(500, 'malformed share row');

  const svc = getServiceClient();
  const { data: fileRow, error: fileErr } = await svc
    .from('files')
    .select('storage_bucket, storage_path, original_name')
    .eq('id', row.file_id)
    .maybeSingle();
  if (fileErr || !fileRow) return jsonError(500, 'file metadata missing');

  const url = await signFileUrl(
    fileRow.storage_bucket,
    fileRow.storage_path,
    SHARE_URL_TTL_SECONDS,
    downloadFilenameFor({
      original_name: row.original_name ?? fileRow.original_name ?? 'file',
      storage_path: fileRow.storage_path,
    }),
  );

  void anon.rpc('record_shared_link_view', { p_token: body.token });
  return jsonOk({ url });
}
