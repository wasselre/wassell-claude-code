/**
 * GET /api/haberchat/files/:id?deviceId=<24-hex>
 *
 * Stream a Haberchat-hosted media file back to the browser. Haberchat's
 * download endpoint is device-scoped (`GET /chat/{deviceId}/files/{id}/download`)
 * and requires the Token header, so the browser CANNOT hit it directly.
 * This proxy adds the token server-side and pipes the response through
 * without buffering.
 *
 * Used by MessageBubble to render inline media — the browser fetches the
 * file via an authenticated fetch() and creates a blob: URL for <img> /
 * <video> / <audio> / the download link.
 */

import { withAuth, jsonError } from '../../_lib/auth.js';
import { downloadFile, defaultDeviceId, HaberchatError } from '../../_lib/haberchat.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    const url = new URL(req.url);
    // Extract file id from the path — the edge runtime doesn't expose
    // Next-style dynamic params, so parse it from the URL.
    const match = url.pathname.match(/\/api\/haberchat\/files\/([^/]+)\/?$/);
    const fileId = match ? decodeURIComponent(match[1]) : '';
    if (!fileId) return jsonError(400, 'fileId is missing from path');

    const deviceId = url.searchParams.get('deviceId') ?? defaultDeviceId();
    if (!deviceId) {
      return jsonError(400, 'deviceId is required — pass ?deviceId=... or set HABERCHAT_DEFAULT_DEVICE_ID');
    }

    try {
      const upstream = await downloadFile(deviceId, fileId);
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
