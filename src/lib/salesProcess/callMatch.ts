// callMatch — the single rule for deciding WHICH phone call belongs to a follow-up.
//
// WHY THIS FILE EXISTS
//   Two independent code paths used to answer this question, and they disagreed:
//
//     1. EvidencePicker auto-attached `candidates[0]` — the client's most recent
//        outbound call — with NO time bound at all.
//     2. The `tg_records_link_call_to_followup` DB trigger (for recordings that
//        arrive after the rep already completed the task) used a 2-hour window.
//
//   Path 1 is why 27 of 400 linked follow-ups in production carry the wrong call
//   as their completing evidence — the worst by 87 days. Measured 2026-07-30
//   against wassell-prod: 373/400 links land within 15 minutes, median delta 0.6
//   minutes, and EVERY link beyond 15 minutes was wrong.
//
//   That 15-minute figure is the window below. It is deliberately generous
//   against a 0.6-minute median: a rep who dials, talks for 4 minutes, then
//   writes notes before hitting Complete is still comfortably inside it.
//
// THE RULE
//   A call is the follow-up's call iff it is OUTBOUND, belongs to this client
//   (by client link or by any phone on the record), and started within
//   ±CALL_MATCH_WINDOW_MINUTES of the anchor — the moment the rep worked the
//   task (`actual_datetime`, falling back to now while the form is still open).
//
//   When nothing matches, the answer is NOTHING — never "the closest thing we
//   could find". A stale auto-attach is worse than an empty field: it shows the
//   rep a recording from another conversation, and (once the AI suggestion
//   pipeline lands) it would have the model classify the wrong call entirely.
//   The rep can always attach a call manually; see `listRecentCalls`.
//
// Keep CALL_MATCH_WINDOW_MINUTES in sync with the `v_window` constant in
// supabase/migrations/2026-07-30_tighten_call_followup_link_window.sql — the
// trigger is the server-side half of this same rule.

import { normalizePhone } from '@/lib/phone';
import type { AppRecord } from '@/types';

/** Half-width of the match window, in minutes. See the header for the evidence. */
export const CALL_MATCH_WINDOW_MINUTES = 15;

const WINDOW_MS = CALL_MATCH_WINDOW_MINUTES * 60_000;

/** How many recent calls to offer for manual attach when nothing auto-matches. */
const RECENT_LIMIT = 5;

export interface CallMatchInput {
  /** All phone_calls records from the store (already model-scoped). */
  calls: readonly AppRecord[];
  /** The follow-up's linked client record id, when known. */
  clientId: string | null;
  /** Every phone number on the follow-up/client, unnormalized. */
  phones: readonly string[];
  /**
   * The moment the rep worked this task — `actual_datetime` once an outcome is
   * picked, otherwise the current time. ISO string or ms.
   */
  anchor: string | number | Date | null | undefined;
}

/** Parsed `call_time` in ms, or null when absent/unparseable. */
export function callTimeMs(call: AppRecord): number | null {
  const raw = call.data.call_time;
  if (typeof raw !== 'string' || !raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function anchorMs(anchor: CallMatchInput['anchor']): number {
  if (anchor instanceof Date) {
    const ms = anchor.getTime();
    return Number.isNaN(ms) ? Date.now() : ms;
  }
  if (typeof anchor === 'number') return Number.isFinite(anchor) ? anchor : Date.now();
  if (typeof anchor === 'string' && anchor) {
    const ms = Date.parse(anchor);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

/** True when this call belongs to the client — by link first, then by phone. */
function belongsToClient(call: AppRecord, clientId: string | null, normPhones: ReadonlySet<string>): boolean {
  if (clientId && call.data.client_link === clientId) return true;
  const cp = normalizePhone(call.data.customer_phone as string);
  return cp ? normPhones.has(cp) : false;
}

/** This client's outbound calls, newest first. Not window-filtered. */
export function listRecentCalls({ calls, clientId, phones }: Omit<CallMatchInput, 'anchor'>): AppRecord[] {
  const normPhones = new Set(phones.map((p) => normalizePhone(p)).filter(Boolean) as string[]);
  return calls
    .filter((r) => r.data.direction === 'outbound' && belongsToClient(r, clientId, normPhones))
    .sort((a, b) => (callTimeMs(b) ?? 0) - (callTimeMs(a) ?? 0))
    .slice(0, RECENT_LIMIT);
}

/**
 * The call that completed this follow-up, or null when none is close enough.
 *
 * Picks the call NEAREST the anchor rather than the most recent one inside the
 * window — if a rep dialled twice, the one they were on when they completed the
 * task is the evidence.
 */
export function resolveCallForFollowup(input: CallMatchInput): AppRecord | null {
  const { calls, clientId, phones } = input;
  const at = anchorMs(input.anchor);
  const normPhones = new Set(phones.map((p) => normalizePhone(p)).filter(Boolean) as string[]);

  let best: AppRecord | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (const call of calls) {
    if (call.data.direction !== 'outbound') continue;
    if (!belongsToClient(call, clientId, normPhones)) continue;
    const ms = callTimeMs(call);
    if (ms === null) continue;
    const delta = Math.abs(ms - at);
    if (delta > WINDOW_MS) continue;
    if (delta < bestDelta) {
      best = call;
      bestDelta = delta;
    }
  }
  return best;
}

/** Minutes between a call and the anchor — for surfacing "why not" to the rep. */
export function minutesFromAnchor(call: AppRecord, anchor: CallMatchInput['anchor']): number | null {
  const ms = callTimeMs(call);
  if (ms === null) return null;
  return Math.round(Math.abs(ms - anchorMs(anchor)) / 60_000);
}
