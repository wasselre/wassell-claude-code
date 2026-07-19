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

import type { IncomingMessage, ServerResponse } from 'node:http';
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

/**
 * The Vercel NODEJS runtime uses the Node `(req, res)` signature — a returned
 * Web `Response` is IGNORED, so the request hangs until the 300s ceiling and
 * 504s (hit live 2026-07-19). Bridge Node↔Web the same way the other
 * node-runtime endpoints in this repo do.
 */
async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of nodeReq) chunks.push(Buffer.from(chunk));
    body = Buffer.concat(chunks).toString('utf8');
  }
  return new Request(url.toString(), { method, headers, body });
}

async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  nodeRes.end(Buffer.from(await webResp.arrayBuffer()));
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const req = await nodeToWebRequest(nodeReq);
  const resp = await runBackfill(req);
  await writeWebResponseToNode(resp, nodeRes);
}

async function runBackfill(req: Request): Promise<Response> {
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
          // downloadMedia:false — text history only. Making WAHA fetch bytes
          // for every historical message is far too slow for a bulk run; the
          // thread's live fetch supplies media when a chat is opened.
          msgs = await listMessages(session, chat.wid, { size: perChat, downloadMedia: false });
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
