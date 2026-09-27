/**
 * When the in-chat card reads the conversation ON ITS OWN as the rep opens
 * the chat (trigger 'open'), without the rep pressing «اقرأ المواقع». Pure —
 * the card calls it after loading.
 *
 * Since the chat auto-read (2026-09-27) there is ONE rule: read when the
 * customer has written something the reader has not read yet
 * (`unread_customer_messages`, counted against the chat_read_state
 * watermarks — transcribed voice notes included). Everything else that used to
 * live here — a minimum of 3 customer messages, an hour between re-reads — is
 * now the server's job: the free keyword gate skips a batch of pleasantries
 * without any model call, and the per-(chat, client) lease stops a double read.
 *   • never when the evidence is graded (a geography re-read there is
 *     review-only and cannot pick up new messages), or inside the server's
 *     60-second cool-down after a reading.
 * The card still calls this at most once per mount. A rep can always press the
 * button by hand; this only saves the tap.
 */

export interface AutoReadInput {
  graded: boolean;
  can_reanalyze: boolean;
  unread_customer_messages: number;
}

export function shouldAutoRead(card: AutoReadInput): boolean {
  if (!card.can_reanalyze || card.graded) return false;
  return card.unread_customer_messages > 0;
}
