/**
 * POST /api/share-links/revoke
 *
 * Body: { linkId: string }
 *
 * Sets is_active=false on the link. Caller must have `edit` role on the
 * underlying file. RLS would refuse the UPDATE anyway — the explicit check
 * gives a clean 403 and lets us log the actor with their email.
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import {
  assertCanAccessFile,
  getJwtClient,
  getServiceClient,
  logFileActivityServer,
} from '../_lib/files.js';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let body: { linkId?: string };
    try {
      body = (await req.json()) as { linkId?: string };
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!body.linkId) return jsonError(400, 'linkId is required');

    const svc = getServiceClient();
    const { data: link, error: linkErr } = await svc
      .from('shared_links')
      .select('id, file_id, is_active')
      .eq('id', body.linkId)
      .maybeSingle();
    if (linkErr) return jsonError(500, `link lookup failed: ${linkErr.message}`);
    if (!link) return jsonError(404, 'link not found');

    const jwtClient = getJwtClient(req);
    await assertCanAccessFile(jwtClient, link.file_id, 'edit');

    const { error: updErr } = await svc.from('shared_links').update({ is_active: false }).eq('id', link.id);
    if (updErr) return jsonError(500, `revoke failed: ${updErr.message}`);

    void logFileActivityServer({
      event_type: 'share_revoked',
      summary_ar: 'إلغاء رابط مشاركة',
      summary_en: 'Revoked share link',
      details: { file_id: link.file_id, shared_link_id: link.id },
      actor_user_id: null,
      actor_email: user.email,
    });

    return jsonOk({ ok: true });
  });
}
