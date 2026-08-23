/**
 * Phase 3 · B5 — service layer for the Business Files Library.
 *
 * Everything here is a thin, typed wrapper over objects that already exist on
 * production: `business_files_search` (B2), the `files` metadata columns (B1),
 * `file_links` (Phase 1/2) and `file_document_types` (B1, readable from B5).
 *
 * ── THE ONE RULE THIS FILE EXISTS TO ENFORCE ──────────────────────────────
 * A failed search must NEVER reach the UI as an empty result. The Project
 * Finder shipped a 504 that rendered as "no matches" and nobody knew for weeks;
 * the Library must not repeat it. So every function here THROWS on failure and
 * the page holds a separate `error` state — "0 rows" and "the query broke" are
 * different screens, and only one of them offers a Retry button.
 *
 * Nothing in here caches. `business_files_search` is 350–1,100 ms on production
 * (measured 2026-08-19, over the 300 ms B2 budget), which is why the page
 * DEBOUNCES the free-text box rather than calling per keystroke — see
 * FilesLibraryPage. Getting that wrong would be the difference between one
 * query and twelve.
 */
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import type {
  BusinessFileRow,
  BusinessFilesSearchResult,
  BusinessFileSort,
  FileDocumentTypeRow,
  FileVocabRow,
  LibraryFilters,
  PageLinkSummary,
} from '@/types';

/** Spec §6: "Server-side pagination from day one, at 60 per page." */
export const LIBRARY_PAGE_SIZE = 60;

/**
 * Turn anything a failed call can hand us into a sentence a person can read.
 *
 * `err instanceof Error ? err.message : String(err)` is the obvious version and
 * it is WRONG here: supabase-js resolves failures as a plain `PostgrestError`
 * object, not an Error, so `String(err)` produces the literal text
 * "[object Object]". Caught in the B5 browser pass — the error card rendered
 * "The search could not run" followed by "[object Object]", which tells the
 * user nothing and tells whoever they report it to even less.
 *
 * PostgREST's own fields are folded in because the useful part is often in
 * `details` or `hint`, not in `message` ("column x does not exist" vs. which
 * statement).
 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [e.message, e.details, e.hint]
      .filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    if (parts.length) {
      const code = typeof e.code === 'string' && e.code ? ` [${e.code}]` : '';
      return parts.join(' — ') + code;
    }
    try {
      return JSON.stringify(err);
    } catch {
      // A circular object. Falling through to String() gives
      // "[object Object]", which is bad but still better than throwing while
      // building an error message.
      return String(err);
    }
  }
  return String(err);
}

/**
 * Surface an error loudly and return it for the caller to throw.
 *
 * Deliberately the same shape as `surfaceError` in ./client.ts rather than an
 * import: that one is scoped to Drive operations and its message prefix reads
 * as a Drive action ("list files: ..."). Keeping them separate means the toast
 * text tells the user which surface actually failed.
 */
function surfaceLibraryError(scope: string, err: unknown): Error {
  const msg = errorText(err);
  console.error(`[library] ${scope} failed:`, err);
  try {
    useAppStore.getState().addToast(`${scope}: ${msg}`, 'error');
  } catch {
    // Pre-init — the toast queue is not mounted. The console.error above is
    // still loud, and the caller still gets a thrown Error.
  }
  return new Error(msg);
}

/** Supabase is optional (the app runs offline against localStorage). The
 *  Library is a server-side search, so with no client there is nothing to
 *  search — say so instead of rendering an empty library. */
function requireSupabase(scope: string) {
  if (!supabase) {
    throw surfaceLibraryError(scope, new Error('Supabase is not configured'));
  }
  return supabase;
}

/**
 * Drop keys the RPC would treat as a constraint but the user did not set.
 *
 * `business_files_search` tests membership with `f ? 'document_type'`, so an
 * EMPTY array is not "no filter" — it is "match nothing". Sending `{tags: []}`
 * would return zero rows and look exactly like a library with no files in it.
 * Same for a `false` boolean: `{unlinked: false}` is harmless today but the key
 * has no business being in a saved view that does not use it.
 */
