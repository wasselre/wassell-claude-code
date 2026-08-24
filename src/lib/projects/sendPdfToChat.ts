/**
 * Send a generated PDF (a Blob) to a WhatsApp conversation as a DOCUMENT, and a
 * plain local download helper.
 *
 * The send reuses the exact refresh-safe path the composer's local-file send
 * uses: upload the bytes straight to storage (`uploadLocalFile` → `wt_<path>`
 * ref, bypassing the ~4.5 MB Vercel body limit) then dispatch through the store
 * (`sendChatMessage`), which resolves the recipient phone + send-from device
 * from the chat record, renders the optimistic bubble, and — for a `document`
 * kind — routes to WAHA's `/api/sendFile`.
 *
 * Posture (per the Silent-Failures rule): this NEVER throws for the non-scheduled
 * path. The upload step can throw (network / storage), so it's caught and
 * surfaced as a toast; the send step manages its own failed-bubble + toast. It
 * returns `{ ok }` so the caller can close its modal / show a success toast.
 */
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { uploadLocalFile } from '@/lib/haberchat/client';
import { startJob, completeJob, failJob } from '@/lib/jobs/jobCenter';
import { normalizePhone } from '@/lib/phone';
import type { AppRecord } from '@/types';

/**
 * The conversation a PDF can be sent into, plus the resolved recipient for the
 * confirm dialog. Present → the units/unit PDF surfaces a "Send to client"
 * action; absent → download only.
 */
export interface ChatPdfContext {
  chatWid: string;
  clientName?: string | null;
  clientPhone?: string | null;
}

const CLIENT_PHONE_SLUGS = ['phone_number', 'phone', 'mobile', 'whatsapp', 'whatsapp_number'];
const CLIENT_NAME_SLUGS = ['name', 'full_name', 'client_name', 'name_ar', 'name_en'];

/**
 * Build a send-PDF context straight from a CLIENT record — so the units-table
 * and single-unit PDFs surface "Send to client" on every surface that carries a
 * client (the finder scoped to a client, the client's options list, the Client
 * 360 tab), not only inside an open WhatsApp thread.
 *
 * The conversation wid is derived from the client's phone the SAME way
 * `startNewChat` mints it (`<e164 digits>@c.us`), so it matches the existing
 * chat record when the client has already been messaged. `sendChatMessage`
 * requires that record to exist (it reads the recipient phone + send-from
 * device off it) and otherwise fails with a visible "conversation not found"
 * toast — a graceful degrade, never a silent drop. Returns null when the client
 * has no usable phone (→ the caller shows Download only).
 */
export function chatPdfFromClient(clientRec: AppRecord | null | undefined): ChatPdfContext | null {
  if (!clientRec) return null;
  const d = (clientRec.data ?? {}) as Record<string, unknown>;
  let phoneRaw: string | null = null;
  for (const slug of CLIENT_PHONE_SLUGS) {
    const v = d[slug];
    if (typeof v === 'string' && v.trim()) { phoneRaw = v; break; }
    if (typeof v === 'number' && Number.isFinite(v)) { phoneRaw = String(v); break; }
  }
  const e164 = normalizePhone(phoneRaw);
  if (!e164) return null;
  let name: string | null = null;
  for (const slug of CLIENT_NAME_SLUGS) {
    const v = d[slug];
    if (typeof v === 'string' && v.trim()) { name = v.trim(); break; }
  }
  return { chatWid: `${e164.slice(1)}@c.us`, clientName: name, clientPhone: e164 };
}

export async function sendPdfToChat(
  chatWid: string,
  blob: Blob,
  filename: string,
  caption: string,
  opts: { deliverAt?: string } = {},
): Promise<{ ok: boolean }> {
  const { addToast, language, sendChatMessage } = useAppStore.getState();
  const isAr = language === 'ar';
  const jobId = startJob({
    kind: 'pdf_send',
    label: opts.deliverAt
      ? isAr ? 'جدولة إرسال ملف PDF' : 'Scheduling a PDF'
      : isAr ? 'إرسال ملف PDF' : 'Sending a PDF',
    href: '/model/chats/',
  });

  try {
    if (!supabase) throw new Error(isAr ? 'التخزين غير مهيّأ' : 'Storage is not configured');
    const file = new File([blob], filename, { type: 'application/pdf' });
    const uploaded = await uploadLocalFile(file);

    // sendChatMessage owns the optimistic bubble + its own send-failure toast
    // (non-scheduled path); the scheduled path throws on identity failure.
    await sendChatMessage(chatWid, {
      mediaFileId: uploaded.fileId,
      mediaCaption: caption.trim() || undefined,
      kind: 'document',
      mediaMime: 'application/pdf',
      mediaSize: uploaded.size ?? blob.size,
      deliverAt: opts.deliverAt,
    });

    completeJob(jobId, { toastMessage: null });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failJob(jobId, msg, { toastMessage: null });
    addToast(isAr ? `تعذّر إرسال الملف — ${msg}` : `Couldn't send the file — ${msg}`, 'error');
    return { ok: false };
  }
}

/** Trigger a browser download of a generated PDF Blob. */
export function downloadPdf(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has committed the navigation.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
