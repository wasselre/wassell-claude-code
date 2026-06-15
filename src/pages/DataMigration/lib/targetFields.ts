import type { AppModel, ModelField } from '@/types';
import type { StandardizableType } from './types';

/**
 * Field types the importer (`mapImportedRows`) can actually write from a flat
 * cell. Everything else (mirror / formula / auto_id / notes / file refs / table
 * / assignee / history) is derived, generated, or structural — never a mapping
 * target. Matches the writable set in src/lib/excelUtils.ts.
 */
const IMPORTABLE_TYPES = new Set<string>([
  'text', 'textarea', 'email', 'phone', 'url',
  'number', 'currency', 'date', 'datetime', 'checkbox',
  'dropdown', 'multiselect', 'section_selector', 'lookup', 'range',
]);

const STANDARDIZABLE_TYPES = new Set<string>(['dropdown', 'multiselect', 'lookup']);

export function importableFields(model: AppModel): ModelField[] {
  // Rollup fields (is_rollup, the all_projects unit-derived ranges/counts) are
  // stored aggregates maintained by a DB trigger — an imported value would be
  // overwritten by the trigger, so they are neither mapping targets nor part of
  // the extraction hunt-list. (The legacy is_computed alias is still honored.)
  return model.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => IMPORTABLE_TYPES.has(f.type) && !(f.is_rollup ?? f.is_computed));
}

/** Mapping-target options for the column→field selects. Range fields expose two
 * entries (`slug.min` / `slug.max`) so each half maps to its own column —
 * mirrors ImportModal's mappingOptions. */
export function mappingTargets(model: AppModel, isAr: boolean): { value: string; label: string }[] {
  return importableFields(model).flatMap((f) => {
    const base = isAr ? f.label_ar : f.label_en;
    if (f.type === 'range') {
      return [
        { value: `${f.name}.min`, label: `${base} — ${isAr ? 'أدنى' : 'min'}` },
        { value: `${f.name}.max`, label: `${base} — ${isAr ? 'أعلى' : 'max'}` },
      ];
    }
    return [{ value: f.name, label: base }];
  });
}

/** DTO sent to /api/migrate (action=suggest_mappings). Ranges expand to two
 * numeric halves so the model can map min/max columns independently. */
export interface TargetFieldLite {
  name: string;
  label_ar: string;
  label_en: string;
  type: string;
  required: boolean;
}

export function targetFieldLites(model: AppModel): TargetFieldLite[] {
  return importableFields(model).flatMap((f): TargetFieldLite[] => {
    if (f.type === 'range') {
      return [
        { name: `${f.name}.min`, label_ar: `${f.label_ar} (أدنى)`, label_en: `${f.label_en} (min)`, type: 'number', required: false },
        { name: `${f.name}.max`, label_ar: `${f.label_ar} (أعلى)`, label_en: `${f.label_en} (max)`, type: 'number', required: false },
      ];
    }
    return [{ name: f.name, label_ar: f.label_ar, label_en: f.label_en, type: f.type, required: f.required }];
  });
}

/** Resolve a mapping value (`slug` or `slug.min`/`slug.max`) to its field. */
export function fieldByMappingValue(model: AppModel, mappingValue: string): ModelField | undefined {
  const dot = mappingValue.indexOf('.');
  const slug = dot === -1 ? mappingValue : mappingValue.slice(0, dot);
  return model.schema.sections.flatMap((s) => s.fields).find((f) => f.name === slug);
}

export interface StandardizableColumn {
  colIndex: number;
  field: ModelField;
  fieldType: StandardizableType;
}

/** Columns whose mapped field is dropdown / multiselect / lookup — the ones
 * the value-standardization step reviews. Range halves (.min/.max) are numeric
 * and never standardizable. */
export function standardizableColumns(
  model: AppModel,
  mappings: Record<number, string | null>,
): StandardizableColumn[] {
  const out: StandardizableColumn[] = [];
  for (const [colStr, mapped] of Object.entries(mappings)) {
    if (!mapped || mapped.includes('.')) continue; // ranges aren't standardizable
    const field = model.schema.sections.flatMap((s) => s.fields).find((f) => f.name === mapped);
    if (field && STANDARDIZABLE_TYPES.has(field.type)) {
      out.push({ colIndex: Number(colStr), field, fieldType: field.type as StandardizableType });
    }
  }
  return out.sort((a, b) => a.colIndex - b.colIndex);
}

/**
 * Distinct non-empty raw values in a column, with occurrence counts (desc).
 * When `multi` is true (multiselect, or multi-value lookup) each cell is split
 * on `,` / `،` and the TOKENS are counted — so standardization operates on the
 * individual values, exactly as `mapImportedRows` splits them at import time.
 */
export function distinctColumnValues(
  rows: string[][],
  colIndex: number,
  multi = false,
): { raw: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const cell = (row[colIndex] ?? '').trim();
    if (!cell) continue;
    const tokens = multi ? cell.split(/[,،]/).map((t) => t.trim()).filter(Boolean) : [cell];
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([raw, count]) => ({ raw, count })).sort((a, b) => b.count - a.count);
}

/** Whether a column's distinct values should be tokenized (multiselect, or a
 * multi-value lookup). */
export function isMultiValueColumn(field: ModelField): boolean {
  return field.type === 'multiselect' || (field.type === 'lookup' && !!field.is_multi);
}
