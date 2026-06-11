/**
 * POST /api/files/delete-folder
 *
 * Body: { folderId: string }
 *
 * Recursively deletes a folder: every file and subfolder inside, at any
 * depth — the Google-Drive expectation. (v1 refused non-empty folders with
 * "Folder is not empty", which left users with no path forward short of
 * manually emptying nested trees — live complaint 2026-06-11.)
 *
 * Permission: caller needs DELETE on the ROOT folder (owner — admin /
 * creator / owner-grant via cascade), checked under the caller's JWT.
 * Everything beneath inherits that decision: the folder cascade model
 * already means an owner of the root out-ranks any weaker grant inside.
 *
 * Order of operations (mirrors api/files/delete.ts row-first posture):
 *   1. Collect the subtree (BFS over parent_folder_id, service-role).
 *   2. Delete all file ROWS in one statement — CASCADE wipes
 *      file_permissions, shared_links, document_links, wassel_documents.
 *   3. Best-effort remove the storage objects (originals + office-preview
 *      artifacts; `doc:` sentinels skipped — they have no object).
 *   4. Delete folder rows DEEPEST-FIRST (parent FK is ON DELETE RESTRICT).
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import {
  assertCanAccessFolder,
  getJwtClient,
  getServiceClient,
  logFileActivityServer,
} from '../_lib/files.js';

export const config = { runtime: 'edge' };

/** Storage .remove() batch size — keeps each request comfortably small. */
const REMOVE_BATCH = 100;
/** Defensive ceiling on folder nesting (BFS levels). */
const MAX_DEPTH = 50;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let body: { folderId?: string };
    try {
      body = (await req.json()) as { folderId?: string };
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!body.folderId) return jsonError(400, 'folderId is required');

    const jwtClient = getJwtClient(req);
    await assertCanAccessFolder(jwtClient, body.folderId, 'delete');

    const svc = getServiceClient();

    // ── 1. Collect the subtree (levels[0] = root, deepest last) ──────────
    const { data: rootRow, error: rootErr } = await svc
      .from('folders')
      .select('id, name')
      .eq('id', body.folderId)
      .maybeSingle();
    if (rootErr) return jsonError(500, `folder lookup failed: ${rootErr.message}`);
    if (!rootRow) return jsonError(404, 'folder not found');

    const levels: string[][] = [[rootRow.id as string]];
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const frontier = levels[levels.length - 1]!;
      const { data: children, error: childErr } = await svc
        .from('folders')
        .select('id')
        .in('parent_folder_id', frontier);
      if (childErr) return jsonError(500, `subtree walk failed: ${childErr.message}`);
      const ids = (children ?? []).map((c) => c.id as string);
      if (ids.length === 0) break;
      levels.push(ids);
    }
    const allFolderIds = levels.flat();

    // ── 2. Files in the subtree → delete rows first ──────────────────────
    const { data: fileRows, error: filesErr } = await svc
      .from('files')
      .select('id, storage_bucket, storage_path, preview_storage_path')
      .in('folder_id', allFolderIds);
    if (filesErr) return jsonError(500, `file listing failed: ${filesErr.message}`);
    const files = (fileRows ?? []) as Array<{
      id: string;
      storage_bucket: string;
      storage_path: string;
      preview_storage_path: string | null;
    }>;

    if (files.length > 0) {
      const { error: delFilesErr } = await svc
        .from('files')
        .delete()
        .in('id', files.map((f) => f.id));
      if (delFilesErr) return jsonError(500, `file rows delete failed: ${delFilesErr.message}`);
    }

    // ── 3. Storage objects, best-effort (originals + preview artifacts) ──
    const pathsByBucket = new Map<string, string[]>();
    for (const f of files) {
      // wassel_doc sentinel paths ("doc:<id>") have no storage object.
      if (!f.storage_path.startsWith('doc:')) {
        const arr = pathsByBucket.get(f.storage_bucket) ?? [];
        arr.push(f.storage_path);
        pathsByBucket.set(f.storage_bucket, arr);
      }
      if (f.preview_storage_path) {
        const arr = pathsByBucket.get(f.storage_bucket) ?? [];
        arr.push(f.preview_storage_path);
        pathsByBucket.set(f.storage_bucket, arr);
      }
    }
    let storageFailures = 0;
    for (const [bucket, paths] of pathsByBucket) {
      for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
        const batch = paths.slice(i, i + REMOVE_BATCH);
        const { error: rmErr } = await svc.storage.from(bucket).remove(batch);
        if (rmErr) {
          storageFailures += batch.length;
          console.warn('[files] folder-delete storage batch failed (rows deleted, orphans left):', rmErr.message);
        }
      }
    }

    // ── 4. Folders, deepest-first (parent FK is RESTRICT) ────────────────
    for (let i = levels.length - 1; i >= 0; i--) {
      const { error: delFoldersErr } = await svc.from('folders').delete().in('id', levels[i]!);
      if (delFoldersErr) {
        return jsonError(500, `folder rows delete failed at depth ${i}: ${delFoldersErr.message}`);
      }
    }

    void logFileActivityServer({
      event_type: 'folder_delete',
      summary_ar: `حذف مجلد وكامل محتوياته: ${rootRow.name as string}`,
      summary_en: `Deleted folder and all contents: ${rootRow.name as string}`,
      details: {
        folder_id: rootRow.id,
        folders_deleted: allFolderIds.length,
        files_deleted: files.length,
        storage_failures: storageFailures,
      },
      actor_user_id: null,
      actor_email: user.email,
    });

    return jsonOk({ ok: true, folders_deleted: allFolderIds.length, files_deleted: files.length });
  });
}
