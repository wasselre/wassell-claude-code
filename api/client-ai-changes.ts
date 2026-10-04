/**
 * /api/client-ai-changes — what the AI wrote onto a client on its own, and Undo.
 *
 *   GET  ?clientId=<uuid>                      → { changes: AiChangeRow[] } (newest 30)
 *   POST { changeId, action: 'undo' }          → { undone: true }
 *
 * The rows come from `client_ai_changes` (service-role only); the caller must be
 * able to see the client under their own RLS (`assertCanAccessRecord`) — the
 * same gate the two review endpoints use. Undo goes through `undoAiChange`
 * (autoSave.ts), which re-reads the fresh client row and refuses (409) when the
 * value moved on since the AI saved it.
 */
import { withAuth, jsonError, jsonOk, assertCanAccessRecord } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';
import { listAiChanges, undoAiChange, UndoError } from './_lib/clientPrefs/autoSave.js';

export const config = { runtime: 'edge' };

const SERVICE_NAME = 'api:client-ai-changes';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST') return jsonError(405, 'method not allowed');
  return withAuth(req, async (user) => {
    const service = makeServiceClient(SERVICE_NAME);
    if (!service) return jsonError(500, 'Supabase service env not configured');

    if (req.method === 'GET') {
      const clientId = new URL(req.url).searchParams.get('clientId') ?? '';
      if (!UUID.test(clientId)) return jsonError(400, 'clientId is required');
      await assertCanAccessRecord(req, clientId, SERVICE_NAME);
      return jsonOk({ changes: await listAiChanges(service, clientId) });
    }

    let body: { changeId?: unknown; action?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const changeId = typeof body.changeId === 'string' ? body.changeId : '';
    if (!UUID.test(changeId)) return jsonError(400, 'changeId is required');
    if (body.action !== 'undo') return jsonError(400, "action must be 'undo'");

    const { data, error } = await service.from('client_ai_changes').select('client_id').eq('id', changeId).maybeSingle();
    if (error) return jsonError(500, `change read failed: ${error.message}`);
    if (!data) return jsonError(404, 'change not found');
    await assertCanAccessRecord(req, (data as { client_id: string }).client_id, SERVICE_NAME);
    try {
      const r = await undoAiChange(service, changeId, user.userId);
      console.log(`[client-ai-changes] undo change=${changeId} by=${user.userId}`);
      return jsonOk(r);
    } catch (err) {
      if (err instanceof UndoError) return jsonError(err.status, err.message);
      throw err;
    }
  });
}
