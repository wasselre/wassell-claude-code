/**
 * POST /api/whatsapp/backfill-history — admin-only, RESUMABLE.
 *
 * Copies conversation history out of the WAHA gateway into our OWN
 * `chat_messages` table, so the CRM owns its history instead of depending on a
 * gateway to display it. This is the lesson from the Haberchat cutover: when
 * that subscription lapsed its history API returned 503 and every message it
 * held became unrecoverable.
 *
 * Batched by design: one call processes `limit` chats starting at `offset` and
 * returns the next offset, so the caller loops until `done`. Keeps each
 * invocation well under the function time limit regardless of mailbox size.
 *
 * Body:  { session?, offset?, limit?, perChat? }
 * Reply: { processedChats, upserted, nextOffset, done }
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { listChats, listMessages, WahaError } from '../_lib/waha.js';
import { uuidV5FromWidSync, type ChatMessageRow } from '../_lib/chatIngest.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 300,
};

const DEFAULT_LIMIT = 10;   // chats per invocation
const DEFAULT_PER_CHAT = 200; // messages per chat

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    const svc = makeServiceClient('api:wa-backfill');
    if (!svc) return jsonError(500, 'service client unavailable');

    const { data: isAdmin, error: adminErr } = await svc.rpc('wassell_is_admin', { auth_user_id: user.userId });
    if (adminErr) return jsonError(500, `admin check failed: ${adminErr.message}`);
    if (isAdmin !== true) return jsonError(403, 'history backfill is admin-only');

    const body = (await req.json().catch(() => ({}))) as {
      session?: string; offset?: number; limit?: number; perChat?: number;
    };
    const offset = Math.max(0, Number(body.offset ?? 0));
    const limit = Math.min(50, Math.max(1, Number(body.limit ?? DEFAULT_LIMIT)));
    const perChat = Math.min(500, Math.max(1, Number(body.perChat ?? DEFAULT_PER_CHAT)));

    // Resolve the WAHA session: explicit, else the active default WAHA number.
    let session = (body.session ?? '').trim();
    if (!session) {
      const { data } = await svc
        .from('whatsapp_numbers')
        .select('device_id, session_name')
        .eq('provider', 'waha')
        .eq('is_active', true)
        .order('is_default', { ascending: false })
        .limit(1)
        .maybeSingle();
      session = (data?.session_name as string | null) ?? (data?.device_id as string | null) ?? '';
    }
    if (!session) return jsonError(400, 'no active WAHA session configured');

    try {
      // listChats paginates by page*size; translate the flat offset.
      const chats = await listChats(session, { size: limit, page: Math.floor(offset / limit) });
      let upserted = 0;

      for (const chat of chats) {
        // Only 1:1 chats: groups/channels have per-sender semantics the CRM's
        // chat model does not represent yet.
        if (chat.kind !== 'user') continue;
        const phone = (chat.phone ?? '').replace(/\D/g, '');
        if (!phone) continue;
        const chatWid = `${phone}@c.us`;

        let msgs;
        try {
          msgs = await listMessages(session, chat.wid, { size: perChat });
        } catch (e) {
          // One unreadable chat must not abort the whole run.
          console.error('[backfill] listMessages failed for', chat.wid, (e as Error).message);
          continue;
        }

        const rows: ChatMessageRow[] = msgs
          .filter((m) => m.wid && m.date)
          .map((m) => ({
            id: m.wid,
            chat_wid: chatWid,
            conversation_record_id: uuidV5FromWidSync(chatWid),
            device_id: session,
            flow: m.flow,
            kind: m.kind,
            subtype: m.subtype ?? null,
            body: m.body ?? null,
            from_phone: m.fromPhone ?? (m.flow === 'in' ? `+${phone}` : null),
            to_phone: m.toPhone ?? (m.flow === 'out' ? `+${phone}` : null),
            ack: m.ack ?? null,
            date: m.date,
            media_file_id: m.mediaFileId ?? null,
            media_mime: m.mediaMime ?? null,
            media_size: m.mediaSize ?? null,
            media_caption: m.mediaCaption ?? null,
            reference: m.reference ?? null,
            quoted: m.quoted ? (m.quoted as unknown as Record<string, unknown>) : null,
          }));
        if (rows.length === 0) continue;

        // ignoreDuplicates: never let a backfill overwrite a live-ingested row
        // (the webhook's copy is authoritative — it carries the resolved phone
        // and the true ack progression).
        const { error } = await svc
          .from('chat_messages')
          .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });
        if (error) {
          console.error('[backfill] upsert failed for', chatWid, error.message);
          continue;
        }
        upserted += rows.length;
      }

      const done = chats.length < limit;
      return jsonOk({
        processedChats: chats.length,
        upserted,
        nextOffset: offset + chats.length,
        done,
        session,
      });
    } catch (err) {
      if (err instanceof WahaError) return jsonError(err.status === 401 ? 502 : err.status, err.message);
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
