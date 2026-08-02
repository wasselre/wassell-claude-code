/**
 * Who may send a WhatsApp message, to whom, and how often.
 *
 * `POST /api/haberchat/messages` used to check only that the caller held a valid
 * JWT. Anything else — which clients they own, their role, how many messages
 * they had already sent, whether the recipient was a customer at all — went
 * unexamined, and `phone` was taken straight from the request body. Any account
 * could therefore message any number on earth from the company's WhatsApp, and
 * nothing recorded that it had happened (WA-01, audit 2026-07-28).
 *
 * The rule mirrors the rest of the CRM rather than inventing a second one:
 *
 *   1. A send is addressed to a CONVERSATION, not to a raw number. The
 *      conversation is resolved with the CALLER'S OWN JWT, so the same RLS that
 *      decides which chats they can open decides which they can write to.
 *   2. Messaging someone with no conversation yet is a distinct act — starting
 *      one — and needs `create` on the chats model. That keeps cold outreach a
 *      privilege rather than a side effect of knowing a phone number.
 *   3. Every attempt is attributed and recorded, whatever the outcome.
 *
 * Phone numbers are masked in everything written here. An audit trail should
 * say who messaged which client, not reproduce the customer's number in a table
 * with far wider read access than the chat itself.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getServiceSupabase } from './supabaseServer.js';
import { uuidV5FromWidSync } from './chatIngest.js';
import { logServerActivity } from './activityLogger.js';

/** Keep the country code and the last two digits: `+9665•••••67`. */
export function maskPhone(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length < 6) return '•'.repeat(digits.length || 3);
  return `+${digits.slice(0, 4)}${'•'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-2)}`;
}

export interface SendAuthOk {
  ok: true;
  chatWid: string;
  /** The conversation record, when one already exists. */
  conversationId: string | null;
  clientId: string | null;
  /** True when this send starts a brand-new conversation. */
  isNewConversation: boolean;
}
export interface SendAuthDenied {
  ok: false;
  status: number;
  error: string;
  reason: 'no_recipient' | 'not_permitted' | 'cannot_start_conversation' | 'rate_limited' | 'lookup_failed';
}
export type SendAuthResult = SendAuthOk | SendAuthDenied;

/**
 * Requests per user per window. Deliberately configurable and deliberately
 * generous by default: this is a runaway/abuse ceiling, not a pacing mechanism
 * (pacing belongs to the send queue). Measured baseline when this was written:
 * the busiest real day across the whole account was 379 outbound messages.
 */
const RATE_WINDOW_MINUTES = Number(process.env.WHATSAPP_SEND_RATE_WINDOW_MIN ?? 5);
const RATE_MAX_PER_WINDOW = Number(process.env.WHATSAPP_SEND_RATE_MAX ?? 60);

function callerClient(req: Request): SupabaseClient | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}

/**
 * Canonical KSA chat id. Mirrors the SQL `ksa_phone_canon` so the browser, the
 * server and the database agree on what "the same number" means — a bare
 * 9-digit local number, `05…`, `9665…` and `+9665…` all collapse to one wid.
 */
