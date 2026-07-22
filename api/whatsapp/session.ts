/**
 * /api/whatsapp/session — admin-only WAHA session lifecycle + pairing.
 *
 *   POST  { session, action: 'create'|'start'|'restart' }
 *         'create' provisions the session on the WAHA host with a per-session
 *         webhook pointing at THIS app's /api/webhook/waha (HMAC-signed), and
 *         starts it. 'start'/'restart' operate an existing session.
 *   GET   ?session=<name>&mode=status  → { status, me, activityTs }
 *   GET   ?session=<name>&mode=qr      → image/png QR bytes for pairing
 *
 * Admin-gated via wassell_is_admin (same posture as geo-elements-admin). The
 * WAHA host + API key stay server-side.
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { createSession, startSession, restartSession, getSessionStatus, getQrImage, WahaError } from '../_lib/waha.js';

export const config = {
  runtime: 'edge',
};

function webhookUrl(): string {
  const base = (process.env.APP_URL ?? 'https://app.wassel.re').replace(/\/+$/, '');
  return `${base}/api/webhook/waha`;
}

export default async function handler(req: Request): Promise<Response> {
  return withAuth(req, async (user) => {
    // Admin gate.
    const svc = makeServiceClient('api:whatsapp-session');
    if (!svc) return jsonError(500, 'service client unavailable');
    const { data: isAdmin, error: adminErr } = await svc.rpc('wassell_is_admin', { auth_user_id: user.userId });
    if (adminErr) return jsonError(500, `admin check failed: ${adminErr.message}`);
    if (isAdmin !== true) return jsonError(403, 'WAHA session management is admin-only');

    const hmac = process.env.WAHA_WEBHOOK_SECRET;
    if (!hmac) return jsonError(500, 'WAHA_WEBHOOK_SECRET not configured');

    try {
      if (req.method === 'GET') {
        const url = new URL(req.url);
        const session = url.searchParams.get('session') ?? '';
        const mode = url.searchParams.get('mode') ?? 'status';
        if (!session) return jsonError(400, 'session is required');
        if (mode === 'qr') {
          const upstream = await getQrImage(session);
          return new Response(upstream.body, {
            status: 200,
            headers: {
              'Content-Type': upstream.headers.get('content-type') ?? 'image/png',
              'Cache-Control': 'no-store',
            },
          });
        }
        const st = await getSessionStatus(session);
        return jsonOk(st);
      }

      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as { session?: string; action?: string };
        const session = body.session ?? '';
        const action = body.action ?? 'create';
        if (!session) return jsonError(400, 'session is required');
        if (action === 'create') {
          await createSession(session, webhookUrl(), hmac);
        } else if (action === 'start') {
          await startSession(session);
        } else if (action === 'restart') {
          await restartSession(session);
        } else {
          return jsonError(400, `unknown action: ${action}`);
        }
        const st = await getSessionStatus(session);
        return jsonOk(st);
      }

      return jsonError(405, `Method ${req.method} not allowed`);
    } catch (err) {
      if (err instanceof WahaError) return jsonError(err.status === 401 ? 502 : err.status, err.message);
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
