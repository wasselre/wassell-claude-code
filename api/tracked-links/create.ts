/**
 * POST /api/tracked-links/create — mint a tracked link for a message a REP is
 * about to send (templates, the units window, bulk sends).
 *
 * Body: { projectId, chatWid, unitId?, lang?, sentVia? }
 * → { token, sections, urls, unitUrl, block, coverFileId }
 *    `block` is the ready-to-paste links text for a project message; a unit link
 *    returns `unitUrl` (one line the caller puts in its message).
 *
 * Gate: the caller must be able to SEE the chat (their JWT reads the chats
 * record under RLS) — no one mints links for a conversation they can't open.
 * A conversation that doesn't exist yet (first message to a new number) is
 * allowed: there is nothing of anyone's to protect, and the link holds only
 * the project's public material.
 * The row itself is written with the service role (reps have no insert grant).
 */
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { getJwtClient, getServiceClient } from '../_lib/files.js';
import { uuidV5FromWidSync } from '../_lib/chatIngest.js';
import { createTrackedLink, linksBlock, type SentVia } from '../_lib/trackedLinks.js';

// Edge: this handler takes a web Request (withAuth). A nodejs-runtime default
// export receives (IncomingMessage, ServerResponse) instead — the mismatch that
// silently broke api/cron/build-project-templates (2026-09-29).
export const config = { runtime: 'edge' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REP_SENT_VIA = new Set<SentVia>(['rep', 'bulk']);

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let body: { projectId?: unknown; chatWid?: unknown; unitId?: unknown; lang?: unknown; sentVia?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const projectId = typeof body.projectId === 'string' ? body.projectId : '';
    const unitId = typeof body.unitId === 'string' && body.unitId ? body.unitId : null;
    const chatWid = typeof body.chatWid === 'string' ? body.chatWid.trim() : '';
    const lang = body.lang === 'en' ? 'en' : 'ar';
    const sentVia: SentVia = typeof body.sentVia === 'string' && REP_SENT_VIA.has(body.sentVia as SentVia) ? (body.sentVia as SentVia) : 'rep';
    if (!UUID_RE.test(projectId)) return jsonError(400, 'projectId is required');
    if (unitId && !UUID_RE.test(unitId)) return jsonError(400, 'unitId is invalid');
    if (!/^[^\s@]+@(c\.us|s\.whatsapp\.net|lid)$/.test(chatWid)) return jsonError(400, 'chatWid is required');

    const conversationRecordId = uuidV5FromWidSync(chatWid);
    const jwt = getJwtClient(req);
    const { data: chat, error: chatErr } = await jwt.from('records').select('id').eq('id', conversationRecordId).maybeSingle();
    if (chatErr) return jsonError(500, `chat check failed: ${chatErr.message}`);
    const svc = getServiceClient();
    if (!chat) {
      // Not visible to the caller: either someone else's conversation (refuse),
      // or one that doesn't exist YET — a bulk send to a new number mints its
      // first project's link before that first message creates the chat. The
      // row then keys on the wid's deterministic record id, so it joins up.
      const { data: exists, error: exErr } = await svc.from('records').select('id').eq('id', conversationRecordId).maybeSingle();
      if (exErr) return jsonError(500, `chat check failed: ${exErr.message}`);
      if (exists) return jsonError(403, 'you cannot access this chat');
    }
    if (unitId) {
      const { data: unit, error: uErr } = await svc.from('records').select('data').eq('id', unitId).maybeSingle();
      if (uErr) return jsonError(500, `unit read failed: ${uErr.message}`);
      const unitProject = (unit as { data?: Record<string, unknown> } | null)?.data?.project_id;
      if (unitProject !== projectId) return jsonError(400, 'the unit does not belong to this project');
    }

    const { data: appUser } = await jwt.from('users').select('id').eq('auth_uid', user.userId).maybeSingle();
    try {
      const link = await createTrackedLink(svc, {
        projectId, unitId, chatWid, conversationRecordId, sentVia,
        userId: (appUser as { id?: string } | null)?.id ?? null,
      });
      return jsonOk({
        token: link.token,
        sections: link.sections,
        urls: link.urls,
        unitUrl: link.unitUrl,
        block: link.unitUrl ? null : linksBlock(link.urls, lang),
        coverFileId: link.cover?.id ?? null,
      });
    } catch (e) {
      console.error('[tracked-links/create] failed:', (e as Error).message);
      return jsonError(500, (e as Error).message);
    }
  });
}
