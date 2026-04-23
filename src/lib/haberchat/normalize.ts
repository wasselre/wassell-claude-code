/**
 * Shape conversions for the Chats module: Haberchat's live chat objects
 * become rows in our generic `records` store, keyed by a deterministic
 * UUID derived from the chat's WhatsApp wid.
 */

import { v5 as uuidv5 } from 'uuid';
import type { AppRecord, HaberchatChat } from '@/types';

/** Strip everything but digits — lets "+966 55 444 6109", "0555 444 6109",
 *  and "966554446109" all match. Returns '' for null/empty. */
export function normalizePhoneDigits(phone: string | null | undefined): string {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
}

/**
 * Find a clients record whose phone matches the given phone (digits-only
 * compare so format differences don't block the match). Returns the
 * record id or null. Short phones (< 6 digits) never match — too ambiguous.
 */
export function resolveClientLink(
  phone: string | null | undefined,
  clients: AppRecord[],
): string | null {
  const target = normalizePhoneDigits(phone);
  if (target.length < 6) return null;
  for (const c of clients) {
    const d = c.data as Record<string, unknown>;
    const p = normalizePhoneDigits(d.phone as string | null | undefined);
    if (!p) continue;
    // Match on exact digit-string OR last 9 digits — covers cases where
    // one side has the country code and the other doesn't.
    if (p === target || p.endsWith(target) || target.endsWith(p)) {
      if (Math.min(p.length, target.length) >= 6) return c.id;
    }
  }
  return null;
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
  const nextData = {
    // Start from existing data so Wassell-owned fields survive.
    ...(existing?.data ?? {}),
    // Then apply Haberchat-authoritative fields.
    ...chatToRecordData(chat, deviceId),
  };
  return {
    id,
    model_id: chatsModelId,
    data: nextData,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}
