/**
 * Browser-side helpers for native Wassel documents (Google-Docs-style rich
 * text). A document is a first-class file in the Files system — same folder,
 * sharing, permissions, rename, delete plumbing as any upload — but its body
 * lives in `public.wassel_documents` instead of the Storage bucket.
 *
 * Two writes per save (the files row's updated_at + the wassel_documents
 * row) are done independently because PostgREST doesn't expose a single
 * multi-table transaction without an RPC, and the failure mode of one
 * succeeding without the other is benign here (the file row's updated_at
 * is a UX nicety, not load-bearing).
 */

import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import type { FileRow, WasselDocumentRow } from '@/types';

export const WASSEL_DOC_MIME = 'application/vnd.wassel.document+json';
export const WASSEL_DOC_KIND = 'wassel_doc' as const;

/** Default empty TipTap document — an empty paragraph so the editor mounts
 *  with a writable line instead of an empty doc the user can't click into. */
const EMPTY_DOC_JSON = {
  type: 'doc',
  content: [{ type: 'paragraph' }],
};

function surfaceError(scope: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[documents] ${scope} failed:`, err);
  try {
    useAppStore.getState().addToast(`${scope}: ${msg}`, 'error');
  } catch {
    // Pre-init — toast queue not ready. Console.error above is still loud.
  }
  return new Error(msg);
}

export interface CreateDocumentOpts {
  /** Display title; becomes files.original_name. Defaults to "Untitled". */
  title?: string;
  folderId?: string | null;
  /** Initial TipTap JSON body — used by template creation. Defaults to an
   *  empty paragraph. Pass contentHtml alongside so previews/export read
   *  correctly before the first editor autosave. */
  contentJson?: Record<string, unknown>;
  contentHtml?: string;
}

/**
 * Provision a new Wassel document. Inserts the files row first (so RLS can
 * gate the wassel_documents row via wassell_can_access_file), then the
 * body row. If the body insert fails after the files row is created, we
 * best-effort delete the files row so we don't leave an orphan doc that
 * looks openable but is empty.
 */
export async function createDocument(opts: CreateDocumentOpts = {}): Promise<FileRow> {
  if (!supabase) throw surfaceError('create document', new Error('Supabase not configured'));
  const appUserId = useAppStore.getState().currentUserId;
  if (!appUserId) throw surfaceError('create document', new Error('Not signed in'));

  const fileId = crypto.randomUUID();
  const title = (opts.title?.trim() || 'Untitled document').slice(0, 200);

  const { data: row, error: insErr } = await supabase
    .from('files')
    .insert({
      id: fileId,
      folder_id: opts.folderId ?? null,
      uploaded_by_user_id: appUserId,
      original_name: title,
      mime_type: WASSEL_DOC_MIME,
      size_bytes: 0,
      // Sentinel path — no Storage object exists. The NOT NULL UNIQUE
      // constraint on storage_path forces a value; `doc:<id>` makes it
      // obvious in DB inspection that this row has no Storage backing.
      storage_path: `doc:${fileId}`,
      kind: WASSEL_DOC_KIND,
    })
    .select('*')
    .single();
  if (insErr || !row) {
    throw surfaceError('create document', insErr ?? new Error('insert returned no row'));
  }

  const { error: bodyErr } = await supabase.from('wassel_documents').insert({
    file_id: fileId,
    content_json: opts.contentJson ?? EMPTY_DOC_JSON,
    content_html: opts.contentHtml ?? '',
    version: 1,
    last_edited_by_user_id: appUserId,
  });
  if (bodyErr) {
    // Orphan cleanup — surface the body error but also try to roll back the
    // files row so the user doesn't see a phantom doc that opens to nothing.
    void supabase.from('files').delete().eq('id', fileId);
    throw surfaceError('create document', bodyErr);
  }

  return row as FileRow;
}

export interface LoadedDocument {
  file: FileRow;
  doc: WasselDocumentRow;
}

/**
 * Fetch a document by its file id. Returns null if either the files row or
 * the wassel_documents row is hidden by RLS or doesn't exist.
 */
export async function loadDocument(fileId: string): Promise<LoadedDocument | null> {
  if (!supabase) return null;
  const [fileRes, docRes] = await Promise.all([
    supabase.from('files').select('*').eq('id', fileId).maybeSingle(),
    supabase.from('wassel_documents').select('*').eq('file_id', fileId).maybeSingle(),
  ]);
  if (fileRes.error) throw surfaceError('load document', fileRes.error);
  if (docRes.error) throw surfaceError('load document', docRes.error);
  if (!fileRes.data || !docRes.data) return null;
  return {
    file: fileRes.data as FileRow,
    doc: docRes.data as WasselDocumentRow,
  };
}

export interface SaveDocumentInput {
  fileId: string;
  contentJson: Record<string, unknown>;
  contentHtml: string;
}

/**
 * Persist edits. Bumps version and last_edited_by, and touches the parent
 * files row's updated_at so the Files grid's "most recent first" ordering
 * surfaces freshly-edited docs. Returns the new version number.
 */
export async function saveDocument(input: SaveDocumentInput): Promise<{ version: number; updatedAt: string }> {
  if (!supabase) throw surfaceError('save document', new Error('Supabase not configured'));
  const appUserId = useAppStore.getState().currentUserId;
  if (!appUserId) throw surfaceError('save document', new Error('Not signed in'));

  // Read current version to increment it (server-side `version + 1` would
  // need a custom RPC; this is fine for single-editor v1).
  const { data: cur, error: readErr } = await supabase
    .from('wassel_documents')
    .select('version')
    .eq('file_id', input.fileId)
    .single();
  if (readErr || !cur) throw surfaceError('save document', readErr ?? new Error('document missing'));
  const nextVersion = (cur.version as number) + 1;

  const { data: updated, error: updErr } = await supabase
    .from('wassel_documents')
    .update({
      content_json: input.contentJson,
      content_html: input.contentHtml,
      version: nextVersion,
      last_edited_by_user_id: appUserId,
    })
    .eq('file_id', input.fileId)
    .select('version, updated_at')
    .single();
  if (updErr || !updated) throw surfaceError('save document', updErr ?? new Error('update returned no row'));

  // Touch parent file's updated_at so Files grid ordering reflects the edit.
  // Best-effort — a failure here is a UX nit (file would still save), not a
  // correctness issue, but we still surface via the toast helper to stay
  // loud (CLAUDE.md "Silent Failures").
  const { error: touchErr } = await supabase
    .from('files')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', input.fileId);
  if (touchErr) surfaceError('touch file', touchErr);

  return {
    version: updated.version as number,
    updatedAt: updated.updated_at as string,
  };
}

/** Persist the document's page settings (size/orientation/margins/header/
 *  footer). Separate from saveDocument — settings changes shouldn't bump the
 *  content version or race the autosave. */
export async function saveDocumentSettings(
  fileId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  if (!supabase) throw surfaceError('save settings', new Error('Supabase not configured'));
  const { error } = await supabase.from('wassel_documents').update({ settings }).eq('file_id', fileId);
  if (error) throw surfaceError('save settings', error);
}

/** Rename a document. Reuses the existing files.renameFile semantics — kept
 *  here so callers in the editor don't have to import from two places. */
export async function renameDocument(fileId: string, newTitle: string): Promise<FileRow> {
  if (!supabase) throw surfaceError('rename document', new Error('Supabase not configured'));
  const trimmed = newTitle.trim().slice(0, 200);
  if (!trimmed) throw surfaceError('rename document', new Error('Title is required'));
  const { data, error } = await supabase
    .from('files')
    .update({ original_name: trimmed })
    .eq('id', fileId)
    .select('*')
    .single();
  if (error || !data) throw surfaceError('rename document', error ?? new Error('update returned no row'));
  return data as FileRow;
}
