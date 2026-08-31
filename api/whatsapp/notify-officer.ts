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

export const config = {
  runtime: 'edge',
};

type Rec = { id: string; data: Record<string, unknown> };

/** Lookup values are stored as a target id string, an array of them, or {id}. */
function idList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? x : (x && typeof x === 'object' && 'id' in x ? String((x as { id: unknown }).id) : ''))).filter(Boolean);
  }
  if (typeof v === 'string') return [v];
  if (typeof v === 'object' && v !== null && 'id' in v) return [String((v as { id: unknown }).id)];
  return [];
}

async function modelIdsByName(svc: ReturnType<typeof makeServiceClient>, names: string[]): Promise<Record<string, string>> {
  const { data } = await svc!.from('models').select('id, name').in('name', names);
  const out: Record<string, string> = {};
  for (const row of (data ?? []) as { id: string; name: string }[]) out[row.name] = row.id;
  return out;
}

type Covering = { id: string; name: string; phone: string; coverage: 'explicit' | 'developer' | 'marketer'; party: 'developer' | 'marketer' | null };

async function resolveOfficers(
  svc: ReturnType<typeof makeServiceClient>,
  projectId: string,
): Promise<{ id: string; name: string; phone: string; coverage: 'explicit' | 'developer' | 'marketer' }[]> {
  const ids = await modelIdsByName(svc, ['project_officers', 'all_projects']);
  const officersModelId = ids['project_officers'];
  if (!officersModelId) return [];

  // A project can carry BOTH a developer and a marketer (a marketing company
  // reselling a developer's project). We resolve officers on either side.
  const { data: projRow } = await svc!.from('unified_records').select('data').eq('id', projectId).maybeSingle();
  const pdata = (projRow as Rec | null)?.data ?? {};
  const developerId = idList(pdata.developer)[0] ?? null;
  const marketerId = idList(pdata.marketer)[0] ?? null;

  const { data: offRows } = await svc!
    .from('unified_records')
    .select('id, data')
    .eq('model_id', officersModelId);

  const covering: Covering[] = [];
  for (const o of (offRows ?? []) as Rec[]) {
    const d = o.data ?? {};
    if (d.is_active === false) continue;
    const phone = typeof d.phone === 'string' ? d.phone : '';
    if (!phone) continue;
    const offDev = idList(d.developer)[0] ?? null;
    const offMkt = idList(d.marketer)[0] ?? null;
    // An officer is tied to a developer OR a marketer; that is their "party".
    const party: 'developer' | 'marketer' | null = offDev ? 'developer' : offMkt ? 'marketer' : null;
    const projs = idList(d.projects);

    let coverage: Covering['coverage'] | null = null;
    if (projs.includes(projectId)) {
      coverage = 'explicit';
    } else if (projs.length === 0) {
      if (offDev && developerId && offDev === developerId) coverage = 'developer';
      else if (offMkt && marketerId && offMkt === marketerId) coverage = 'marketer';
    }
    if (!coverage) continue;
    covering.push({ id: o.id, name: String(d.name ?? ''), phone, coverage, party });
  }

  // Developer-officer-wins (the operator's rule): if ANY covering officer is on
  // the DEVELOPER side, we treat the project as ours and contact only the
  // developer's officer(s) — the marketer is a fallback used only when we have no
  // developer contact. This is evaluated live per send, so it self-corrects when
  // an officer is added or removed (no stale reclassification of the project).
  const devSide = covering.filter((o) => o.party === 'developer');
  const chosen = devSide.length > 0 ? devSide : covering.filter((o) => o.party !== 'developer');

  // Explicit subset assignment is a stronger signal than a whole-entity match.
  chosen.sort((a, b) => (a.coverage === b.coverage ? 0 : a.coverage === 'explicit' ? -1 : 1));
  return chosen.map(({ id, name, phone, coverage }) => ({ id, name, phone, coverage }));
}

export default async function handler(req: Request): Promise<Response> {
  return withAuth(req, async () => {
    const svc = makeServiceClient('api:notify-officer');
    if (!svc) return jsonError(500, 'service client unavailable');

    try {
      if (req.method === 'GET') {
        const url = new URL(req.url);
        const projectId = url.searchParams.get('project_id') ?? '';
        if (!projectId) return jsonError(400, 'project_id is required');
        const officers = await resolveOfficers(svc, projectId);
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