export function pruneFilters(filters: LibraryFilters): LibraryFilters {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out[k] = v;
      continue;
    }
    if (typeof v === 'boolean') {
      if (!v) continue;
      out[k] = v;
      continue;
    }
    out[k] = v;
  }
  return out as LibraryFilters;
}

export interface SearchArgs {
  q?: string;
  filters?: LibraryFilters;
  sort?: BusinessFileSort;
  page?: number;
  pageSize?: number;
}

/**
 * One round trip for the grid, the count AND the filter bar.
 *
 * The RPC is SECURITY INVOKER, so RLS is the only authority on what comes
 * back: two users running the same query legitimately get different totals and
 * different facet counts. That is correct, not a bug to normalise away.
 */
export async function searchBusinessFiles(args: SearchArgs): Promise<BusinessFilesSearchResult> {
  const db = requireSupabase('search files');
  const { data, error } = await db.rpc('business_files_search', {
    p_q: args.q?.trim() ? args.q.trim() : null,
    p_filters: pruneFilters(args.filters ?? {}),
    p_sort: args.sort ?? 'created_desc',
    p_page: args.page ?? 1,
    p_page_size: args.pageSize ?? LIBRARY_PAGE_SIZE,
  });
  if (error) throw surfaceLibraryError('search files', error);
  if (!data) throw surfaceLibraryError('search files', new Error('the search returned no payload'));
  return data as BusinessFilesSearchResult;
}

/**
 * Which records use each file on the current page.
 *
 * ONE query for up to 60 files (~88 ms measured on production) instead of one
 * per row. `file_links` carries both-sides RLS, so an edge to a record the
 * caller cannot see is simply absent — the counts here are "links visible to
 * you", which is the only count we are entitled to show.
 */
export async function fetchPageLinks(fileIds: string[]): Promise<Map<string, PageLinkSummary[]>> {
  const out = new Map<string, PageLinkSummary[]>();
  if (fileIds.length === 0) return out;
  const db = requireSupabase('load file links');

  const { data, error } = await db
    .from('file_links')
    .select('file_id, model_id')
    .in('file_id', fileIds);
  if (error) throw surfaceLibraryError('load file links', error);

  // Model names come from the store, which already holds every model — a join
  // here would make PostgREST embed `models`, and that embed is subject to its
  // own RLS pass for no benefit.
  const models = useAppStore.getState().models;
  const byId = new Map(models.map((m) => [m.id, m]));

  const tally = new Map<string, Map<string, number>>();
  for (const row of (data ?? []) as Array<{ file_id: string; model_id: string }>) {
    let per = tally.get(row.file_id);
    if (!per) { per = new Map(); tally.set(row.file_id, per); }
    per.set(row.model_id, (per.get(row.model_id) ?? 0) + 1);
  }

  for (const [fileId, per] of tally) {
    const list: PageLinkSummary[] = [];
    for (const [modelId, count] of per) {
      const m = byId.get(modelId);
      list.push({
        file_id: fileId,
        // A model id with no model in the store is a real condition (a model
        // deleted while its edges linger), so it renders as the id's prefix
        // rather than as nothing at all.
        model_name: m?.name ?? modelId.slice(0, 8),
        model_label_ar: m?.label_ar ?? null,
        model_label_en: m?.label_en ?? null,
        count,
      });
    }
    list.sort((a, b) => b.count - a.count);
    out.set(fileId, list);
  }
  return out;
}

/** The 16-row controlled vocabulary. Only ACTIVE rows are visible (the RLS
 *  policy filters them), so a deactivated type disappears from the pickers
 *  while files that already carry it keep it. */
export async function listDocumentTypes(): Promise<FileDocumentTypeRow[]> {
  const db = requireSupabase('load document types');
  const { data, error } = await db
    .from('file_document_types')
    .select('*')
    .order('sort');
  if (error) throw surfaceLibraryError('load document types', error);
  return (data ?? []) as FileDocumentTypeRow[];
}

/** The metadata a user may edit from the Library detail panel.
 *
 *  Deliberately absent: `origin` and `file_class` (set by the write path, not
 *  by a person), `checksum_sha256` (B7 computes it), and `archived_at` — which
 *  is derived from `status` by B1's fill-in trigger and carries a CHECK that
 *  the pair stays coherent. Sending it separately is how that CHECK gets hit. */