export function chatWidFromPhone(phone: string): string | null {
  let d = (phone ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = `966${d.slice(1)}`;
  else if (d.length === 9) d = `966${d}`;
  if (d.length < 8 || d.length > 15) return null;
  return `${d}@c.us`;
}

export async function authorizeWhatsappSend(args: {
  req: Request;
  user: { userId: string; email?: string | null };
  phone?: string;
  chatWid?: string;
  /** Where the send came from — recorded, and used to label the audit row. */
  source: 'composer' | 'new_chat' | 'workflow' | 'document' | 'media_batch' | 'bulk' | 'other';
}): Promise<SendAuthResult> {
  const svc = getServiceSupabase();
  const chatWid = args.chatWid ?? (args.phone ? chatWidFromPhone(args.phone) : null);
  if (!chatWid) {
    return { ok: false, status: 400, error: 'a recipient phone or chat is required', reason: 'no_recipient' };
  }

  // ── rate ceiling ──────────────────────────────────────────────────────────
  const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString();
  const { count, error: rateErr } = await svc
    .from('activity_log')
    .select('id', { count: 'exact', head: true })
    .eq('category', 'whatsapp')
    .eq('event_type', 'send_attempt')
    .eq('actor_user_id', args.user.userId)
    .gte('created_at', since);
  if (rateErr) {
    // Fail OPEN on a counter failure — a broken audit table must not stop a rep
    // answering a customer — but say so loudly.
    console.error('[whatsappSendAuth] rate check failed (allowing send):', rateErr.message);
  } else if ((count ?? 0) >= RATE_MAX_PER_WINDOW) {
    return {
      ok: false,
      status: 429,
      error: `send rate limit reached (${RATE_MAX_PER_WINDOW} per ${RATE_WINDOW_MINUTES} min)`,
      reason: 'rate_limited',
    };
  }

  // ── the conversation decides, under the CALLER'S rls ──────────────────────
  const scoped = callerClient(args.req);
  if (!scoped) {
    return { ok: false, status: 500, error: 'Supabase env missing', reason: 'lookup_failed' };
  }

  // Resolve the chats model up front so BOTH record lookups below can be scoped
  // to it. This is not just correctness — it is the difference between a 31ms
  // query and a timeout. The `records` SELECT RLS calls `wassell_can_view_record`,
  // which is NOT leakproof, so Postgres must evaluate it on every candidate row
  // BEFORE the `data->>wid` filter — and unscoped that means the ENTIRE records
  // table (market listings, clients, …), which blew past statement_timeout and
  // 500'd EVERY send with reason 'lookup_failed' from ~2026-07-30 on, while the
  // WhatsApp gateway was perfectly healthy. `model_id` is indexed, so scoping to
  // the ~few-hundred chat rows lets the RLS function run only on those.
  const { data: chatsModel } = await svc.from('models').select('id').eq('name', 'chats').maybeSingle();
  const chatsModelId = (chatsModel as { id?: string } | null)?.id ?? null;
  if (!chatsModelId) {
    return { ok: false, status: 500, error: 'chats model missing', reason: 'lookup_failed' };
  }

  const { data: visible, error: visErr } = await scoped
    .from('records')
    .select('id, data')
    .eq('model_id', chatsModelId)
    .eq('data->>wid', chatWid)
    .maybeSingle();
  if (visErr) {
    return { ok: false, status: 500, error: `chat lookup failed: ${visErr.message}`, reason: 'lookup_failed' };
  }

  if (visible) {
    const d = (visible.data ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      chatWid,
      conversationId: visible.id as string,
      clientId: typeof d.client_link === 'string' ? d.client_link : null,
      isNewConversation: false,
    };
  }

  // Not visible. Either it does not exist (starting a new conversation) or it
  // exists and this user may not see it — those are different answers and must
  // not be conflated, or "no permission" would silently become "new chat".
  const { data: exists } = await svc
    .from('records')
    .select('id')
    .eq('model_id', chatsModelId)
    .eq('data->>wid', chatWid)
    .maybeSingle();

  if (exists) {
    return {
      ok: false,
      status: 403,
      error: 'this conversation is not in your scope',
      reason: 'not_permitted',
    };
  }

  const { data: mayCreate } = await svc.rpc('wassell_user_has_action', {
    auth_user_id: args.user.userId,
    the_model_id: chatsModelId,
    action: 'create',
  });
  if (mayCreate !== true) {
    return {
      ok: false,
      status: 403,
      error: 'you do not have permission to start a new WhatsApp conversation',
      reason: 'cannot_start_conversation',
    };
  }

  return { ok: true, chatWid, conversationId: null, clientId: null, isNewConversation: true };
}

/**
 * Has this exact logical send already gone out?
 *
 * `reference` is our own idempotency key. It used to be generated, echoed back
 * and thrown away — WAHA has no send-time reference of its own, and the webhook
 * explicitly stores null — so the field the workflow engine's comment called
 * "the idempotency key" guaranteed nothing at all (WA-12). Two things could
 * therefore deliver the same message twice: a proxy timeout AFTER WhatsApp had
 * accepted (the caller sees a failure and retries a send that already
 * succeeded), and any caller re-issuing a request with the same key.
 *
 * Now that the send row is persisted at send time (WA-04) the key is durable,
 * so a repeat is answered with the ORIGINAL result instead of a second message.
 *
 * Deliberately not a UNIQUE index: the worker writes several rows sharing one
 * reference for a multi-part send (body, then each media item), so uniqueness
 * on the column would reject legitimate traffic. The guarantee lives where the
 * one-row-per-send invariant actually holds.
 */
export async function findPriorSendByReference(
  reference: string,
  chatWid: string,
): Promise<{ wid: string } | null> {
  if (!reference) return null;
  const supa = getServiceSupabase();
  const { data, error } = await supa
    .from('chat_messages')
    .select('id, ack')
    .eq('reference', reference)
    .eq('chat_wid', chatWid)
    .eq('flow', 'out')
    .limit(1)
    .maybeSingle();
  if (error) {
    // Fail OPEN: an idempotency lookup that breaks must not block a rep from
    // messaging a customer. The cost is the pre-existing duplicate risk, not a
    // new one.
    console.error('[whatsappSendAuth] idempotency lookup failed (allowing send):', error.message);
    return null;
  }
  const row = data as { id: string; ack: string | null } | null;
  if (!row) return null;
  // A previous attempt that FAILED should be retryable — replaying it would
  // strand the message forever on a transient fault.
  if (row.ack === 'failed') return null;
  return { wid: row.id };
}

/**
 * Persist the outbound message ITSELF, at send time.
 *
 * Until now nothing did. The row was created only when WhatsApp echoed our own
 * send back through the inbound webhook, so if that echo was lost — a gateway
 * restart, a webhook 500, an addressing change, a re-pair — the customer had
 * the message and the CRM had no idea it existed: no bubble, no
 * reconcile_outbound_whatsapp, no 24-hour deadline, no supersede. And with no
 * send log either, it could not be detected after the fact (WA-04).
 *
 * Writing it here is safe against double-creation because the id we store is
 * the one WAHA assigns, which is exactly the id the echo carries — so the
 * webhook's upsert merges onto this row rather than adding a second one, and
 * the hash-dedupe added on 2026-07-27 catches it even if the echo comes back
 * under the other addressing mode.
 *
 * A FAILED send is persisted too, under a synthetic `failed:<key>` id. That is
 * the whole of WA-15: the old code marked the bubble failed in memory only, so
 * it vanished on refresh and the rep could not tell a failed send from one they
 * never typed. `chat_messages` held zero ack='failed' rows across all time.
 */
export async function recordOutboundMessage(args: {
  chatWid: string;
  deviceId: string;
  body?: string | null;
  mediaFileId?: string | null;
  mediaCaption?: string | null;
  quotedWid?: string | null;
  reference: string;
  /** Which surface produced this — decides whether it retires call tasks (WA-24). */
  sendSource?: string | null;
  /** The gateway's message id when it accepted; absent when it did not. */
  messageWid?: string | null;
  outcome: 'accepted' | 'failed';
}): Promise<void> {
  const supa = getServiceSupabase();
  const digits = args.chatWid.split('@')[0] ?? '';
  // An ACCEPTED send with no id is still an accepted send. WhatsApp took the
  // message; we merely could not read its id back. Recording that as `failed:`
  // would put a red bubble in front of the rep and invite the resend that
  // delivered the message twice on 2026-07-28.
  const id = args.messageWid
    || (args.outcome === 'accepted' ? `sent:${args.reference}` : `failed:${args.reference}`);
  const kind = args.mediaFileId ? 'document' : 'text';

  const { error } = await supa.from('chat_messages').upsert({
    id,
    chat_wid: args.chatWid,
    conversation_record_id: uuidV5FromWidSync(args.chatWid),
    device_id: args.deviceId,
    flow: 'out',
    kind,
    subtype: null,
    body: args.body ?? null,
    from_phone: null,
    to_phone: `+${digits}`,
    // 'sent' is what we can honestly claim: the gateway accepted it. The
    // delivered/read progression arrives later on the ack webhook.
    ack: args.outcome === 'accepted' ? 'sent' : 'failed',
    date: new Date().toISOString(),
    media_file_id: args.mediaFileId ?? null,
    media_mime: null,
    media_size: null,
    media_caption: args.mediaCaption ?? null,
    reference: args.reference,
    send_source: args.sendSource ?? null,
    quoted: args.quotedWid ? { wid: args.quotedWid, body: null, kind: 'text' } : null,
  }, { onConflict: 'id', ignoreDuplicates: false });

  if (error) {
    // Loud, but never fatal: the message HAS gone to the customer at this
    // point, and failing the request would tell the rep the opposite.
    console.error('[whatsappSendAuth] could not persist outbound message:', error.message, id);
  }
}

/**
 * Record one send attempt. Called for allowed AND denied attempts, and for
 * failures after the gateway was reached — "who tried to message whom" is
 * exactly the question that had no answer before.
 */
export async function logSendAttempt(args: {
  user: { userId: string; email?: string | null };
  chatWid: string;
  clientId?: string | null;
  conversationId?: string | null;
  deviceId?: string | null;
  source: string;
  outcome: 'accepted' | 'denied' | 'failed';
  reason?: string | null;
  messageWid?: string | null;
  hasMedia?: boolean;
  error?: string | null;
}): Promise<void> {
  const masked = maskPhone(args.chatWid.split('@')[0] ?? '');
  await logServerActivity({
    category: 'whatsapp',
    event_type: 'send_attempt',
    actor_user_id: args.user.userId,
    actor_email: args.user.email ?? null,
    target_record_id: args.conversationId ?? null,
    target_label: `whatsapp: ${masked}`,
    summary_ar: `محاولة إرسال واتساب إلى ${masked} (${args.outcome})`,
    summary_en: `WhatsApp send attempt to ${masked} (${args.outcome})`,
    details: {
      // NOTE: the full number is deliberately absent. The conversation and
      // client ids identify the recipient for anyone who is allowed to look.
      recipient_masked: masked,
      conversation_id: args.conversationId ?? null,
      client_id: args.clientId ?? null,
      device_id: args.deviceId ?? null,
      source: args.source,
      outcome: args.outcome,
      reason: args.reason ?? null,
      message_wid: args.messageWid ?? null,
      has_media: args.hasMedia ?? false,
    },
    status: args.outcome === 'accepted' ? 'success' : 'error',
    error: args.error ?? null,
  });
}
