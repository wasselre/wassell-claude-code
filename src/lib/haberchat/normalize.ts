/**
 * Shape conversions for the Chats module: Haberchat's live chat objects
 * become rows in our generic `records` store, keyed by a deterministic
 * UUID derived from the chat's WhatsApp wid.
 */

import { v5 as uuidv5 } from 'uuid';
import type { AppRecord, AppModel, HaberchatChat, WhatsAppNumber, HaberchatDevice } from '@/types';

/** Strip everything but digits — lets "+966 55 444 6109", "0555 444 6109",
 *  and "966554446109" all match. Returns '' for null/empty. */
export function normalizePhoneDigits(phone: string | null | undefined): string {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
}

/**
 * Canonicalize a digit string to KSA E.164 (no `+`), mirroring the SQL
 * `ksa_phone_canon` (supabase/migrations/2026-06-10_phone_canon_rpc.sql) so the
 * browser matcher and the server webhook agree. Reconciles the formats Wassell
 * clients are stored in — `+966…`, bare 9-digit subscriber (`599090218`), local
 * trunk `05…`, and `00966…` — onto one string. A plain digit-suffix compare
 * MISSES the `05…` form (the leading `0` breaks the suffix against `966…`),
 * which is exactly how an existing client rendered as a brand-new contact.
 */
export function ksaCanonicalPhone(digits: string): string {
  let d = digits;
  if (d.startsWith('00')) d = d.slice(2); // international 00-prefix
  if (d.startsWith('966')) return d;
  if (d.startsWith('0')) return '966' + d.slice(1); // local trunk 0
  return '966' + d; // bare subscriber number
}

/**
 * Walk a model's schema and return every field slug whose type is 'phone'.
 * Used so the chat-to-client link resolver doesn't hardcode `data.phone`
 * — the Wassell clients model ships with `phone_number`, and admins may
 * rename/add phone fields via the Builder.
 */
export function phoneFieldSlugs(model: AppModel | null | undefined): string[] {
  if (!model) return [];
  const slugs: string[] = [];
  for (const section of model.schema.sections) {
    for (const field of section.fields) {
      if (field.type === 'phone') slugs.push(field.name);
    }
  }
  return slugs;
}

/**
 * Find a clients record whose phone matches the given phone (digits-only
 * compare so format differences don't block the match). Returns the
 * record id or null. Short phones (< 6 digits) never match — too
 * ambiguous. Which fields on each client record are considered "phone"
 * is derived from the clients model's schema (every `type: 'phone'`
 * field slug).
 */
export function resolveClientLink(
  phone: string | null | undefined,
  clients: AppRecord[],
  phoneSlugs: string[],
): string | null {
  return matchRecordByPhone(phone, clients, phoneSlugs)?.id ?? null;
}

/**
 * Generic phone → record matcher shared by the chat→client linker and the
 * chat→advertiser matcher. Digits-only compare; short phones (< 6 digits)
 * never match — too ambiguous.
 */
export function matchRecordByPhone(
  phone: string | null | undefined,
  candidates: AppRecord[],
  phoneSlugs: string[],
): AppRecord | null {
  const target = normalizePhoneDigits(phone);
  if (target.length < 6) return null;
  if (phoneSlugs.length === 0) return null;
  const targetCanon = ksaCanonicalPhone(target);
  for (const c of candidates) {
    const d = c.data as Record<string, unknown>;
    for (const slug of phoneSlugs) {
      const p = normalizePhoneDigits(d[slug] as string | null | undefined);
      if (!p || p.length < 6) continue;
      // Match on: exact digit-string; equal KSA-canonical form (reconciles
      // "+966…" / bare "599…" / local "05…" / "00966…" — the local-trunk form
      // is invisible to a raw suffix compare because its leading 0 breaks the
      // suffix); OR either side being a suffix of the other (kept so a non-KSA
      // country-code pair like "971…" still matches as before).
      if (
        p === target ||
        ksaCanonicalPhone(p) === targetCanon ||
        p.endsWith(target) ||
        target.endsWith(p)
      ) {
        return c;
      }
    }
  }
  return null;
}

/**
 * True when `clientLink` is a non-empty string that matches a currently-live
 * clients record. Used by the chat→client relinkers to treat a stale link
 * (e.g. pointing to a since-deleted client) as "unlinked" so the next sweep
 * can attach the chat to a freshly-created client with the same phone.
 *
 * `deleteRecord` deliberately leaves dangling lookup references in JSONB
 * (see appStore.ts), so without this check the relinkers would skip every
 * chat whose original client was deleted — even if a replacement client
 * with the same number was added later.
 */
export function isLiveClient(
  clientLink: unknown,
  clients: AppRecord[],
): boolean {
  if (typeof clientLink !== 'string' || clientLink === '') return false;
  for (const c of clients) {
    if (c.id === clientLink) return true;
  }
  return false;
}

/**
 * Fixed namespace for the chats module. Do NOT change — records already
 * in production were keyed with this namespace and renaming it would
 * orphan them. Generated once via `uuidv4()` and baked in here.
 */
export const CHATS_NAMESPACE = 'a7f3c8d1-5e24-4b3a-9d8e-6c1f2a4b7e90';

/** Deterministic record id from a chat's Haberchat wid. */
export function chatRecordId(chatWid: string): string {
  return uuidv5(chatWid, CHATS_NAMESPACE);
}

/**
 * Convert a live Haberchat chat into an AppRecord.data shape that matches
 * the `chats` model's field slugs. Fields the chat doesn't provide are
 * left out so existing values in `data` (e.g. manual owner assignment) are
 * preserved by the caller's merge step.
 */
