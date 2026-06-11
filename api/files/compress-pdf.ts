/**
 * POST /api/files/compress-pdf
 *
 * Body: { fileId: string, start?: boolean }
 *
 * Start/poll surface for PDF compression (Ghostscript on the Fly worker —
 * pdf_compress_jobs queue, the fourth queue alongside decks/images/previews).
 *
 *   start=true  → enqueue a compression job for the file (concurrent starts
 *                 collapse into the one active job) and return
 *                 { status: 'pending' }.
 *   start absent → report the LATEST job for the file:
 *     { status: 'none' }                    — never compressed
 *     { status: 'pending' }                 — queued or running
 *     { status: 'done', result_file_id,     — finished; result_file_id null +
 *       no_gain, original_bytes,              no_gain=true means the PDF was
 *       compressed_bytes }                    already optimized (no copy made)
 *     { status: 'failed', error }           — worker error; start again to retry
 *
 * The compression itself runs on the Fly worker — this endpoint NEVER waits
 * on it (no held HTTP for long work, same hard rule as decks/image-chats/
 * office previews). The worker creates the compressed COPY as a new files row
 * ("<name> (مضغوط).pdf") next to the original; originals are never replaced.
 *
 * Requires 'edit' access to the source file: compressing creates new content
 * in the file's folder, which is more than a viewer grant should allow.
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import {
  assertCanAccessFile,
  getJwtClient,
  getServiceClient,
  loadFileBypassRls,
  logFileActivityServer,
  wakePreviewWorker,
} from '../_lib/files.js';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let body: { fileId?: string; start?: boolean };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!body.fileId) return jsonError(400, 'fileId is required');

    const jwtClient = getJwtClient(req);
    await assertCanAccessFile(jwtClient, body.fileId, 'edit', { email: user.email });

    const file = await loadFileBypassRls(body.fileId);
    if (!file) return jsonError(404, 'file not found');
    if ((file.mime_type ?? '').toLowerCase() !== 'application/pdf') {
      return jsonError(400, 'not a PDF');
    }

    const svc = getServiceClient();

    if (body.start === true) {
      const { data: state, error: enqErr } = await svc.rpc('pdf_compress_enqueue', {
        p_file_id: file.id,
      });
      if (enqErr) return jsonError(500, `enqueue failed: ${enqErr.message}`);
      if (state === null) return jsonError(404, 'file not found');

      void logFileActivityServer({
        event_type: 'compress_start',
        summary_ar: `بدء ضغط ملف PDF: ${file.original_name}`,
        summary_en: `Started PDF compression: ${file.original_name}`,
        details: { file_id: file.id, size_bytes: file.size_bytes },
        actor_email: user.email ?? null,
        status: 'info',
      });

      wakePreviewWorker();
      return jsonOk({ status: 'pending' });
    }

    // Poll: report the latest job for this file. The table is service-role
    // only; the JWT permission check above is the access gate.
    const { data: job, error: jobErr } = await svc
      .from('pdf_compress_jobs')
      .select('status, error, result_file_id, original_bytes, compressed_bytes')
      .eq('file_id', file.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (jobErr) return jsonError(500, `job lookup failed: ${jobErr.message}`);

    if (!job) return jsonOk({ status: 'none' });
    if (job.status === 'queued' || job.status === 'running') {
      return jsonOk({ status: 'pending' });
    }
    if (job.status === 'failed') {
      return jsonOk({ status: 'failed', error: job.error ?? 'compression failed' });
    }
    return jsonOk({
      status: 'done',
      result_file_id: job.result_file_id,
      no_gain: job.result_file_id === null,
      original_bytes: job.original_bytes,
      compressed_bytes: job.compressed_bytes,
    });
  });
}
