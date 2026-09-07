/**
 * Per-conversation SEND LANE — keeps outbound WhatsApp messages to one
 * recipient single-file.
 *
 * Why: a project message goes out as text → photos → videos, where the
 * gallery is ONE long server request (`/api/whatsapp/send-media-batch`) that
 * sends each item in order. Meanwhile the rep keeps working — opens the units
 * list and sends a units PDF, or types a follow-up — and that send used to go
 * straight to the gateway and land IN THE MIDDLE of the gallery (live
 * complaint 2026-09-07: the unit PDF arrived between two project photos).
 *
 * Model: each conversation (chat wid) has a lane. A long-running send HOLDS
 * the lane (`holdSendLane`); any other send-now to that conversation WAITS for
 * every hold to settle before it dispatches (`waitForSendLane`). Holds are
 * either a promise (the batch request) or a timestamp (a batch the server
 * upgraded to its delivery queue, which finishes at a known time).
 *
 * Scope: ONE browser tab. The batch itself is refresh-safe (server-owned), and
 * a waiting send is the rep's own action in this tab, so a `beforeunload`
 * guard warns while anything is queued here. Scheduled (deliverAt) sends never
 * touch the lane — they sit in the server queue at explicit times.
 *
 * Safety: every hold has a ceiling (a hung request must never freeze a chat
 * forever). When it trips, the hold is released with a console.error — the
 * worst case is the old interleaving behavior, never a stuck composer.
 *
 * Plain module + pub/sub (same pattern as jobCenter / staleBuild) so the store
 * and non-React libs read it synchronously.
 */

export interface SendLaneHold {
  id: string;
  /** Human label of the work holding the lane ("إرسال 5 من الوسائط"). */
  label: string;
  startedAt: number;
}

type Listener = () => void;

/** A promise-backed hold may run this long before it is force-released. The
 *  batch endpoint's own ceiling is 300 s (maxDuration); this sits above it. */
const PROMISE_HOLD_CEILING_MS = 6 * 60_000;
/** A time-based hold (server delivery queue) may extend this far ahead —
 *  120 items × 10 s stagger = 20 min is the largest batch the server accepts. */
const UNTIL_HOLD_CEILING_MS = 25 * 60_000;

interface InternalHold extends SendLaneHold {
  done: Promise<void>;
}

const lanes = new Map<string, InternalHold[]>();
const listeners = new Set<Listener>();
let waiters = 0;

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeSendLanes(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Current holds on a conversation's lane (empty → free). */
export function getSendLaneHolds(chatWid: string): readonly SendLaneHold[] {
  return lanes.get(chatWid) ?? [];
}

export function isSendLaneBusy(chatWid: string): boolean {
  return (lanes.get(chatWid)?.length ?? 0) > 0;
}

/** Sends currently parked behind a lane, across all conversations. */
export function getSendLaneWaiterCount(): number {
  return waiters;
}

function removeHold(chatWid: string, id: string): void {
  const list = lanes.get(chatWid);
  if (!list) return;
  const next = list.filter((h) => h.id !== id);
  if (next.length === 0) lanes.delete(chatWid);
  else lanes.set(chatWid, next);
  emit();
}

/**
 * Hold the conversation's lane while `work` runs, or until the `until`
 * timestamp (ms) passes. Returns a release function — calling it early ends
 * the hold (e.g. the batch request failed before sending anything).
 *
 * A rejected `work` promise releases the hold like a resolved one; the caller
 * owns its own error handling.
 */
export function holdSendLane(
  chatWid: string,
  label: string,
  work: Promise<unknown> | { until: number },
): () => void {
  const id = crypto.randomUUID();
  let release: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const done = new Promise<void>((resolve) => {
    let settled = false;
    release = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeHold(chatWid, id);
      resolve();
    };

    if ('until' in work) {
      const delay = Math.min(UNTIL_HOLD_CEILING_MS, Math.max(0, work.until - Date.now()));
      timer = setTimeout(release, delay);
    } else {
      // Ceiling: a request that never settles must not freeze the chat.
      timer = setTimeout(() => {
        console.error(`[sendLane] hold "${label}" on ${chatWid} exceeded ${PROMISE_HOLD_CEILING_MS / 1000}s — releasing`);
        release();
      }, PROMISE_HOLD_CEILING_MS);
      work.then(release, release);
    }
  });

  const hold: InternalHold = { id, label, startedAt: Date.now(), done };
  lanes.set(chatWid, [...(lanes.get(chatWid) ?? []), hold]);
  emit();
  return release;
}

/**
 * Resolve once the conversation's lane is free. Re-checks after every wave of
 * holds settles, so a hold added while waiting is honored too (a second
 * gallery queued behind the first keeps the PDF behind both).
 *
 * `onWaiting` fires once if the lane was busy on entry — callers use it to
 * show "waiting for the media to finish" in their job entry.
 */
export async function waitForSendLane(
  chatWid: string,
  onWaiting?: (holds: readonly SendLaneHold[]) => void,
): Promise<void> {
  if (!isSendLaneBusy(chatWid)) return;
  waiters++;
  emit();
  try {
    onWaiting?.(getSendLaneHolds(chatWid));
    while (isSendLaneBusy(chatWid)) {
      const current = lanes.get(chatWid) ?? [];
      await Promise.all(current.map((h) => h.done));
    }
  } finally {
    waiters--;
    emit();
  }
}

/** One-line description of what the lane is waiting on, for job details. */
export function describeSendLaneHolds(holds: readonly SendLaneHold[], isAr: boolean): string {
  const names = holds.map((h) => `«${h.label}»`).join(isAr ? '، ' : ', ');
  return isAr ? `بانتظار انتهاء ${names}` : `Waiting for ${names} to finish`;
}

// ── beforeunload guard: a send parked in this tab dies with the tab. ────────
// The batch it waits on is server-owned (refresh-safe); the parked send is not.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (waiters > 0) {
      e.preventDefault();
      // Legacy browsers need returnValue set to show the prompt.
      e.returnValue = '';
    }
  });
}

/** TEST-ONLY. */
export function __resetSendLanes(): void {
  lanes.clear();
  waiters = 0;
  emit();
}
