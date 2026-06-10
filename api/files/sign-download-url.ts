/**
 * POST /api/files/sign-download-url
 *
 * Body: { fileId: string }
 *
 * Same as sign-view-url but the signed URL includes the `download=<name>`
 * query so the browser saves rather than inlining. Logs as 'download'.
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import {
  assertCanAccessFile,
  downloadFilenameFor,
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
    await assertCanAccessFile(jwtClient, body.fileId, 'view', { email: user.email });

    const file = await loadFileBypassRls(body.fileId);
    if (!file) return jsonError(404, 'file not found');

    const url = await signFileUrl(
      file.storage_bucket,
      file.storage_path,
      VIEW_URL_TTL_SECONDS,
      downloadFilenameFor(file),
    );

    void logFileActivityServer({
      event_type: 'download',
      summary_ar: `تنزيل ملف: ${file.original_name}`,
      summary_en: `Downloaded file: ${file.original_name}`,
      details: { file_id: file.id, size_bytes: file.size_bytes },
      actor_user_id: null,
      actor_email: user.email,
    });

    return jsonOk({ url });
  });
}
