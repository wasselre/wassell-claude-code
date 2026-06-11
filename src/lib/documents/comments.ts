/**
 * Browser-side CRUD for document comment threads (`public.document_comments`).
 *
 * RLS does the access work: read/insert/resolve need 'view' on the file,
 * delete needs author-or-file-owner, and DB triggers enforce thread shape
 * (single-level replies, immutable identity columns, author-only body edits).
 * The ANCHOR is not stored here — it's a `comment` mark inside the document
 * content carrying the row's id (see CommentMarkExtension.ts).
 */

import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';

export interface DocComment {
  id: string;
  file_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  anchor_text: string | null;
  resolved: boolean;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface CommentThread {
  root: DocComment;
  replies: DocComment[];
}

function surfaceError(scope: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[comments] ${scope} failed:`, err);
  try {
    useAppStore.getState().addToast(`${scope}: ${msg}`, 'error');
  } catch {
    // Pre-init — toast queue not ready. Console.error above is still loud.
  }
  return new Error(msg);
}

/** All threads for a document. Replies are grouped under their root and
 *  ordered oldest-first (conversation order); root order is left to the
 *  caller (the editor page sorts by anchor position in the document). */
export async function listCommentThreads(fileId: string): Promise<CommentThread[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('document_comments')
    .select('*')
    .eq('file_id', fileId)
    .order('created_at', { ascending: true });
  if (error) throw surfaceError('load comments', error);
  const rows = (data ?? []) as DocComment[];
  const threads = new Map<string, CommentThread>();
  for (const row of rows) {
    if (row.parent_id === null) threads.set(row.id, { root: row, replies: [] });
  }
  for (const row of rows) {
    if (row.parent_id === null) continue;
    // Orphan replies (root deleted mid-flight) are dropped — the CASCADE
    // would have removed them; this only skips a torn read.
    threads.get(row.parent_id)?.replies.push(row);
  }
  return [...threads.values()];
}

/** Create a thread root. The caller then anchors it in the document by
 *  applying the `comment` mark with the returned id and saving. */
export async function addComment(fileId: string, body: string, anchorText: string): Promise<DocComment> {
  if (!supabase) throw surfaceError('add comment', new Error('Supabase not configured'));
  const authorId = useAppStore.getState().currentUserId;
  if (!authorId) throw surfaceError('add comment', new Error('Not signed in'));
  const { data, error } = await supabase
    .from('document_comments')
    .insert({
      file_id: fileId,
      author_id: authorId,
      body: body.trim(),
      anchor_text: anchorText.slice(0, 300) || null,
    })
    .select('*')
    .single();
  if (error || !data) throw surfaceError('add comment', error ?? new Error('insert returned no row'));
  return data as DocComment;
}

export async function replyToComment(fileId: string, parentId: string, body: string): Promise<DocComment> {
  if (!supabase) throw surfaceError('reply', new Error('Supabase not configured'));
  const authorId = useAppStore.getState().currentUserId;
  if (!authorId) throw surfaceError('reply', new Error('Not signed in'));
  const { data, error } = await supabase
    .from('document_comments')
    .insert({ file_id: fileId, parent_id: parentId, author_id: authorId, body: body.trim() })
    .select('*')
    .single();
  if (error || !data) throw surfaceError('reply', error ?? new Error('insert returned no row'));
  return data as DocComment;
}

/** Resolve / reopen a thread (root rows only — the UI never resolves a reply). */
export async function setThreadResolved(commentId: string, resolved: boolean): Promise<void> {
  if (!supabase) throw surfaceError('resolve comment', new Error('Supabase not configured'));
  const userId = useAppStore.getState().currentUserId;
  const { error } = await supabase
    .from('document_comments')
    .update(
      resolved
        ? { resolved: true, resolved_by_user_id: userId, resolved_at: new Date().toISOString() }
        : { resolved: false, resolved_by_user_id: null, resolved_at: null },
    )
    .eq('id', commentId)
    .is('parent_id', null);
  if (error) throw surfaceError('resolve comment', error);
}

/** Delete one comment. Deleting a thread root cascades its replies (DB FK);
 *  the caller is responsible for also removing the anchor mark from the
 *  document (unsetCommentById) when deleting a root. */
export async function deleteComment(commentId: string): Promise<void> {
  if (!supabase) throw surfaceError('delete comment', new Error('Supabase not configured'));
  const { error } = await supabase.from('document_comments').delete().eq('id', commentId);
  if (error) throw surfaceError('delete comment', error);
}
