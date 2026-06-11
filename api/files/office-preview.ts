/**
 * POST /api/files/office-preview
 *
 * Body: { fileId: string, retry?: boolean }
 *
 * Single poll surface for office-document previews (DOC/DOCX/PPT/PPTX/
 * XLS/XLSX). The SPA calls this when the preview modal opens on an office
 * file and keeps polling while status='pending':
 *
 *   { status: 'ready',   url, expires_at }  — cached PDF exists; render it
 *   { status: 'pending' }                   — conversion queued/running
 *   { status: 'failed',  error }            — conversion failed; pass
 *                                             retry=true to clear + re-enqueue
 *
 * The conversion itself runs on the Fly worker (file_preview_jobs queue) —
 * this endpoint NEVER waits on it (no held HTTP for long work, same hard rule
 * as decks/image-chats). Enqueueing goes through the atomic
 * file_preview_enqueue RPC via service-role after the caller's access check.
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import {
  assertCanAccessFile,
  getJwtClient,
  getServiceClient,
  isOfficePreviewMime,
  loadFileBypassRls,
  signFileUrl,
  VIEW_URL_TTL_SECONDS,
  wakePreviewWorker,
} from '../_lib/files.js';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    let body: { fileId?: string; retry?: boolean };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!body.fileId) return jsonError(400, 'fileId is required');

    const jwtClient = getJwtClient(req);
    await assertCanAccessFile(jwtClient, body.fileId, 'view');

    const file = await loadFileBypassRls(body.fileId);
    if (!file) return jsonError(404, 'file not found');
    if (!isOfficePreviewMime(file.mime_type)) {
      return jsonError(400, 'not an office document');
    }

    // Cached and ready → sign the PDF artifact and return immediately.
    if (file.preview_status === 'ready' && file.preview_storage_path) {
      const url = await signFileUrl(
        file.storage_bucket,
        file.preview_storage_path,
        VIEW_URL_TTL_SECONDS,
      );
      return jsonOk({
        status: 'ready',
        url,
        expires_at: new Date(Date.now() + VIEW_URL_TTL_SECONDS * 1000).toISOString(),
      });
    }

    // Failed and the caller isn't asking for a retry → report the error.
    if (file.preview_status === 'failed' && !body.retry) {
      return jsonOk({ status: 'failed', error: file.preview_error ?? 'conversion failed' });
    }

    // Otherwise ensure a job exists (atomic; collapses concurrent calls into
    // one job) and report pending. retry=true forces past a failed state.
    const svc = getServiceClient();
    const { data: state, error: enqErr } = await svc.rpc('file_preview_enqueue', {
      p_file_id: file.id,
      p_force: body.retry === true,
    });
    if (enqErr) return jsonError(500, `enqueue failed: ${enqErr.message}`);
    if (state === null) return jsonError(404, 'file not found');

    // Race: another caller's job may have completed between our load and the
    // enqueue — the RPC then reports 'ready' and we sign on the spot.
    if (state === 'ready') {
      const fresh = await loadFileBypassRls(file.id);
      if (fresh?.preview_storage_path) {
        const url = await signFileUrl(
          fresh.storage_bucket,
          fresh.preview_storage_path,
          VIEW_URL_TTL_SECONDS,
        );
        return jsonOk({
          status: 'ready',
          url,
          expires_at: new Date(Date.now() + VIEW_URL_TTL_SECONDS * 1000).toISOString(),
        });
      }
    }

    wakePreviewWorker();
    return jsonOk({ status: 'pending' });
  });
}
