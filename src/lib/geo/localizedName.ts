/**
 * THE localization contract for Saudi geography proper nouns.
 *
 * CORE PRINCIPLE (Issue #8): the database decides; AI writes around the facts.
 * No model may invent, translate, transliterate or "improve" a region, city or
 * district name when an authoritative localized value exists — and one always
 * does: every one of the 13 regions / 152 cities / 3,733 districts stores both
 * `name_ar` and `name_en` (verified 100% populated, 2026-07-19).
 *
 * WHY THIS MODULE EXISTS
 * Seven independent resolvers had each collapsed a trilingual record to ONE
 * Arabic string via `display_name ?? name_ar` — and because `display_name` is
 * Arabic and never null for cities/districts, the `name_en` branch (where it
 * existed at all) was dead code. Downstream, that Arabic string was either fed
 * to an LLM asked for English (→ invented transliterations; «حي المهدية» was
 * rendered "Al-Muharraq", a city in Bahrain, in a customer WhatsApp message) or
 * copied verbatim into an English body.
 *
 * RUNTIME REACH
 * This file is the CANONICAL implementation and is imported directly by both
 * `src/**` (SPA) and `api/**` (Vercel functions) — `tsconfig.api.json` covers
 * both and `api/_lib/analyticsRun.ts` sets the cross-import precedent.
 * Three runtimes cannot import it and carry documented adapters that MUST
 * satisfy the same conformance fixtures (`geoLocalizationFixtures.ts`):
 *   - `worker/src/lib/localizedName.ts`              (standalone npm pkg, rootDir:src)
 *   - `supabase/functions/_shared/localizedName.ts`  (Deno)
 *   - `Wassel Website/js/localized-name.js`          (separate repo, vanilla JS)
 * Change this file → change all three. Never add an eighth ad-hoc resolver.
 */

/** A fully-localized proper noun. Every field is non-empty by construction. */
export interface LocalizedName {
  /** The geography record id. NEVER put this in an LLM prompt or user-visible output. */
  id: string;
  /** Arabic form — `display_name ?? name_ar`, whitespace-normalized. */
  ar: string;
  /** Canonical English exactly as stored in `name_en` (whitespace-normalized only). */
  enCanonical: string;
  /** Presentation English — `enCanonical` minus a trailing "Dist."/"District". */
  enDisplay: string;
}

/** Why a record could not be fully localized. Callers must handle this explicitly. */
export type LocalizationFailure =
  | 'missing_record'
  | 'missing_arabic'
  | 'missing_english';

/**
 * Collapse whitespace runs and trim. Deterministic and idempotent.
 * Needed because stored names are not perfectly clean — e.g. the district
 * "Asharai  Dist." carries a double space in production.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Presentation English: strip a trailing administrative suffix.
 *
 * ONLY at the very end of the string, and ONLY these forms. "District Cooling
 * Plant" or a mid-string "District" is left alone. The canonical DB value is
 * never modified — this is a display transform applied to a copy.
 */
export function toEnglishDisplay(enCanonical: string): string {
  const normalized = normalizeWhitespace(enCanonical);
  const stripped = normalized.replace(/[\s,]*\b(?:Dist\.|District)\s*$/i, '');
  const result = normalizeWhitespace(stripped);
  // Never return an empty display name — a name that IS "District" stays as-is.
  return result || normalized;
}

/** Read a string field, treating blank/non-string as absent. */
function str(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === 'string' && v.trim() ? normalizeWhitespace(v) : null;
}

/**
 * Resolve ONE geography record to its localized names.
 *
 * Returns `null` when the record cannot be FULLY localized. Callers that need
 * English MUST handle null explicitly and MUST NOT substitute the Arabic value
 * — silently rendering Arabic under an English label is the exact defect this
 * module exists to prevent. Use `resolveArabicName` when Arabic alone is
 * legitimately sufficient (an Arabic-only output surface).
 *
 * `regions` records carry no `display_name` at all (0/13 in production), so the
 * `display_name ?? name_ar` order handles all three levels uniformly.
 */
export function resolveLocalizedName(
  id: string | null | undefined,
  data: Record<string, unknown> | null | undefined,
): LocalizedName | null {
  if (!id || !data) return null;
  const ar = str(data, 'display_name') ?? str(data, 'name_ar');
  const enCanonical = str(data, 'name_en');
  if (!ar || !enCanonical) return null;
  return { id, ar, enCanonical, enDisplay: toEnglishDisplay(enCanonical) };
}

/**
 * Same as `resolveLocalizedName` but reports WHY resolution failed, for callers
 * that need to log a specific, actionable diagnostic instead of a bare null.
 */
export function diagnoseLocalizedName(
  id: string | null | undefined,
  data: Record<string, unknown> | null | undefined,
): { ok: true; value: LocalizedName } | { ok: false; reason: LocalizationFailure } {
  if (!id || !data) return { ok: false, reason: 'missing_record' };
  const ar = str(data, 'display_name') ?? str(data, 'name_ar');
  if (!ar) return { ok: false, reason: 'missing_arabic' };
  const enCanonical = str(data, 'name_en');
  if (!enCanonical) return { ok: false, reason: 'missing_english' };
  return { ok: true, value: { id, ar, enCanonical, enDisplay: toEnglishDisplay(enCanonical) } };
}

/** Arabic-only resolution, for surfaces that legitimately never render English. */
export function resolveArabicName(
  data: Record<string, unknown> | null | undefined,
): string | null {
  if (!data) return null;
  return str(data, 'display_name') ?? str(data, 'name_ar');
}

/** Pick the right rendering for a UI/message language. */
export function pickLocalized(name: LocalizedName, isArabic: boolean): string {
  return isArabic ? name.ar : name.enDisplay;
}

/**
 * Guard: true when a string looks like a bare UUID.
 *
 * Geography ids must never reach an LLM prompt or user-visible output — the
 * `project-details-ai-v2` edge function was passing raw `location` UUIDs to the
 * model, which then fabricated landmarks around a location it could not read.
 */
export function looksLikeUuid(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
  );
}

/** Deep scan for any UUID-looking value — used by tests and prompt-build guards. */
export function containsUuid(value: unknown): boolean {
  if (looksLikeUuid(value)) return true;
  if (Array.isArray(value)) return value.some(containsUuid);
  if (value && typeof value === 'object') return Object.values(value).some(containsUuid);
  return false;
}
