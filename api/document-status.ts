/**
 * POST /api/document-status
 *
 * Two modes (mirrors the office-preview poll surface):
 *
 *   { jobId }              → poll one generation job:
 *       { status: 'ready', file_id, name, url, expires_at }
 *       { status: 'pending' }
 *       { status: 'failed', error }
 *
 *   { recordId }           → list the generated PDFs for a record (completed
 *                            jobs): { documents: [{ file_id, name, size_bytes,
 *                            url, created_at }] }
 *
 * Ownership is gated by SOURCE RECORD visibility under the caller's JWT (RLS on
 * unified_records). Signing the result PDF runs service-role after that gate,
 * same posture as api/files/office-preview.ts.
 */

import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import {
  getJwtClient,
  getServiceClient,
  loadFileBypassRls,
  signFileUrl,
  VIEW_URL_TTL_SECONDS,
} from './_lib/files.js';

export const config = { runtime: 'edge' };

interface Body {
  jobId?: string;
  recordId?: string;
}

function expiresAt(): string {
  return new Date(Date.now() + VIEW_URL_TTL_SECONDS * 1000).toISOString();
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async () => {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const jwtClient = getJwtClient(req);
    const svc = getServiceClient();

    // ── Mode A: poll one job ──────────────────────────────────────────
    if (body.jobId) {
      const { data: job, error } = await svc
        .from('document_jobs')
        .select('id, status, error, result_file_id, source_record_id')
        .eq('id', body.jobId)
        .maybeSingle();
      if (error) return jsonError(500, `job lookup failed: ${error.message}`);
      if (!job) return jsonError(404, 'job not found');

      // Gate: caller must be able to see the source record.
      const { data: vis } = await jwtClient
        .from('unified_records')
        .select('id')
        .eq('id', job.source_record_id)
        .maybeSingle();
      if (!vis) return jsonError(403, 'not allowed');

      if (job.status === 'completed' && job.result_file_id) {
        const file = await loadFileBypassRls(job.result_file_id);
        if (!file) return jsonError(404, 'generated file missing');
        const url = await signFileUrl(file.storage_bucket, file.storage_path, VIEW_URL_TTL_SECONDS);
        return jsonOk({ status: 'ready', file_id: job.result_file_id, name: file.original_name, url, expires_at: expiresAt() });
      }
      if (job.status === 'failed') {
        return jsonOk({ status: 'failed', error: job.error ?? 'generation failed' });
      }
      return jsonOk({ status: 'pending' });
    }

    // ── Mode B: list generated documents for a record ─────────────────
    if (body.recordId) {
      const { data: vis } = await jwtClient
        .from('unified_records')
        .select('id')
        .eq('id', body.recordId)
        .maybeSingle();
      if (!vis) return jsonError(403, 'not allowed');

      const { data: jobs, error } = await svc
        .from('document_jobs')
        .select('result_file_id, created_at')
        .eq('source_record_id', body.recordId)
        .eq('status', 'completed')
        .not('result_file_id', 'is', null)
        .order('created_at', { ascending: false });
      if (error) return jsonError(500, `job list failed: ${error.message}`);

      const ids = [...new Set((jobs ?? []).map((j) => j.result_file_id as string))];
      if (ids.length === 0) return jsonOk({ documents: [] });

      const { data: files, error: fErr } = await svc
        .from('files')
        .select('id, original_name, size_bytes, storage_bucket, storage_path, created_at')
        .in('id', ids);
      if (fErr) return jsonError(500, `file lookup failed: ${fErr.message}`);
      const fileMap = new Map((files ?? []).map((f) => [f.id as string, f]));

      const documents = (
        await Promise.all(
          ids.map(async (id) => {
            const f = fileMap.get(id);
            if (!f) return null; // deleted since
            const url = await signFileUrl(f.storage_bucket as string, f.storage_path as string, VIEW_URL_TTL_SECONDS);
            return {
              file_id: id,
              name: f.original_name as string,
              size_bytes: f.size_bytes as number,
              url,
              created_at: f.created_at as string,
            };
          }),
        )
      ).filter((x): x is NonNullable<typeof x> => x !== null);

      return jsonOk({ documents, expires_at: expiresAt() });
    }

    return jsonError(400, 'jobId or recordId is required');
  });
}