export interface FileMetadataPatch {
  title?: string;
  document_type?: string;
  description?: string | null;
  tags?: string[];
  status?: BusinessFileRow['status'];
  owner_user_id?: string;
  confidentiality?: BusinessFileRow['confidentiality'];
  valid_from?: string | null;
  valid_until?: string | null;
  // Metadata Intelligence axes (Phase B) — direct scalar columns on files.
  // `ai_description` is deliberately NOT here: it is machine-written in the AI
  // phase, not hand-edited from this patch.
  asset_nature?: string | null;
  acquisition_source?: string | null;
  usage_rights?: string | null;
  production_state?: string | null;
}

/**
 * Save edited metadata.
 *
 * ── WHY THE ROW COUNT IS CHECKED ──────────────────────────────────────────
 * `files_update` is gated on `wassell_can_access_file(id,'edit')`, and that
 * helper does NOT include B4's record-derived branch — deliberately: B4 is a
 * VIEW grant, no write policy references it. So a user who can see a file only
 * because they can see a record that uses it can open this panel and cannot
 * save. PostgREST reports that as HTTP 200 with an EMPTY array, not as an
 * error. Without the check below, the panel would show "saved", the user would
 * navigate away, and the edit would be gone — the exact silent-failure shape
 * this repo has been bitten by three times. The UI also pre-disables the form
 * on effective role, but that is an affordance; this is the guard.
 */
export async function updateFileMetadata(
  fileId: string,
  patch: FileMetadataPatch,
): Promise<BusinessFileRow> {
  const db = requireSupabase('save file metadata');
  const { data, error } = await db
    .from('files')
    .update(patch)
    .eq('id', fileId)
    .select('*');
  if (error) throw surfaceLibraryError('save file metadata', error);

  const rows = (data ?? []) as BusinessFileRow[];
  const saved = rows[0];
  if (!saved) {
    throw surfaceLibraryError(
      'save file metadata',
      new Error('the database accepted the request but changed no row — you do not have edit rights on this file'),
    );
  }
  return saved;
}

/** The data-driven picklists for the Metadata-Intelligence scalar axes
 *  (asset_nature / acquisition_source / usage_rights / production_state). One
 *  round-trip returns all four; callers group by `dimension`. Only ACTIVE rows
 *  are returned by RLS+filter, mirroring listDocumentTypes. */
export async function listFileVocabularies(): Promise<FileVocabRow[]> {
  const db = requireSupabase('load file vocabularies');
  const { data, error } = await db
    .from('file_vocabularies')
    .select('*')
    .eq('active', true)
    .order('dimension')
    .order('sort');
  if (error) throw surfaceLibraryError('load file vocabularies', error);
  return (data ?? []) as FileVocabRow[];
}

/** The FULL subject set for one file (file_subjects). document_type is the
 *  PRIMARY subject and is always among these after a save. */
export async function fetchFileSubjects(fileId: string): Promise<string[]> {
  const db = requireSupabase('load file subjects');
  const { data, error } = await db
    .from('file_subjects')
    .select('subject')
    .eq('file_id', fileId);
  if (error) throw surfaceLibraryError('load file subjects', error);
  return (data ?? []).map((r) => (r as { subject: string }).subject);
}

/** Replace a file's subject set. The caller passes the COMPLETE desired set
 *  (including the primary document_type). Delete-then-insert keeps it simple and
 *  idempotent; RLS gates both on edit access to the parent file. Empty rows are
 *  filtered so a stray blank never violates the FK. */
export async function saveFileSubjects(fileId: string, subjects: string[]): Promise<void> {
  const db = requireSupabase('save file subjects');
  const clean = [...new Set(subjects.map((s) => s.trim()).filter(Boolean))];
  const del = await db.from('file_subjects').delete().eq('file_id', fileId);
  if (del.error) throw surfaceLibraryError('save file subjects', del.error);
  if (clean.length === 0) return;
  const ins = await db
    .from('file_subjects')
    .insert(clean.map((subject) => ({ file_id: fileId, subject })));
  if (ins.error) throw surfaceLibraryError('save file subjects', ins.error);
}
