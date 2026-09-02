/**
 * Bulk project send engine — one client, many projects, strictly ordered.
 *
 * Sends a prepared plan of projects into ONE WhatsApp conversation:
 *   • Per project: TEXT first, then the ordered media (documents → photos →
 *     videos, as the caller ordered `orderedRefs`) — i.e. text → PDF → pictures.
 *   • Across projects: project N is FULLY sent before project N+1 begins.
 *
 * SENT-GATING (not delivery): every step is `await`ed, and each await resolves
 * only when WhatsApp has ACCEPTED the message —
 *   - `sendChatMessage` throws on failure and otherwise resolves after the
 *     gateway accepts (it flips the bubble to `ack:'sent'`);
 *   - `startNewChat().sent` resolves `{ ok }` after the first message is
 *     accepted/rejected (used only to establish a brand-new conversation);
 *   - `sendProjectImageMessages` returns `{ sent, failed }` after its server-side
 *     sequential loop, which itself awaits each item's WAHA acceptance.
 * We never wait on delivery acks (double-tick) — those arrive async and would
 * stall on a phone that's off. Nothing here is fire-and-forget: the ordering the
 * customer sees is guaranteed by the awaits, not by luck.
 *
 * There is intentionally NO durable cross-project queue: a mid-bulk tab close
 * stops the remaining projects (each project is itself atomic + refresh-safe).
 * The wizard surfaces exactly where it stopped so the rep can resume.
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

export type BulkStepStatus =
  | 'pending'
  | 'sending-text'
  | 'sending-media'
  | 'done'
  | 'done-with-errors'
  | 'failed';

export interface BulkProgress {
  /** 0-based index of the project in the plan. */
  index: number;
  projectId: string;
  status: BulkStepStatus;
  mediaSent?: number;
  mediaFailed?: number;
  error?: string;
}

export interface BulkSendResult {
  /** The conversation everything went to (resolved after the first send). */
  chatWid: string | null;
  sentProjects: number;
  failedProjects: number;
  /** Index the run STOPPED at on a hard failure, or null if it completed. */
  stoppedAt: number | null;
}

export async function runBulkProjectSend(
  recipient: BulkRecipient,
  plan: BulkProjectPlanItem[],
  opts: { onProgress?: (p: BulkProgress) => void } = {},
): Promise<BulkSendResult> {
  const report = (p: BulkProgress) => opts.onProgress?.(p);
  const { sendChatMessage, startNewChat } = useAppStore.getState();

  let chatWid: string | null = recipient.kind === 'chat' ? recipient.chatWid : null;
  // For a 'chat' recipient the conversation already exists; for 'new' it is
  // established by the first text send (startNewChat).
  let established = recipient.kind === 'chat';
  let sentProjects = 0;
  let failedProjects = 0;

  for (let i = 0; i < plan.length; i++) {
    const item = plan[i]!;

    // ── 1) TEXT (sent-gated). ────────────────────────────────────────────
    report({ index: i, projectId: item.projectId, status: 'sending-text' });
    let textOk = false;
    let textErr: string | undefined;
    try {
      if (!established && recipient.kind === 'new') {
        const r = await startNewChat({
          phone: recipient.phone,
          body: item.text,
          clientRecordId: recipient.clientRecordId,
        });
        chatWid = r.chatWid;
        established = true;
        const { ok } = await r.sent; // resolves on acceptance/rejection, never throws
        textOk = ok;
        if (!ok) textErr = 'gateway rejected the first message';
      } else if (chatWid) {
        await sendChatMessage(chatWid, { body: item.text });
        textOk = true;
      }
    } catch (err) {
      textOk = false;
      textErr = err instanceof Error ? err.message : String(err);
    }

    if (!textOk) {
      // Hard failure: do NOT send this project's media, and do NOT jump ahead —
      // stop so the rep decides. Ordering is never violated by continuing past
      // a message we couldn't send.
      failedProjects++;
      report({ index: i, projectId: item.projectId, status: 'failed', error: textErr });
      return { chatWid, sentProjects, failedProjects, stoppedAt: i };
    }

    // ── 2) MEDIA — one refresh-safe request; the server sends PDF → photos →
    //        videos sequentially, awaiting each item's acceptance. ──────────
    let mediaSent = 0;
    let mediaFailed = 0;
    if (item.orderedRefs.length > 0 && chatWid) {
      report({ index: i, projectId: item.projectId, status: 'sending-media' });
      const res = await sendProjectImageMessages(chatWid, item.orderedRefs);
      mediaSent = res.sent;
      mediaFailed = res.failed;
    }

    sentProjects++;
    report({
      index: i,
      projectId: item.projectId,
      status: mediaFailed > 0 ? 'done-with-errors' : 'done',
      mediaSent,
      mediaFailed,
    });
  }

  return { chatWid, sentProjects, failedProjects, stoppedAt: null };
}
