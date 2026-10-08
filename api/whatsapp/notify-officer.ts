/**
 * /api/whatsapp/notify-officer — reach the project's officer FROM THE OPS LINE.
 *
 *   GET  ?project_id=<uuid>
 *        → { officers: [{ id, name, phone, coverage }] } covering that project.
 *   POST { officer_phone, message, project_id?, officer_id?, client_id? }
 *        → sends `message` to the officer FROM the operations WhatsApp number
 *          (never the sales number), returns { ok, wid, deviceId }.
 *
 * This is the outbound half of the sales/ops separation: officer outreach always
 * leaves on the operations line (resolveOperationsDeviceId → is_operations),
 * and the WAHA webhook keeps the sales funnel off the reply thread. If no
 * operations number is designated we 409 with a clear message rather than
 * silently falling back to sales — that fallback is exactly what this feature
 * exists to prevent.
 *
 * Officer resolution runs with the service client: reaching a project's officer
 * to coordinate a customer visit is an operational action any authenticated rep
 * performs, independent of whether they can browse the officers model. Officers
 * are internal contacts, not client PII.
 *
 * Every message sent for a CLIENT (client_id given) is logged in ai_actions
 * (kind officer_notice, status sent, context.trigger 'manual') — the client's
 * Portals tab lists every officer message about the client from there
 * (operator, 2026-10-08). A failed log never un-sends the message: it is
 * reported in the response (`logged: false`) and console.error'd.
 *
 * Coverage rule (matches the model design): an officer covers a project P when
 *   P.id ∈ officer.projects            (explicit subset), OR
 *   officer.projects is empty AND officer.developer == P.developer  (whole dev).
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { sendMessage, resolveOperationsDeviceId, HaberchatError } from '../_lib/whatsappGateway.js';
import { resolveProjectOfficers } from '../_lib/projectOfficers.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  return withAuth(req, async (user) => {
    const svc = makeServiceClient('api:notify-officer');
    if (!svc) return jsonError(500, 'service client unavailable');

    try {
      if (req.method === 'GET') {
        const url = new URL(req.url);
        const projectId = url.searchParams.get('project_id') ?? '';
        if (!projectId) return jsonError(400, 'project_id is required');
        const officers = (await resolveProjectOfficers(svc, projectId)).map(({ id, name, phone, coverage }) => ({ id, name, phone, coverage }));
        return jsonOk({ officers });
      }

      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as {
          officer_phone?: string;
          message?: string;
          project_id?: string;
          officer_id?: string;
          client_id?: string;
        };
        const phone = (body.officer_phone ?? '').trim();
        const message = (body.message ?? '').trim();
        if (!phone) return jsonError(400, 'officer_phone is required');
        if (!message) return jsonError(400, 'message is required');

        const opsDeviceId = await resolveOperationsDeviceId();
        if (!opsDeviceId) {
          return jsonError(
            409,
            'No operations number is configured. Mark a WhatsApp number as the operations line (is_operations) first.',
          );
        }

        const result = await sendMessage({ deviceId: opsDeviceId, phone, body: message });
        const logged = body.client_id
          ? await logManualOfficerMessage(svc, {
            clientId: body.client_id, projectId: body.project_id ?? null, officerId: body.officer_id ?? null,
            phone, message, deviceId: opsDeviceId, authUid: user.userId,
          })
          : null;
        return jsonOk({ ok: true, wid: result.wid, deviceId: opsDeviceId, ...(logged === null ? {} : { logged }) });
      }

      return jsonError(405, `Method ${req.method} not allowed`);
    } catch (err) {
      if (err instanceof HaberchatError) return jsonError(err.status, err.message);
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Log a hand-sent officer message against the client (see the header). */
async function logManualOfficerMessage(
  svc: NonNullable<ReturnType<typeof makeServiceClient>>,
  a: { clientId: string; projectId: string | null; officerId: string | null; phone: string; message: string; deviceId: string; authUid: string },
): Promise<boolean> {
  try {
    if (!UUID_RE.test(a.clientId)) throw new Error(`client_id is not a uuid: ${a.clientId}`);
    const officerId = a.officerId && UUID_RE.test(a.officerId) ? a.officerId : null;
    const projectId = a.projectId && UUID_RE.test(a.projectId) ? a.projectId : null;
    const [{ data: me }, officerRow] = await Promise.all([
      svc.from('users').select('id').eq('auth_uid', a.authUid).maybeSingle(),
      officerId ? svc.from('unified_records').select('data').eq('id', officerId).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const officerName = String(((officerRow.data as { data?: Record<string, unknown> } | null)?.data ?? {}).name ?? '');
    let digits = a.phone.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0')) digits = `966${digits.slice(1)}`;
    else if (digits.length === 9 && digits.startsWith('5')) digits = `966${digits}`;
    const now = new Date().toISOString();
    const { error } = await svc.from('ai_actions').insert({
      kind: 'officer_notice', status: 'sent', client_id: a.clientId, chat_wid: `${digits}@c.us`, project_id: projectId,
      officer_id: officerId, phone: `+${digits}`, device_id: a.deviceId, body: a.message, original_body: a.message,
      reference: `officer_manual:${crypto.randomUUID()}`, decided_by: (me as { id?: string } | null)?.id ?? null,
      decided_at: now, sent_at: now, context: { trigger: 'manual', officer_name: officerName || null },
    });
    if (error) throw new Error(error.message);
    return true;
  } catch (err) {
    console.error('[notify-officer] message sent but could not be logged against the client:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
