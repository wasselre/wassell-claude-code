/**
 * POST /api/careers/send-experience — AUTHENTICATED + ADMIN.
 *
 * Sends the per-candidate recruitment-experience link to the applicant over
 * WhatsApp, then flips the application to `offer_sent` (stamping offer_sent_at
 * the first time). Admin gate reuses the table RLS: the row is first read
 * through the caller's OWN JWT (`wassell_is_admin`); a non-admin sees zero rows
 * → 403 (same trick as api/careers/file-url).
 *
 * Body: { id: string, origin?: string }  →  { ok, link, invite_token, wid, status, offer_sent_at }
 *
 * The token is minted here (once) and persisted only AFTER a successful send, so
 * a failed send never leaves a half-committed link. The message goes out on the
 * operations line if one is configured, else the active default number.
 */
import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { getJwtClient, getServiceClient } from '../_lib/files.js';
import { sendMessage, resolveOperationsDeviceId, resolveDefaultDeviceId, HaberchatError } from '../_lib/whatsappGateway.js';

export const config = { runtime: 'edge' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    const body = (await req.json().catch(() => ({}))) as { id?: string; origin?: string };
    const id = typeof body.id === 'string' ? body.id : '';
    if (!UUID_RE.test(id)) return jsonError(400, 'invalid id');
    const origin = typeof body.origin === 'string' && /^https?:\/\//.test(body.origin)
      ? body.origin.replace(/\/+$/, '')
      : (req.headers.get('origin') || 'https://app.wassel.re');

    // Admin gate via RLS: this read only returns a row for an admin JWT.
    const jwt = getJwtClient(req);
    const { data: app, error } = await jwt
      .from('job_applications')
      .select('id, full_name, phone, invite_token, offer_sent_at')
      .eq('id', id)
      .maybeSingle();
    if (error) return jsonError(500, `access check failed: ${error.message}`);
    if (!app) return jsonError(403, 'not permitted');
    if (!app.phone) return jsonError(400, 'this application has no phone number');

    const token = (app.invite_token as string | null) || crypto.randomUUID();
    const link = `${origin}/careers/experience/${token}`;
    const name = ((app.full_name as string | null) ?? '').trim();
    const greeting = name ? `أهلًا ${name} 👋` : 'أهلًا 👋';
    const message =
      `${greeting}\n` +
      `يسعدنا اهتمامك بالانضمام إلى فريق وصل العقارية.\n` +
      `جهّزنا لك تجربة قصيرة تعرّفك على طريقة العمل والدخل قبل المقابلة — تأخذ دقائق من جوالك:\n` +
      `${link}\n\n` +
      `هذا الرابط خاص بك.`;

    const deviceId = (await resolveOperationsDeviceId()) || (await resolveDefaultDeviceId());
    if (!deviceId) return jsonError(409, 'no active WhatsApp number is configured to send from');

    let wid: string | null = null;
    try {
      const result = await sendMessage({ deviceId, phone: app.phone as string, body: message });
      wid = result.wid;
    } catch (err) {
      if (err instanceof HaberchatError) return jsonError(err.status, `send failed: ${err.message}`);
      return jsonError(502, `send failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Persist token + status only after the send actually went out.
    const patch: Record<string, unknown> = { invite_token: token, status: 'offer_sent' };
    const offerSentAt = (app.offer_sent_at as string | null) ?? new Date().toISOString();
    if (!app.offer_sent_at) patch.offer_sent_at = offerSentAt;

    const svc = getServiceClient();
    const { error: upErr } = await svc.from('job_applications').update(patch).eq('id', id);
    if (upErr) return jsonError(500, `link sent, but saving status failed: ${upErr.message}`);

    return jsonOk({ ok: true, link, invite_token: token, wid, status: 'offer_sent', offer_sent_at: offerSentAt });
  });
}
