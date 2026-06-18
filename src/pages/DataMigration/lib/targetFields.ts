import type { AppModel, ModelField } from '@/types';
import { splitMultiValue } from '@/lib/textMatch';
import { NON_TARGET_MODEL_NAMES, type StandardizableType } from './types';

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
  // the extraction hunt-list.
  return model.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => IMPORTABLE_TYPES.has(f.type) && !f.is_rollup);
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
    const tokens = multi ? splitMultiValue(cell) : [cell];
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].map(([raw, count]) => ({ raw, count })).sort((a, b) => b.count - a.count);
}

/** Whether a column's distinct values should be tokenized (multiselect, or a
 * multi-value lookup). */
export function isMultiValueColumn(field: ModelField): boolean {
  return field.type === 'multiselect' || (field.type === 'lookup' && !!field.is_multi);
}

/**
 * Can the migrator create a NEW record in this lookup field's target model?
 * Returns null when it's safe, or a human reason when blocked — the single
 * source of truth shared by the record builder (to mark rows invalid) and the
 * standardization UI (to warn before the user picks "create new"). Creation is
 * blocked when the target is a custom-UI/system model that can't take generic
 * records, or when it has REQUIRED fields beyond the display field that we
 * can't fill safely from a single raw value (would mint an invalid record).
 *
 * Frozen targets are NOT blocked here — `record_save` dispatches frozen writes
 * fine; only un-fillable required fields matter.
 */
export function lookupCreateBlockReason(
  field: ModelField,
  allModels: AppModel[],
  isAr: boolean,
): string | null {
  const targetModel = allModels.find((m) => m.id === field.lookup_model_id);
  if (!targetModel) return isAr ? 'النموذج المرتبط غير موجود' : 'Linked model not found';
  if (NON_TARGET_MODEL_NAMES.has(targetModel.name)) {
    return isAr
      ? `لا يمكن إنشاء سجلات في ${targetModel.label_ar} تلقائيًا`
      : `Records can't be auto-created in ${targetModel.label_en}`;
  }
  const disp = field.lookup_display_field;
  if (!disp) return isAr ? 'لا يوجد حقل عرض للنموذج المرتبط' : 'Linked model has no display field';
  const missing = importableFields(targetModel).filter((f) => f.required && f.name !== disp);
  if (missing.length > 0) {
    const names = missing.map((f) => (isAr ? f.label_ar : f.label_en)).join('، ');
    return isAr
      ? `يتطلب ${targetModel.label_ar} حقولًا إلزامية لا يمكن تعبئتها: ${names}`
      : `${targetModel.label_en} requires fields we can't fill: ${names}`;
  }
  return null;
}
