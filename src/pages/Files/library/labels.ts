/**
 * Phase 3 · B5 — how the Library turns stored values into words.
 *
 * Four different vocabularies reach the screen and they resolve differently:
 *
 *   document_type   → `file_document_types`, which carries label_ar/label_en.
 *                     A value with no row (deactivated, or added by a
 *                     migration a stale client has not seen) falls back to the
 *                     raw value rather than to blank.
 *   status / origin /
 *   confidentiality → fixed enumerations, translated through i18n.
 *   owner           → `users`, from the store.
 *   linked model    → `models`, from the store, which already carries both
 *                     labels.
 *
 * Everything here takes `t` or `isAr` explicitly instead of calling a hook, so
 * these stay plain functions usable from sorting comparators and grouping keys
 * as well as from render.
 */
import type { TFunction } from 'i18next';
import type { AppModel, FileDocumentTypeRow, User } from '@/types';

/**
 * Two roles are NOT document types and never appear in `file_document_types`:
 *
 *   attachment — the reserved role-NEUTRAL sentinel. The legacy
 *                `files.record_id` column proves a file is *associated* with a
 *                record and nothing more, so Phase 1 refuses to invent a role
 *                for it. 564 edges carry it on production.
 *   unmapped   — an unrecognised (model, field) pair, named explicitly rather
 *                than swallowed, so reconciliation can report it.
 *
 * Both reach the UI as `file_links.role` and both need words. Without these the
 * panel printed the raw slug — and, under the section heading's `uppercase`,
 * rendered "ATTACHMENT" on an Arabic page. Adding them to the vocabulary table
 * instead would be wrong: they would then be offered in the "link as" picker as
 * though a person could choose them, which is exactly what they are not.
 */
const ROLE_SENTINELS: Record<string, { ar: string; en: string }> = {
  attachment: { ar: 'مرفق بالسجل', en: 'Attached to the record' },
  unmapped: { ar: 'حقل غير معرّف', en: 'Unrecognised field' },
};

export function documentTypeLabel(
  value: string,
  types: FileDocumentTypeRow[],
  isAr: boolean,
): string {
  const row = types.find((t) => t.value === value);
  if (row) return isAr ? row.label_ar : row.label_en;
  const sentinel = ROLE_SENTINELS[value];
  if (sentinel) return isAr ? sentinel.ar : sentinel.en;
  // A genuinely unknown value renders as itself — ugly, but true, and it names
  // the thing a reader needs in order to go and look it up.
  return value;
}

export function statusLabel(value: string, t: TFunction): string {
  return t(`files.library.status.${value}`, { defaultValue: value });
}

export function originLabel(value: string, t: TFunction): string {
  return t(`files.library.origin.${value}`, { defaultValue: value });
}

export function confidentialityLabel(value: string, t: TFunction): string {
  return t(`files.library.conf.${value}`, { defaultValue: value });
}

export function ownerLabel(userId: string, users: User[], isAr: boolean): string {
  const u = users.find((x) => x.id === userId);
  if (!u) return userId.slice(0, 8);
  return (isAr ? u.name_ar : u.name_en) || u.email || userId.slice(0, 8);
}

export function modelLabel(name: string, models: AppModel[], isAr: boolean): string {
  const m = models.find((x) => x.name === name);
  if (!m) return name;
  return (isAr ? m.label_ar : m.label_en) || name;
}

/** `2026-08` → a readable month, used by the month grouping. Built from the
 *  active language so the Arabic view reads as Arabic. */
export function monthLabel(key: string, isAr: boolean): string {
  const [y, m] = key.split('-');
  const year = Number(y);
  const month = Number(m);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return key;
  const d = new Date(Date.UTC(year, month - 1, 1));
  return d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/** A date as the Library shows it: short, unambiguous, and locale-correct. */
export function shortDate(iso: string | null, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}