export function chatToRecordData(chat: HaberchatChat, deviceId: string): Record<string, unknown> {
  return {
    wid: chat.wid,
    name: chat.name ?? chat.phone ?? chat.wid,
    phone: chat.phone ?? null,
    kind: chat.kind,
    device_id: deviceId,
    status: chat.status ?? 'active',
    labels: chat.labels ?? [],
    unread_count: chat.unreadCount ?? 0,
    last_message_at: chat.lastMessageAt ?? null,
    last_message_preview: chat.lastMessagePreview ?? null,
    // `owner` and `client_link` are deliberately NOT set here — owner is
    // Wassell-side (assigned by agent via the UI), client_link is set by
    // the webhook handler via phone match.
  };
}

/**
 * Coerce a stored `device_id` value to the 24-hex id string. The Haberchat
 * webhook used to persist the WHOLE device envelope object ({id, plan,
 * alias, phone}) into records.data.device_id — a chat created by the webhook
 * then produced "deviceId=[object Object]" proxy URLs (400) for every thread
 * load and send until a list sync repaired it. The webhook is fixed and the
 * stored rows migrated, but records cached in localStorage (or a not-yet-
 * migrated environment) can still carry the object shape — every reader goes
 * through this guard.
 */
export function deviceIdString(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object') {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

/**
 * Resolve WHICH WhatsApp device an outbound message for a conversation goes
 * out from: the conversation record's own `device_id` first, then the local
 * overlay's default, then any active overlay row, then the first live
 * Haberchat device. Returns null when nothing is resolvable yet.
 *
 * Single source of truth for a chain that used to be open-coded in three
 * places (appStore.sendChatMessage, appStore.loadMessagesForChat, the
 * Composer's scheduled-strip lookup). Copies of it could disagree about
 * whether a conversation was sendable, which is exactly how the composer
 * ended up enabled for a chat the send path then refused.
 */
export function resolveSendDeviceId(
  recordDeviceId: unknown,
  waDevices: WhatsAppNumber[] | null | undefined,
  waDevicesLive: HaberchatDevice[] | null | undefined,
): string | null {
  return (
    deviceIdString(recordDeviceId) ??
    (waDevices ?? []).find((d) => d.is_default && d.is_active)?.device_id ??
    (waDevices ?? []).find((d) => d.is_active)?.device_id ??
    (waDevicesLive ?? [])[0]?.id ??
    null
  );
}

/**
 * Merge Haberchat's fresh view of a chat onto an existing record's data.
 * Keeps fields only Wassell owns (owner, client_link) and overwrites
 * everything Haberchat is authoritative for.
 */
export function mergeChatIntoRecord(
  existing: AppRecord | null,
  chat: HaberchatChat,
  deviceId: string,
  chatsModelId: string,
): AppRecord {
  const now = new Date().toISOString();
  const id = chatRecordId(chat.wid);
  const nextData: Record<string, unknown> = {
    // Start from existing data so Wassell-owned fields survive.
    ...(existing?.data ?? {}),
    // Then apply Haberchat-authoritative fields.
    ...chatToRecordData(chat, deviceId),
  };
  // Recency is forward-only: the webhook stamps last_message_* with the
  // chat's true newest message, and Haberchat's LIST value can lag it (a
  // message landing mid-sync). Never move the record's timestamp backwards —
  // and keep the preview paired with whichever timestamp wins.
  const prevData = (existing?.data ?? {}) as Record<string, unknown>;
  const prevAt = typeof prevData.last_message_at === 'string' ? prevData.last_message_at : '';
  const chatAt = chat.lastMessageAt ?? '';
  if (prevAt && (!chatAt || prevAt > chatAt)) {
    nextData.last_message_at = prevAt;
    nextData.last_message_preview = prevData.last_message_preview ?? null;
  }
  // Haberchat's chat list carries NO last-message body (verified against a
  // live chat object 2026-07-17 — there is no lastMessage/preview field), so
  // a sync must never null out the preview the webhook stamped. Keep ours
  // whenever Haberchat has nothing to say.
  if (chat.lastMessagePreview == null && prevData.last_message_preview != null) {
    nextData.last_message_preview = prevData.last_message_preview;
  }
  // unread_count is CRM-owned: the webhook increments it on inbound and
  // opening the chat zeroes it (markChatAsRead persists the zero). Haberchat's
  // meta.unreadCount reflects the PHONE's read state, not what this app's
  // user has seen — taking it on every sync both resurrected badges the user
  // had cleared and (before the meta.unreadCount mapping fix) zeroed every
  // badge. Haberchat's value only SEEDS a chat we've never tracked before.
  if (typeof prevData.unread_count === 'number') {
    nextData.unread_count = prevData.unread_count;
  }
  // status is CRM-owned once a chat is CLOSED. WAHA has no per-chat status
  // concept and feeds 'active' for every chat (see api/_lib/waha.ts listChats),
  // so taking the gateway's status on every list sync silently RE-OPENED every
  // resolved/archived chat — the reason مغلقة stayed at 0 (and the Done button
  // appeared not to work) after the WAHA cutover. A CRM-closed chat must stay
  // closed across syncs; the ONE intentional re-open is the server webhook's
  // inbound-reply reopen (chatIngest.ts), never a passive list sync. Active vs
  // pending is still gateway-driven; only the closed states are pinned.
  if (prevData.status === 'resolved' || prevData.status === 'archived') {
    nextData.status = prevData.status;
  }
  return {
    id,
    model_id: chatsModelId,
    data: nextData,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}
