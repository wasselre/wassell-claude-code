/**
 * Document ↔ record relationships (document_links table).
 *
 * A document (or any file) can be linked to MANY CRM records; the document
 * then appears inside those records (LinkedDocumentsPanel on the record
 * form). Distinct from files.model_id/record_id — that pair is the single
 * record-ATTACHMENT pointer written by Drive-backed record fields; this is
 * the many-to-many relationship surface.
 *
 * RLS gates everything by FILE access (view to list, edit to add/remove), so
 * a record viewer only ever sees documents they could actually open.
 */

import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, AppRecord } from '@/types';

export interface DocumentLink {
  id: string;
  file_id: string;
  model_id: string;
  record_id: string;
  created_by_user_id: string;
  created_at: string;
}

function surfaceError(scope: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[doc-links] ${scope} failed:`, err);
  try {
    useAppStore.getState().addToast(`${scope}: ${msg}`, 'error');
  } catch {
    // Pre-init — toast queue not ready. Console.error above is still loud.
  }
  return new Error(msg);
}

export async function listLinksForFile(fileId: string): Promise<DocumentLink[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('document_links')
    .select('*')
    .eq('file_id', fileId)
    .order('created_at', { ascending: false });
  if (error) throw surfaceError('list document links', error);
  return (data ?? []) as DocumentLink[];
}

export async function listLinksForRecord(modelId: string, recordId: string): Promise<DocumentLink[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('document_links')
    .select('*')
    .eq('model_id', modelId)
    .eq('record_id', recordId)
    .order('created_at', { ascending: false });
  if (error) throw surfaceError('list record documents', error);
  return (data ?? []) as DocumentLink[];
}

export async function addDocumentLink(fileId: string, modelId: string, recordId: string): Promise<DocumentLink> {
  if (!supabase) throw surfaceError('link record', new Error('Supabase not configured'));
  const appUserId = useAppStore.getState().currentUserId;
  if (!appUserId) throw surfaceError('link record', new Error('Not signed in'));
  const { data, error } = await supabase
    .from('document_links')
    .upsert(
      { file_id: fileId, model_id: modelId, record_id: recordId, created_by_user_id: appUserId },
      { onConflict: 'file_id,model_id,record_id' },
    )
    .select('*')
    .single();
  if (error || !data) throw surfaceError('link record', error ?? new Error('insert returned no row'));
  return data as DocumentLink;
}

export async function removeDocumentLink(linkId: string): Promise<void> {
  if (!supabase) throw surfaceError('unlink record', new Error('Supabase not configured'));
  const { error } = await supabase.from('document_links').delete().eq('id', linkId);
  if (error) throw surfaceError('unlink record', error);
}

// ─── Record title heuristic ──────────────────────────────────────────────
// Slugs that conventionally carry a record's human name across the live
// models (clients.client_name, all_projects.project_name, ...). Probed in
// order before falling back to the first non-empty text field.
const TITLE_SLUGS = [
  'client_name',
  'project_name',
  'full_name',
  'name',
  'title',
  'label',
  'unit_number',
  'unit_name',
];

/** Best-effort display title for a record. Never returns empty — falls back
 *  to the model label + short id so the UI always has something clickable. */
export function recordTitle(model: AppModel | undefined, record: AppRecord, isAr: boolean): string {
  const data = record.data ?? {};
  for (const slug of TITLE_SLUGS) {
    const v = data[slug];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  if (model) {
    const textField = model.schema.sections
      .flatMap((s: AppModel['schema']['sections'][number]) => s.fields)
      .find((f: AppModel['schema']['sections'][number]['fields'][number]) => {
        if (f.type !== 'text') return false;
        const v = data[f.name];
        return typeof v === 'string' && v.trim().length > 0;
      });
    if (textField) return String(data[textField.name]).trim();
    const label = isAr ? model.label_ar : model.label_en;
    return `${label} · ${record.id.slice(0, 8)}`;
  }
  return record.id.slice(0, 8);
}

/** Models offered in the link picker: every normal data model. Custom-UI
 *  surfaces (chats, AI conversations, migrations...) aren't linkable —
 *  their records aren't business entities a document belongs to. */
const NON_LINKABLE = new Set([
  'chats',
  'ai_chats',
  'copywriter_chats',
  'image_chats',
  'data_migration',
]);

export function linkableModels(models: AppModel[]): AppModel[] {
  return models.filter((m) => !NON_LINKABLE.has(m.name));
}
