/**
 * Provider-neutral chat-ingest helpers shared by the webhook handlers.
 *
 * The Haberchat webhook (`api/webhook/haberchat.ts`) predates this module and
 * keeps its own inline copies (it is the live, load-bearing path — left
 * untouched on purpose). This module is what the WAHA webhook
 * (`api/webhook/waha.ts`) uses, so WAHA ingest produces byte-identical
 * `chat_messages` rows + `records` bumps + reply-reconciliation as Haberchat.
 *
 * The one thing that MUST stay identical across both is CHATS_NAMESPACE — the
 * conversation record id is uuidv5(chat_wid) under this namespace, matched in
 * THREE places (here, api/webhook/haberchat.ts, src/lib/haberchat/normalize.ts).
 * Do not change it.
 */

import { getServiceSupabase } from './supabaseServer.js';

// MUST match api/webhook/haberchat.ts#CHATS_NAMESPACE and
// src/lib/haberchat/normalize.ts#CHATS_NAMESPACE. Never change.
export const CHATS_NAMESPACE = 'a7f3c8d1-5e24-4b3a-9d8e-6c1f2a4b7e90';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACK_ORDER = {
  failed: -1,
  pending: 0,
  sent: 1,
  delivered: 2,
  played: 3,
  read: 3,
} as const;

export interface ChatMessageRow {
  id: string;
  chat_wid: string;
  conversation_record_id: string;
  device_id: string;
  flow: 'in' | 'out';
  kind: string;
  subtype: string | null;
  body: string | null;
  from_phone: string | null;
  to_phone: string | null;
  ack: string | null;
  date: string;
  media_file_id: string | null;
  media_mime: string | null;
  media_size: number | null;
  media_caption: string | null;
  reference: string | null;
  quoted: Record<string, unknown> | null;
  // Structured per-message payload (buttons / list responses / ad attribution).
  // Set ONCE at insert time — the WAHA path stores Click-to-WhatsApp ad
  // attribution here as `{ ad: {...} }` on the opening inbound message. Left
  // undefined for ordinary messages (DB default is `'{}'::jsonb`). Deliberately
  // NOT overwritten by later echo/ack/edit upserts (see upsertChatMessage).
  meta?: Record<string, unknown> | null;
}

/**
 * The STABLE identity of a WhatsApp message.
 *
 * A message id is `<true|false>_<chatId>_<HASH>[_<participant>]`, and the
 * `<chatId>` segment carries the ADDRESSING MODE the reporting gateway happened
 * to use — `<phone>@c.us` or `<lid>@lid` — for the very same message. So the id
 * is NOT stable: the same message reported by two gateways (or by the REST
 * store vs the webhook) yields two different ids, which defeats both the
 * `onConflict: id` dedupe and any ack lookup keyed on the id.
 *
 * The trailing HASH is WhatsApp's own message id and is the part that does not
 * move. Returns null for ids that aren't in this shape (Haberchat-era rows are
 * bare hex with no underscores — those ARE their own identity).
 */
export function messageIdHash(id: string): string | null {
  if (!/^(true|false)_[^_]+@[a-z.]+_/i.test(id)) return null;
  return id.split('_')[2] ?? null;
}

/**
 * Find an already-stored row for the same physical message under a DIFFERENT
 * addressing mode. Matched on the trailing hash plus direction: the hash is
 * WhatsApp's globally-unique message id, and pinning the direction too means a
 * stray collision still cannot merge an inbound with an outbound.
 */
async function findRowByHash(id: string, flow: 'in' | 'out'): Promise<string | null> {
  const hash = messageIdHash(id);
  if (!hash) return null;
  const supa = getServiceSupabase();
  // `like '%<hash>'` is an ends-with probe; the exact `_<hash>` boundary is
  // re-checked below because LIKE's `_` is itself a single-char wildcard.
  const { data } = await supa
    .from('chat_messages')
    .select('id')
    .eq('flow', flow)
    .like('id', `%${hash}`)
    .limit(5);
  // `_<hash>` is the WAHA shape; a bare `<hash>` is the Haberchat-era shape,
  // where the id WAS the hash. Both are the same message.
  const match = (data as { id: string }[] | null)?.find(
    (r) => r.id !== id && (r.id.endsWith(`_${hash}`) || r.id === hash),
  );
  return match?.id ?? null;
}

