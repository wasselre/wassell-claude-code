/**
 * Shape conversions for the Chats module: Haberchat's live chat objects
 * become rows in our generic `records` store, keyed by a deterministic
 * UUID derived from the chat's WhatsApp wid.
 */

import { v5 as uuidv5 } from 'uuid';
import type { AppRecord, AppModel, HaberchatChat } from '@/types';

/** Strip everything but digits — lets "+966 55 444 6109", "0555 444 6109",
 *  and "966554446109" all match. Returns '' for null/empty. */
export function normalizePhoneDigits(phone: string | null | undefined): string {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
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
  for (const c of candidates) {
    const d = c.data as Record<string, unknown>;
    for (const slug of phoneSlugs) {
      const p = normalizePhoneDigits(d[slug] as string | null | undefined);
      if (!p || p.length < 6) continue;
      // Match on exact digit-string OR either side being a suffix of
      // the other — covers the case where one side has a country code
      // and the other doesn't ("966555…" vs local "0555…").
      if (p === target || p.endsWith(target) || target.endsWith(p)) {
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
