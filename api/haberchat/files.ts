/**
 * POST /api/haberchat/files
 *
 * Upload a media file (image, video, audio, document) to Haberchat.
 * The browser sends multipart/form-data with a single `file` field; we
 * forward it straight through with the Token header added server-side.
 * Returns { fileId, mime, size, filename } for the caller to embed in
 * a subsequent POST /api/haberchat/messages as `mediaFileId`.
 *
 * Size limits come from Haberchat's plan — 3 MB Professional, 10 MB
 * Business / Enterprise. Oversized uploads surface as a 400/413 from
 * Haberchat which we pass back to the browser.
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { uploadFile, HaberchatError } from '../_lib/haberchat.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    // Edge runtime gives us req.formData() natively.
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError(400, 'expected multipart/form-data with a "file" field');
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return jsonError(400, 'missing "file" field in form data');
    }
    // Rebuild a minimal FormData for Haberchat — some implementations
    // reject extra fields we don't care about.
    const out = new FormData();
    out.append('file', file, file.name);

    try {
      const result = await uploadFile(out);
      return jsonOk(result);
    } catch (err) {
      if (err instanceof HaberchatError) {
        return jsonError(err.status === 401 ? 502 : err.status, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
