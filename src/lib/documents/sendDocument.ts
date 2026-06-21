/**
 * Browser-side helper for sending a generated PDF to a customer over WhatsApp.
 * The server (api/send-document) resolves the client phone, re-hosts the PDF to
 * Haberchat, sends it, and logs the send. The browser never holds the call.
 */

import { authHeader } from './generate';

export async function sendDocumentToCustomer(input: {
  fileId: string;
  recordId: string;
  deviceId: string;
  caption: string;
}): Promise<{ ok: true; wid: string }> {
  const res = await fetch('/api/send-document', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; wid?: string; error?: string };
  if (!res.ok || !body.ok) {
    throw new Error(body.error ?? `POST /api/send-document failed (${res.status})`);
  }
  return { ok: true, wid: body.wid ?? '' };
}
