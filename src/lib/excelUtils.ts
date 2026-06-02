import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';
import { v4 as uuid } from 'uuid';
import { resolveMirror, resolveLookupDisplayValue } from './mirrorResolver';
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
    case 'multi_link': {
      if (!Array.isArray(val)) return String(val);
      return (val as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0).join('\n');
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

// Field types that can't be filled from a flat spreadsheet cell —
// either derived/computed, auto-generated, file/UUID references, or
// nested array structures.
const TEMPLATE_SKIP_TYPES = new Set<string>([
  'auto_id',
  'mirror',
  'section_mirror',
  'notes',
  'formula',
  'assignee',
  'table',
  'image',
  'multi_image',
  'file',
  'multi_file',
  'multi_link',
  'attachment',
  'template_variables',
  'templates_picker',
  'generations_gallery',
  'whatsapp_history',
  'call_history',
]);

// 1-indexed column number → Excel column letter (1 → A, 27 → AA, etc.).
function numToColLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const DROPDOWN_BACKED_TYPES = new Set(['dropdown', 'multiselect', 'section_selector']);

/**
 * Export a blank Excel template for a model — the "what to fill" companion
 * to Import. Headers match the importer's auto-mapper exactly, so a user can
 * download the template, paste data underneath the header row, and re-import
 * without touching the column-mapping UI.
 *
 * Built with ExcelJS (not SheetJS) because the Community build of `xlsx`
 * can't write data validations and the whole point of this export is that
 * dropdown/multi-select/section_selector columns get **real in-cell Excel
 * dropdowns** the user can click on.
 *
 * Workbook layout:
 * 1. **Template** — header row + 5,000 rows of data-validated cells under
 *    every dropdown/multi-select/section_selector column. Range fields split
 *    into `<label> (min)` / `<label> (max)` columns (Arabic: `(أدنى)` /
 *    `(أعلى)`) so each half maps cleanly on re-import.
 * 2. **Field Guide** — one row per logical field with type, required Yes/No,
 *    and notes. Dropdown/multi-select rows just say "use the in-cell
 *    dropdown" because the options live in the Template now. Lookups still
 *    name the target model + display field. Range, checkbox, date, phone,
 *    currency get format hints.
 * 3. **Options** (hidden) — backs the in-cell dropdowns. One column per
 *    dropdown/multi-select field, options stacked vertically. Always
 *    referenced (never inlined as `"a,b,c"`) so commas inside option labels
 *    don't break the formula AND so long lists like "الأحياء المفضلة"
 *    (hundreds of values, thousands of characters) sail past Excel's 255-
 *    char inline limit.
 *
 * Field types that can't be expressed in a flat cell are excluded entirely
 * (`TEMPLATE_SKIP_TYPES` — mirror/notes/formula/file refs/etc.).
 */
export async function exportTemplate(
  model: AppModel,
  language: Language,
  allModels: AppModel[],
): Promise<void> {
  const isAr = language === 'ar';
  const MIN_LABEL = isAr ? 'أدنى' : 'min';
  const MAX_LABEL = isAr ? 'أعلى' : 'max';
  const DATA_END_ROW = 5001; // 5,000 data rows (header is row 1)

  const allFields = model.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => !TEMPLATE_SKIP_TYPES.has(f.type));

  // ── Column layout for the Template sheet ────────────────────────────────
  type Col = { header: string; field: ModelField };
  const columns: Col[] = [];
  for (const f of allFields) {
    const base = isAr ? f.label_ar : f.label_en;
    if (f.type === 'range') {
      columns.push({ header: `${base} (${MIN_LABEL})`, field: f });
      columns.push({ header: `${base} (${MAX_LABEL})`, field: f });
    } else {
      columns.push({ header: base, field: f });
    }
  }

  // ── Pre-compute which fields back an in-cell dropdown ───────────────────
  // field.id -> 1-indexed column on the hidden Options sheet
  const fieldOptionsCol = new Map<string, number>();
  let nextOptCol = 0;
  for (const f of allFields) {
    if (!DROPDOWN_BACKED_TYPES.has(f.type)) continue;
    if ((f.options?.length ?? 0) === 0) continue;
    nextOptCol += 1;
    fieldOptionsCol.set(f.id, nextOptCol);
  }

  // ── Build workbook ──────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  const templateName = isAr ? 'النموذج' : 'Template';
  const guideName = isAr ? 'دليل الحقول' : 'Field Guide';
  const optionsName = isAr ? 'الخيارات' : 'Options';

  // Add in desired tab order. Hidden Options sheet last.
  const templateSheet = wb.addWorksheet(templateName, {
    views: isAr ? [{ rightToLeft: true }] : undefined,
  });
  const guideSheet = wb.addWorksheet(guideName, {
    views: isAr ? [{ rightToLeft: true }] : undefined,
  });
  const optionsSheet = wb.addWorksheet(optionsName);
  optionsSheet.state = 'hidden';

  // ── Populate Options sheet ──────────────────────────────────────────────
  for (const f of allFields) {
    const col = fieldOptionsCol.get(f.id);
    if (col === undefined) continue;
    optionsSheet.getCell(1, col).value = isAr ? f.label_ar : f.label_en;
    (f.options ?? []).forEach((opt, i) => {
      optionsSheet.getCell(i + 2, col).value = isAr ? opt.label_ar : opt.label_en;
    });
  }

  // ── Populate Template sheet ─────────────────────────────────────────────
  templateSheet.columns = columns.map((c) => ({ header: c.header, width: 22 }));
  // Bold the header row so it's visually distinct from data rows.
  templateSheet.getRow(1).font = { bold: true };

  columns.forEach((col, idx) => {
    const optsColNum = fieldOptionsCol.get(col.field.id);
    if (optsColNum === undefined) return;
    const opts = col.field.options ?? [];
    const optsLetter = numToColLetter(optsColNum);
    const colLetter = numToColLetter(idx + 1);
    // Quote the sheet name (works regardless of Arabic chars or spaces).
    const sheetRef = `'${optionsName}'!$${optsLetter}$2:$${optsLetter}$${opts.length + 1}`;
    // Single-value dropdown: warn on invalid input but don't block (the
    //   importer is forgiving — substring matches and falls back to the raw
    //   string — so a hard `errorStyle: 'stop'` would be more annoying than
    //   useful).
    // Multi-select / section_selector: explicitly DON'T show an error,
    //   because the importer expects comma-separated values ("Opt1, Opt2")
    //   and we want users to be able to type those out without Excel
    //   complaining.
    const isSingleDropdown = col.field.type === 'dropdown';
    // `Worksheet.dataValidations.add(range, dv)` is the runtime API, but
    // ExcelJS's bundled `index.d.ts` only exposes the per-cell setter
    // (`Cell.dataValidation`). Cast through a minimal interface so we keep
    // the efficient range-based call without `any`-leakage. Verified working
    // by round-tripping the produced .xlsx through ExcelJS's reader.
    const dvSheet = templateSheet as ExcelJS.Worksheet & {
      dataValidations: {
        add: (range: string, validation: ExcelJS.DataValidation) => void;
      };
    };
    dvSheet.dataValidations.add(`${colLetter}2:${colLetter}${DATA_END_ROW}`, {
      type: 'list',
      allowBlank: true,
      formulae: [sheetRef],
      showErrorMessage: isSingleDropdown,
      errorStyle: 'warning',
      errorTitle: isAr ? 'قيمة غير صالحة' : 'Invalid value',
      error: isAr
        ? 'هذه القيمة ليست من الخيارات المتاحة. تابع إذا كنت متأكدًا.'
        : 'This value is not in the allowed list. Continue if you are sure.',
    });
  });

  // ── Populate Field Guide sheet ──────────────────────────────────────────
  const TYPE_LABELS_EN: Record<string, string> = {
    text: 'Text',
    textarea: 'Long text',
    number: 'Number',
    email: 'Email',
    phone: 'Phone',
    date: 'Date',
    datetime: 'Date & time',
    currency: 'Currency (SAR)',
    url: 'URL',
    checkbox: 'Checkbox',
    dropdown: 'Dropdown',
    multiselect: 'Multi-select',
    lookup: 'Lookup',
    section_selector: 'Section selector',
    range: 'Range',
  };
  const TYPE_LABELS_AR: Record<string, string> = {
    text: 'نص',
    textarea: 'نص طويل',
    number: 'رقم',
    email: 'بريد إلكتروني',
    phone: 'هاتف',
    date: 'تاريخ',
    datetime: 'تاريخ ووقت',
    currency: 'مبلغ (ر.س)',
    url: 'رابط',
    checkbox: 'مربع اختيار',
    dropdown: 'قائمة منسدلة',
    multiselect: 'اختيار متعدد',
    lookup: 'بحث',
    section_selector: 'محدد الأقسام',
    range: 'نطاق',
  };
  const typeLabel = (type: string): string =>
    (isAr ? TYPE_LABELS_AR[type] : TYPE_LABELS_EN[type]) ?? type;

  const lookupHint = (f: ModelField): string => {
    const target = allModels.find((m) => m.id === f.lookup_model_id);
    const targetName = target
      ? (isAr ? target.label_ar : target.label_en)
      : (isAr ? '(غير محدد)' : '(unset)');
    const displayField = target?.schema.sections
      .flatMap((s) => s.fields)
      .find((tf) => tf.name === f.lookup_display_field);
    const displayLabel = displayField
      ? (isAr ? displayField.label_ar : displayField.label_en)
      : (f.lookup_display_field ?? (isAr ? '(غير محدد)' : '(unset)'));
    const multi = f.is_multi
      ? (isAr ? ' — متعدد، افصل بفواصل' : ' — multiple, separate with commas')
      : '';
    return isAr
      ? `بحث ← ${targetName} — اكتب ${displayLabel}${multi}`
      : `Lookup → ${targetName} — enter ${displayLabel}${multi}`;
  };

  const noteFor = (f: ModelField): string => {
    const base = isAr ? f.label_ar : f.label_en;
    switch (f.type) {
      case 'dropdown':
        return isAr
          ? 'اختر من القائمة المنسدلة في عمود النموذج'
          : 'Pick from the dropdown in the Template column';
      case 'multiselect':
      case 'section_selector':
        return isAr
          ? 'اختر من القائمة المنسدلة (يمكن إضافة قيم متعددة مفصولة بفواصل)'
          : 'Pick from the dropdown (add more values separated by commas)';
      case 'lookup':
        return lookupHint(f);
      case 'range': {
        const minCol = `${base} (${MIN_LABEL})`;
        const maxCol = `${base} (${MAX_LABEL})`;
        return isAr
          ? `عمودان رقميان: "${minCol}" و"${maxCol}"`
          : `Two numeric columns: "${minCol}" and "${maxCol}"`;
      }
      case 'checkbox':
        return isAr ? 'نعم / لا (أو Yes / No)' : 'Yes / No (or نعم / لا)';
      case 'date':
        return isAr ? 'مثال: 2026-05-23' : 'e.g. 2026-05-23';
      case 'datetime':
        return isAr ? 'مثال: 2026-05-23 14:30' : 'e.g. 2026-05-23 14:30';
      case 'currency':
        return isAr ? 'رقم بالريال السعودي' : 'Number (Saudi Riyal)';
      case 'phone':
        return isAr ? 'مثال: 0501234567' : 'e.g. 0501234567';
      default:
        return '';
    }
  };

  const yes = isAr ? 'نعم' : 'Yes';
  const no = isAr ? 'لا' : 'No';
  guideSheet.columns = [
    { header: isAr ? 'اسم العمود' : 'Column Name', width: 32 },
    { header: isAr ? 'النوع' : 'Type', width: 18 },
    { header: isAr ? 'مطلوب' : 'Required', width: 10 },
    { header: isAr ? 'ملاحظات' : 'Notes', width: 70 },
  ];
  guideSheet.getRow(1).font = { bold: true };
  for (const f of allFields) {
    const base = isAr ? f.label_ar : f.label_en;
    const columnName =
      f.type === 'range' ? `${base} (${MIN_LABEL}) / (${MAX_LABEL})` : base;
    guideSheet.addRow([columnName, typeLabel(f.type), f.required ? yes : no, noteFor(f)]);
  }

  // ── Write + trigger download ────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${model.name}_template.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Write an arbitrary { headers, rows } table to an .xlsx and trigger a browser
 * download. Generic counterpart to `exportToExcel` (which is model-bound) —
 * used by the Data Migration wizard so the user can pull the AI-extracted raw
 * table out, fix it in Excel, and re-upload.
 *
 * Plain text cells, NO data validation — deliberate. The template export
 * (`exportTemplate`) gives multiselect columns a single-select in-cell
 * dropdown, which silently collapses a multi-value cell to one value. Here
 * every cell is free text, so comma / `،`-separated multi-values survive the
 * download → edit → re-upload round-trip intact.
 */
export function exportRawTable(
  table: { headers: string[]; rows: (string | number)[][] },
  filename: string,
  isAr: boolean,
): void {
  const wsData = [table.headers, ...table.rows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = table.headers.map(() => ({ wch: 22 }));
  if (isAr) ws['!dir'] = 'rtl';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, isAr ? 'البيانات' : 'Data');
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

/**
 * Read an uploaded Excel/CSV file and return header row + data rows
 */
export async function readExcelFile(
  file: File,
): Promise<{ headers: string[]; rows: string[][] }> {
  const buffer = await file.arrayBuffer();
  // codepage 65001 = UTF-8. Forces SheetJS to decode CSV/TXT bytes as UTF-8 so
  // Arabic in a BOM-less UTF-8 CSV doesn't mojibake (e.g. "شقة" → "Ø´ÙØ©").
  // Ignored for .xlsx (already UTF-8 internally). UTF-8 is the right modern default.
  const wb = XLSX.read(buffer, { type: 'array', codepage: 65001 });

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
  allModels: AppModel[],
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

    // A `mirror` display field is computed at runtime and stores nothing, so we
    // can neither warm the cache from raw data nor auto-create by writing to it.
    // Match existing records against their RESOLVED mirror value, and on a miss
    // leave the cell unlinked (return null) rather than create a junk record
    // with an orphan data key — see CLAUDE.md "never silently corrupt data".
    const targetModel = allModels.find((m) => m.id === modelId);
    const displayIsMirror =
      targetModel?.schema.sections
        .flatMap((s) => s.fields)
        .find((f) => f.name === displayField)?.type === 'mirror';

    let cache = lookupCache.get(modelId);
    if (!cache) {
      cache = new Map();
      // Warm with existing records so we don't re-scan for every row.
      for (const rec of allRecords[modelId] ?? []) {
        const v = displayIsMirror
          ? resolveLookupDisplayValue(rec, displayField, { targetModel, allModels, allRecords })
          : rec.data[displayField];
        if (v === null || v === undefined) continue;
        const k = String(v).trim().toLowerCase();
        if (k && !cache.has(k)) cache.set(k, rec.id);
      }
      lookupCache.set(modelId, cache);
    }

    const existing = cache.get(key);
    if (existing) return existing;

    // Can't auto-create a target record keyed on a computed mirror field.
    if (displayIsMirror) return null;

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
            // Split on either the Latin `,` or the Arabic comma `،` (U+060C).
            // Arabic spreadsheets commonly use `،`; without this, a cell like
            // `صالة جلوس، مجلس` was treated as ONE unsplit string, didn't match
            // any option, and got stored as a single raw-label entry which the
            // MultiSelect form then dropped at render time (it filters values
            // not present in the option list) — making the field appear empty
            // after import even though the data was technically "saved".
            const parts = cellValue.split(/[,،]/).map((s) => s.trim()).filter(Boolean);
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
