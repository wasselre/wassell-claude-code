/**
 * POST /api/whatsapp/upload-url — mint a one-shot signed URL for uploading an
 * outbound WhatsApp attachment DIRECTLY to Supabase Storage from the browser.
 *
 * Why: attachments used to be POSTed THROUGH a Vercel function, which caps
 * request bodies at ~4.5 MB — so any real phone video failed (or was skipped by
 * the composer's old 10 MB guard). Uploading straight to storage removes Vercel
 * from the byte path entirely (the wassel-files bucket allows 500 MB), and WAHA
 * then sends the file by resolving its `wt_<path>` ref to a signed download URL
 * (api/_lib/waha.ts#resolveMediaFile).
 *
 * Returns { path, token }. The browser uploads with
 * supabase.storage.from('wassel-files').uploadToSignedUrl(path, token, file) —
 * the token authorizes that single upload, so no bucket RLS grant is needed.
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';

export const config = {
  runtime: 'edge',
};

const BUCKET = 'wassel-files';
const PREFIX = 'waha-outbound';

const EXT_OK = /^[a-z0-9]{1,8}$/i;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    const body = (await req.json().catch(() => ({}))) as { filename?: string; mime?: string };
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const mime = typeof body.mime === 'string' ? body.mime : '';

    // Derive a safe extension from the filename, then the mime, else 'bin'.
    let ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!EXT_OK.test(ext)) ext = (mime.split('/')[1] ?? '').toLowerCase();
    if (!EXT_OK.test(ext)) ext = 'bin';

    const uid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const path = `${PREFIX}/${uid}.${ext}`;

    const svc = makeServiceClient('api:wa-upload-url');
    if (!svc) return jsonError(500, 'service client unavailable');

    const { data, error } = await svc.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data?.token) return jsonError(502, `signed upload url failed: ${error?.message ?? 'no token'}`);

    return jsonOk({ path: data.path ?? path, token: data.token });
  });
}
