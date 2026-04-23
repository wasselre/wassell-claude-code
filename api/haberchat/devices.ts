/**
 * GET /api/haberchat/devices
 *
 * Lists every WhatsApp number (Haberchat device) connected to the account.
 * Browser-initiated; requires a valid Supabase JWT in Authorization header.
 *
 * Powers the /settings/whatsapp-numbers page — admin merges this live list
 * with the local `whatsapp_numbers` table to show friendly names + default
 * flag alongside the authoritative Haberchat state.
 */

import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { listDevices, HaberchatError } from '../_lib/haberchat.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async () => {
    try {
      const devices = await listDevices();
      return jsonOk({ devices });
    } catch (err) {
      if (err instanceof HaberchatError) {
        return jsonError(err.status === 401 ? 502 : err.status, err.message);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(500, msg);
    }
  });
}
