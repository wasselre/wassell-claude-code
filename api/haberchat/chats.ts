/**
 * GET /api/haberchat/chats?deviceId=<24-hex>
 *
 * Lists conversations for one Haberchat device (one WhatsApp number).
 * When `deviceId` is omitted, falls back to `HABERCHAT_DEFAULT_DEVICE_ID`.
 *
 * The browser calls this once per active device (see appStore's
 * `loadChatsFromHaberchat`) and merges the results into the records store.
 * Single-device-per-call keeps the response fast and shallow.
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { listChats, resolveDefaultDeviceId, HaberchatError } from '../_lib/whatsappGateway.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    const url = new URL(req.url);
    const deviceId = url.searchParams.get('deviceId') ?? (await resolveDefaultDeviceId());
    if (!deviceId) {
      return jsonError(
        400,
        'deviceId is required — pass ?deviceId=... or set HABERCHAT_DEFAULT_DEVICE_ID',
      );
    }
    const size = clampInt(url.searchParams.get('size'), 1, 200, 100);
    const page = clampInt(url.searchParams.get('page'), 0, 10_000, 0);
    try {
      const chats = await listChats(deviceId, { size, page });
      return jsonOk({ deviceId, chats, size, page });
    } catch (err) {
      if (err instanceof HaberchatError) {
        // 401 from Haberchat is a bad token — surface as 502 so the browser
        // doesn't confuse it with our own auth layer's 401.
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
