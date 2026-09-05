/**
 * POST /api/careers/file-url — AUTHENTICATED + ADMIN. Mint a short-lived signed
 * url so the internal review page can view/download an applicant's CV or voice
 * recording. The `job-applications` bucket is private with no anon policy, so
 * signing must go through service-role — this endpoint gates that behind an admin
 * check by REUSING the table's RLS: it first reads the application row through
 * the caller's OWN JWT (RLS = `wassell_is_admin`), and only signs if that read
 * succeeds. A non-admin JWT sees zero rows → 403.
 *
 * Body: { id: string, kind: 'cv'|'audio', download?: boolean }  →  { url }
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { getJwtClient, getServiceClient } from '../_lib/files.js';
import { JOB_APP_BUCKET } from '../_lib/careers.js';

export const config = { runtime: 'edge' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL_SECONDS = 60 * 5;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    const body = (await req.json().catch(() => ({}))) as { id?: string; kind?: string; download?: boolean };
    const id = typeof body.id === 'string' ? body.id : '';
    const kind = body.kind === 'cv' || body.kind === 'audio' ? body.kind : '';
    if (!UUID_RE.test(id)) return jsonError(400, 'invalid id');
    if (!kind) return jsonError(400, 'invalid kind');

    // Authz via RLS: this read only returns a row for an admin JWT.
    const jwt = getJwtClient(req);
    const { data: app, error } = await jwt
      .from('job_applications')
      .select('id, full_name, cv_path, cv_name, audio_path')
      .eq('id', id)
      .maybeSingle();
    if (error) return jsonError(500, `access check failed: ${error.message}`);
    if (!app) return jsonError(403, 'not permitted');

    const path = kind === 'cv' ? (app.cv_path as string | null) : (app.audio_path as string | null);
    if (!path) return jsonError(404, `${kind} not found`);

    const opts: { download?: string } = {};
    if (body.download) {
      const ext = path.slice(path.lastIndexOf('.') + 1) || (kind === 'cv' ? 'pdf' : 'audio');
      const base = (app.full_name as string | null)?.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'applicant';
      opts.download = kind === 'cv' ? ((app.cv_name as string | null) || `${base}-cv.${ext}`) : `${base}-audio.${ext}`;
    }

    const svc = getServiceClient();
    const { data: signed, error: signErr } = await svc.storage
      .from(JOB_APP_BUCKET)
      .createSignedUrl(path, TTL_SECONDS, Object.keys(opts).length ? opts : undefined);
    if (signErr || !signed?.signedUrl) return jsonError(502, `sign failed: ${signErr?.message ?? 'no url'}`);

    return jsonOk({ url: signed.signedUrl });
  });
}
