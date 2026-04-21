import * as XLSX from 'xlsx';
import { v4 as uuid } from 'uuid';
import { resolveMirror } from './mirrorResolver';
import { formatRangeValue } from '@/pages/Records/components/RangeField';
import type { AppModel, AppRecord, ModelField, Language, NoteEntry } from '@/types';

function formatCell(field: ModelField, val: unknown, isAr: boolean): string | number {
  if (val === undefined || val === null) return '';
  switch (field.type) {
    case 'dropdown': {
      const opt = field.options?.find((o) => o.value === val);
      return opt ? (isAr ? opt.label_ar : opt.label_en) : String(val);
    }
    case 'multiselect':
    case 'section_selector': {
      if (!Array.isArray(val)) return String(val);
      return (val as string[])
        .map((v) => {
          const opt = field.options?.find((o) => o.value === v);
          return opt ? (isAr ? opt.label_ar : opt.label_en) : v;
        })
        .join(', ');
    }
    case 'checkbox':
      return val ? (isAr ? 'نعم' : 'Yes') : (isAr ? 'لا' : 'No');
    case 'currency':
      return typeof val === 'number' ? val : Number(val) || '';
    case 'range':
      return formatRangeValue(field, val, isAr);
    case 'notes': {
      if (!Array.isArray(val)) return '';
      return (val as NoteEntry[])
        .filter((e) => e && typeof e.text === 'string')
        .map((e) => {
          const ts = e.created_at?.slice(0, 10) ?? '';
          return ts ? `[${ts}] ${e.text}` : e.text;
        })
        .join('\n---\n');
    }
    default:
      return String(val);
  }
}

/**
 * Export model records to an Excel file.
 * Mirrors resolve live via the sibling lookup — resolution requires allRecords + allModels.
 */
