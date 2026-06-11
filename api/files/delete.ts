/**
 * POST /api/files/delete
 *
 * Body: { fileId: string }
 *
 * Order matters: delete the DB row FIRST (CASCADE wipes file_permissions
 * and shared_links). If that succeeds we best-effort remove the storage
 * object. Storage failure logs a warning and leaves an orphan — better
 * than the alternative (object gone, row dangling). Future GC sweep can
 * mop up orphans by storage_path mismatch.
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import {
  assertCanAccessFile,
  getJwtClient,
  getServiceClient,
  loadFileBypassRls,
  logFileActivityServer,
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
    await assertCanAccessFile(jwtClient, body.fileId, 'delete');

    const file = await loadFileBypassRls(body.fileId);
    if (!file) return jsonError(404, 'file not found');

    const svc = getServiceClient();
    const { error: rowErr } = await svc.from('files').delete().eq('id', file.id);
    if (rowErr) return jsonError(500, `file delete failed: ${rowErr.message}`);

    // Remove the original + the office-preview artifact (if one was ever
    // converted). wassel_doc sentinel paths have no storage object.
    const paths = [
      ...(file.storage_path.startsWith('doc:') ? [] : [file.storage_path]),
      ...(file.preview_storage_path ? [file.preview_storage_path] : []),
    ];
    const { error: storageErr } = paths.length
      ? await svc.storage.from(file.storage_bucket).remove(paths)
      : { error: null };
    if (storageErr) {
      console.warn('[files] storage object removal failed (row deleted, orphan left):', storageErr.message);
    }

    void logFileActivityServer({
      event_type: 'delete',
      summary_ar: `حذف ملف: ${file.original_name}`,
      summary_en: `Deleted file: ${file.original_name}`,
      details: {
        file_id: file.id,
        storage_path: file.storage_path,
        orphaned: !!storageErr,
      },
      actor_user_id: null,
      actor_email: user.email,
    });

    return jsonOk({ ok: true });
  });
}
