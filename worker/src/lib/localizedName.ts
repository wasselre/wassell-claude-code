/**
 * WORKER COPY of src/lib/geo/localizedName.ts — the localization contract for
 * Saudi geography proper nouns.
 *
 * The worker is a standalone npm package (rootDir:src) and CANNOT import from
 * `src/**` (same posture as worker/src/imageGen.ts, worker/src/migrateAgent.ts,
 * worker/src/documents/*). This file is a straight port of the canonical
 * implementation and MUST satisfy the same conformance fixtures
 * (src/lib/geo/geoLocalizationFixtures.ts). Change the canonical file → change
 * this one. See the header of src/lib/geo/localizedName.ts for the full rationale.
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
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Presentation English: strip a trailing administrative suffix.
 */
export function toEnglishDisplay(enCanonical: string): string {
  const normalized = normalizeWhitespace(enCanonical);
  const stripped = normalized.replace(/[\s,]*\b(?:Dist\.|District)\s*$/i, '');
  const result = normalizeWhitespace(stripped);
  return result || normalized;
}

/** Read a string field, treating blank/non-string as absent. */
function str(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === 'string' && v.trim() ? normalizeWhitespace(v) : null;
}

/**
 * Resolve ONE geography record to its localized names. Returns `null` when the
 * record cannot be FULLY localized.
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
 * Same as `resolveLocalizedName` but reports WHY resolution failed.
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

/** Guard: true when a string looks like a bare UUID. */
export function looksLikeUuid(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
  );
}

/** Deep scan for any UUID-looking value. */
export function containsUuid(value: unknown): boolean {
  if (looksLikeUuid(value)) return true;
  if (Array.isArray(value)) return value.some(containsUuid);
  if (value && typeof value === 'object') return Object.values(value).some(containsUuid);
  return false;
}
