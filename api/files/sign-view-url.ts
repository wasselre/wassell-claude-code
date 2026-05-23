/**
 * POST /api/files/sign-view-url
 *
 * Body: { fileId: string }
 *
 * Mints a short-lived signed URL for the file's storage object. Used by the
 * in-app preview modal. The bucket is private and the file's storage path is
 * `<uploader.auth.uid>/<file_id>.<ext>` — so anyone who is NOT the uploader
 * but has been granted access must mint via service-role (their JWT would be
 * blocked by bucket RLS otherwise). We call `wassell_can_access_file` under
 * the caller's JWT first to gate it.
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import {
  assertCanAccessFile,
  getJwtClient,
  loadFileBypassRls,
  logFileActivityServer,
  signFileUrl,
  VIEW_URL_TTL_SECONDS,
} from '../_lib/files.js';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let body: { fileId?: string };
    try {
      body = (await req.json()) as { fileId?: string };
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!body.fileId) return jsonError(400, 'fileId is required');

    const jwtClient = getJwtClient(req);
    await assertCanAccessFile(jwtClient, body.fileId, 'view');

    const file = await loadFileBypassRls(body.fileId);
    if (!file) return jsonError(404, 'file not found');

    const url = await signFileUrl(file.storage_bucket, file.storage_path, VIEW_URL_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + VIEW_URL_TTL_SECONDS * 1000).toISOString();

    void logFileActivityServer({
      event_type: 'view',
      summary_ar: `معاينة ملف: ${file.original_name}`,
      summary_en: `Previewed file: ${file.original_name}`,
      details: { file_id: file.id, mime_type: file.mime_type },
      actor_user_id: null, // app_user_id resolution happens client-side; the
      actor_email: user.email, //  email is enough for the timeline display.
    });

    return jsonOk({
      url,
      original_name: file.original_name,
      mime_type: file.mime_type,
      expires_at: expiresAt,
    });
  });
}
