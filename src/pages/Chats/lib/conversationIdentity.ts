/**
 * Conversation identity — the ONE explicit answer to "is this conversation
 * ready to be sent on, and with what?".
 *
 * Why this exists (live bug, 2026-08-18): the conversation header, the thread
 * and the composer all rendered from `record.data` the moment the record
 * existed, but the pieces a send actually needs — the chat `wid`, the
 * recipient `phone`, and a send-from device — resolve at DIFFERENT times.
 * `wid`/`phone` land when the chats list (or the inbound webhook) fills the
 * record; the device overlay is a separate fire-and-forget load at boot. The
 * composer was gated only on `kind === 'user'`, so a rep could type and hit
 * Send in that window; `sendChatMessage` then threw one of its identity
 * errors BEFORE creating the optimistic bubble, and the message vanished.
 *
 * Resolving identity as one value fixes that: the composer only exists when
 * every piece is present, and the send captures the resolved identity so a
 * resolution landing later can never re-target an in-flight send.
 */

import type { AppModel, AppRecord, WhatsAppNumber, HaberchatDevice } from '@/types';
import { resolveSendDeviceId } from '@/lib/haberchat/normalize';

/** A conversation with every piece a send needs. Carried by value into each
 *  dispatch, so an in-flight send is bound to the chat it was typed in. */
export interface ResolvedConversationIdentity {
  status: 'ready';
  /** `records` row id of the conversation (the uuidv5-of-wid record). */
  recordId: string;
  /** Haberchat conversation id, e.g. `966555…@c.us`. */
  chatWid: string;
  /** Canonical recipient phone as stored on the record. */
  phone: string;
  /** Device the message goes out from. */
  deviceId: string;
}

export type ConversationIdentity =
  | ResolvedConversationIdentity
  /** Something identity depends on is still loading — show a wait state, not
   *  an error, and never an enabled composer. */
  | { status: 'loading' }
  /** Groups / channels — sending is not supported at all. */
  | { status: 'unsupported'; kind: string }
  /** Loaded, but a required piece is genuinely absent. A real, actionable
   *  problem: say so instead of spinning forever. */
  | { status: 'incomplete'; reason: 'missing-wid' | 'missing-phone' | 'no-device' };

export function resolveConversationIdentity(input: {
  recordId: string;
  chatsModel: AppModel | null | undefined;
  /** `records[chatsModel.id]` — the conversation rows currently in the store. */
  chatRecords: AppRecord[];
  waDevices: WhatsAppNumber[] | null | undefined;
  waDevicesLive: HaberchatDevice[] | null | undefined;
  /** False until the device overlay load has settled. Distinguishes "the
   *  devices haven't arrived yet" (wait) from "there is no device" (error). */
  devicesLoaded: boolean;
}): ConversationIdentity {
  const { recordId, chatsModel, chatRecords, waDevices, waDevicesLive, devicesLoaded } = input;

  if (!chatsModel) return { status: 'loading' };
  const record = chatRecords.find((r) => r.id === recordId);
  if (!record) return { status: 'loading' };

  const data = record.data as Record<string, unknown>;

  const kind = typeof data.kind === 'string' && data.kind ? data.kind : 'user';
  if (kind !== 'user') return { status: 'unsupported', kind };

  const chatWid = typeof data.wid === 'string' && data.wid ? data.wid : null;
  if (!chatWid) return { status: 'incomplete', reason: 'missing-wid' };

  const phone = typeof data.phone === 'string' && data.phone ? data.phone : null;
  if (!phone) return { status: 'incomplete', reason: 'missing-phone' };

  const deviceId = resolveSendDeviceId(data.device_id, waDevices, waDevicesLive);
  if (!deviceId) return devicesLoaded ? { status: 'incomplete', reason: 'no-device' } : { status: 'loading' };

  return { status: 'ready', recordId, chatWid, phone, deviceId };
}

/** Short bilingual explanation for every non-ready identity state. */
export function conversationIdentityMessage(
  identity: Exclude<ConversationIdentity, ResolvedConversationIdentity>,
  isAr: boolean,
): string {
  if (identity.status === 'loading') {
    return isAr ? 'جارٍ تحميل المحادثة…' : 'Loading conversation…';
  }
  if (identity.status === 'unsupported') {
    return isAr
      ? 'الإرسال للمجموعات والقنوات غير مدعوم حاليًا.'
      : 'Sending to groups and channels is not yet supported.';
  }
  if (identity.reason === 'no-device') {
    return isAr
      ? 'لا يوجد رقم واتساب للإرسال — عيّن رقمًا افتراضيًا في الإعدادات.'
      : 'No WhatsApp number to send from — set a default in Settings.';
  }
  return isAr
    ? 'لا يمكن الإرسال بعد — لم يكتمل التعرّف على هذه المحادثة (الرقم غير معروف).'
    : "Can't send yet — this conversation isn't fully identified (its number is unknown).";
}
