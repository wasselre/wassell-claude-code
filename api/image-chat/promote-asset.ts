/**
 * POST /api/image-chat/promote-asset  (Image Chats v2 — Part 5: asset identity)
 *
 * Promotes a generated chat image (a public `marketing-assets` URL) into the
 * Files System as a first-class `files` row in the private `wassel-files`
 * bucket, so it can be attached to records, placed in Drive folders, shared,
 * etc. The chat's original marketing-assets object is NEVER touched — this is
 * a copy ("Add to Files: copy, don't move, keep the chat copy intact").
 *
 * Body: {
 *   source_url:     string,            // the chat image's marketing-assets URL
 *   folder_id?:     string | null,     // Drive folder to place the file in (Add to Files)
 *   model_id?:      string | null,     // tag the file to a record (Add to Record)
 *   record_id?:     string | null,
 *   original_name?: string,            // display name; defaults to a derived name
 *   chat_record_id?: string,           // OPTIONAL dedup-cache locator: the
 *   message_id?:     string,           //   image_chats conversation + message +
 *   image_index?:    number,           //   image to stamp with the new files.id
 * }
 *
 * Returns the created FileRow. When the chat locator is supplied, the new
 * files.id is cached back onto MessageImage.file_id (first-promote-wins) so a
 * subsequent Add-to-Record reuses the SAME id (true dedup — one files row, one
 * storage object, many references). That cache write happens HERE (server-side
 * via record_save), NOT via the browser store, so the realtime echo-dedup
 * never suppresses a concurrent worker fill-in on the same conversation.
 *
 * Security:
 *   - The source_url MUST be one of the caller's own image-chats objects
 *     (path `image-chats/<sub>/<auth.uid()>/...`) — you can't promote an
 *     arbitrary public object.
 *   - Bytes are copied via the caller's JWT client, so the wassel-files
 *     path-prefix RLS (`<auth.uid()>/...`) and `files_insert` RLS both apply.
 *
 * Loud failures only (CLAUDE.md): 400 bad/foreign URL, 404 app-user, 502 fetch,
 * 500 upload/insert. Orphan storage object is best-effort removed on insert
 * failure.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { recordSaveWithRetry } from '../_lib/recordSaveRetry.js';
import { getJwtClient, logFileActivityServer, FILES_BUCKET } from '../_lib/files.js';

export const config = { runtime: 'edge' };

const MARKETING_BUCKET = 'marketing-assets';

function marketingObjectPath(url: string, supabaseUrl: string): string | null {
  const marker = `/storage/v1/object/public/${MARKETING_BUCKET}/`;
  if (!url.startsWith(supabaseUrl) || !url.includes(marker)) return null;
  const idx = url.indexOf(marker);
  const rest = url.slice(idx + marker.length);
  // Strip any query string.
  return rest.split('?')[0] ?? null;
}

function extFromContentType(ct: string, fallbackPath: string): string {
  const m = ct.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  const fromPath = fallbackPath.match(/\.([a-z0-9]+)$/i)?.[1];
  return (fromPath ?? 'png').toLowerCase();
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: {
      source_url?: string;
      folder_id?: string | null;
      model_id?: string | null;
      record_id?: string | null;
      original_name?: string;
      chat_record_id?: string;
      message_id?: string;
      image_index?: number;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const sourceUrl = body.source_url?.trim();
    if (!sourceUrl) return jsonError(400, 'source_url is required');

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    if (!supabaseUrl) return jsonError(500, 'SUPABASE_URL not configured');

    // ── Validate the source is one of the caller's own chat images ───────
    const objectPath = marketingObjectPath(sourceUrl, supabaseUrl);
    if (!objectPath) {
      return jsonError(400, 'source_url must be a marketing-assets public URL');
    }
    // Expected: image-chats/<outputs|uploads|preset-copies>/<auth.uid()>/...
    const segs = objectPath.split('/');
    if (segs[0] !== 'image-chats' || segs[2] !== user.userId) {
      return jsonError(403, 'source_url is not one of your image-chat assets');
    }

    const jwtClient = getJwtClient(req);

    // Resolve the app user id (public.users.id) — files.uploaded_by_user_id is
    // the CRM user id, not auth.uid(). Same pattern as share-links/create.ts.
    const { data: appUser, error: appUserErr } = await jwtClient
      .from('users')
      .select('id')
      .eq('auth_uid', user.userId)
      .maybeSingle();
    if (appUserErr || !appUser?.id) return jsonError(404, 'app user lookup failed');
    const appUserId = appUser.id as string;

    // ── Fetch the source bytes (public URL) ──────────────────────────────
    let bytes: Uint8Array;
    let contentType: string;
    try {
      const res = await fetch(sourceUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
      contentType = res.headers.get('content-type') ?? 'image/png';
    } catch (err) {
      return jsonError(502, `could not fetch source image: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!contentType.startsWith('image/')) {
      // marketing-assets sometimes serves octet-stream; trust the path ext.
      contentType = 'image/png';
    }
    const ext = extFromContentType(contentType, objectPath);

    // ── Upload into wassel-files under the caller's auth.uid() prefix ─────
    const fileId = crypto.randomUUID();
    const storagePath = `${user.userId}/${fileId}.${ext}`;
    const { error: upErr } = await jwtClient.storage
      .from(FILES_BUCKET)
      .upload(storagePath, bytes, { contentType, upsert: false });
    if (upErr) return jsonError(500, `upload to ${FILES_BUCKET} failed: ${upErr.message}`);

    const originalName =
      body.original_name?.trim() ||
      `wassel-image-${fileId.slice(0, 8)}.${ext}`;

    // ── Insert the files row (JWT client → files_insert RLS applies) ──────
    const { data: fileRow, error: insErr } = await jwtClient
      .from('files')
      .insert({
        id: fileId,
        folder_id: body.folder_id ?? null,
        model_id: body.model_id ?? null,
        record_id: body.record_id ?? null,
        uploaded_by_user_id: appUserId,
        original_name: originalName,
        mime_type: contentType,
        size_bytes: bytes.byteLength,
        storage_bucket: FILES_BUCKET,
        storage_path: storagePath,
        kind: 'image',
      })
      .select('*')
      .single();
    if (insErr || !fileRow) {
      // Best-effort: remove the orphan storage object so we don't leak bytes.
      void jwtClient.storage.from(FILES_BUCKET).remove([storagePath]);
      return jsonError(500, `files row insert failed: ${insErr?.message ?? 'unknown'}`);
    }

    void logFileActivityServer({
      event_type: 'promote',
      summary_ar: `حفظ صورة من محادثة التصميم: ${originalName}`,
      summary_en: `Saved an Image Chats image to Files: ${originalName}`,
      details: {
        file_id: fileId,
        source: 'image_chat',
        folder_id: body.folder_id ?? null,
        model_id: body.model_id ?? null,
        record_id: body.record_id ?? null,
      },
      actor_user_id: appUserId,
      actor_email: user.email,
    });

    // Cache the new files.id onto the originating chat message (first-promote-
    // wins) so future Add-to-Record dedups to this row. Server-side via
    // record_save (NOT the browser store) → no echo-dedup suppression of a
    // concurrent worker fill-in. Best-effort: the file row already exists; a
    // cache miss just means the next add re-promotes.
    const chatRecordId = body.chat_record_id?.trim();
    const messageId = body.message_id?.trim();
    const imageIndex = typeof body.image_index === 'number' ? body.image_index : -1;
    if (chatRecordId && messageId && imageIndex >= 0) {
      await cacheFileIdOnChatMessage(jwtClient, chatRecordId, messageId, imageIndex, fileId).catch(
        (e) => console.warn(`[promote-asset] cache file_id failed (non-fatal): ${(e as Error).message}`),
      );
    }

    return jsonOk({ file: fileRow }, 201);
  });
}

/**
 * Stamp `images[imageIndex].file_id = fileId` on the given chat message, only
 * if it's currently unset (first-promote-wins). Optimistic concurrency via
 * record_save's p_expected_version + retry on the 40001 version-mismatch (the
 * worker may be writing the same conversation concurrently).
 */
async function cacheFileIdOnChatMessage(
  jwtClient: SupabaseClient,
  recordId: string,
  messageId: string,
  imageIndex: number,
  fileId: string,
): Promise<void> {
  await recordSaveWithRetry(jwtClient, {
    recordId,
    build: (data) => {
      const messages = Array.isArray(data.messages)
        ? (data.messages as Array<Record<string, unknown>>)
        : [];
      let changed = false;
      const newMessages = messages.map((m) => {
        if (m.id !== messageId) return m;
        const images = Array.isArray(m.images) ? (m.images as Array<Record<string, unknown>>) : [];
        if (imageIndex >= images.length) return m;
        const img = images[imageIndex];
        if (img && !img.file_id) {
          changed = true;
          return {
            ...m,
            images: images.map((x, i) => (i === imageIndex ? { ...x, file_id: fileId } : x)),
          };
        }
        return m;
      });
      if (!changed) return null; // already cached, or message/image not found — skip the save
      return { ...data, messages: newMessages };
    },
  });
}
