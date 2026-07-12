/**
 * POST /api/haberchat/messages
 *
 * Send a message on one device. Body shape (JSON):
 *   {
 *     deviceId:   "24-hex",            // optional; defaults to HABERCHAT_DEFAULT_DEVICE_ID
 *     phone:      "+9665...",          // direct chats (v1)
 *     group:      "...@g.us",          // reserved for v2
 *     channel:    "...@newsletter",    // reserved for v2
 *     body:       "text to send",      // required unless mediaFileId is given
 *     mediaFileId:"..." (optional),    // from /api/haberchat/files; Step 9
 *     mediaCaption: "..." (optional),
 *     quotedWid:  "..." (optional),    // reply-to
 *     reference:  "uuid"               // optional; generated here if missing
 *   }
 *
 * Returns { wid, status, reference }. The browser stores `reference` on the
 * optimistic placeholder; when the message:out:ack webhook fires (Step 8),
 * the store swaps the placeholder for the real row keyed by wid.
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { sendMessage, defaultDeviceId, HaberchatError } from '../_lib/haberchat.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    let input: Record<string, unknown>;
    try {
      input = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const deviceId = (input.deviceId as string | undefined) ?? defaultDeviceId() ?? '';
    if (!deviceId) {
      return jsonError(400, 'deviceId is required — pass in body or set HABERCHAT_DEFAULT_DEVICE_ID');
    }

    const phone   = typeof input.phone   === 'string' ? input.phone   : undefined;
    const group   = typeof input.group   === 'string' ? input.group   : undefined;
    const channel = typeof input.channel === 'string' ? input.channel : undefined;
    const body    = typeof input.body    === 'string' ? input.body    : undefined;
    const mediaFileId  = typeof input.mediaFileId  === 'string' ? input.mediaFileId  : undefined;
    const mediaCaption = typeof input.mediaCaption === 'string' ? input.mediaCaption : undefined;
    const quotedWid    = typeof input.quotedWid    === 'string' ? input.quotedWid    : undefined;
    const reference    = typeof input.reference    === 'string' ? input.reference    : crypto.randomUUID();
    const deliverAt    = typeof input.deliverAt    === 'string' ? input.deliverAt    : undefined;

    // Scheduled sends must be a valid future timestamp — a past deliverAt
    // would either fire immediately or be rejected upstream; catch it here
    // with a clear message instead.
    if (deliverAt) {
      const t = new Date(deliverAt).getTime();
      if (Number.isNaN(t)) {
        return jsonError(400, 'deliverAt must be a valid ISO 8601 datetime');
      }
      if (t <= Date.now() + 30_000) {
        return jsonError(400, 'deliverAt must be at least 1 minute in the future');
      }
    }

    try {
      const result = await sendMessage({
        deviceId,
        phone,
        group,
        channel,
        body,
        mediaFileId,
        mediaCaption,
        quotedWid,
        reference,
        deliverAt,
      });
      return jsonOk(result);
    } catch (err) {
      if (err instanceof HaberchatError) {
        return jsonError(err.status === 401 ? 502 : err.status, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