/**
 * Resolve a normalized Click-to-WhatsApp ad referral to our Paid Ads chain
 * (mos_resolve_ad) and return it with a `resolved` field for storage on the
 * OPENING message's `chat_messages.meta.ad`.
 *
 * `resolved` is null when the ad isn't in our Paid Ads yet — the raw referral is
 * still preserved, and `mos_reresolve_first_touch()` back-fills `resolved` onto
 * chat_messages.meta once the ad record is created. We store this on the message
 * (immutable — the browser never rewrites chat_messages) rather than the chats
 * record, whose `data` blob the SPA store rewrites and would clobber.
 */
export async function attachAdResolution(
  ad: Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  if (!ad) return null;
  const adId = ad.ad_id;
  if (typeof adId !== 'string' || !adId) return { ...ad, resolved: null };
  const supa = getServiceSupabase();
  let resolved: Record<string, unknown> | null = null;
  try {
    const { data: res, error } = await supa.rpc('mos_resolve_ad', { p_platform_ad_id: adId });
    if (error) console.error('[chatIngest] mos_resolve_ad failed:', error.message);
    else if (Array.isArray(res) && res.length > 0) {
      const row = { ...(res[0] as Record<string, unknown>) };
      delete row.project_ids; // drop the bulky array; project_id (scalar) is kept
      resolved = { ...row, resolved_at: new Date().toISOString() };
    }
  } catch (err) {
    console.error('[chatIngest] mos_resolve_ad threw:', err instanceof Error ? err.message : String(err));
  }
  return { ...ad, resolved };
}

/**
 * Upsert a chat_messages row. onConflict:id so a retried/duplicated webhook
 * never creates a second row. Returns `{ isNew }` so the caller can make the
 * unread bump idempotent (only a genuinely new inbound message bumps unread).
 *
 * Also collapses the SAME message arriving under a different addressing mode
 * onto the row we already hold (see `messageIdHash`). Two gateways paired to
 * one number — a re-pair that left the old companion linked, or a store-sourced
 * backfill racing the webhook — otherwise write the message twice, into two
 * different conversation records, and split its acks across both (live
 * 2026-07-27). The row we already have wins; the late copy only fills gaps.
 */
export async function upsertChatMessage(row: ChatMessageRow): Promise<{ isNew: boolean }> {
  const supa = getServiceSupabase();
  const { data: existing } = await supa
    .from('chat_messages')
    .select('id, ack')
    .eq('id', row.id)
    .maybeSingle();

  if (existing) {
    // An echo must not DESTROY what the send already recorded.
    //
    // The webhook builds its row with `reference: null` (WAHA has no send-time
    // reference of its own) and an ack straight from the payload. Upserting
    // that verbatim over an existing row wiped the idempotency key the send
    // path had just written — about a second after it was written — so a
    // replay of the same logical send no longer recognised itself and
    // delivered a second message (live 2026-07-28). The same overwrite could
    // walk a 'read' ack back to 'pending'.
    //
    // So the echo fills gaps and advances state; it never blanks a field the
    // send path owns.
    const patch: Record<string, unknown> = { ...row };
    if (row.reference == null) delete patch.reference;
    // `meta` is write-once (set at insert on the opening message — e.g. ad
    // attribution). An echo/ack/edit re-upsert must never blank or overwrite it,
    // exactly like the `reference` protection above. So the merge never touches
    // meta; only the original insert writes it.
    delete patch.meta;
    const prevAck = (existing as { ack?: string | null }).ack ?? null;
    const prevRank = prevAck ? (ACK_ORDER[prevAck as keyof typeof ACK_ORDER] ?? -1) : -1;
    const nextRank = row.ack ? (ACK_ORDER[row.ack as keyof typeof ACK_ORDER] ?? -1) : -1;
    if (nextRank <= prevRank) delete patch.ack;

    const { error } = await supa.from('chat_messages').update(patch).eq('id', row.id);
    if (error) console.error('[chatIngest] chat_messages merge failed:', error.message);
    return { isNew: false };
  }

  // Not under this id — is it already here under the other addressing mode?
  const twinId = await findRowByHash(row.id, row.flow);
  if (twinId) {
    console.warn(`[chatIngest] duplicate addressing for one message: "${row.id}" is already stored as "${twinId}" — dropping the copy`);
    // Deliberately NOT merged field-by-field. It is the same message, so the
    // established row already has the body; and its media ref would be
    // `wf_<other session>/…`, i.e. bytes on a gateway that is not the one we
    // download from — copying that in would swap a working ref for a 404.
    //
    // The ack is the exception: it is the one thing the echo knows that the
    // established row (written optimistically at send time as 'pending') does
    // not. applyAck only ever ratchets forward, so this cannot regress a state.
    if (row.flow === 'out' && row.ack) await applyAck(twinId, row.ack);
    return { isNew: false };
  }

  const { error } = await supa.from('chat_messages').upsert(row, { onConflict: 'id', ignoreDuplicates: false });
  if (error) console.error('[chatIngest] chat_messages upsert failed:', error.message);
  return { isNew: true };
}

