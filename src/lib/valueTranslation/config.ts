/**
 * Which record fields participate in automatic value translation, and how.
 *
 * Keep the eligibility rules in sync with `value_translation_candidates` in
 * supabase/migrations/2026-07-31_value_translations.sql (the backfill's view
 * of the same question).
 *
 * Fields whose slug ends in _ar/_en are bilingual BY DESIGN (each side is
 * authored) — never overlay-translate those.
 */

import type { ModelField } from '@/types';

const BILINGUAL_BY_DESIGN_RE = /_(ar|en)$/;

/** 'name' → transliterate (proper nouns); 'text' → natural translation. */
export type ValueTranslationKind = 'name' | 'text';

type FieldLike = Pick<ModelField, 'type' | 'name'>;

/** True when this field's free-typed values should display translated. */
export function isTranslatableField(field: FieldLike): boolean {
  if (field.type !== 'text' && field.type !== 'textarea' && field.type !== 'notes') return false;
  return !BILINGUAL_BY_DESIGN_RE.test(field.name);
}

const NAME_SLUG_RE = /(^|_)(name|title|block|model|project|developer|client)/;

/** Proper-noun fields transliterate; everything else translates. */
export function kindForField(field: FieldLike): ValueTranslationKind {
  if (field.type !== 'text') return 'text';
  return NAME_SLUG_RE.test(field.name) ? 'name' : 'text';
}
