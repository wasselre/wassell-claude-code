/**
 * Bulk project send engine — one client, many projects, ENQUEUED to the backend.
 *
 * Sends a prepared plan of projects into ONE WhatsApp conversation without the
 * rep ever waiting for delivery. On "Send all" we compute a staggered delivery
 * schedule and hand every message (each project's TEXT, then its ordered media)
 * to the durable `scheduled_whatsapp_jobs` queue via the existing scheduled-send
 * primitives:
 *   • TEXT  → `startNewChat({…, deliverAt})` for a brand-new conversation (also
 *             creates the chat record + client link), or `sendChatMessage(wid,
 *             {body, deliverAt})` for an existing one.
 *   • MEDIA → `sendProjectImageMessages(wid, refs, {deliverAt})` — the server
 *             fans the gallery into the same queue, one staggered row per item.
 * Each of those calls returns as soon as the message is ENQUEUED (a fast DB
 * insert), never waiting for WhatsApp to accept it. The Fly worker then drains
 * the queue and actually delivers — so the rep's modal closes the instant the
 * plan is queued, not minutes later when the last photo has gone out.
 *
 * ORDERING (was sent-gating, now deliver_at staggering): the old engine awaited
 * each WhatsApp acceptance in the tab so project N fully sent before N+1 began —
 * which is exactly what forced the rep to wait. Ordering now comes from the
 * `deliver_at` timestamps instead: the whole bulk is one steady ~4s stream —
 * TEXT at `base`, media at `base + k·SPACING`, the next project's text one tick
 * after the previous project's last media. The worker's
 * `scheduled_whatsapp_claim_due` pulls rows in `deliver_at` order, so the
 * customer sees text → photos → next project. Media items are staggered by the
 * SAME `SPACING` on the server (send-media-batch's `staggerSeconds`), so the
 * cadence is uniform end to end.
 *
 * DURABILITY: nothing is held in the tab. A mid-enqueue tab close can drop the
 * projects not yet queued (the enqueue loop is quick, so this window is ~1s),
 * but once queued a message survives refresh, tab close, and worker restarts —
 * and every queued message is visible + cancelable in the conversation's
 * scheduled-message strip.
 */

import { useAppStore } from '@/stores/appStore';
import { sendProjectImageMessages } from '@/lib/projectMessageImages';

/** Who receives the bulk send. Either an existing conversation, or a phone we
 *  may not have messaged yet (the first text establishes the chat). */
export type BulkRecipient =
  | { kind: 'chat'; chatWid: string }
  | { kind: 'new'; phone: string; clientRecordId?: string };

export interface BulkProjectPlanItem {
  projectId: string;
  projectName: string;
  /** Non-empty message body (the wizard validates). */
  text: string;
  /** Media refs already ordered documents → photos → videos (built via
   *  `orderSelectedRefsBulk`). May be empty (text-only project). */
  orderedRefs: string[];
}

export interface BulkEnqueueResult {
  /** The conversation everything was queued into (resolved after the first
   *  send establishes a brand-new chat). */
  chatWid: string | null;
  /** Projects successfully queued (text — and media, if any — enqueued). */
  queuedProjects: number;
  /** Projects whose TEXT could not be enqueued (skipped, media not queued). */
  failedProjects: number;
  /** Total media messages queued across all projects. */
  queuedMedia: number;
  /** First enqueue error, for a compact summary line. */
  firstError?: string;
}

/** Uniform delivery spacing for the whole bulk stream — every message (each
 *  project's text and each media item) is scheduled one tick after the last, so
 *  a batch drips out at a steady ~4s cadence rather than the 10s the default
 *  scheduled gallery uses. Kept just above the worker's ~3s poll so a chat's
 *  rows stay single-file (and so it survives send-media-batch's [3,60] clamp,
 *  since media items are staggered by the SAME value on the server). */
const SPACING_MS = 4_000;
/** Lead time before the FIRST message's delivery — the worker polls every ~3s,
 *  so this keeps project 1's text near-immediate while still going through the
 *  queue (uniform ordering with everything after it). */
const START_DELAY_MS = 4_000;

/**
 * Queue a whole bulk plan to the backend and return as soon as it is enqueued.
 *
 * Resolves quickly (only fast enqueue round-trips, no delivery waits). A failed
 * TEXT enqueue skips that project's media and is tallied in `failedProjects`;
 * the loop CONTINUES (later projects have later `deliver_at`, so skipping one
 * never reorders the rest) — unlike the old sent-gated engine, which stopped.
 */
export async function enqueueBulkProjectSend(
  recipient: BulkRecipient,
  plan: BulkProjectPlanItem[],
): Promise<BulkEnqueueResult> {
  const { sendChatMessage, startNewChat } = useAppStore.getState();

  let chatWid: string | null = recipient.kind === 'chat' ? recipient.chatWid : null;
  // For a 'chat' recipient the conversation already exists; for 'new' it is
  // established by the first text send (startNewChat creates the record + link).
  let established = recipient.kind === 'chat';
  let queuedProjects = 0;
  let failedProjects = 0;
  let queuedMedia = 0;
  let firstError: string | undefined;

  // Delivery cursor. Every project's text is scheduled at `cursor`; the cursor
  // then advances past that project's media before the next project starts.
  let cursor = Date.now() + START_DELAY_MS;

  for (const item of plan) {
    const base = cursor;
    const baseIso = new Date(base).toISOString();

    // ── 1) TEXT — enqueue (never awaited for delivery). ──────────────────
    let textOk = false;
    try {
      if (!established && recipient.kind === 'new') {
        const r = await startNewChat({
          phone: recipient.phone,
          body: item.text,
          clientRecordId: recipient.clientRecordId,
          deliverAt: baseIso,
        });
        chatWid = r.chatWid;
        established = true;
        textOk = true;
      } else if (chatWid) {
        await sendChatMessage(chatWid, { body: item.text, deliverAt: baseIso });
        textOk = true;
      } else {
        throw new Error('no conversation to send to');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      firstError ??= msg;
      failedProjects++;
      // Don't queue this project's media without its text. Advance one tick so
      // the remaining projects keep their spacing, then move on.
      cursor = base + SPACING_MS;
      continue;
    }

    if (!textOk) continue; // defensive; the try above sets it or throws

    // ── 2) MEDIA — one enqueue request; the server schedules PDF → photos →
    //        videos as queue rows at base + k·SPACING (staggerSeconds). ─────
    let mediaEnd = base;
    if (item.orderedRefs.length > 0 && chatWid) {
      const res = await sendProjectImageMessages(chatWid, item.orderedRefs, {
        deliverAt: baseIso,
        staggerSeconds: SPACING_MS / 1000,
      });
      queuedMedia += res.sent;
      if (res.failed > 0) firstError ??= 'some media could not be queued';
      // The server placed item k at base + (k+1)·SPACING, so the last one is at
      // base + n·SPACING regardless of how many resolved — reserve that window.
      mediaEnd = base + item.orderedRefs.length * SPACING_MS;
    }

    queuedProjects++;
    // Next project's text one tick after this project's last media.
    cursor = mediaEnd + SPACING_MS;
  }

  return { chatWid, queuedProjects, failedProjects, queuedMedia, firstError };
}
