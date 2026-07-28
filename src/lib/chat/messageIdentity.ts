/**
 * The stable identity of a WhatsApp message, browser side.
 *
 * A WhatsApp message id is `<true|false>_<chatId>_<HASH>[_<participant>]`, and
 * the `<chatId>` segment carries the ADDRESSING MODE the reporting source
 * happened to use — `<phone>@c.us` or `<lid>@lid` — for the very same message.
 * The gateway's history API and our webhook do not always agree on it, so the
 * raw id is not a usable key: the same message under two addressings occupies
 * two slots and renders twice.
 *
 * The trailing HASH is WhatsApp's own message id and is the part that does not
 * move.
 *
 * SERVER TWIN: `api/_lib/chatIngest.ts#messageIdHash` is the same function for
 * the ingest path. Change both together — the codebase already keeps
 * `CHATS_NAMESPACE` in step across three files for the same reason.
 */

import type { ChatMessage } from '@/types';

const WA_ID_RE = /^(true|false)_[^_]+@[a-z.]+_/i;

/**
 * WhatsApp's own message id, or null for ids that are not in that shape —
 * Haberchat-era rows are bare hex (they ARE their own identity) and our
 * synthesized rows (`reaction_…`, `pending:…`) must never collapse together.
 */
export function messageIdHash(id: string): string | null {
  if (!WA_ID_RE.test(id)) return null;
  return id.split('_')[2] ?? null;
}

/**
 * The key two records must share to be considered the same message.
 *
 * Direction is part of the key deliberately: the hash is globally unique per
 * message, but pinning the flow too means a freak collision still cannot merge
 * an inbound with an outbound.
 */
export function identityKey(m: Pick<ChatMessage, 'id' | 'flow'>): string {
  return `${m.flow}:${messageIdHash(m.id) ?? m.id}`;
}

const ACK_RANK: Record<string, number> = {
  failed: -1, pending: 0, sent: 1, delivered: 2, played: 3, read: 3,
};
function ackRank(a: ChatMessage['ack']): number {
  return a ? (ACK_RANK[a] ?? -1) : -1;
}

/**
 * Combine two records of the same message.
 *
 * `preferred` wins on content (it is the more trustworthy source — our own
 * mirror over the gateway's copy, because the mirror carries durable `wm_`
 * media refs while the gateway's `wf_` refs point at a disk we may not be
 * reading from). Delivery state is the exception: acks only ever move forward,
 * so the higher rank wins regardless of which side it came from — otherwise
 * reloading a thread could walk a "read" tick back to "sent".
 */
export function mergeOne(preferred: ChatMessage, other: ChatMessage): ChatMessage {
  const better = ackRank(other.ack) > ackRank(preferred.ack) ? other.ack : preferred.ack;

  // A message the customer DELETED ("deleted for everyone") is stored with
  // kind='revoked' and an emptied body. Backfilling a missing field from the
  // other source would put the withdrawn text straight back on screen, so a
  // revoked record is taken as-is: emptiness is its content.
  if (preferred.kind === 'revoked') return { ...preferred, ack: better, pending: undefined };

  return {
    ...preferred,
    ack: better,
    // Keep whichever side actually has media/quote/caption — a gateway row can
    // carry a quoted message the mirror stored before the reply landed, and a
    // mirror row can carry media the gateway has since expired.
    media_file_id: preferred.media_file_id ?? other.media_file_id,
    media_mime: preferred.media_mime ?? other.media_mime,
    media_caption: preferred.media_caption ?? other.media_caption,
    quoted: preferred.quoted ?? other.quoted,
    body: preferred.body ?? other.body,
    subtype: preferred.subtype ?? other.subtype,
    // A placeholder confirmed by either side is no longer pending; never let a
    // merge resurrect the clock icon.
    pending: preferred.pending === true && other.pending === true ? true : undefined,
    client_id: preferred.client_id ?? other.client_id,
  };
}

/**
 * Merge message lists into one thread.
 *
 * Sources are passed MOST TRUSTED FIRST. Later sources may add messages the
 * earlier ones do not have, but can never overwrite them (except to advance an
 * ack, see `mergeOne`). Result is sorted ascending by date, which is the order
 * the thread renders in.
 */
export function mergeMessageSources(...sources: ChatMessage[][]): ChatMessage[] {
  const byIdentity = new Map<string, ChatMessage>();
  for (const list of sources) {
    for (const m of list) {
      const k = identityKey(m);
      const seen = byIdentity.get(k);
      byIdentity.set(k, seen ? mergeOne(seen, m) : m);
    }
  }
  return [...byIdentity.values()].sort((a, b) => a.date.localeCompare(b.date));
}
