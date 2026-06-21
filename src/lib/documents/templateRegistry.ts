/**
 * Document template registry — binds a Wassel document (kind='wassel_doc') to a
 * record model so a record's "Generate document" action can find its official
 * template(s). Templates are authored/edited/versioned in the normal Documents
 * editor; this is just the binding + key/label/default metadata.
 *
 * RLS: SELECT is open to all authenticated users (templates are company forms);
 * writes are admin-only (see the document_templates migration). All DB access
 * goes through this lib — never directly in components.
 */

import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';

export interface DocumentTemplateBinding {
  id: string;
  file_id: string;
  model_id: string;
  template_key: string;
  label_ar: string;
  label_en: string;
  is_default: boolean;
  is_active: boolean;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
}

function surfaceError(scope: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[doc-templates] ${scope} failed:`, err);
  try {
    useAppStore.getState().addToast(`${scope}: ${msg}`, 'error');
  } catch {
    // Pre-init — toast queue not ready. console.error above is still loud.
  }
  return new Error(msg);
}

/** Active templates bound to a model, default first. Drives the record-form
 *  Generate panel — returns [] when the model has none (panel renders nothing). */
export async function listTemplatesForModel(modelId: string): Promise<DocumentTemplateBinding[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('document_templates')
    .select('*')
    .eq('model_id', modelId)
    .eq('is_active', true)
    .order('is_default', { ascending: false })
    .order('label_ar', { ascending: true });
  if (error) throw surfaceError('list templates', error);
  return (data ?? []) as DocumentTemplateBinding[];
}

/** Every template (management page). RLS shows active to everyone, archived to
 *  admins; the page is admin-gated so admins see the full set. */
export async function listTemplates(): Promise<DocumentTemplateBinding[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('document_templates')
    .select('*')
    .order('model_id', { ascending: true })
    .order('label_ar', { ascending: true });
  if (error) throw surfaceError('list templates', error);
  return (data ?? []) as DocumentTemplateBinding[];
}

/** The binding for a given template document, or null if the doc isn't a
 *  registered template. Lets the editor switch to template-token mode. */
export async function getTemplateBinding(fileId: string): Promise<DocumentTemplateBinding | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('document_templates')
    .select('*')
    .eq('file_id', fileId)
    .maybeSingle();
  if (error) throw surfaceError('load template binding', error);
  return (data as DocumentTemplateBinding) ?? null;
}

export interface CreateTemplateInput {
  fileId: string;
  modelId: string;
  templateKey: string;
  labelAr: string;
  labelEn: string;
  isDefault?: boolean;
}

export async function createTemplateBinding(input: CreateTemplateInput): Promise<DocumentTemplateBinding> {
  if (!supabase) throw surfaceError('create template', new Error('Supabase not configured'));
  const appUserId = useAppStore.getState().currentUserId;
  if (!appUserId) throw surfaceError('create template', new Error('Not signed in'));

  // Insert non-default first; promoting to default is a separate step so the
  // one-default-per-model partial unique index can never be violated.
  const { data, error } = await supabase
    .from('document_templates')
    .insert({
      file_id: input.fileId,
      model_id: input.modelId,
      template_key: input.templateKey,
      label_ar: input.labelAr,
      label_en: input.labelEn,
      is_default: false,
      created_by_user_id: appUserId,
    })
    .select('*')
    .single();
  if (error || !data) throw surfaceError('create template', error ?? new Error('insert returned no row'));
  const row = data as DocumentTemplateBinding;
  if (input.isDefault) {
    await setDefaultTemplate(input.modelId, row.id);
    row.is_default = true;
  }
  return row;
}

export async function updateTemplateBinding(
  id: string,
  patch: Partial<Pick<DocumentTemplateBinding, 'label_ar' | 'label_en' | 'template_key' | 'model_id' | 'is_active'>>,
): Promise<DocumentTemplateBinding> {
  if (!supabase) throw surfaceError('update template', new Error('Supabase not configured'));
  const { data, error } = await supabase
    .from('document_templates')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error || !data) throw surfaceError('update template', error ?? new Error('update returned no row'));
  return data as DocumentTemplateBinding;
}

/** Make `templateId` the model's default — clears any existing default first so
 *  the partial unique index (one default per model) is never violated. */
export async function setDefaultTemplate(modelId: string, templateId: string): Promise<void> {
  if (!supabase) throw surfaceError('set default template', new Error('Supabase not configured'));
  const now = new Date().toISOString();
  const { error: clearErr } = await supabase
    .from('document_templates')
    .update({ is_default: false, updated_at: now })
    .eq('model_id', modelId)
    .eq('is_default', true);
  if (clearErr) throw surfaceError('set default template', clearErr);
  const { error: setErr } = await supabase
    .from('document_templates')
    .update({ is_default: true, updated_at: now })
    .eq('id', templateId);
  if (setErr) throw surfaceError('set default template', setErr);
}

/** Remove a template binding. By default keeps the underlying wassel_doc (a
 *  mis-click shouldn't destroy a hand-built template); pass alsoDeleteDoc to
 *  delete the document too (CASCADE removes the binding). */
export async function deleteTemplateBinding(
  id: string,
  opts: { alsoDeleteDoc?: boolean } = {},
): Promise<void> {
  if (!supabase) throw surfaceError('delete template', new Error('Supabase not configured'));
  if (opts.alsoDeleteDoc) {
    const { data: row, error: readErr } = await supabase
      .from('document_templates')
      .select('file_id')
      .eq('id', id)
      .maybeSingle();
    if (readErr) throw surfaceError('delete template', readErr);
    const fileId = (row as { file_id?: string } | null)?.file_id;
    if (fileId) {
      // Deleting the files row CASCADEs to wassel_documents + document_templates.
      const { error: delErr } = await supabase.from('files').delete().eq('id', fileId);
      if (delErr) throw surfaceError('delete template', delErr);
      return;
    }
  }
  const { error } = await supabase.from('document_templates').delete().eq('id', id);
  if (error) throw surfaceError('delete template', error);
}
