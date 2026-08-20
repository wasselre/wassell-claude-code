/**
 * Phase 3 · B6 — the files attached to one record.
 *
 * This reads the Phase 1/2 PROJECTION (`file_links`), not `document_links`.
 * That distinction is the whole point of the batch: a record's files come from
 * four different mechanisms — a schema field holding a file id, the legacy
 * `files.record_id` column, a manual link, and a marketing asset — and the
 * projection is the one place they are already unified and kept converged
 * inside the writing transaction.
 *
 * ── WHAT IS EDITABLE, AND HOW WE KNOW ─────────────────────────────────────
 * `file_link_sources.source_key` carries the provenance, prefixed by mechanism:
 *
 *     field:<model>:<record>:<field>:<index>:<file>   → derived, READ-ONLY
 *     attachment:<file>:<model>:<record>              → derived, READ-ONLY
 *     marketing:<asset>:<file>:<model>:<record>       → derived, READ-ONLY
 *     manual:<file>:<model>:<record>                  → a person made it
 *
 * Only a `manual:` source can be removed from this UI. Everything else is a
 * projection of a fact that lives somewhere else — a record field, the legacy
 * column, a marketing asset — and "unlinking" it here would either do nothing
 * or silently disagree with the record form. The spec is explicit: field-derived
 * entries render read-only and deep-link to the field instead.
 *
 * ── AN EDGE CAN HAVE BOTH ─────────────────────────────────────────────────
 * A file can be a unit's floor-plan FIELD and also manually linked to the same
 * unit. Removing the manual link then leaves the edge standing, because the
 * field still proves it. That is correct and already tested in Phase 1; the UI
 * says so rather than pretending the row will disappear.
 */
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import { errorText } from './library';
import type { BusinessFileRow } from '@/types';

function surfaceError(scope: string, err: unknown): Error {
  // errorText, NOT `String(err)`. Everything that reaches here from supabase-js
  // is a plain PostgrestError, not an Error, and String() renders it as the
  // literal "[object Object]". B5 diagnosed exactly this and wrote the helper;
  // this file then repeated the original mistake, which is why the helper is
  // imported rather than the pattern retyped.
  const msg = errorText(err);
  console.error(`[record-files] ${scope} failed:`, err);
  try {
    useAppStore.getState().addToast(`${scope}: ${msg}`, 'error');
  } catch {
    // Pre-init — the toast queue is not mounted. console.error is still loud
    // and the caller still receives a thrown Error.
  }
  return new Error(msg);
}

/** How a relationship came to exist. Ordered weakest-claim to strongest so a
 *  UI can pick one label for an edge with several sources. */
export type LinkOrigin = 'manual' | 'field' | 'attachment' | 'marketing' | 'unknown';

export interface RecordFileEntry {
  /** `file_links.id` — the edge, not the file and not the manual link. */
  link_id: string;
  file: BusinessFileRow;
  /** The document type this file IS *to this record*. Groups the panel. */
  role: string;
  origins: LinkOrigin[];
  /** True when a `manual:` source exists, i.e. this UI can remove something. */
  removable: boolean;
  /** True when a source other than `manual:` also proves the edge — so removing
   *  the manual link leaves the row on screen. The UI warns instead of lying. */
  survivesRemoval: boolean;
  /** The record field that derives this, when one does. Lets the panel say
   *  "this comes from the Floor plan field" and jump there. */
  sourceField: string | null;
}

export function originOf(sourceKey: string): LinkOrigin {
  const head = sourceKey.split(':', 1)[0];
  if (head === 'manual' || head === 'field' || head === 'attachment' || head === 'marketing') {
    return head;
  }
  return 'unknown';
}

/**
 * Decide what the UI may do with an edge, from its source keys alone.
 *
 * Exported and pure because this is the single most consequential rule in the
 * batch: get it wrong in the permissive direction and the panel offers an
 * unlink that silently does nothing (or worse, disagrees with the record form);
 * get it wrong in the restrictive direction and a manual link becomes
 * impossible to undo from the only place it is visible.
 */