export function exportToExcel(
  model: AppModel,
  records: AppRecord[],
  language: Language,
  allRecords: Record<string, AppRecord[]>,
  allModels: AppModel[],
): void {
  const isAr = language === 'ar';
  const allFields = model.schema.sections.flatMap((s) => s.fields);

  // Build header row using field labels
  const headers = allFields.map((f) => (isAr ? f.label_ar : f.label_en));

  // Build data rows
  const rows = records.map((rec) =>
    allFields.map((field) => {
      if (field.type === 'mirror') {
        const res = resolveMirror(field, rec.data, allRecords, allModels);
        if (res.status !== 'ok' || !res.targetField) return '';
        return formatCell(res.targetField, res.value, isAr);
      }
      return formatCell(field, rec.data[field.name], isAr);
    }),
  );

  const wsData = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Set column widths
  ws['!cols'] = allFields.map(() => ({ wch: 20 }));

  // RTL for Arabic
  if (isAr) {
    ws['!dir'] = 'rtl';
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, isAr ? model.label_ar : model.label_en);
  XLSX.writeFile(wb, `${model.name}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/**
 * Read an uploaded Excel/CSV file and return header row + data rows
 */
export async function readExcelFile(
  file: File,
): Promise<{ headers: string[]; rows: string[][] }> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });

  const firstSheet = wb.Sheets[wb.SheetNames[0]!];
  if (!firstSheet) throw new Error('Empty file');

  const data = XLSX.utils.sheet_to_json<string[]>(firstSheet, { header: 1 });

  const headers = (data[0] ?? []).map((h) => String(h ?? '').trim());
  const rows = data.slice(1).map((row) =>
    row.map((cell) => String(cell ?? '').trim()),
  );

  return { headers, rows };
}

export interface MapImportedRowsResult {
  data: Record<string, unknown>[];
  // Records auto-created in lookup-target models when the imported display-value
  // didn't match any existing record. Caller must persist these.
  newLookupRecords: AppRecord[];
}

/**
 * Map imported rows to AppRecord data using column mappings.
 *
 * Lookup fields are resolved by matching the cell value against the configured
 * `lookup_display_field` on the target model (case-insensitive, trimmed). Missing
 * matches auto-create a new target record with just the display-field populated,
 * and duplicate values within the same import dedupe to a single new record.
 * Multi-select lookups split the cell on `,` or Arabic `،`.
 *
 * Range fields are addressed via dotted mapping values — `slug.min` / `slug.max`
 * each consume one source column. Mapping the two halves to separate columns
 * merges them into `{ min, max }`; mapping only one half stores that side alone.
 */
export function mapImportedRows(
  rows: string[][],
  columnMappings: Record<number, string | null>, // col index -> field name or null (skip)
  allFields: ModelField[],
  allRecords: Record<string, AppRecord[]>,
): MapImportedRowsResult {
  const newLookupRecords: AppRecord[] = [];
  // modelId -> (normalizedValue -> recordId). Covers both pre-existing matches
  // and within-this-import auto-creates, so the second row referencing the same
  // developer name reuses the first row's newly-created id.
  const lookupCache = new Map<string, Map<string, string>>();

  const resolveLookup = (field: ModelField, rawValue: string): string | null => {
    const modelId = field.lookup_model_id;
    const displayField = field.lookup_display_field;
    if (!modelId || !displayField) return null;
    const normalized = rawValue.trim();
    if (!normalized) return null;
    const key = normalized.toLowerCase();

    let cache = lookupCache.get(modelId);
    if (!cache) {
      cache = new Map();
      // Warm with existing records so we don't re-scan for every row.
      for (const rec of allRecords[modelId] ?? []) {
        const v = rec.data[displayField];
        if (v === null || v === undefined) continue;
        const k = String(v).trim().toLowerCase();
        if (k && !cache.has(k)) cache.set(k, rec.id);
      }
      lookupCache.set(modelId, cache);
    }

    const existing = cache.get(key);
    if (existing) return existing;

    const now = new Date().toISOString();
    const newRec: AppRecord = {
      id: uuid(),
      model_id: modelId,
      data: { [displayField]: normalized },
      created_at: now,
      updated_at: now,
    };
    newLookupRecords.push(newRec);
    cache.set(key, newRec.id);
    return newRec.id;
  };

  const data = rows
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) => {
      const data: Record<string, unknown> = {};
      for (const [colIdxStr, mapped] of Object.entries(columnMappings)) {
        if (!mapped) continue;
        const colIdx = Number(colIdxStr);
        const cellValue = row[colIdx] ?? '';
        if (!cellValue) continue;

        // Dotted mappings (`slug.min` / `slug.max`) address a sub-value of the field.
        const dotIx = mapped.indexOf('.');
        const fieldName = dotIx === -1 ? mapped : mapped.slice(0, dotIx);
        const subPath = dotIx === -1 ? null : mapped.slice(dotIx + 1);

        const field = allFields.find((f) => f.name === fieldName);
        if (!field) continue;
        if (field.type === 'mirror') continue; // Mirrors are derived; can't be written.
        if (field.type === 'notes') continue; // Notes are append-only history; skip import.

        if (field.type === 'range') {
          // Range must be mapped with a .min / .max suffix; anything else would
          // put a raw string where { min, max } is expected.
          if (subPath !== 'min' && subPath !== 'max') continue;
          const stripped = cellValue.replace(/[^\d.-]/g, '');
          if (!stripped) continue; // cell had no numeric chars — skip this half
          const num = Number(stripped);
          if (!Number.isFinite(num)) continue;
          const existing = (data[fieldName] as { min?: number; max?: number } | undefined) ?? {};
          data[fieldName] = { ...existing, [subPath]: num };
          continue;
        }

        // Parse value based on field type
        switch (field.type) {
          case 'number':
          case 'currency': {
            const num = Number(cellValue.replace(/[^\d.-]/g, ''));
            if (!isNaN(num)) data[fieldName] = num;
            break;
          }
          case 'checkbox':
            data[fieldName] = ['yes', 'نعم', 'true', '1'].includes(cellValue.toLowerCase());
            break;
          case 'dropdown': {
            // Try to match by label or value
            const opt = field.options?.find(
              (o) =>
                o.value === cellValue ||
                o.label_ar === cellValue ||
                o.label_en === cellValue ||
                o.label_ar.includes(cellValue) ||
                o.label_en.toLowerCase().includes(cellValue.toLowerCase()),
            );
            data[fieldName] = opt ? opt.value : cellValue;
            break;
          }
          case 'multiselect':
          case 'section_selector': {
            const parts = cellValue.split(',').map((s) => s.trim());
            data[fieldName] = parts.map((part) => {
              const opt = field.options?.find(
                (o) => o.value === part || o.label_ar === part || o.label_en === part,
              );
              return opt ? opt.value : part;
            });
            break;
          }
          case 'lookup': {
            if (field.is_multi) {
              const parts = cellValue.split(/[,،]/).map((s) => s.trim()).filter(Boolean);
              const ids = parts
                .map((p) => resolveLookup(field, p))
                .filter((id): id is string => !!id);
              if (ids.length > 0) data[fieldName] = ids;
            } else {
              const id = resolveLookup(field, cellValue);
              if (id) data[fieldName] = id;
            }
            break;
          }
          default:
            data[fieldName] = cellValue;
        }
      }
      return data;
    });

  return { data, newLookupRecords };
}
