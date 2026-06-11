/**
 * POST /api/share-links/create
 *
 * Body: {
 *   fileId: string,
 *   expiresAt?: string | null,    // ISO timestamp; null = never
 *   password?: string | null,     // plaintext — hashed via pgcrypto bcrypt
 *   allowDownload?: boolean       // default true
 * }
 *
 * Caller must have `edit` role on the file. RLS on `shared_links` enforces
 * the same — this server-side gate produces a clean 403 and runs the password
 * hashing through the dedicated `set_shared_link_password` SECURITY DEFINER
 * function so we never ship plaintext to the SPA or back to the caller.
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import {
  assertCanAccessFile,
  getJwtClient,
  getServiceClient,
  isOfficePreviewMime,
  loadFileBypassRls,
  logFileActivityServer,
  wakePreviewWorker,
} from '../_lib/files.js';

export const config = { runtime: 'edge' };

function appOrigin(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let body: {
      fileId?: string;
      expiresAt?: string | null;
      password?: string | null;
      allowDownload?: boolean;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!body.fileId) return jsonError(400, 'fileId is required');

    const jwtClient = getJwtClient(req);
    await assertCanAccessFile(jwtClient, body.fileId, 'edit');

    const file = await loadFileBypassRls(body.fileId);
    if (!file) return jsonError(404, 'file not found');

    const { data: appUser, error: appUserErr } = await jwtClient
      .from('users')
      .select('id')
      .eq('auth_uid', user.userId)
      .maybeSingle();
    if (appUserErr || !appUser?.id) return jsonError(500, 'app user lookup failed');

    const svc = getServiceClient();

    const { data: ins, error: insErr } = await svc
      .from('shared_links')
      .insert({
        file_id: file.id,
        created_by_user_id: appUser.id,
        expires_at: body.expiresAt ?? null,
        allow_download: body.allowDownload !== false,
        is_active: true,
      })
      .select('id, token')
      .single();
    if (insErr || !ins) {
      return jsonError(500, `share link insert failed: ${insErr?.message ?? 'unknown'}`);
    }

    if (body.password && body.password.length > 0) {
      const { error: setErr } = await svc.rpc('set_shared_link_password', {
        p_link_id: ins.id,
        p_pw: body.password,
      });
      if (setErr) {
        void svc.from('shared_links').delete().eq('id', ins.id);
        return jsonError(500, `password hash failed: ${setErr.message}`);
      }
    }

    // Warm the office-preview cache at link creation so the FIRST external
    // viewer gets an inline render instead of a download card. Fire-and-forget
    // — a failure here only costs the first viewer the warm cache.
    if (isOfficePreviewMime(file.mime_type) && file.preview_status !== 'ready') {
      void svc
        .rpc('file_preview_enqueue', { p_file_id: file.id, p_force: false })
        .then(({ error: enqErr }) => {
          if (enqErr) console.error('[share-links/create] preview warm failed:', enqErr.message);
          else wakePreviewWorker();
        });
    }

    void logFileActivityServer({
      event_type: 'share_created',
      summary_ar: `إنشاء رابط مشاركة: ${file.original_name}`,
      summary_en: `Created share link: ${file.original_name}`,
      details: {
        file_id: file.id,
        shared_link_id: ins.id,
        has_password: !!body.password,
        expires_at: body.expiresAt ?? null,
        allow_download: body.allowDownload !== false,
      },
      actor_user_id: appUser.id,
      actor_email: user.email,
    });

    return jsonOk({
      token: ins.token,
      url: `${appOrigin(req)}/share/${ins.token}`,
    });
  });
}
