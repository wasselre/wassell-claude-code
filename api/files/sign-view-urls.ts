/**
 * POST /api/files/sign-view-urls   (batch sibling of sign-view-url)
 *
 * Body: { fileIds: string[] }  → { urls: Record<fileId, signedUrl> }
 *
 * Why this exists: the Files grid used to fire ONE /api/files/sign-view-url
 * per image tile, so a 40-image folder meant 40 browser→edge round-trips,
 * each doing JWT-verify + an RLS RPC + a service-role sign. This collapses the
 * whole grid into a SINGLE invocation that signs every viewable thumbnail in
 * parallel server-side.
 *
 * Access gating: instead of N per-file `wassell_can_access_file` RPCs, we run
 * ONE select through the caller's JWT client — RLS (`files_select` →
 * wassell_can_access_file(id,'view')) filters the result to exactly the files
 * the caller may view. Ids the caller can't see are silently omitted from the
 * response map (the grid falls back to the icon tile). Signing then runs as
 * service-role because the bytes live under the uploader's auth.uid() prefix.
 *
 * No activity_log 'view' rows are written here: this powers grid/thumbnail
 * rendering, not a deliberate open. The single sign-view-url endpoint (used by
 * the preview modal) still logs the real 'view'.
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { getJwtClient, signFileUrl, VIEW_URL_TTL_SECONDS } from '../_lib/files.js';

export const config = { runtime: 'edge' };

/** Cap so a malicious/huge body can't fan out into unbounded signing work. */
const MAX_BATCH = 200;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    let body: { fileIds?: unknown };
    try {
      body = (await req.json()) as { fileIds?: unknown };
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!Array.isArray(body.fileIds)) return jsonError(400, 'fileIds (array) is required');

    // De-dupe + validate to non-empty strings, cap the batch.
    const ids = Array.from(
      new Set(body.fileIds.filter((x): x is string => typeof x === 'string' && x.length > 0)),
    ).slice(0, MAX_BATCH);
    if (ids.length === 0) return jsonOk({ urls: {} });

    // RLS-filtered: returns only the rows this caller may view.
    const jwtClient = getJwtClient(req);
    const { data, error } = await jwtClient
      .from('files')
      .select('id, storage_bucket, storage_path')
      .in('id', ids);
    if (error) return jsonError(500, `file lookup failed: ${error.message}`);

    const rows = (data ?? []) as Array<{ id: string; storage_bucket: string; storage_path: string }>;

    // Sign every viewable file in parallel. A single failed sign drops just
    // that id from the map rather than failing the whole grid.
    const entries = await Promise.all(
      rows.map(async (r) => {
        try {
          const url = await signFileUrl(r.storage_bucket, r.storage_path, VIEW_URL_TTL_SECONDS);
          return [r.id, url] as const;
        } catch {
          return null;
        }
      }),
    );

    const urls: Record<string, string> = {};
    for (const e of entries) {
      if (e) urls[e[0]] = e[1];
    }
    return jsonOk({ urls });
  });
}
