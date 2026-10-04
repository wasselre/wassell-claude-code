/**
 * Which WhatsApp numbers ("lines") a conversation lives on.
 *
 * A conversation record is ONE per contact, shared by every number we own
 * (its id is uuidv5 of the contact's wid), and `data.device_id` keeps only the
 * FIRST number it was ever seen on. So `device_id` alone cannot answer "does
 * this chat belong under the Client requests number?": an office that once
 * wrote to the sales number would only ever show under Sales.
 *
 * `data.lines` is the answer. The WhatsApp webhook adds the number of every
 * message it ingests (api/_lib/chatIngest.ts), and the 2026-10-04 backfill
 * filled it from chat_messages. A conversation the webhook never touched falls
 * back to its first number.
 */

import type { WhatsAppNumber } from '@/types';
import { deviceIdString } from '@/lib/haberchat/normalize';

/** Every number this conversation has messages on. */
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
 * Label for a number in the Chats switcher. The sales default and the
 * operations line are named by their ROLE (which survives a SIM swap or a
 * rename); any other number by its own display name.
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
