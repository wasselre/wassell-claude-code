/**
 * Helpers for detecting how many records would be affected by a destructive
 * change to a model field (deletion, type change). Used to drive the Builder's
 * "this change affects N records, continue?" confirmation modals — our
 * minimum-safe guard against silent data loss for user-built models.
 *
 * These helpers intentionally DO NOT mutate anything — they only count. The
 * decision to proceed is made in the UI (with a user-confirmation) and the
 * actual mutation still goes through the regular Builder save path.
 */
import type { AppRecord } from '@/types';

/**
 * Count records whose `data[fieldName]` holds any meaningful value.
 * Treats `undefined`, `null`, empty string, and empty array as "no data."
 * Anything else — number 0 included — counts.
 */
export function countRecordsWithFieldData(
  modelId: string,
  fieldName: string,
  records: Record<string, AppRecord[]>,
): number {
  const rows = records[modelId] ?? [];
  let count = 0;
  for (const r of rows) {
    const v = r.data?.[fieldName];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    count++;
  }
  return count;
}

/**
 * Whether changing `fromType` to `toType` is likely to render existing
 * record values un-readable. Returns false for no-op or compatible changes
 * (e.g., text ↔ textarea, number ↔ currency), true for lossy changes
 * (text → dropdown, dropdown → number, anything → lookup).
 *
 * Conservative: when in doubt we return `true` so the user sees the
 * confirmation. Better to warn once too often than lose data silently.
 */
export function isTypeChangeLossy(fromType: string, toType: string): boolean {
  if (fromType === toType) return false;
  const COMPATIBLE_PAIRS = new Set<string>([
    // Free-text variants — values stay readable.
    'text|textarea',
    'textarea|text',
    'text|notes',
    'notes|text',
    'textarea|notes',
    'notes|textarea',
    // Numeric variants — values stay numeric-ish.
    'number|currency',
    'currency|number',
    // Date variants.
    'date|datetime',
    'datetime|date',
    // URL/email/phone are text-like.
    'text|email',
    'email|text',
    'text|url',
    'url|text',
    'text|phone',
    'phone|text',
  ]);
  return !COMPATIBLE_PAIRS.has(`${fromType}|${toType}`);
}
