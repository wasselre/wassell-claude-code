import type { AppModel, AppRecord, ModelField } from '@/types';
import type { ColumnStandardization, ValueDecision } from './types';

export interface AppliedStandardization {
  /** Rewritten + augmented rows (canonical values; routed values appended as
   * extra columns so they survive mapImportedRows' empty-row filtering). */
  rows: string[][];
  /** Column index → field slug, including the appended routed columns. */
  mappings: Record<number, string | null>;
  /** Options to create on the model before import: fieldId → distinct labels. */
  newOptions: Record<string, string[]>;
}

function modelFields(model: AppModel): ModelField[] {
  return model.schema.sections.flatMap((s) => s.fields);
}

/**
 * Apply the approved value-standardization decisions to the raw rows so that
 * `mapImportedRows` (unchanged) produces the right values:
 *  - dropdown/multiselect → rewrite cells to the chosen option value(s)
 *  - lookup "link existing" → rewrite to that record's display value (the
 *    importer then resolves it to the existing record — no duplicate)
 *  - "create new" → rewrite to the new label (option created first / lookup
 *    auto-created by the importer)
 *  - "leave blank" → clear the cell
 *  - "move to another field" → clear the source cell and append the value to a
 *    dedicated extra column mapped to the target field (so the row isn't
 *    dropped as empty and the value lands on the right field)
 */
export function applyStandardization(
  model: AppModel,
  table: { headers: string[]; rows: string[][] },
  mappings: Record<number, string | null>,
  standardization: Record<number, ColumnStandardization>,
  allRecords: Record<string, AppRecord[]>,
): AppliedStandardization {
  const fields = modelFields(model);
  const colCount = table.headers.length;
  const rows = table.rows.map((r) => {
    const next = r.slice(0, colCount);
    while (next.length < colCount) next.push('');
    return next;
  });

  const newMappings: Record<number, string | null> = { ...mappings };
  const newOptions: Record<string, string[]> = {};
  // routed target field slug → its appended column index
  const routeCol = new Map<string, number>();
  let nextCol = colCount;

  const ensureRouteColumn = (fieldSlug: string): number => {
    let idx = routeCol.get(fieldSlug);
    if (idx === undefined) {
      idx = nextCol++;
      routeCol.set(fieldSlug, idx);
      newMappings[idx] = fieldSlug;
      for (const row of rows) while (row.length <= idx!) row.push('');
    }
    return idx;
  };

  const addNewOption = (fieldId: string, label: string) => {
    const list = newOptions[fieldId] ?? (newOptions[fieldId] = []);
    if (label && !list.includes(label)) list.push(label);
  };

  for (const [colStr, plan] of Object.entries(standardization)) {
    const col = Number(colStr);
    if (!plan || newMappings[col] !== plan.fieldName) continue; // mapping changed since planning
    const field = fields.find((f) => f.name === plan.fieldName);
    if (!field) continue;
    const isMulti = field.type === 'multiselect' || (field.type === 'lookup' && !!field.is_multi);
    const byRaw = new Map<string, ValueDecision>(plan.values.map((v) => [v.raw, v]));

    // For lookup link-existing: resolve recordId → display value once.
    const displayById = new Map<string, string>();
    if (field.type === 'lookup' && field.lookup_model_id && field.lookup_display_field) {
      for (const rec of allRecords[field.lookup_model_id] ?? []) {
        const d = String(rec.data[field.lookup_display_field] ?? '').trim();
        if (d) displayById.set(rec.id, d);
      }
    }

    const resolveToken = (token: string, rowIndex: number): string | null => {
      const v = byRaw.get(token.trim());
      if (!v) return token; // not in plan (e.g. blank) — leave as-is
      const d = v.decision;
      switch (d.kind) {
        case 'option':
          return d.optionValue ?? '';
        case 'lookup_record':
          return d.recordId ? (displayById.get(d.recordId) ?? '') : '';
        case 'create_option':
          if (d.newLabel) addNewOption(field.id, d.newLabel);
          return d.newLabel ?? '';
        case 'create_record':
          return d.newLabel ?? token;
        case 'route_to_field':
          if (d.routeFieldName) {
            const idx = ensureRouteColumn(d.routeFieldName);
            rows[rowIndex]![idx] = d.routeValue ?? token;
          }
          return null; // removed from this column
        case 'unmatched':
        default:
          return null;
      }
    };

    rows.forEach((row, r) => {
      const cell = (row[col] ?? '').trim();
      if (!cell) return;
      if (isMulti) {
        const tokens = cell.split(/[,،]/).map((t) => t.trim()).filter(Boolean);
        const out = tokens.map((t) => resolveToken(t, r)).filter((t): t is string => t !== null && t !== '');
        row[col] = out.join(', ');
      } else {
        const resolved = resolveToken(cell, r);
        row[col] = resolved ?? '';
      }
    });
  }

  return { rows, mappings: newMappings, newOptions };
}

/** Append the collected new options to the model's fields (returns a new model;
 * caller persists it via saveModel before importing). Option value = the label
 * so the importer matches it by value or label. */
export function modelWithNewOptions(
  model: AppModel,
  newOptions: Record<string, string[]>,
  makeId: () => string,
): AppModel {
  if (Object.keys(newOptions).length === 0) return model;
  return {
    ...model,
    schema: {
      ...model.schema,
      sections: model.schema.sections.map((s) => ({
        ...s,
        fields: s.fields.map((f) => {
          const labels = newOptions[f.id];
          if (!labels || labels.length === 0) return f;
          const existing = f.options ?? [];
          const have = new Set(existing.map((o) => o.value));
          const added = labels
            .filter((l) => !have.has(l))
            .map((l) => ({ id: makeId(), label_ar: l, label_en: l, value: l }));
          return { ...f, options: [...existing, ...added] };
        }),
      })),
    },
    updated_at: new Date().toISOString(),
  };
}
