/**
 * Which of our numbers the OPEN chat belongs to.
 *
 * A contact who talked to two of our numbers is two chats in the Chats list
 * (one per number). Whatever gets sent while one of them is open — typed text,
 * attachments, a project's photos, a payment-plan PDF — must leave from THAT
 * number, not from whichever number the conversation record happened to see
 * first. ChatDetail registers the open chat's number here; every send path
 * that resolves a sending number for a wid asks here first.
 *
 * In-memory and per tab: it describes what is on screen right now.
 */

const openLines = new Map<string, string>();

export function setOpenChatLine(chatWid: string, deviceId: string | null): void {
  if (!chatWid) return;
  if (deviceId) openLines.set(chatWid, deviceId);
  else openLines.delete(chatWid);
}

export function openChatLine(chatWid: string | null | undefined): string | null {
  return chatWid ? openLines.get(chatWid) ?? null : null;
}
