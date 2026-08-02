/**
 * Localized form-editing contract (bilingual W3b, REV 4 §B10/§5c).
 *
 * The form shows ONE input per field, in the user's language. What a commit
 * MEANS depends on what the input was showing when editing began (the BASIS):
 *
 *   basis 'source'          → normal source edit (draft onChange; capture
 *                             trigger regenerates translations on save)
 *   basis 'translation'     → target-side CORRECTION: routed to the
 *                             record_translation_human_edit RPC; the stored
 *                             source is NEVER touched, and the edited text
 *                             becomes a human-owned translation the machine
 *                             will not overwrite
 *   basis 'pending_source'  → the user is looking at raw source in the
 *                             opposite language (no translation yet): edits
 *                             are source edits (they're editing the real value)
 *
 * The invariant that must never break (REV 4 blocker 6): an UNCHANGED
 * localized display is never written back as source — `commitKind` returns
 * 'none' when the text equals the basis, so the draft is untouched.
 */

import { supabase } from '@/lib/supabase';
import { getEntityFieldText, invalidateEntityTranslations } from './store';

export type Lang = 'ar' | 'en';
export type BasisKind = 'source' | 'translation' | 'pending_source';

export interface EditingBasis {
  kind: BasisKind;
  /** Exactly what the input displayed when editing began. */
  shownText: string;
  /** The underlying stored source value (what records.data holds). */
  sourceText: string;
}

const ARABIC_RE = /[؀-ۿ]/;

function scriptOf(text: string): Lang | null {
  if (ARABIC_RE.test(text)) return 'ar';
  if (/[A-Za-z]{2}/.test(text)) return 'en';
  return null;
}

/**
 * Decide what the input should display and what editing it means.
 * Pure given the store lookup — unit-tested in editingBasis.test.ts.
 */
export function computeBasis(
  entityId: string | undefined,
  fieldPath: string,
  sourceValue: string,
  uiLang: Lang,
  lookup: (entityId: string, fieldPath: string, lang: Lang) => string | null = getEntityFieldText,
): EditingBasis {
  const source = sourceValue ?? '';
  const srcScript = scriptOf(source.trim());
  // Same-language (or scriptless) value: the input IS the source.
  if (!entityId || srcScript === null || srcScript === uiLang) {
    return { kind: 'source', shownText: source, sourceText: source };
  }
  const translation = lookup(entityId, fieldPath, uiLang);
  if (translation) {
    return { kind: 'translation', shownText: translation, sourceText: source };
  }
  return { kind: 'pending_source', shownText: source, sourceText: source };
}

export type CommitKind = 'none' | 'source_edit' | 'translation_correction';

/** What does committing `currentText` against `basis` mean? */
export function commitKind(basis: EditingBasis, currentText: string): CommitKind {
  if (currentText === basis.shownText) return 'none';
  if (basis.kind === 'translation') return 'translation_correction';
  return 'source_edit';
}

/**
 * Apply a translation correction via the authz'd + generation-CAS'd RPC.
 * Throws on failure (callers toast); 'source_changed' means the record moved
 * under the editor — re-fetch and retry.
 */
export async function submitTranslationCorrection(
  entityId: string,
  fieldPath: string,
  lang: Lang,
  text: string,
): Promise<void> {
  if (!supabase) throw new Error('offline');
  // Fresh generation read — the CAS precondition for the edit.
  const { data: status, error: sErr } = await supabase.rpc('entity_translation_status', {
    p_kind: 'record', p_entity: entityId,
  });
  if (sErr) throw new Error(sErr.message);
  const row = (status ?? []).find(
    (r: { field_path: string; lang: string }) => r.field_path === fieldPath && r.lang === lang,
  );
  const generation = row?.unit_generation;
  if (generation == null) throw new Error('translation unit not found — save the record first');

  const { error } = await supabase.rpc('record_translation_human_edit', {
    p_kind: 'record', p_entity: entityId, p_path: fieldPath, p_lang: lang,
    p_text: text, p_expected_generation: generation,
  });
  if (error) throw new Error(error.message);
  invalidateEntityTranslations(entityId);
}

/**
 * "Rewrite as {lang} source": flips the unit's source language (locked,
 * role swap, generation bump — server-side) so the user's text becomes the
 * authoritative source on the next save and the opposite side regenerates.
 * Call BEFORE putting the text into the draft.
 */
export async function flipSourceLanguage(
  entityId: string,
  fieldPath: string,
  newSourceLang: Lang,
): Promise<void> {
  if (!supabase) throw new Error('offline');
  const { data: status, error: sErr } = await supabase.rpc('entity_translation_status', {
    p_kind: 'record', p_entity: entityId,
  });
  if (sErr) throw new Error(sErr.message);
  const row = (status ?? []).find((r: { field_path: string }) => r.field_path === fieldPath);
  const generation = row?.unit_generation;
  if (generation == null) throw new Error('translation unit not found');
  const { error } = await supabase.rpc('record_translation_set_source_lang', {
    p_kind: 'record', p_entity: entityId, p_path: fieldPath,
    p_lang: newSourceLang, p_expected_generation: generation,
  });
  if (error) throw new Error(error.message);
  invalidateEntityTranslations(entityId);
}
