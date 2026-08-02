/**
 * Unified display resolver (bilingual W3).
 *
 * ONE call for every render site: `resolveFieldDisplay(entityId, fieldPath,
 * raw, lang, meta)`.
 *
 *  - With an entity id: authoritative record-scoped lookup against the
 *    translation_variants store. Hit → the stored translation. Hydrated
 *    miss → the SOURCE text (pending honesty — never a text-keyed guess,
 *    REV 4 §D4: the new path has no legacy fallback).
 *  - Without an entity id (transition surfaces that haven't threaded record
 *    ids yet): the legacy text-keyed overlay keeps working until each surface
 *    migrates. Removing that path entirely is the last W3 cleanup step.
 *
 * Re-rendering: components subscribe via useFieldDisplayVersion() which
 * combines both stores' version counters.
 */

import { useRecordTranslationVersion, getEntityFieldText } from './store';
import { resolveDisplayText, useValueTranslationVersion } from '@/lib/valueTranslation/runtime';
import type { ValueTranslationKind } from '@/lib/valueTranslation/config';

type Lang = 'ar' | 'en';

const ARABIC_RE = /[؀-ۿ]/;

export interface FieldDisplayMeta {
  kind?: ValueTranslationKind;
  field_hint?: string;
}

/** Does this raw value even need cross-language resolution for `lang`? */
function needsResolution(text: string, lang: Lang): boolean {
  if (lang === 'en') return ARABIC_RE.test(text);
  return !ARABIC_RE.test(text) && /[A-Za-z]{2}/.test(text);
}

export function resolveFieldDisplay(
  entityId: string | undefined,
  fieldPath: string,
  raw: unknown,
  lang: Lang,
  meta?: FieldDisplayMeta,
): string {
  if (raw == null) return '';
  const text = typeof raw === 'string' ? raw : String(raw);
  const trimmed = text.trim();
  if (trimmed === '' || !needsResolution(trimmed, lang)) return text;

  if (entityId) {
    const hit = getEntityFieldText(entityId, fieldPath, lang);
    return hit ?? text;
  }
  // Transition-only: surfaces without a record id still use the legacy
  // text-keyed overlay.
  return resolveDisplayText(text, lang, { kind: meta?.kind, field_hint: meta?.field_hint ?? fieldPath });
}

/** Subscribe a component to BOTH translation stores' arrivals. */
export function useFieldDisplayVersion(): number {
  const a = useRecordTranslationVersion();
  const b = useValueTranslationVersion();
  return a * 1_000_003 + b;
}
