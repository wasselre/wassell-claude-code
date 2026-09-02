import type { AppRecord } from '@/types';

/**
 * The name to show for a conversation (2026-08-10; extended to clients same day).
 *
 * A chat's `data.name` is the PUSH NAME — whatever the person set on their own
 * WhatsApp profile, or nothing at all (then we fall back to the raw number).
 * Whenever we have deliberately filed that number under a name of our own —
 * as a client or as an address-book contact — OURS is the better label: it is
 * the name the business chose, and it is the entire point of saving the record.
 *
 * Precedence: linked client → saved contact → project officer → WhatsApp push
 * name → phone → «—».
 *
 * Client wins over contact because the sales relationship is the stronger one
 * and its record is what a rep acts on; the two rarely coexist on one number.
 * A project officer (a developer's/marketer's coordinator we notify about
 * visits) is a deliberately-filed name too, so it beats the raw push name — but
 * it ranks below client/contact, which are the records a rep acts on directly.
 * The identifying phone stays visible under the title in both panes either way,
 * and the «عميل مرتبط» / «جهة اتصال» / «مسؤول مشروع» pills still say which
 * record is in play.
 */
export function resolveChatDisplayName(
  chatData: Record<string, unknown> | undefined,
  matchedContact: AppRecord | null,
  linkedClient?: AppRecord | null,
  matchedOfficer?: AppRecord | null,
): string {
  // Clients store their name in `client_name`; some legacy rows use `name`.
  const clientData = linkedClient ? (linkedClient.data as Record<string, unknown>) : null;
  const clientName =
    (clientData?.client_name as string | null | undefined) ??
    (clientData?.name as string | null | undefined);
  if (typeof clientName === 'string' && clientName.trim()) return clientName.trim();

  const contactName = matchedContact
    ? ((matchedContact.data as Record<string, unknown>).name as string | null | undefined)
    : null;
  if (typeof contactName === 'string' && contactName.trim()) return contactName.trim();

  const officerName = matchedOfficer
    ? ((matchedOfficer.data as Record<string, unknown>).name as string | null | undefined)
    : null;
  if (typeof officerName === 'string' && officerName.trim()) return officerName.trim();

  const pushName = chatData?.name as string | null | undefined;
  if (typeof pushName === 'string' && pushName.trim()) return pushName.trim();

  const phone = chatData?.phone as string | null | undefined;
  if (typeof phone === 'string' && phone.trim()) return phone.trim();

  return '—';
}
