import type { AppRecord } from '@/types';

/**
 * The name to show for a conversation (2026-08-10).
 *
 * A chat's `data.name` is the PUSH NAME — whatever the person set on their own
 * WhatsApp profile, or nothing at all (then we fall back to the raw number).
 * When we have deliberately saved that number under a name in the address book,
 * OUR name is the better label: that is the entire point of saving a contact.
 *
 * Precedence: saved contact name → WhatsApp push name → phone → em dash.
 *
 * Deliberately NOT applied to linked clients — a client-linked chat keeps its
 * push name and carries the client name in its «عميل مرتبط» pill, which is what
 * the sales surfaces have shown since 2026-07-21. Change that on purpose, not
 * as a side effect of this helper.
 */
export function resolveChatDisplayName(
  chatData: Record<string, unknown> | undefined,
  matchedContact: AppRecord | null,
): string {
  const contactName = matchedContact
    ? ((matchedContact.data as Record<string, unknown>).name as string | null | undefined)
    : null;
  if (typeof contactName === 'string' && contactName.trim()) return contactName.trim();

  const pushName = chatData?.name as string | null | undefined;
  if (typeof pushName === 'string' && pushName.trim()) return pushName.trim();

  const phone = chatData?.phone as string | null | undefined;
  if (typeof phone === 'string' && phone.trim()) return phone.trim();

  return '—';
}
