/**
 * WHEN the chat auto-read cron reads a conversation. PURE (unit-tested).
 *
 * Measured on live traffic (2026-09-27): 71% of the gaps between a customer's
 * consecutive messages are under 3 minutes (median 42 s) and reps reply after a
 * median 95 s. So a burst is read ONCE, after it settles:
 *   • settle  — wait until SETTLE_MS (90 s) has passed since the newest unread
 *               customer message (a customer typing in three bubbles is one read);
 *   • cap     — never wait more than MAX_WAIT_MS (10 min) after the OLDEST
 *               unread message, however chatty the customer keeps being;
 *   • voice   — a voice note still being transcribed holds the read back (its
 *               text is on its way), subject to the same cap;
 *   • gate    — the free keyword gate (keywordGate.ts) decides whether the
 *               settled batch is worth a reading at all;
 *   • lease   — a chat another reader holds is skipped;
 *   • backoff — a chat whose reads keep failing waits 2, 4, 8 … 60 minutes
 *               between attempts and is left to the rep (open / «أعد القراءة»)
 *               after MAX_CONSECUTIVE_FAILURES in a row — never an every-minute
 *               retry loop on a paid model.
 */

import { passesKeywordGate } from './keywordGate.js';

export const SETTLE_MS = 90_000;
export const MAX_WAIT_MS = 600_000;
export const LEASE_SECONDS = 300;
/** After this many failed/partial reads in a row the cron stops trying; a rep read resets it. */
export const MAX_CONSECUTIVE_FAILURES = 8;
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;

/** One row of `chat_read_candidates` (supabase/migrations/2026-09-27_05_chat_read_state.sql). */
export interface ReadCandidate {
  chat_wid: string;
  client_id: string;
  newest_in_at: string | null;
  oldest_unread_at: string | null;
  unread_count: number;
  unread_bodies: string[] | null;
  pending_transcripts: number;
  unread_voice_untranscribed: number;
  lease_until: string | null;
  consecutive_failures: number;
  last_attempt_at: string | null;
}

export type NotDueReason = 'not_settled' | 'transcribing' | 'leased' | 'gate' | 'backoff';
export type DueDecision = { due: true } | { due: false; reason: NotDueReason };

const ms = (iso: string | null | undefined): number => {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
};

/** How long to wait after the n-th consecutive failure (n ≥ 1). */
export function backoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS);
}

export function decideDue(c: ReadCandidate, now: Date): DueDecision {
  const t = now.getTime();

  const lease = ms(c.lease_until);
  if (!Number.isNaN(lease) && lease > t) return { due: false, reason: 'leased' };

  const failures = c.consecutive_failures ?? 0;
  if (failures >= MAX_CONSECUTIVE_FAILURES) return { due: false, reason: 'backoff' };
  if (failures > 0) {
    const last = ms(c.last_attempt_at);
    if (!Number.isNaN(last) && t - last < backoffMs(failures)) return { due: false, reason: 'backoff' };
  }

  const oldest = ms(c.oldest_unread_at);
  const capped = !Number.isNaN(oldest) && t - oldest >= MAX_WAIT_MS;
  if (!capped) {
    const newest = ms(c.newest_in_at);
    if (!Number.isNaN(newest) && t - newest < SETTLE_MS) return { due: false, reason: 'not_settled' };
    if ((c.pending_transcripts ?? 0) > 0) return { due: false, reason: 'transcribing' };
  }

  // Nothing unread to read (only a voice note, and it hit the cap) ⇒ nothing to do.
  if ((c.unread_count ?? 0) === 0) return { due: false, reason: 'gate' };
  if (!passesKeywordGate(c.unread_bodies ?? []).pass) return { due: false, reason: 'gate' };
  return { due: true };
}

export interface DueSelection {
  due: ReadCandidate[];
  /** Settled, but the keyword gate says there is nothing worth reading. */
  gated: ReadCandidate[];
  /** Still settling or waiting for a voice transcript. */
  waiting: ReadCandidate[];
  leased: ReadCandidate[];
  backoff: ReadCandidate[];
}

/** Partition candidates; input order (oldest unread first) is preserved in every bucket. */
export function selectDueChats(cands: readonly ReadCandidate[], now: Date): DueSelection {
  const out: DueSelection = { due: [], gated: [], waiting: [], leased: [], backoff: [] };
  for (const c of cands) {
    const d = decideDue(c, now);
    if (d.due) { out.due.push(c); continue; }
    switch (d.reason) {
      case 'gate': out.gated.push(c); break;
      case 'leased': out.leased.push(c); break;
      case 'backoff': out.backoff.push(c); break;
      default: out.waiting.push(c);
    }
  }
  return out;
}
