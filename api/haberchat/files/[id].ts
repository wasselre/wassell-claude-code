/**
 * GET /api/haberchat/files/:id[?deviceId=<24-hex>]
 *
 * Stream a Haberchat-hosted media file back to the browser. Haberchat
 * has two file namespaces:
 *  - Account-scoped  (no deviceId): files we uploaded via POST /files.
 *    Used by the Chat Templates flow.
 *  - Device-scoped   (deviceId set): media on a delivered message
 *    (Haberchat transcodes audio/video when sending, and inbound media
 *    lives here too). Used when rendering message bubbles.
 *
 * The browser decides which path to take — MessageBubble passes the
 * conversation's device_id so bubble-media resolves correctly;
 * ChatTemplateFormPage (if it ever needs to re-download) passes no
 * deviceId so the template's own uploaded file resolves.
 *
 * The Token header is added server-side so the browser never holds it.
 */

import { withAuth, jsonError } from '../../_lib/auth.js';
import { downloadFile, HaberchatError } from '../../_lib/haberchat.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    const url = new URL(req.url);
    const match = url.pathname.match(/\/api\/haberchat\/files\/([^/]+)\/?$/);
    const fileId = match ? decodeURIComponent(match[1]) : '';
    if (!fileId) return jsonError(400, 'fileId is missing from path');
    const deviceId = url.searchParams.get('deviceId') || undefined;

    try {
      const upstream = await downloadFile(fileId, deviceId);
      // Copy through content-type + size + cache headers. Haberchat URLs
      // resolve to immutable file content so a long private cache is
      // safe and saves repeat round-trips when the user scrolls back up.
      const headers = new Headers();
      const ct = upstream.headers.get('content-type');
      if (ct) headers.set('Content-Type', ct);
      const cl = upstream.headers.get('content-length');
      if (cl) headers.set('Content-Length', cl);
      headers.set('Cache-Control', 'private, max-age=86400, immutable');
      return new Response(upstream.body, { status: 200, headers });
    } catch (err) {
      if (err instanceof HaberchatError) {
        return jsonError(err.status === 401 ? 502 : err.status, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
