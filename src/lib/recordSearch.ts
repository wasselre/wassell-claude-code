import type { AppModel, AppRecord, ModelField } from '@/types';
import { resolveLookupDisplayValue } from './mirrorResolver';

/**
 * Convert Arabic-Indic (٠-٩, U+0660–U+0669) and Extended / Persian Arabic-Indic
 * (۰-۹, U+06F0–U+06F9) digits to ASCII 0-9 so a query typed in one digit script
 * matches data stored in the other — e.g. typing "١٤" matches "14".
 */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x30))
    .replace(/[۰-۹]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x06F0 + 0x30));
}

/** Lowercase + digit-normalize, for case- and digit-script-insensitive matching. */
export function normalizeForSearch(input: string): string {
  return normalizeDigits(input).toLowerCase();
}

export interface RecordSearchContext {
  models: AppModel[];
  records: Record<string, AppRecord[]>;
}

/**
 * Build a single searchable string for a record spanning ALL of its fields —
 * not just text/email/phone. Resolves the human-readable value wherever the
 * stored value differs from what the user sees:
 *   - dropdown / multiselect / section_selector → option labels (ar + en) + slug
 *   - lookup → the linked record's display value (mirror-aware)
 *   - range → "min max"
 *   - checkbox → نعم/لا + yes/no
 *   - table → every cell's text; notes → each entry's text
 *   - everything else (text / number / currency / date / auto_id / …) → stringified
 *
 * Callers normalize the result (and the query) with {@link normalizeForSearch}
 * and substring-match. Resolving lookups is O(linked-model rows); build this once
 * per record and reuse across keystrokes rather than calling it inside a filter.
 */
export function buildRecordSearchText(
  record: AppRecord,
  model: AppModel,
  ctx: RecordSearchContext,
): string {
  const data = record.data as Record<string, unknown>;
  const parts: string[] = [];
  for (const section of model.schema.sections) {
    for (const field of section.fields) {
      const v = data[field.name];
      if (v === null || v === undefined || v === '') continue;
      collectFieldSearchParts(field, v, ctx, parts);
    }
  }
  return parts.join(' ');
}

function collectFieldSearchParts(
  field: ModelField,
  v: unknown,
  ctx: RecordSearchContext,
  out: string[],
): void {
  switch (field.type) {
    case 'dropdown': {
      out.push(String(v));
      const opt = (field.options ?? []).find((o) => o.value === v);
      if (opt) out.push(opt.label_ar, opt.label_en);
      return;
    }
    case 'multiselect':
    case 'section_selector': {
      const arr = Array.isArray(v) ? v : [v];
      for (const val of arr) {
        out.push(String(val));
        const opt = (field.options ?? []).find((o) => o.value === val);
        if (opt) out.push(opt.label_ar, opt.label_en);
      }
      return;
    }
    case 'lookup': {
      if (!field.lookup_model_id || !field.lookup_display_field) return;
      const targetModel = ctx.models.find((m) => m.id === field.lookup_model_id);
      const targets = ctx.records[field.lookup_model_id] ?? [];
      const ids = Array.isArray(v) ? v : [v];
      for (const id of ids) {
        const target = targets.find((r) => r.id === id);
        if (!target) continue;
        const disp = resolveLookupDisplayValue(target, field.lookup_display_field, {
          targetModel: targetModel ?? undefined,
          allModels: ctx.models,
          allRecords: ctx.records,
        });
        if (disp !== null && disp !== undefined && disp !== '') out.push(String(disp));
      }
      return;
    }
    case 'range': {
      if (v && typeof v === 'object') {
        const r = v as { min?: unknown; max?: unknown };
        if (r.min !== undefined && r.min !== null) out.push(String(r.min));
        if (r.max !== undefined && r.max !== null) out.push(String(r.max));
      } else {
        out.push(String(v));
      }
      return;
    }
    case 'checkbox':
      out.push(v ? 'نعم' : 'لا', v ? 'yes' : 'no');
      return;
    case 'table': {
      if (Array.isArray(v)) {
        for (const row of v) {
          if (row && typeof row === 'object') {
            for (const cell of Object.values(row as Record<string, unknown>)) {
              if (cell !== null && cell !== undefined && cell !== '' && typeof cell !== 'object') {
                out.push(String(cell));
              }
            }
          }
        }
      }
      return;
    }
    case 'notes': {
      if (Array.isArray(v)) {
        for (const e of v) {
          if (e && typeof e === 'object' && 'text' in (e as object)) {
            out.push(String((e as { text?: unknown }).text ?? ''));
          } else if (typeof e !== 'object') {
            out.push(String(e));
          }
        }
      } else if (typeof v !== 'object') {
        out.push(String(v));
      }
      return;
    }
    case 'multi_link': {
      const arr = Array.isArray(v) ? v : [v];
      for (const u of arr) if (typeof u !== 'object') out.push(String(u));
      return;
    }
    default: {
      // text / email / phone / url / textarea / number / currency / formula /
      // auto_id / date / datetime / assignee / etc. — stringify scalars; skip
      // unknown object shapes (no meaningful text to search).
      if (typeof v !== 'object') out.push(String(v));
    }
  }
}
