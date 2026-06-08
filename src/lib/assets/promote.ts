/**
 * Promote-on-add (Image Chats v2, Part 5).
 *
 * A generated chat image lives as a public `marketing-assets` URL. The first
 * time the user adds it to Files or a record, `/api/image-chat/promote-asset`
 * creates ONE `files` row for it (server-side byte copy → `wassel-files`) and
 * — when the chat locator is passed — caches the resulting `files.id` back onto
 * the message image (server-side, first-promote-wins). Every later
 * Add-to-Record reuses that SAME id, so the asset is deduped (one files row,
 * one storage object, many references) instead of re-copied per reference.
 *
 * The cache write happens on the SERVER (not the browser store) so it can't
 * trip the realtime echo-dedup and suppress a concurrent worker fill-in on the
 * same conversation. This module is the single client entry point for the
 * policy — the actions menu, Add-to-Files, and Add-to-Record all go through it.
 */

import { supabase } from '@/lib/supabase';
import type { FileRow } from '@/types/files';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface PromoteInput {
  /** The chat image's public marketing-assets URL. */
  sourceUrl: string;
  /** Drive folder to place the new file in (Add to Files). */
  folderId?: string | null;
  /** Tag the file to a target record (Add to Record). */
  modelId?: string | null;
  recordId?: string | null;
  /** Display name; the server derives one if omitted. */
  originalName?: string;
  /** Locator to cache files.id back onto the originating chat message
   *  (server-side, first-promote-wins). Pass all three to enable dedup. */
  chatRecordId?: string;
  messageId?: string;
  imageIndex?: number;
}

/**
 * Create a `files` row from a chat image. Returns the new FileRow. Throws on
 * failure (the caller surfaces it via toast — never swallow, per CLAUDE.md).
 */
export async function promoteChatImage(input: PromoteInput): Promise<FileRow> {
  const res = await fetch('/api/image-chat/promote-asset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      source_url: input.sourceUrl,
      folder_id: input.folderId ?? null,
      model_id: input.modelId ?? null,
      record_id: input.recordId ?? null,
      original_name: input.originalName,
      chat_record_id: input.chatRecordId,
      message_id: input.messageId,
      image_index: input.imageIndex,
    }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(b?.error ?? `promote-asset failed (${res.status})`);
  }
  const json = (await res.json()) as { file?: FileRow };
  if (!json.file) throw new Error('promote-asset succeeded but no file returned');
  return json.file;
}
