/**
 * When the in-chat geography card reads the conversation ON ITS OWN, without
 * the rep pressing «اقرأ المواقع». Pure — the card calls it after loading.
 *
 * A reading costs one extraction + one verifier call, so it is triggered only
 * when there is something new to read, and never twice in a burst:
 *   • never read → read once the CUSTOMER has written at least
 *     AUTO_READ_MIN_CUSTOMER_MESSAGES text messages (a greeting alone has no
 *     places in it);
 *   • read before, and the customer has written since → re-read, but at most
 *     once per AUTO_REREAD_MIN_GAP_MS, so a rep reopening a busy chat does not
 *     pay for a reading per message;
 *   • never when the evidence is graded (a re-read there is review-only and
 *     cannot pick up new messages) or inside the server's cool-down.
 * A rep can always press the button by hand; this only saves the tap.
 */
export const AUTO_READ_MIN_CUSTOMER_MESSAGES = 3;
export const AUTO_REREAD_MIN_GAP_MS = 60 * 60 * 1000;

export interface AutoReadInput {
  status: string;
  stale: boolean;
  graded: boolean;
  can_reanalyze: boolean;
  analyzed_at: string | null;
  customer_messages: number;
}

export function shouldAutoRead(card: AutoReadInput, now: Date = new Date()): boolean {
  if (!card.can_reanalyze || card.graded) return false;
  if (card.status === 'none') return card.customer_messages >= AUTO_READ_MIN_CUSTOMER_MESSAGES;
  if (!card.stale) return false;
  const last = card.analyzed_at ? Date.parse(card.analyzed_at) : Number.NaN;
  if (Number.isNaN(last)) return false; // cannot tell how old the reading is ⇒ leave it to the rep
  return now.getTime() - last >= AUTO_REREAD_MIN_GAP_MS;
}
