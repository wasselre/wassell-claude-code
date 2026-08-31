// Shared helpers for the "notify the client's owner on inbound WhatsApp"
// surfaces (2026-08-31): the passive watcher (WhatsAppOwnerAlerts — toast + OS
// notification) and the header bell (WhatsAppOwnerBell — persistent "clients
// waiting for you" list). Both read the SAME live `records[chats]` slice, so
// their notion of "a client I own messaged me" must stay identical — hence one
// shared module rather than two copies that can drift.
//
// Why the chats record is enough: the WAHA webhook is the only routine writer of
// chat records (see docs/prd/chats.md), and it bumps `last_message_at` /
// `last_message_flow` / `unread_count` and — via the client_owner mirror
// trigger — `client_owner` on every inbound message. The RealtimeOrchestrator
// merges that bump into `records[chats]` app-wide, so a rep sitting anywhere in
// the app sees it without any extra subscription.

import type { AppRecord } from '@/types';

/** A chat conversation row's `data`, narrowed to the fields these surfaces read.
 *  Everything is optional — a freshly-created conversation may carry only a wid. */
export interface ChatData {
  wid?: string;
  phone?: string | null;
  client_link?: string | null;
  /** The owning user's `public.users.id` (mirrored from the linked client's
   *  Sales Consultant). Compared directly against `currentUserId`. */
  client_owner?: string | null;
  status?: string;
  unread_count?: number;
  last_message_at?: string;
  last_message_flow?: 'in' | 'out' | null;
  last_message_preview?: string | null;
}

export function chatData(rec: AppRecord): ChatData {
  return (rec.data ?? {}) as ChatData;
}

/** True when `rec` is a conversation the given user owns AND whose newest message
 *  is an unread inbound one — i.e. "a client I'm responsible for is waiting for a
 *  reply". This is the exact predicate the bell counts and the watcher alerts on. */
export function isOwnedWaiting(rec: AppRecord, currentUserId: string | null): boolean {
  if (!currentUserId) return false;
  const d = chatData(rec);
  if (d.client_owner !== currentUserId) return false;
  if (d.last_message_flow !== 'in') return false;
  if (typeof d.unread_count !== 'number' || d.unread_count <= 0) return false;
  // An archived thread is deliberately out of the inbox; a customer message
  // reopens it (webhook sets status back to 'active'), so an archived row here
  // is a stale local view — leave it out until the reopen lands.
  if (d.status === 'archived') return false;
  return true;
}

/** Resolve the human name to show for a conversation: the linked client's name
 *  when we have it, else the phone, else a generic label. `clientsById` is the
 *  store's clients slice indexed by id (built once by the caller — these
 *  surfaces run on every chats change, so a per-call linear scan of ~1k clients
 *  would be wasteful). */
export function chatDisplayName(
  d: ChatData,
  clientsById: Map<string, AppRecord>,
  isAr: boolean,
): string {
  if (d.client_link) {
    const client = clientsById.get(d.client_link);
    const name = (client?.data as { client_name?: unknown } | undefined)?.client_name;
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  if (typeof d.phone === 'string' && d.phone) return d.phone;
  return isAr ? 'عميل' : 'A client';
}

/** The in-app path that opens a conversation thread (RecordDetailDispatcher →
 *  ChatsSplitPage reads :recordId). Same convention the push `url` uses. */
export function chatUrl(recordId: string): string {
  return `/model/chats/${recordId}`;
}
