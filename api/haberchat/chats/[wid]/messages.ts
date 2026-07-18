/**
 * GET /api/haberchat/chats/:wid/messages?deviceId=...&size=50&before=<ISO>
 *
 * Proxies Haberchat's `GET /chat/{deviceId}/chats/{chatWid}/sync` to load
 * a page of messages for one conversation. The `before` cursor lets the
 * UI paginate backwards through history (intersection observer at the top
 * of the thread). Missing deviceId falls back to HABERCHAT_DEFAULT_DEVICE_ID.
 */

import { withAuth, jsonOk, jsonError } from '../../../_lib/auth.js';
import { listMessages, defaultDeviceId, HaberchatError } from '../../../_lib/whatsappGateway.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    const url = new URL(req.url);

    // Extract chatWid from the path. Vercel routes `api/haberchat/chats/[wid]/messages.ts`
    // to a wildcard match; the dynamic segment is in `req.url.pathname`.
    // We pull it from the URL rather than relying on params because the edge
    // runtime's request object doesn't expose Next-style params.
    const match = url.pathname.match(/\/api\/haberchat\/chats\/([^/]+)\/messages\/?$/);
    const chatWid = match ? decodeURIComponent(match[1]) : '';
    if (!chatWid) {
      return jsonError(400, 'chatWid is missing from path');
    }

    const deviceId = url.searchParams.get('deviceId') ?? defaultDeviceId();
    if (!deviceId) {
      return jsonError(
        400,
        'deviceId is required — pass ?deviceId=... or set HABERCHAT_DEFAULT_DEVICE_ID',
      );
    }

    // Min 50: Haberchat 400s /sync when size < 50 (verified 2026-07-12).
    const size = clampInt(url.searchParams.get('size'), 50, 200, 50);
    const before = url.searchParams.get('before') ?? undefined;

    try {
      const messages = await listMessages(deviceId, chatWid, { size, before });
      // hasMore is a best-effort hint — if we got a full page, there's
      // likely more history; if we got fewer, we've reached the head.
      const hasMore = messages.length >= size;
      return jsonOk({ deviceId, chatWid, messages, hasMore, size });
    } catch (err) {
      if (err instanceof HaberchatError) {
        return jsonError(err.status === 401 ? 502 : err.status, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
