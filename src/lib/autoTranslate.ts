/**
 * Bilingual label utilities used by the Builder.
 *
 * IMPORTANT (changed 2026-05-10):
 *   The legacy stub used to copy the input as-is to the other language and
 *   produce `item_<timestamp>` slugs for any Arabic input — that's how
 *   models/sections/fields ended up with mismatched labels and gibberish
 *   slugs across the database (and even in our seed data).
 *
 *   This module no longer does that. The synchronous `slugify` only accepts
 *   Latin input; for non-Latin (Arabic) input it returns an empty string and
 *   the caller is expected to use the live translator (`translateLabel` /
 *   `useDebouncedTranslation`) which routes through `/api/translate` to get
 *   a real English-derived slug.
 */

/**
 * Latin-only synchronous slug. Returns an empty string for inputs that don't
 * contain ASCII letters — callers must use `translateLabel` to derive a slug
 * from non-Latin input.
 *
 * Use cases that remain valid for the sync version:
 *   - Auto-syncing the API name field as the user types Latin characters
 *   - Sanitizing manual API-name input
 *   - Slugifying values inside API-name overrides
 */
export function slugify(text: string): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  // No ASCII letters → caller must translate first.
  if (!/[a-zA-Z]/.test(trimmed)) return '';
  let slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!slug) return '';
  // snake_case slugs must start with a letter — prepend `f_` if a digit leads.
  if (!/^[a-z]/.test(slug)) slug = `f_${slug}`;
  return slug;
}

/**
 * Detect whether labels are out of sync (one language is just a copy of the
 * other, indicating the legacy stub or a manual mistake). Used by callers
 * that want to surface "needs translation" UI for legacy records.
 */
export function needsTranslation(labelAr: string, labelEn: string): boolean {
  if (!labelAr || !labelEn) return true;
  if (labelAr.trim() === labelEn.trim()) return true;
  // If both labels are in the same script, one is a copy of the other.
  const arLooksArabic = /[؀-ۿ]/.test(labelAr);
  const enLooksEnglish = /[A-Za-z]/.test(labelEn);
  return !(arLooksArabic && enLooksEnglish);
}
