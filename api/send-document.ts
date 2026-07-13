/**
 * POST /api/send-document
 *
 * Body: { fileId, recordId, deviceId?, caption? }
 *
 * Sends a generated PDF to the record's customer over WhatsApp (Haberchat):
 * resolves the client phone from the record's client lookup, downloads the PDF
 * (service-role signed URL), re-hosts it to Haberchat, and sends it as a
 * document message with a caption. Logs the send to activity_log.
 *
 * The SPA shows a confirm step (recipient + device + caption) BEFORE calling
 * this — see SendDocumentModal. Haberchat calls are fast, so this runs inline
 * (no queue needed); we never hold HTTP for the render (that already happened).
 */

import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import {
  assertCanAccessFile,
  getJwtClient,
  getServiceClient,
  loadFileBypassRls,
  logFileActivityServer,
  signFileUrl,
} from './_lib/files.js';
import { uploadFile as haberUpload, sendMessage as haberSend, defaultDeviceId, HaberchatError } from './_lib/haberchat.js';

export const config = { runtime: 'edge' };
export const maxDuration = 60;

interface Body {
  fileId?: string;
  recordId?: string;
  deviceId?: string;
  caption?: string;
  /** Future ISO datetime — schedule the send via Haberchat's delivery queue. */
  deliverAt?: string;
}

function asLinkId(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = asLinkId(x);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const cand = o.id ?? o.recordId ?? o.record_id;
    return typeof cand === 'string' && cand.trim() ? cand.trim() : null;
  }
  return null;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const fileId = (body.fileId ?? '').trim();
    const recordId = (body.recordId ?? '').trim();
    if (!fileId) return jsonError(400, 'fileId is required');
    if (!recordId) return jsonError(400, 'recordId is required');

    const jwtClient = getJwtClient(req);
    const svc = getServiceClient();

    // 1. Caller must be able to view the file (RLS gate).
    await assertCanAccessFile(jwtClient, fileId, 'view', { email: user.email });

    // 2. Resolve the recipient phone from the record's client lookup.
    const { data: rec, error: rErr } = await jwtClient
      .from('unified_records')
      .select('id, data')
      .eq('id', recordId)
      .maybeSingle();
    if (rErr) return jsonError(500, `record lookup failed: ${rErr.message}`);
    if (!rec) return jsonError(404, 'record not found or not accessible');
    const clientId = asLinkId((rec.data as Record<string, unknown>)?.client_id);
    if (!clientId) return jsonError(400, 'no client linked to this record');

    const { data: client } = await jwtClient
      .from('unified_records')
      .select('data')
      .eq('id', clientId)
      .maybeSingle();
    const rawPhone = String((client?.data as Record<string, unknown>)?.phone_number ?? '');
    // Canonicalize through the same helper the webhooks use (clients store
    // mixed bare-9-digit / +966 formats), then strip to digits for Haberchat.
    const { data: canon } = await svc.rpc('ksa_phone_canon', { p: rawPhone });
    const phone = (typeof canon === 'string' ? canon : rawPhone).replace(/\D/g, '');
    if (!phone || phone.length < 8) return jsonError(400, 'client has no valid phone number');

    // 3. Resolve the WhatsApp device (caller-chosen, else the env default).
    const device = (body.deviceId ?? '').trim() || defaultDeviceId();
    if (!device) return jsonError(400, 'no WhatsApp device configured');

    // 4. Download the PDF bytes (service-role signed URL, short TTL).
    const file = await loadFileBypassRls(fileId);
    if (!file) return jsonError(404, 'file not found');
    const url = await signFileUrl(file.storage_bucket, file.storage_path, 120);
    const resp = await fetch(url);
    if (!resp.ok) return jsonError(502, `failed to fetch document bytes (${resp.status})`);
    const bytes = await resp.arrayBuffer();

    // 5. Re-host to Haberchat, then send as a document message.
    const fd = new FormData();
    const fileName = file.original_name.toLowerCase().endsWith('.pdf')
      ? file.original_name
      : `${file.original_name}.pdf`;
    fd.append('file', new Blob([bytes], { type: file.mime_type || 'application/pdf' }), fileName);

    const caption = (body.caption ?? '').trim() || 'مرفق المستند الخاص بكم من وصل العقارية.';

    // Scheduled sends: validate the same way the messages proxy does — a
    // valid ISO timestamp at least ~1 minute out.
    const deliverAt = typeof body.deliverAt === 'string' && body.deliverAt ? body.deliverAt : undefined;
    if (deliverAt) {
      const t = new Date(deliverAt).getTime();
      if (Number.isNaN(t)) return jsonError(400, 'deliverAt must be a valid ISO 8601 datetime');
      if (t <= Date.now() + 30_000) return jsonError(400, 'deliverAt must be at least 1 minute in the future');
    }

    try {
      const uploaded = await haberUpload(fd);
      const sent = await haberSend({
        deviceId: device,
        phone,
        mediaFileId: uploaded.fileId,
        mediaCaption: caption,
        deliverAt,
      });
      void logFileActivityServer({
        event_type: 'document_sent',
        summary_ar: deliverAt
          ? `جُدول إرسال مستند عبر واتساب: ${file.original_name}`
          : `أُرسل مستند عبر واتساب: ${file.original_name}`,
        summary_en: deliverAt
          ? `Document scheduled via WhatsApp: ${file.original_name}`
          : `Document sent via WhatsApp: ${file.original_name}`,
        details: { file_id: fileId, record_id: recordId, phone, message_wid: sent.wid, deliver_at: deliverAt ?? null },
        actor_email: user.email,
        status: 'success',
      });
      return jsonOk({ ok: true, wid: sent.wid, status: sent.status });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof HaberchatError) {
        return jsonError(err.status === 401 ? 502 : err.status, `WhatsApp send failed: ${msg}`);
      }
      return jsonError(502, `WhatsApp send failed: ${msg}`);
    }
  });
}
