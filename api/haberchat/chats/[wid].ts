/**
 * PATCH /api/haberchat/chats/:wid?deviceId=<24-hex>
 *
 * Update one conversation's status and / or labels. Body:
 *   { status?: 'active'|'resolved'|'archived', labels?: string[] }
 *
 * Haberchat's native endpoint is bulk action-based — our proxy flattens
 * it to a single-wid patch so the UI doesn't have to care.
 */

import { withAuth, jsonOk, jsonError } from '../../_lib/auth.js';
import { patchChat, resolveDefaultDeviceId, HaberchatError } from '../../_lib/whatsappGateway.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'PATCH') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    const url = new URL(req.url);
    const match = url.pathname.match(/\/api\/haberchat\/chats\/([^/]+)\/?$/);
    const chatWid = match ? decodeURIComponent(match[1]) : '';
    if (!chatWid) return jsonError(400, 'chatWid is missing from path');

    const deviceId = url.searchParams.get('deviceId') ?? (await resolveDefaultDeviceId());
    if (!deviceId) {
      return jsonError(400, 'deviceId is required — pass ?deviceId=... or set HABERCHAT_DEFAULT_DEVICE_ID');
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const status = typeof body.status === 'string'
      ? (['active', 'resolved', 'archived'].includes(body.status) ? body.status as 'active' | 'resolved' | 'archived' : null)
      : null;
    const labels = Array.isArray(body.labels)
      ? (body.labels as unknown[]).filter((v): v is string => typeof v === 'string')
      : null;

    if (status == null && labels == null) {
      return jsonError(400, 'at least one of status / labels is required');
    }

    try {
      await patchChat(deviceId, chatWid, {
        status: status ?? undefined,
        labels: labels ?? undefined,
      });
      return jsonOk({ ok: true });
    } catch (err) {
      if (err instanceof HaberchatError) {
        return jsonError(err.status === 401 ? 502 : err.status, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