/**
 * Bump the parent conversation record (last_message_*, unread, auto-reopen) and
 * run reply reconciliation. `reopenPushBack` lets a provider push a reopen back
 * to its gateway (Haberchat's chat status is authoritative on the next sync);
 * WAHA passes none because status is fully CRM-owned there.
 */
/**
 * A WhatsApp chat id: `<digits>@c.us` (user), `@g.us` (group), `@newsletter`
 * (channel), `@lid` (LID-addressed), `@broadcast`/`@status` (status posts).
 *
 * Anything else must never mint a conversation. One record created on
 * 2026-04-23 carried an entire 2,705-character serialized chat OBJECT as its
 * wid — its record id was uuidv5 of that blob, so it could never match a real
 * conversation, and it sat in the list forever holding the only unread badge in
 * the system. Cheap to make structurally impossible. (WA-22.)
 */
const CHAT_WID_RE = /^[0-9]+@(c\.us|g\.us|lid|newsletter|broadcast|status)$/i;

export function isValidChatWid(wid: string): boolean {
  return CHAT_WID_RE.test(wid);
}

export async function bumpConversationRecord(args: {
  chatWid: string;
  deviceId: string;
  lastBody: string;
  lastAt: string;
  lastFlow: 'in' | 'out';
  incrementUnread: boolean;
  reopenPushBack?: (deviceId: string, chatWid: string) => Promise<void>;
}): Promise<void> {
  if (!isValidChatWid(args.chatWid)) {
    // Loud, not silent: a wid we cannot parse means an upstream shape changed,
    // and creating a junk conversation would hide that behind a broken row.
    console.error(
      `[chatIngest] refusing to create a conversation for a malformed wid (len=${args.chatWid.length}, starts="${args.chatWid.slice(0, 24)}")`,
    );
    return;
  }
  const supa = getServiceSupabase();
  const modelId = await findChatsModelId();
  if (!modelId) return;
  const recordId = uuidV5FromWidSync(args.chatWid);

  const { data: existing } = await supa.from('records').select('data').eq('id', recordId).maybeSingle();
  const prevData = (existing?.data as Record<string, unknown> | null) ?? {};
  const prevUnread = typeof prevData.unread_count === 'number' ? prevData.unread_count : 0;
  const prevStatus = typeof prevData.status === 'string' ? prevData.status : 'active';
  const reopen = args.lastFlow === 'in' && (prevStatus === 'resolved' || prevStatus === 'archived');

  const nextData = {
    ...prevData,
    wid: prevData.wid ?? args.chatWid,
    device_id: prevData.device_id ?? args.deviceId,
    last_message_at: args.lastAt,
    last_message_preview: truncate(args.lastBody, 120),
    last_message_flow: args.lastFlow,
    unread_count: args.incrementUnread ? prevUnread + 1 : prevUnread,
    ...(reopen ? { status: 'active' } : {}),
  };

  const { error } = await supa.from('records').upsert(
    { id: recordId, model_id: modelId, data: nextData },
    { onConflict: 'id' },
  );
  if (error) console.error('[chatIngest] record bump upsert failed:', error.message);

  if (reopen && args.reopenPushBack) {
    try {
      await args.reopenPushBack(args.deviceId, args.chatWid);
    } catch (err) {
      console.error('[chatIngest] auto-reopen push-back failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // WhatsApp activity bridge (2026-07-21) — the follow-up engine tracks the
  // real conversation on a client-linked chat:
  //  * inbound  → reconcile_inbound_whatsapp: wraps mark_whatsapp_replied
  //    (waiting→'replied' + early-message stamp) AND creates a "your turn"
  //    task when the client has no open follow-up at all.
  //  * outbound → reconcile_outbound_whatsapp: arms/creates the client's
  //    WhatsApp task as "waiting for customer" (+24h deadline) and retires
  //    stale reach-out tasks (booking / no-show-recovery calls).
  // Both RPCs are idempotent — webhook retries re-stamp, never duplicate.
  // Resolve the client link HERE if the conversation does not carry one yet.
  //
  // This used to happen only in the browser (appStore.bumpParentFromMessage /
  // relinkChatsAgainstClients), so a conversation created by the webhook stayed
  // unlinked until somebody opened the app — and the reconcile below is gated
  // on that link. At night and at weekends, exactly when the AI is answering,
  // a customer's reply therefore changed no follow-up state at all: not marked
  // replied, the 24-hour checkpoint still running, escalation still able to
  // chase someone who had already answered (WA-09).
  //
  // find_client_id_by_phone is the SAME matcher the rest of the server uses
  // (ksa_phone_canon on both sides), so this cannot invent a link the app would
  // not have made. A phone that matches nothing stays unlinked — most inbound
  // on unlinked chats is genuinely not a client, and guessing would be worse
  // than leaving it.
  let clientLink = typeof prevData.client_link === 'string' ? prevData.client_link : null;
  if (!clientLink) {
    const digits = args.chatWid.split('@')[0] ?? '';
    if (/^\d{8,15}$/.test(digits)) {
      const { data: matched, error: matchErr } = await supa.rpc('find_client_id_by_phone', { p_phone: `+${digits}` });
      if (matchErr) {
        console.error('[chatIngest] find_client_id_by_phone failed:', matchErr.message);
      } else if (typeof matched === 'string' && matched) {
        clientLink = matched;
        const { error: linkErr } = await supa
          .from('records')
          .update({ data: { ...nextData, client_link: matched } })
          .eq('id', recordId);
        if (linkErr) console.error('[chatIngest] persisting client_link failed:', linkErr.message);
        else console.warn(`[chatIngest] linked conversation ${args.chatWid} to client ${matched} server-side`);
      }
    }
  }
  if (clientLink && UUID_RE.test(clientLink)) {
    const rpcName = args.lastFlow === 'in' ? 'reconcile_inbound_whatsapp' : 'reconcile_outbound_whatsapp';
    try {
      // WA-24 — the OUTBOUND reconcile retires the client's open call tasks, so
      // it must know whether this was a rep talking to them or a document/bulk
      // send that happens to have left the building. The send paths stamp
      // `send_source` on the row at send time; the webhook echo merges onto
      // that same row, so by the time we get here the answer is on it.
      let sendSource: string | null = null;
      if (args.lastFlow === 'out') {
        const { data: srcRow } = await supa
          .from('chat_messages')
          .select('send_source')
          .eq('chat_wid', args.chatWid)
          .eq('flow', 'out')
          .order('date', { ascending: false })
          .limit(1)
          .maybeSingle();
        sendSource = (srcRow as { send_source?: string | null } | null)?.send_source ?? null;
      }
      const { error: rpcErr } = await supa.rpc(rpcName, {
        p_client_id: clientLink,
        p_message_at: args.lastAt,
        ...(args.lastFlow === 'out' ? { p_source: sendSource ?? 'composer' } : {}),
      });
      if (rpcErr) console.error(`[chatIngest] ${rpcName} failed:`, rpcErr.message);
    } catch (err) {
      console.error(`[chatIngest] ${rpcName} threw:`, err instanceof Error ? err.message : String(err));
    }
  }
}

/** Apply an ack, never downgrading past the current rank. */
/**
 * Apply a delivery receipt to the message it belongs to.
 *
 * The ack's `id` is addressed however the REPORTING gateway addresses that chat,
 * which is not necessarily how the row was stored — an ack for
 * `true_<lid>@lid_<HASH>` is the receipt for a row saved as
 * `true_<phone>@c.us_<HASH>`. Matching on the id alone therefore updated nothing
 * and left 34 of 75 delivered messages showing a permanent "pending" clock to
 * the rep (live 2026-07-27). So: try the exact id, then fall back to the stable
 * hash (see `messageIdHash`).
 */
export async function applyAck(wid: string, ack: string): Promise<void> {
  const rank = ACK_ORDER[ack as keyof typeof ACK_ORDER];
  if (rank == null) return;
  const supa = getServiceSupabase();

  let target = wid;
  let { data: current } = await supa.from('chat_messages').select('ack').eq('id', wid).maybeSingle();

  if (!current) {
    // An ack only ever describes a message WE sent.
    const twinId = await findRowByHash(wid, 'out');
    if (!twinId) return; // Genuinely unknown message — nothing to mark.
    target = twinId;
    ({ data: current } = await supa.from('chat_messages').select('ack').eq('id', target).maybeSingle());
    if (!current) return;
  }

  const currentRank = current.ack ? (ACK_ORDER[current.ack as keyof typeof ACK_ORDER] ?? -1) : -1;
  if (rank <= currentRank) return;
  const { error } = await supa.from('chat_messages').update({ ack }).eq('id', target);
  if (error) console.error('[chatIngest] ack update failed:', error.message);
}

// ─── shared utilities ────────────────────────────────────────────────

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

let chatsModelIdCache: string | null = null;
export async function findChatsModelId(): Promise<string | null> {
  if (chatsModelIdCache) return chatsModelIdCache;
  const supa = getServiceSupabase();
  const { data } = await supa.from('models').select('id').eq('name', 'chats').maybeSingle();
  chatsModelIdCache = (data?.id as string | undefined) ?? null;
  return chatsModelIdCache;
}

// ─── uuidv5 (pure-JS SHA-1, edge-safe) — mirrors the Haberchat webhook ──

const widCache = new Map<string, string>();
export function uuidV5FromWidSync(wid: string): string {
  const cached = widCache.get(wid);
  if (cached) return cached;
  const id = sha1UuidV5(wid);
  widCache.set(wid, id);
  return id;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
function bytesToUuid(b: Uint8Array): string {
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function sha1UuidV5(name: string): string {
  const nsBytes = uuidToBytes(CHATS_NAMESPACE);
  const nameBytes = new TextEncoder().encode(name);
  const combined = new Uint8Array(nsBytes.length + nameBytes.length);
  combined.set(nsBytes, 0);
  combined.set(nameBytes, nsBytes.length);
  const digest = sha1(combined);
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}
function sha1(input: Uint8Array): Uint8Array {
  const ml = input.length * 8;
  const withOne = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  withOne.set(input);
  withOne[input.length] = 0x80;
  const view = new DataView(withOne.buffer);
  view.setUint32(withOne.length - 4, ml >>> 0, false);
  view.setUint32(withOne.length - 8, Math.floor(ml / 0x100000000), false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let i = 0; i < withOne.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) { const x = w[j - 3]! ^ w[j - 8]! ^ w[j - 14]! ^ w[j - 16]!; w[j] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | ((~b) & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]!) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0, false); ov.setUint32(4, h1, false); ov.setUint32(8, h2, false);
  ov.setUint32(12, h3, false); ov.setUint32(16, h4, false);
  return out;
}
