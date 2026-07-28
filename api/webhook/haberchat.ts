/**
 * POST /api/webhook/haberchat
 *
 * Receives events from Haberchat's webhook system. Registered once per
 * environment via:
 *   POST https://api.haber.chat/v1/webhooks
 *   Body: {
 *     url: "https://<prod-url>/api/webhook/haberchat",
 *     events: ["message:in:new","message:out:new","message:out:ack","chat:update"],
 *     headers: { "X-Webhook-Secret": "<HABERCHAT_WEBHOOK_SECRET value>" }
 *   }
 *
 * On every event:
 *  1. Verify X-Webhook-Secret header against env (401 on mismatch).
 *  2. Write/update the chat_messages row via service-role Supabase.
 *  3. Optionally update the parent chats record (last_message_preview,
 *     last_message_at, unread_count bump on inbound).
 *  4. Always return 200 + {ok:true} when auth passes, so Haberchat doesn't
 *     retry. Errors inside individual event branches are logged + swallowed.
 *
 * The live SPA's Supabase Realtime subscription on `chat_messages` picks
 * up the insert / update and the browser UI reacts without a reload.
 */

export const config = { runtime: 'edge' };

/**
 * RETIRED 2026-07-28 (WA-28).
 *
 * WhatsApp moved to the self-hosted WAHA gateway on 2026-07-19 and the operator
 * has confirmed there is no fallback to Haberchat. Its account is gone — the API
 * answers 403 "The API token provided is invalid" to every request — and the
 * last event this endpoint received was 2026-07-18 14:30, the cutover day.
 *
 * The endpoint stays MOUNTED and refuses, rather than being deleted outright: a
 * removed route 404s, which is indistinguishable from a deploy problem. 410 Gone
 * says the resource is deliberately retired, and anything still pointed here is
 * recorded rather than silently swallowed — an unexpected caller on a webhook
 * that once wrote to chat_messages is worth seeing.
 *
 * Live ingest is api/webhook/waha.ts.
 */
export default async function handler(req: Request): Promise<Response> {
  console.warn('[webhook.haberchat] RETIRED endpoint called —', req.method, req.headers.get('user-agent') ?? 'no-ua');
  return new Response(
    JSON.stringify({
      error: 'gone',
      message: 'The Haberchat integration was retired on 2026-07-28. WhatsApp ingest is /api/webhook/waha.',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json' } },
  );
}
