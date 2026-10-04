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
  return withAuth(req, async () => {
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
        return jsonOk({ ok: true, wid: result.wid, deviceId: opsDeviceId });
      }

      return jsonError(405, `Method ${req.method} not allowed`);
    } catch (err) {
      if (err instanceof HaberchatError) return jsonError(err.status, err.message);
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
