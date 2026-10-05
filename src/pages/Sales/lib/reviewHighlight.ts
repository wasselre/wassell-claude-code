import { normalizeForSearch } from '@/lib/recordSearch';

/**
 * Which chat messages a review card rests on — so clicking a card in the AI
 * chat review lights those messages up. Pure, so it is unit-tested.
 *
 * The AI keeps the customer's own words for every preference it saves
 * (`client_ai_changes.quote`, sometimes several fragments joined by «…» / ...),
 * the district name for a place (`label`), and a time for a booking. We match
 * on the folded text (same folding as record search: أإآ→ا, ة→ه, ى→ي, digits).
 */

export interface ReviewMessage {
  id: string;
  flow: string;
  date: string;
  body?: string | null;
  media_caption?: string | null;
  transcript?: string | null;
}

const MIN_FRAGMENT = 3;

function textOf(m: ReviewMessage): string {
  return normalizeForSearch([m.body, m.media_caption, m.transcript].filter(Boolean).join(' '));
}

/** A quote → the fragments worth searching for (ellipses and guillemets split it). */
export function quoteFragments(quote: string | null | undefined): string[] {
  if (!quote) return [];
  return quote
    .split(/\.{2,}|…|«|»|"|\n/)
    .map((f) => normalizeForSearch(f).trim())
    .filter((f) => f.length >= MIN_FRAGMENT);
}

/**
 * Messages whose text contains any of the needles. `inboundFirst`: prefer the
 * customer's messages, and use the whole chat only when none of theirs match
 * (a district the customer named vs. one our side named).
 */
export function messagesMatching(
  messages: readonly ReviewMessage[], needles: readonly string[], inboundFirst = false,
): Set<string> {
  const ns = needles.map((n) => normalizeForSearch(n).trim()).filter((n) => n.length >= MIN_FRAGMENT);
  const hit = (pool: readonly ReviewMessage[]) =>
    new Set(pool.filter((m) => { const t = textOf(m); return t && ns.some((n) => t.includes(n)); }).map((m) => m.id));
  if (ns.length === 0) return new Set();
  if (inboundFirst) {
    const own = hit(messages.filter((m) => m.flow === 'in'));
    if (own.size > 0) return own;
  }
  return hit(messages);
}

/** Messages in the minutes before (and just after) a moment — what led to a booking. */
export function messagesBefore(
  messages: readonly ReviewMessage[], atISO: string, beforeMin = 20, afterMin = 2,
): Set<string> {
  const at = Date.parse(atISO);
  if (!Number.isFinite(at)) return new Set();
  const lo = at - beforeMin * 60_000;
  const hi = at + afterMin * 60_000;
  return new Set(messages.filter((m) => { const t = Date.parse(m.date); return t >= lo && t <= hi; }).map((m) => m.id));
}
