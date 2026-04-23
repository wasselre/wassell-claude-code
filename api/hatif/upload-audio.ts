/**
 * POST /api/hatif/upload-audio
 *
 * Forward a user-uploaded audio file to Hatif's
 * `POST /v1/support/upload-audio` endpoint. Hatif auto-converts to WAV 8kHz
 * mono and returns a URL we use as `audioFileUrl` on the outbound_ivr action.
 *
 * Body: `multipart/form-data` with an `audioFile` part (matches Hatif's
 * field name). Max 10 MB per Hatif's spec — we don't pre-check, let Hatif
 * reject and pass the error through.
 *
 * Response: whatever Hatif returns, typically `{ url: "..." }`.
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { uploadAudioFile, HatifError } from '../_lib/hatif.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    const ct = req.headers.get('content-type') ?? '';
    if (!ct.startsWith('multipart/form-data')) {
      return jsonError(400, 'content-type must be multipart/form-data');
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError(400, 'invalid multipart body');
    }

    const audioFile = form.get('audioFile');
    if (!audioFile || typeof audioFile === 'string') {
      return jsonError(400, 'audioFile part is required');
    }

    try {
      const result = await uploadAudioFile(form);
      return jsonOk(result);
    } catch (err) {
      if (err instanceof HatifError) {
        const status = err.status >= 500 ? 502 : err.status;
        return jsonError(status, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
