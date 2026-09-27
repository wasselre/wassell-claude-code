/**
 * /api/geo-preference/chat-card — the in-chat card (geography + preferences).
 *
 *   GET  ?clientId=<uuid>&chatWid=<wid>
 *        → ChatCard (see chatCard.ts) + { prefs } (see clientPrefs/card.ts)
 *   POST { action:'analyze', clientId, chatWid, trigger?: 'open'|'manual' }
 *        → the fresh GET payload + { read, mode }
 *        Runs THE unified chat read (clientPrefs/readChat.ts): the geography
 *        agent (full extraction or a review-only rerun) and the preference
 *        agent, in parallel, under the (chat, client) lease. `open` (the card
 *        reading on its own when the rep opens the chat) applies the free
 *        keyword gate and waits for an in-flight voice transcript; `manual`
 *        (the «أعد القراءة» button, the default) bypasses both. Can take up
 *        to a minute.
 *
 * REP-FACING, not admin-only: withAuth, then assertCanAccessRecord on the
 * CLIENT under the caller's own RLS — any rep who can see the client may read
 * and (re)analyze its chats. The pipeline itself runs on the service client
 * (it already is service-side, exactly like the backfill).
 *
 * SAFETY BOUNDARY: this endpoint never writes a client record and never sends
 * a message. It writes only what the backfill writes (evidence / relations /
 * checkpoint / proposal / verifier opinion), a pending client_pref_proposals
 * row, and the chat_read_state watermarks. Saving to the client goes through
 * POST /api/geo-preference/review (geography) and POST /api/client-prefs/review
 * (preferences) — nowhere else.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { withAuth, jsonError, jsonOk, assertCanAccessRecord } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { loadChatCard, ChatCardError } from '../_lib/geoPreference/chatCard.js';
import { loadPrefsCard } from '../_lib/clientPrefs/card.js';
import { readChatForClient, type ReadTrigger } from '../_lib/clientPrefs/readChat.js';
import {
  readNodeBodyLimited, PayloadTooLargeError, sendPayloadTooLarge, MAX_REQUEST_BODY_BYTES,
} from '../_lib/httpBody.js';

export const config = {
  runtime: 'nodejs',
  // 'analyze' runs one extraction + one verifier call for ONE conversation.
  maxDuration: 300,
};

const SERVICE_NAME = 'api:geo-preference-chat-card';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A WhatsApp wid (`9665…@c.us`, `…@lid`, `…@g.us`). Bounded + no control chars —
// it is used in PostgREST filters.
const WID_RE = /^[A-Za-z0-9._:@+-]{3,128}$/;

async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : await readNodeBodyLimited(nodeReq, MAX_REQUEST_BODY_BYTES);
  return new Request(url.toString(), { method, headers, body });
}

async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  const buf = Buffer.from(await webResp.arrayBuffer());
  nodeRes.end(buf);
}

function validate(clientId: unknown, chatWid: unknown): { clientId: string; chatWid: string } | Response {
  const c = typeof clientId === 'string' ? clientId.trim() : '';
  const w = typeof chatWid === 'string' ? chatWid.trim() : '';
  if (!UUID_RE.test(c)) return jsonError(400, 'clientId must be a uuid');
  if (!w) return jsonError(400, 'chatWid is required');
  if (!WID_RE.test(w)) return jsonError(400, 'chatWid is not a valid WhatsApp id');
  return { clientId: c, chatWid: w };
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  let req: Request;
  try {
    req = await nodeToWebRequest(nodeReq);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return sendPayloadTooLarge(nodeRes, err.limitBytes);
    throw err;
  }

  const resp = await withAuth(req, async (user) => {
    let input: { clientId: string; chatWid: string } | Response;
    let action = 'get';
    let trigger: ReadTrigger = 'manual';
    if (req.method === 'GET') {
      const q = new URL(req.url).searchParams;
      input = validate(q.get('clientId'), q.get('chatWid'));
    } else if (req.method === 'POST') {
      let body: { action?: unknown; clientId?: unknown; chatWid?: unknown; trigger?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonError(400, 'invalid JSON body');
      }
      action = typeof body.action === 'string' ? body.action : '';
      if (action !== 'analyze') return jsonError(400, `unknown action '${action}' (expected 'analyze')`);
      if (body.trigger !== undefined && body.trigger !== 'open' && body.trigger !== 'manual') {
        return jsonError(400, "trigger must be 'open' or 'manual'");
      }
      trigger = body.trigger === 'open' ? 'open' : 'manual';
      input = validate(body.clientId, body.chatWid);
    } else {
      return jsonError(405, 'Method not allowed');
    }
    if (input instanceof Response) return input;
    const { clientId, chatWid } = input;

    // The caller must be able to see the CLIENT under their own RLS. Service
    // role bypasses RLS, so this is the gate. Throws AuthError → withAuth maps it.
    await assertCanAccessRecord(req, clientId, SERVICE_NAME);

    const sb = makeServiceClient(SERVICE_NAME);
    if (!sb) return jsonError(500, 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    const loadAll = async () => {
      const [card, prefs] = await Promise.all([loadChatCard(sb, clientId, chatWid), loadPrefsCard(sb, clientId, chatWid)]);
      return { ...card, prefs };
    };

    try {
      if (action === 'analyze') {
        const read = await readChatForClient(sb, {
          clientId, chatWid, trigger,
          owner: `${trigger}:${user.userId.slice(0, 8)}:${globalThis.crypto.randomUUID().slice(0, 8)}`,
          log: (m) => console.log(m),
        });
        console.log(`[geo-chat-card] analyze client=${clientId} chat=${chatWid} trigger=${trigger} outcome=${read.outcome} geo=${read.geo.mode ?? (read.geo.error ? 'error' : '-')} by=${user.userId}`);
        return jsonOk({ ...(await loadAll()), read, mode: read.geo.mode ?? 'none' });
      }
      return jsonOk(await loadAll());
    } catch (err) {
      if (err instanceof ChatCardError) return jsonError(err.status, err.message);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[geo-chat-card] ${action} client=${clientId} chat=${chatWid} failed:`, msg);
      return jsonError(500, msg);
    }
  });

  await writeWebResponseToNode(resp, nodeRes);
}
