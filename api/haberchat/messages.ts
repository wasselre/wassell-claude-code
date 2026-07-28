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
import { sendMessage, resolveDefaultDeviceId, maybeScheduleWaha, HaberchatError } from '../_lib/whatsappGateway.js';
import { authorizeWhatsappSend, logSendAttempt } from '../_lib/whatsappSendAuth.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async (user) => {
    let input: Record<string, unknown>;
    try {
      input = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const deviceId = (input.deviceId as string | undefined) ?? (await resolveDefaultDeviceId()) ?? '';
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

    // AUTHORIZATION (WA-01). A valid JWT is not permission to message a
    // customer. The send is authorized against the CONVERSATION under the
    // caller's own RLS — the same rule that decides which chats they can open —
    // and starting a brand-new conversation additionally requires `create` on
    // the chats model, so cold outreach is a privilege rather than a side
    // effect of knowing a phone number.
    //
    // Groups and channels are not gated here: the composer refuses them
    // outright, so `phone` is the only reachable send path.
    const source = typeof input.source === 'string' ? input.source : 'composer';

    if (phone && !group && !channel) {
      const auth = await authorizeWhatsappSend({ req, user, phone, source: source as 'composer' });
      if (!auth.ok) {
        await logSendAttempt({
          user, chatWid: `${phone.replace(/\D/g, '')}@c.us`, deviceId, source,
          outcome: 'denied', reason: auth.reason,
        });
        return jsonError(auth.status, auth.error);
      }

      try {
        const scheduled = deliverAt
          ? await maybeScheduleWaha({ deviceId, phone, body, mediaFileId, mediaCaption, reference, deliverAt }, user.userId)
          : null;
        if (scheduled) {
          await logSendAttempt({
            user, chatWid: auth.chatWid, clientId: auth.clientId, conversationId: auth.conversationId,
            deviceId, source, outcome: 'accepted', reason: 'scheduled',
            messageWid: scheduled.wid, hasMedia: !!mediaFileId,
          });
          return jsonOk(scheduled);
        }

        const result = await sendMessage({
          deviceId, phone, group, channel, body, mediaFileId, mediaCaption, quotedWid, reference, deliverAt,
        });
        await logSendAttempt({
          user, chatWid: auth.chatWid, clientId: auth.clientId, conversationId: auth.conversationId,
          deviceId, source, outcome: 'accepted', messageWid: result.wid, hasMedia: !!mediaFileId,
        });
        return jsonOk(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Recorded BEFORE returning: a send that failed at the gateway is
        // exactly the event that previously left no trace anywhere.
        await logSendAttempt({
          user, chatWid: auth.chatWid, clientId: auth.clientId, conversationId: auth.conversationId,
          deviceId, source, outcome: 'failed', hasMedia: !!mediaFileId, error: msg,
        });
        if (err instanceof HaberchatError) return jsonError(err.status === 401 ? 502 : err.status, err.message);
        return jsonError(500, msg);
      }
    }

    try {
      // Scheduled send on a WAHA number → enqueue into our own queue (WAHA has
      // no native deliverAt). Haberchat scheduled sends fall through to
      // sendMessage's native deliverAt. Returns null when not a WAHA schedule.
      const scheduled = deliverAt
        ? await maybeScheduleWaha({ deviceId, phone, body, mediaFileId, mediaCaption, reference, deliverAt }, user.userId)
        : null;
      if (scheduled) return jsonOk(scheduled);

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
