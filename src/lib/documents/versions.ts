/**
 * Version history for Wassel documents (`public.document_versions`).
 *
 * Immutable content snapshots. Capture points:
 *   'auto'     — during editing, at most one per AUTO_SNAPSHOT_MIN_MS of
 *                activity (called after every successful save; self-throttles)
 *   'manual'   — the user pressed "save version" (optionally labeled)
 *   'approval' — an approval-status transition stamped the current content
 *   'restore'  — safety snapshot taken right before restoring an old version
 *
 * Retention: auto rows beyond AUTO_KEEP are pruned (newest kept); the other
 * kinds are permanent. Restore itself is the editor page's job (it owns the
 * editor instance) — this lib only reads/writes rows.
 */

import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';

export type VersionKind = 'auto' | 'manual' | 'approval' | 'restore';

/** List row — content omitted on purpose (bodies can be large). */
export interface DocVersionMeta {
  id: string;
  file_id: string;
  doc_version: number;
  kind: VersionKind;
  label: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

export interface DocVersionFull extends DocVersionMeta {
  content_json: Record<string, unknown>;
  content_html: string;
}

const AUTO_SNAPSHOT_MIN_MS = 10 * 60 * 1000; // one auto snapshot per 10 min
const AUTO_KEEP = 30;

function surfaceError(scope: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[versions] ${scope} failed:`, err);
  try {
    useAppStore.getState().addToast(`${scope}: ${msg}`, 'error');
  } catch {
    // Pre-init — toast queue not ready. Console.error above is still loud.
  }
  return new Error(msg);
}

export async function listVersions(fileId: string): Promise<DocVersionMeta[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('document_versions')
    .select('id, file_id, doc_version, kind, label, created_by_user_id, created_at')
    .eq('file_id', fileId)
    .order('created_at', { ascending: false });
  if (error) throw surfaceError('load versions', error);
  return (data ?? []) as DocVersionMeta[];
}

export async function getVersion(id: string): Promise<DocVersionFull | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('document_versions').select('*').eq('id', id).maybeSingle();
  if (error) throw surfaceError('load version', error);
  return (data as DocVersionFull | null) ?? null;
}

export interface SnapshotInput {
  fileId: string;
  docVersion: number;
  kind: VersionKind;
  label?: string | null;
  contentJson: Record<string, unknown>;
  contentHtml: string;
}

export async function snapshotVersion(input: SnapshotInput): Promise<DocVersionMeta> {
  if (!supabase) throw surfaceError('save version', new Error('Supabase not configured'));
  const userId = useAppStore.getState().currentUserId;
  const { data, error } = await supabase
    .from('document_versions')
    .insert({
      file_id: input.fileId,
      doc_version: input.docVersion,
      kind: input.kind,
      label: input.label?.trim() || null,
      content_json: input.contentJson,
      content_html: input.contentHtml,
      created_by_user_id: userId,
    })
    .select('id, file_id, doc_version, kind, label, created_by_user_id, created_at')
    .single();
  if (error || !data) throw surfaceError('save version', error ?? new Error('insert returned no row'));
  return data as DocVersionMeta;
}

/**
 * Auto-snapshot throttle: called after every successful save; inserts only
 * when the newest AUTO row is older than AUTO_SNAPSHOT_MIN_MS (or none
 * exists), then prunes old auto rows beyond AUTO_KEEP. Failures are surfaced
 * (toast + console) but intentionally not re-thrown — version capture must
 * never break the save path it rides on.
 */
export async function maybeAutoSnapshot(
  input: Omit<SnapshotInput, 'kind' | 'label'>,
): Promise<void> {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('document_versions')
      .select('created_at')
      .eq('file_id', input.fileId)
      .eq('kind', 'auto')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    const newest = data?.[0]?.created_at as string | undefined;
    if (newest && Date.now() - new Date(newest).getTime() < AUTO_SNAPSHOT_MIN_MS) return;

    await snapshotVersion({ ...input, kind: 'auto' });

    // Prune: keep the newest AUTO_KEEP auto rows.
    const { data: extras, error: listErr } = await supabase
      .from('document_versions')
      .select('id')
      .eq('file_id', input.fileId)
      .eq('kind', 'auto')
      .order('created_at', { ascending: false })
      .range(AUTO_KEEP, AUTO_KEEP + 49);
    if (listErr) throw listErr;
    if (extras && extras.length > 0) {
      const { error: delErr } = await supabase
        .from('document_versions')
        .delete()
        .in('id', extras.map((r) => r.id as string));
      if (delErr) throw delErr;
    }
  } catch (err) {
    surfaceError('auto version snapshot', err);
  }
}