export function classifyEdge(sourceKeys: string[]): {
  origins: LinkOrigin[];
  removable: boolean;
  survivesRemoval: boolean;
} {
  const origins = [...new Set(sourceKeys.map(originOf))];
  const removable = origins.includes('manual');
  return {
    origins,
    removable,
    // Only meaningful when something IS removable: an edge with no manual
    // source has nothing to remove, so it cannot "survive" a removal.
    survivesRemoval: removable && origins.some((o) => o !== 'manual'),
  };
}

/**
 * Every file linked to a record, with enough provenance for the panel to know
 * what it may edit.
 *
 * Three queries, not one join: PostgREST embeds run their own RLS pass per
 * embedded table and the projection's own policy already gates both sides, so
 * an embed buys nothing here and makes the failure modes harder to read.
 *
 * Throws on failure. A record whose files could not be loaded must not render
 * as a record with no files — that is the empty-vs-broken trap this phase has
 * already been bitten by once.
 */
export async function listRecordFiles(
  modelId: string,
  recordId: string,
): Promise<RecordFileEntry[]> {
  if (!supabase) return [];

  const { data: links, error: linkErr } = await supabase
    .from('file_links')
    .select('id, file_id, role')
    .eq('model_id', modelId)
    .eq('record_id', recordId);
  if (linkErr) throw surfaceError('load record files', linkErr);
  const edges = (links ?? []) as Array<{ id: string; file_id: string; role: string }>;
  if (edges.length === 0) return [];

  const [{ data: sources, error: srcErr }, { data: files, error: fileErr }] = await Promise.all([
    supabase
      .from('file_link_sources')
      .select('link_id, source_key, source_field')
      .in('link_id', edges.map((e) => e.id)),
    supabase
      .from('files')
      .select('*')
      .in('id', [...new Set(edges.map((e) => e.file_id))]),
  ]);
  if (srcErr) throw surfaceError('load link provenance', srcErr);
  if (fileErr) throw surfaceError('load linked files', fileErr);

  const byLink = new Map<string, Array<{ source_key: string; source_field: string | null }>>();
  for (const s of (sources ?? []) as Array<{ link_id: string; source_key: string; source_field: string | null }>) {
    const cur = byLink.get(s.link_id);
    if (cur) cur.push(s);
    else byLink.set(s.link_id, [s]);
  }
  const fileById = new Map((files ?? []).map((f) => [(f as BusinessFileRow).id, f as BusinessFileRow]));

  const out: RecordFileEntry[] = [];
  for (const e of edges) {
    const file = fileById.get(e.file_id);
    // An edge whose file the caller cannot SELECT is not an error — RLS gates
    // the two tables independently and the file half can legitimately be
    // narrower. Skipping is right; inventing a placeholder row would tell the
    // user a file exists that they may not know about.
    if (!file) continue;

    const srcs = byLink.get(e.id) ?? [];
    const { origins, removable, survivesRemoval } = classifyEdge(srcs.map((s) => s.source_key));
    out.push({
      link_id: e.id,
      file,
      role: e.role,
      origins,
      removable,
      survivesRemoval,
      sourceField: srcs.find((s) => s.source_field)?.source_field ?? null,
    });
  }
  return out;
}

/**
 * Link an existing file to a record.
 *
 * Writes `document_links`, which spec §5 chose as the universal manual link
 * table: it is unique on (file_id, model_id, record_id) and is already a Phase 2
 * trigger source, so the edge appears in `file_links` at COMMIT with no second
 * write and no bytes copied. Linking the same file to five records is five rows
 * here and still ONE file.
 *
 * Idempotent by upsert on the natural key — clicking "attach" twice must not
 * show a unique-violation for what the user experiences as a no-op.
 */
