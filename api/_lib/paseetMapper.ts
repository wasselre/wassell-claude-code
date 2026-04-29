/**
 * Pure mapper: takes a `PaseetQueryResult` plus one `PaseetResponseMapping`
 * and returns a partial JSONB patch to merge into a record's `data` field.
 *
 * Three mapping kinds:
 *   - set_field:           target_field gets a single value parsed from
 *                          rawText (optionally pluck via `extract_regex`).
 *   - append_table_rows:   each row of the parsed table becomes one row in
 *                          target_field (a `table` type field), appended to
 *                          whatever existing rows are already there.
 *   - replace_table_rows:  same as append, but throws away the existing rows.
 *
 * Column resolution is keyword-based and case-insensitive after underscore→
 * space normalization, so Paseet's "متوسط_السعر" matches a mapping that
 * declares "متوسط السعر" or "متوسط".
 */

// Inline shape declarations — keeping them here avoids cross-folder imports
// from src/types into the api/ deploy bundle, which Vercel sometimes choked
// on when paths were too clever. The src/types declarations are the source
// of truth; these mirror them.

export type PaseetResponseShape = 'text' | 'single_value' | 'table_rows';
export type PaseetResponseMappingKind =
  | 'set_field'
  | 'append_table_rows'
  | 'replace_table_rows';
export type ParseAs = 'text' | 'number' | 'currency';

export interface PaseetTableColumnMapping {
  id: string;
  target_column_id: string;
  source_header_keywords: string[];
  parse_as?: ParseAs;
}

export interface PaseetResponseMapping {
  id: string;
  kind: PaseetResponseMappingKind;
  target_field_id: string;
  parse_as?: ParseAs;
  table_column_mappings?: PaseetTableColumnMapping[];
  extract_regex?: string;
}

/** Light shape of a model field — only what the mapper needs. */
export interface MapperField {
  name: string; // slug used as JSONB key
  type: string; // 'text' | 'table' | 'currency' | etc.
}

/** Light shape of a model schema — only what the mapper needs. */
export interface MapperSchema {
  sections: { fields: MapperField[] }[];
}

export interface PaseetTableData {
  headers: string[];
  rows: string[][];
}

export interface PaseetQueryResultLike {
  rawText: string;
  table: PaseetTableData | null;
}

const normHeader = (s: string): string => s.replace(/_/g, ' ').trim().toLowerCase();

/** Find the index of a column in `headers` whose normalized text contains
 *  ANY of the provided `keywords` (also normalized). Returns -1 if no match. */
function findColumn(headers: string[], keywords: string[]): number {
  const normed = headers.map(normHeader);
  for (const kw of keywords) {
    const nKw = normHeader(kw);
    if (!nKw) continue;
    const idx = normed.findIndex((h) => h.includes(nKw));
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Coerce a raw cell or rawText into the storage type for a target field. */
function coerce(raw: string, parseAs?: ParseAs): unknown {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return parseAs === 'number' || parseAs === 'currency' ? null : '';
  }
  if (parseAs === 'number' || parseAs === 'currency') {
    // Convert Arabic-Indic digits → ASCII, then strip thousands separators
    // (Latin and Arabic commas), spaces, and SAR currency markers.
    const ascii = trimmed
      .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/[,،\s]|ر\.س|SAR/g, '');
    const n = parseFloat(ascii);
    return Number.isFinite(n) ? n : null;
  }
  return trimmed;
}

export interface ApplyMappingArgs {
  result: PaseetQueryResultLike;
  mapping: PaseetResponseMapping;
  modelSchema: MapperSchema;
  /** Existing record.data to merge against (for append_table_rows). */
  existingData: Record<string, unknown>;
}

/**
 * Returns a partial patch for `record.data`. Caller is responsible for
 * merging it into the record and persisting via Supabase (or a store call).
 *
 * Empty patch ({}) means the mapping had nothing to apply (e.g. table_rows
 * mapping but Paseet returned no table) — caller may treat that as a no-op
 * or surface a warning.
 */
export function applyPaseetMapping(args: ApplyMappingArgs): Record<string, unknown> {
  const { result, mapping, modelSchema, existingData } = args;

  // Resolve the target field by its slug (we store id === slug for JSONB keys).
  const allFields: MapperField[] = modelSchema.sections.flatMap((s) => s.fields);
  const targetField = allFields.find((f) => f.name === mapping.target_field_id);
  if (!targetField) {
    throw new Error(`Target field "${mapping.target_field_id}" not found on model`);
  }

  if (mapping.kind === 'set_field') {
    let raw = result.rawText;
    if (mapping.extract_regex) {
      try {
        const re = new RegExp(mapping.extract_regex, 'm');
        const m = re.exec(result.rawText);
        // First capture group if any; otherwise full match.
        raw = m ? (m[1] ?? m[0]) : '';
      } catch {
        raw = '';
      }
    }
    return { [targetField.name]: coerce(raw, mapping.parse_as) };
  }

  if (mapping.kind === 'append_table_rows' || mapping.kind === 'replace_table_rows') {
    if (!result.table || result.table.rows.length === 0) {
      return {};
    }
    const colMappings = mapping.table_column_mappings ?? [];
    if (colMappings.length === 0) {
      return {};
    }

    const newRows: Record<string, unknown>[] = result.table.rows.map((row) => {
      const cells: Record<string, unknown> = {};
      for (const cm of colMappings) {
        const idx = findColumn(result.table!.headers, cm.source_header_keywords);
        cells[cm.target_column_id] = idx >= 0 ? coerce(row[idx] ?? '', cm.parse_as) : null;
      }
      return cells;
    });

    if (mapping.kind === 'replace_table_rows') {
      return { [targetField.name]: newRows };
    }

    // append: merge with whatever rows already exist
    const existing = existingData[targetField.name];
    const existingArr = Array.isArray(existing) ? (existing as Record<string, unknown>[]) : [];
    return { [targetField.name]: [...existingArr, ...newRows] };
  }

  return {};
}
