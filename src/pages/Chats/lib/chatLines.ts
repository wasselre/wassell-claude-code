/**
 * One contact, one chat PER NUMBER.
 *
 * A conversation record is ONE per contact, shared by every number we own (its
 * id is uuidv5 of the contact's wid — the AI gate, the send check, the send
 * worker and read tracking all look it up that way, so it must stay one
 * record). The Chats list instead SHOWS one chat per number the contact has
 * talked to: its own row, preview, unread count and thread, and replies from
 * that number.
 *
 * The record carries what that needs, kept by the WhatsApp webhook
 * (api/_lib/chatIngest.ts) and back-filled from chat_messages:
 *   data.lines      — every number (session) the conversation has messages on
 *   data.line_meta  — per number: last message time / preview / direction and
 *                     unread count
 *
 * Numbers are grouped by the switcher's ACTIVE numbers: a session that is not
 * one of them (the retired `wassel_main`, old Haberchat ids — all the same
 * sales phone) belongs to the default number's chat.
 */

import type { WhatsAppNumber } from '@/types';
import { deviceIdString } from '@/lib/haberchat/normalize';

/** Every number (session) this conversation has messages on. */
export function chatLines(data: Record<string, unknown> | null | undefined): string[] {
  if (!data) return [];
  const raw = data.lines;
  if (Array.isArray(raw)) {
    const lines = raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (lines.length > 0) return lines;
  }
  const first = deviceIdString(data.device_id);
  return first ? [first] : [];
}

/**
 * Label for a number in the Chats switcher and on a chat row. The sales
 * default and the operations line are named by their ROLE (which survives a
 * SIM swap or a rename); any other number by its own display name.
 */
export function lineLabel(d: WhatsAppNumber, isAr: boolean): string {
  if (d.is_default) return isAr ? 'المبيعات' : 'Sales';
  if (d.is_operations) return isAr ? 'العمليات' : 'Operations';
  return (isAr ? d.friendly_name_ar : d.friendly_name_en) || d.friendly_name_ar || d.friendly_name_en || d.phone;
}

/** Active numbers in switcher order: sales, operations, then the rest by name. */
export function switcherLines(waDevices: WhatsAppNumber[] | null | undefined): WhatsAppNumber[] {
  const rank = (d: WhatsAppNumber) => (d.is_default ? 0 : d.is_operations ? 1 : 2);
  return (waDevices ?? [])
    .filter((d) => d.is_active)
    .sort((a, b) => rank(a) - rank(b) || (a.friendly_name_en ?? a.phone).localeCompare(b.friendly_name_en ?? b.phone));
}

/** Which chat a session's messages belong to: the session itself when it is
 *  an active number, otherwise the default number's (sales) chat. */
export function lineGroupOf(deviceId: string | null | undefined, lines: WhatsAppNumber[]): string | null {
  if (deviceId && lines.some((d) => d.device_id === deviceId)) return deviceId;
  return lines.find((d) => d.is_default)?.device_id ?? lines[0]?.device_id ?? null;
}

/** One per-number chat of a conversation, as the list shows it. */
export interface ChatLineRow {
  /** The active number this chat belongs to (its device_id). */
  group: string;
  /** Sessions whose messages make up this chat (for clearing its unread). */
  devices: string[];
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_flow: string | null;
  unread_count: number;
}

interface LineMeta {
  last_message_at?: string | null;
  last_message_preview?: string | null;
  last_message_flow?: string | null;
  unread_count?: number;
}

function lineMetaOf(data: Record<string, unknown>): Record<string, LineMeta> {
  const raw = data.line_meta;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, LineMeta>) : {};
}

/** The per-number chats of one conversation, newest first. */
export function chatLineRows(data: Record<string, unknown>, lines: WhatsAppNumber[]): ChatLineRow[] {
  const meta = lineMetaOf(data);
  const rows = new Map<string, ChatLineRow & { hasMeta: boolean }>();
  for (const dev of chatLines(data)) {
    const group = lineGroupOf(dev, lines);
    if (!group) continue;
    const row = rows.get(group) ?? {
      group, devices: [], last_message_at: null, last_message_preview: null, last_message_flow: null, unread_count: 0, hasMeta: false,
    };
    row.devices.push(dev);
    const m = meta[dev];
    if (m) {
      row.hasMeta = true;
      const at = m.last_message_at ?? null;
      if (at && (!row.last_message_at || at > row.last_message_at)) {
        row.last_message_at = at;
        row.last_message_preview = m.last_message_preview ?? null;
        row.last_message_flow = m.last_message_flow ?? null;
      }
      row.unread_count += typeof m.unread_count === 'number' ? m.unread_count : 0;
    }
    rows.set(group, row);
  }
  // A conversation with no per-number data yet (never touched since the
  // split, or no messages at all) is one chat showing the record's own fields.
  const list = [...rows.values()];
  if (list.length === 0) {
    const group = lineGroupOf(deviceIdString(data.device_id), lines);
    if (!group) return [];
    list.push({ group, devices: deviceIdString(data.device_id) ? [deviceIdString(data.device_id) as string] : [], last_message_at: null, last_message_preview: null, last_message_flow: null, unread_count: 0, hasMeta: false });
  }
  for (const row of list) {
    if (!row.hasMeta) {
      row.last_message_at = (data.last_message_at as string | null | undefined) ?? null;
      row.last_message_preview = (data.last_message_preview as string | null | undefined) ?? null;
      row.last_message_flow = (data.last_message_flow as string | null | undefined) ?? null;
      row.unread_count = list.length === 1 && typeof data.unread_count === 'number' ? data.unread_count : 0;
    }
  }
  return list
    .map(({ hasMeta: _hasMeta, ...row }) => row)
    .sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''));
}

/** Which messages a per-number chat shows: one number, or — for the default
 *  (sales) chat — everything except the other active numbers. */
export function lineMessageFilter(group: string, lines: WhatsAppNumber[]): { include?: string[]; exclude?: string[] } {
  const isDefaultGroup = lines.find((d) => d.is_default)?.device_id === group;
  return isDefaultGroup
    ? { exclude: lines.filter((d) => d.device_id !== group).map((d) => d.device_id) }
    : { include: [group] };
}

/** Does a message belong to that per-number chat? Messages without a number
 *  (old cached copies) count as the default chat's. */
export function messageInLine(
  deviceId: string | null | undefined,
  filter: { include?: string[]; exclude?: string[] } | null,
): boolean {
  if (!filter) return true;
  if (filter.include) return !!deviceId && filter.include.includes(deviceId);
  if (filter.exclude) return !deviceId || !filter.exclude.includes(deviceId);
  return true;
}