export async function attachFileToRecord(
  fileId: string,
  modelId: string,
  recordId: string,
  role: string | null,
): Promise<void> {
  if (!supabase) throw surfaceError('attach file', new Error('Supabase is not configured'));
  const appUserId = useAppStore.getState().currentUserId;
  if (!appUserId) throw surfaceError('attach file', new Error('Not signed in'));

  const { data, error } = await supabase
    .from('document_links')
    .upsert(
      {
        file_id: fileId,
        model_id: modelId,
        record_id: recordId,
        created_by_user_id: appUserId,
        // NULL means "the linker did not say", which B1 deliberately kept
        // distinguishable from an explicit choice of supporting_document.
        role: role ?? null,
      },
      { onConflict: 'file_id,model_id,record_id' },
    )
    .select('id');
  if (error) throw surfaceError('attach file', error);
  if (((data ?? []) as unknown[]).length === 0) {
    // RLS refuses with 200 + zero rows, not with an error. Without this the
    // panel would report success and show nothing after a refresh.
    throw surfaceError(
      'attach file',
      new Error('the database changed no row — you need edit rights on the file to link it'),
    );
  }
}

/**
 * Remove a manual link.
 *
 * Deletes by the NATURAL key rather than by `document_links.id`: the surrogate
 * id is not what identifies the relationship (the table's own UNIQUE constraint
 * is), and the panel already knows the triple. This also means the caller never
 * has to fetch `document_links` just to obtain an id it will immediately use
 * once.
 *
 * The EDGE may survive this — see the file header. The caller is told via
 * `survivesRemoval` and should reload rather than assume the row disappears.
 */
export async function detachFileFromRecord(
  fileId: string,
  modelId: string,
  recordId: string,
): Promise<void> {
  if (!supabase) throw surfaceError('unlink file', new Error('Supabase is not configured'));
  const { data, error } = await supabase
    .from('document_links')
    .delete()
    .eq('file_id', fileId)
    .eq('model_id', modelId)
    .eq('record_id', recordId)
    .select('id');
  if (error) throw surfaceError('unlink file', error);
  if (((data ?? []) as unknown[]).length === 0) {
    throw surfaceError(
      'unlink file',
      new Error('nothing was unlinked — either it is derived from a record field, or you lack edit rights'),
    );
  }
}

/**
 * Correct the document type of a manual link.
 *
 * Allowed by the B6 migration's UPDATE policy, gated on the same file-edit
 * predicate as linking. A BEFORE trigger refuses any attempt to change the
 * file/model/record triple in the same statement, so this can only ever move
 * a link between headings — never retarget it.
 */
export async function setLinkRole(
  fileId: string,
  modelId: string,
  recordId: string,
  role: string | null,
): Promise<void> {
  if (!supabase) throw surfaceError('change link type', new Error('Supabase is not configured'));
  const { data, error } = await supabase
    .from('document_links')
    .update({ role })
    .eq('file_id', fileId)
    .eq('model_id', modelId)
    .eq('record_id', recordId)
    .select('id');
  if (error) throw surfaceError('change link type', error);
  if (((data ?? []) as unknown[]).length === 0) {
    throw surfaceError(
      'change link type',
      new Error('the database changed no row — this link may be derived rather than manual'),
    );
  }
}

/** Group entries by role, biggest group first, so the panel sections mirror the
 *  spec's per-record default groupings without hard-coding a list per model. */
export function groupByRole(entries: RecordFileEntry[]): Array<{ role: string; entries: RecordFileEntry[] }> {
  const buckets = new Map<string, RecordFileEntry[]>();
  for (const e of entries) {
    const cur = buckets.get(e.role);
    if (cur) cur.push(e);
    else buckets.set(e.role, [e]);
  }
  return [...buckets.entries()]
    .map(([role, list]) => ({ role, entries: list }))
    .sort((a, b) => b.entries.length - a.entries.length || a.role.localeCompare(b.role));
}
