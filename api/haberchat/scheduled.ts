/**
 * /api/haberchat/scheduled — scheduled (queued) WhatsApp messages.
 *
 * Scheduled sends live in HABERCHAT'S delivery queue (POST /messages with
 * `deliverAt`), not in our DB — so they fire even when the app is closed.
 * This proxy lets the browser see and cancel them:
 *
 *   GET    ?deviceId=...&phone=%2B9665...   → { messages: HaberchatQueuedMessage[] }
 *          phone is optional; when present the list is narrowed to that
 *          recipient (digits-only comparison).
 *   DELETE ?id=<messageId>                  → { ok: true }
 *          Cancels a still-queued message. 4xx from Haberchat (already
 *          sent / unknown id) is passed through.
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { listScheduled, cancelScheduled, resolveDefaultDeviceId, HaberchatError } from '../_lib/whatsappGateway.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    const url = new URL(req.url);

    try {
      if (req.method === 'GET') {
        const deviceId = url.searchParams.get('deviceId') ?? (await resolveDefaultDeviceId()) ?? '';
        if (!deviceId) {
          return jsonError(400, 'deviceId is required — pass as query param or set HABERCHAT_DEFAULT_DEVICE_ID');
        }
        const phone = url.searchParams.get('phone') ?? undefined;
        const messages = await listScheduled(deviceId, phone);
        return jsonOk({ messages });
      }

      // DELETE — cancel one queued message (WAHA job uuid or Haberchat id).
      const id = url.searchParams.get('id') ?? '';
      if (!id) return jsonError(400, 'id is required');
      await cancelScheduled(id);
      return jsonOk({ ok: true });
    } catch (err) {
      if (err instanceof HaberchatError) {
        return jsonError(err.status === 401 ? 502 : err.status, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
