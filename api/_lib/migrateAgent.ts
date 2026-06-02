/**
 * Anthropic helpers for the Data Migration wizard (POST /api/migrate).
 *
 * Three actions, each forced-tool so the model always returns structured JSON:
 *   - extract            : files (PDF/image) → one unified raw { headers, rows } table
 *   - suggest_mappings   : raw headers + sample rows + target fields → column→field map  (Phase 4)
 *   - standardize        : a dropdown/multiselect/lookup column's distinct values →
 *                          canonical option / lookup matches                            (Phase 4)
 *
 * Models are pinned to IDs proven available in this project (the decks
 * pipeline + aiAgent use opus-4-7 / sonnet-4-6). Bump in one place when the
 * account gains access to a newer tier.
 */

import Anthropic from '@anthropic-ai/sdk';

export const EXTRACT_MODEL = 'claude-opus-4-7';
export const EXTRACT_FALLBACK_MODEL = 'claude-sonnet-4-6';

export type AgentLanguage = 'ar' | 'en';

/** Force the model's human-readable text (notes / reasons) into the UI
 * language. Cell DATA is always preserved verbatim regardless. */
function langLine(language: AgentLanguage, field: string): string {
  const lang = language === 'ar' ? 'Arabic (العربية)' : 'English';
  return `\n\nIMPORTANT: Write every "${field}" value you return in ${lang}. (This applies only to your explanatory text — never translate or alter the extracted cell DATA itself.)`;
}
// Mapping + standardization are bounded text tasks (headers/sample rows, and
// distinct values per column) — Sonnet is plenty and keeps cost down.
export const MAP_MODEL = 'claude-sonnet-4-6';
export const STANDARDIZE_MODEL = 'claude-sonnet-4-6';

/** One uploaded source file, addressed by a short-lived signed URL the client
 * minted from the wassel-migrations bucket (RLS-scoped to the owner). */
export interface ExtractFileInput {
  name: string;
  mimeType: string;
  url: string;
}

export interface RawTableResult {
  headers: string[];
  rows: string[][];
  notes?: string;
  truncated: boolean;
  files_processed: number;
  files_skipped: { name: string; reason: string }[];
}

// Claude vision accepts these image media types only.
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_FILES = 20;
// Keep comfortably under the Anthropic ~32 MB request cap once base64-inflated.
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'emit_raw_table',
  description:
    'Return ALL tabular data extracted from the uploaded files as ONE unified table. ' +
    'Union every distinct column seen across files into a single header row; a row ' +
    'lacking a column gets an empty string. One logical record per row.',
  input_schema: {
    type: 'object',
    properties: {
      headers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Unified column headers, left-to-right. Use the clearest source label per column.',
      },
      rows: {
        type: 'array',
        items: { type: 'array', items: { type: 'string' } },
        description:
          'Each inner array is one record, positionally aligned to `headers`. Cell text VERBATIM; ' +
          'empty string where a source lacked that column.',
      },
      notes: {
        type: 'string',
        description: 'Optional: ambiguities (merged cells, unreadable regions, inferred units). One short paragraph.',
      },
      truncated: {
        type: 'boolean',
        description: 'True if you could not include every row/page because the input was larger than what fits in one response.',
      },
    },
    required: ['headers', 'rows', 'truncated'],
  },
};

const EXTRACT_SYSTEM = `You extract structured tabular data from messy real-estate documents for a Saudi Arabian CRM (Wassel / وصل العقارية). The files are developer hand-offs: unit lists, price tables, project specs — as PDFs, screenshots, or photos, often in Arabic.

Always call the \`emit_raw_table\` tool — never reply in prose.

Rules:
1. Find every table / list of records across ALL the provided files and merge them into ONE table. If two files describe the same kind of record (e.g. units), union their columns: same concept → same column. A row missing a column gets an empty string for it.
2. One logical record per row (e.g. one unit per row).
3. Preserve cell values EXACTLY as written — do NOT translate, do NOT reformat numbers or dates, do NOT standardize spelling, do NOT strip units (keep "120 م²", "450,000 ر.س" verbatim). Cleaning and standardization happen later with human approval; your job is faithful capture.
4. Keep Arabic text in Arabic. Keep mixed Arabic/Latin as-is.
5. If a cell holds multiple values (e.g. several amenities), keep them all in that one cell separated by a comma — never drop any.
6. Use clear, human-readable column headers taken from the source (Arabic or English as the source uses).
7. If the input has more rows/pages than you can faithfully fit in one response, extract as many complete rows as you can and set "truncated": true. Never invent or pad data.`;

function fileExtensionMime(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    default: return null;
  }
}

/**
 * Fetch each signed-URL file, build Claude content blocks, and ask the model
 * to emit one unified raw table. Falls back from opus to sonnet on a model
 * error. Throws on a hard failure (caller surfaces a loud error).
 */
export async function runExtract(
  apiKey: string,
  files: ExtractFileInput[],
  language: AgentLanguage = 'ar',
): Promise<RawTableResult> {
  const skipped: { name: string; reason: string }[] = [];
  const blocks: Anthropic.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        'Extract every record from the following file(s) into one unified table. ' +
        'Preserve all values verbatim.',
    },
  ];

  let totalBytes = 0;
  let used = 0;
  let truncatedInput = false;

  for (const file of files) {
    if (used >= MAX_FILES) {
      truncatedInput = true;
      skipped.push({ name: file.name, reason: 'file limit reached' });
      continue;
    }
    // Trust the browser mime, fall back to extension sniffing (HEIC on Firefox
    // reports empty type; odd screenshot exports too).
    const mime = (file.mimeType && file.mimeType !== 'application/octet-stream')
      ? file.mimeType
      : (fileExtensionMime(file.name) ?? file.mimeType);

    const isImage = IMAGE_MEDIA_TYPES.has(mime);
    const isPdf = mime === 'application/pdf';
    if (!isImage && !isPdf) {
      skipped.push({
        name: file.name,
        reason: `unsupported type "${mime || 'unknown'}" — convert to PNG/JPG/PDF`,
      });
      continue;
    }

    let bytes: ArrayBuffer;
    try {
      const res = await fetch(file.url);
      if (!res.ok) {
        skipped.push({ name: file.name, reason: `download failed (${res.status})` });
        continue;
      }
      bytes = await res.arrayBuffer();
    } catch (err) {
      skipped.push({ name: file.name, reason: `download error: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    if (totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
      truncatedInput = true;
      skipped.push({ name: file.name, reason: 'total upload size limit reached' });
      continue;
    }
    totalBytes += bytes.byteLength;
    const data = Buffer.from(bytes).toString('base64');

    blocks.push({ type: 'text', text: `File: ${file.name}` });
    if (isImage) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime as 'image/png', data },
      });
    } else {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data },
      });
    }
    used += 1;
  }

  if (used === 0) {
    throw new Error(
      `No extractable files. ${skipped.map((s) => `${s.name}: ${s.reason}`).join('; ') || 'No files provided.'}`,
    );
  }

  const client = new Anthropic({ apiKey });
  const call = (model: string) =>
    client.messages.create({
      model,
      max_tokens: 16000,
      system: EXTRACT_SYSTEM + langLine(language, 'notes'),
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'emit_raw_table' },
      messages: [{ role: 'user', content: blocks }],
    });

  let response;
  try {
    response = await call(EXTRACT_MODEL);
  } catch {
    response = await call(EXTRACT_FALLBACK_MODEL);
  }

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    throw new Error('Extraction model did not return a table');
  }
  const out = toolBlock.input as {
    headers?: unknown;
    rows?: unknown;
    notes?: unknown;
    truncated?: unknown;
  };

  const headers = Array.isArray(out.headers) ? out.headers.map((h) => String(h ?? '')) : [];
  const rawRows = Array.isArray(out.rows) ? out.rows : [];
  const rows: string[][] = rawRows.map((r) =>
    Array.isArray(r) ? r.map((c) => String(c ?? '')) : [],
  );

  return {
    headers,
    rows,
    notes: typeof out.notes === 'string' ? out.notes : undefined,
    truncated: Boolean(out.truncated) || truncatedInput,
    files_processed: used,
    files_skipped: skipped,
  };
}

// ============================================================================
// suggest_mappings — column → target field
// ============================================================================

export interface TargetFieldLite {
  name: string; // slug, or a range half "slug.min" / "slug.max"
  label_ar: string;
  label_en: string;
  type: string;
  required: boolean;
}

export interface MappingSuggestion {
  columnIndex: number;
  fieldName: string | null;
  confidence: number;
  reason: string;
}

const SUGGEST_TOOL: Anthropic.Tool = {
  name: 'emit_column_mappings',
  description: 'For each source column index, choose the single best target field slug, or "" if none fits.',
  input_schema: {
    type: 'object',
    properties: {
      mappings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            columnIndex: { type: 'integer', description: '0-based index into the source headers.' },
            fieldName: {
              type: 'string',
              description: 'Target field slug (its `name`), exactly as given. For a range field use the exact "slug.min" / "slug.max" entry. "" = leave this column unmapped.',
            },
            confidence: { type: 'number', description: '0..1 confidence in this mapping.' },
            reason: { type: 'string', description: 'Short justification referencing the header and/or sample values.' },
          },
          required: ['columnIndex', 'fieldName', 'confidence', 'reason'],
        },
      },
    },
    required: ['mappings'],
  },
};

const SUGGEST_SYSTEM = `You map the columns of a raw spreadsheet to the fields of a target data model in a Saudi Arabian real-estate CRM (Wassel / وصل العقارية). Always call the \`emit_column_mappings\` tool.

For each source column (identified by its 0-based index) pick the target field whose MEANING best matches the column — use both the header text and the sample values, which may be Arabic or English. Return the field's \`name\` (slug) EXACTLY as given in the field list.

Rules:
- A range field appears in the list as two entries, "slug.min" and "slug.max". Map a "from / أدنى / min / starting" column to .min and a "to / أعلى / max / up to" column to .max.
- Do not map two different columns to the same field, UNLESS they are the two halves of a range.
- Be conservative: if no field clearly fits a column, return "" for it. A skipped column is better than a wrong mapping — the user can fix mappings, but a wrong one silently corrupts data.
- Match across languages (an Arabic header can map to an English-labelled field and vice-versa).`;

export async function runSuggestMappings(
  apiKey: string,
  input: { headers: string[]; sampleRows: string[][]; fields: TargetFieldLite[]; language?: AgentLanguage },
): Promise<MappingSuggestion[]> {
  const fieldList = input.fields
    .map((f) => `- ${f.name} | ${f.label_en} / ${f.label_ar} | type=${f.type}${f.required ? ' | required' : ''}`)
    .join('\n');
  const cols = input.headers
    .map((h, i) => {
      const samples = input.sampleRows
        .slice(0, 6)
        .map((r) => r[i] ?? '')
        .filter((v) => v !== '')
        .slice(0, 3);
      return `[${i}] "${h}" → e.g. ${samples.length ? samples.join(' | ') : '(empty)'}`;
    })
    .join('\n');
  const userMsg = `TARGET FIELDS (name | English / Arabic | type):\n${fieldList}\n\nSOURCE COLUMNS (index "header" → sample values):\n${cols}`;

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MAP_MODEL,
    max_tokens: 2000,
    system: SUGGEST_SYSTEM + langLine(input.language ?? 'ar', 'reason'),
    tools: [SUGGEST_TOOL],
    tool_choice: { type: 'tool', name: 'emit_column_mappings' },
    messages: [{ role: 'user', content: userMsg }],
  });
  const tb = response.content.find((b) => b.type === 'tool_use');
  if (!tb || tb.type !== 'tool_use') throw new Error('Mapping model did not respond');
  const out = tb.input as { mappings?: unknown };
  const arr = Array.isArray(out.mappings) ? out.mappings : [];
  return arr
    .map((m): MappingSuggestion => {
      const o = m as Record<string, unknown>;
      const fn = typeof o.fieldName === 'string' ? o.fieldName.trim() : '';
      return {
        columnIndex: Number(o.columnIndex),
        fieldName: fn ? fn : null,
        confidence: Number(o.confidence) || 0,
        reason: typeof o.reason === 'string' ? o.reason : '',
      };
    })
    .filter((m) => Number.isInteger(m.columnIndex));
}

// ============================================================================
// standardize — a column's distinct values → canonical option / lookup matches
// ============================================================================

export interface StandardizeCandidate {
  // dropdown / multiselect: value + labels. lookup: id + display.
  value?: string;
  label_ar?: string;
  label_en?: string;
  id?: string;
  display?: string;
}

export interface ValueDecisionOut {
  rawValue: string;
  kind: 'match' | 'new' | 'unmatched';
  candidateId: string | null; // lookup match → record id; else null
  canonical: string; // exact option label/value, chosen record display, cleaned new value, or ''
  confidence: number;
  reason: string;
}

const STANDARDIZE_TOOL: Anthropic.Tool = {
  name: 'emit_value_standardization',
  description: 'For each distinct raw cell value, decide how it maps to the target field’s allowed values.',
  input_schema: {
    type: 'object',
    properties: {
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rawValue: { type: 'string', description: 'The distinct raw cell value, verbatim.' },
            kind: {
              type: 'string',
              enum: ['match', 'new', 'unmatched'],
              description: 'match = equals an allowed value; new = none fits, propose creating it; unmatched = cannot decide.',
            },
            candidateId: {
              type: 'string',
              description: 'For kind=match on a LOOKUP field: the id of the chosen existing record. "" otherwise.',
            },
            canonical: {
              type: 'string',
              description:
                'The exact string to store. dropdown/multiselect match: echo the option’s label EXACTLY as given. lookup match: the chosen record’s display EXACTLY. multiselect cell with several values: the canonical labels joined with ", ". kind=new: the cleaned value to create. kind=unmatched: "".',
            },
            confidence: { type: 'number', description: '0..1.' },
            reason: { type: 'string', description: 'Why this maps here (note any Arabic spelling normalization).' },
          },
          required: ['rawValue', 'kind', 'candidateId', 'canonical', 'confidence', 'reason'],
        },
      },
    },
    required: ['decisions'],
  },
};

const STANDARDIZE_SYSTEM = `You standardize the distinct raw values of ONE spreadsheet column so they match the allowed values of a target field in a Saudi Arabian real-estate CRM (Wassel / وصل العقارية). Always call the \`emit_value_standardization\` tool.

You are given the field type, an ALLOWED-VALUES list (numbered), and the DISTINCT raw values. For each distinct raw value decide:
- "match": it means the same as one allowed value. Set "canonical" to that allowed value's label/display ECHOED EXACTLY (character-for-character) as given — never paraphrase, the importer matches by exact string. For a LOOKUP field also set "candidateId" to that record's id.
- "new": no allowed value fits, but it's a legitimate value worth creating. Set "canonical" to a cleaned version of the raw value. (The user approves any creation.)
- "unmatched": you can't confidently decide. Set "canonical" to "".

Rules:
- Normalize Arabic spelling variants when matching: shop forms of taa-marbuta (ة/ه), alef-hamza (أ/إ/ا), ya/alef-maqsura (ي/ى), tatweel (ـ), and diacritics. e.g. "شقه" matches the option "شقة".
- MULTISELECT columns: a single cell may hold several values separated by "," or "،". Treat EACH distinct WHOLE raw cell as one entry, standardize every token in it, and set "canonical" to the matched labels joined with ", ". Never drop a value.
- Match across Arabic/English (a raw "apartment" can match the option "شقة").
- Default to "unmatched" rather than guessing wrong — the user reviews everything.`;

export async function runStandardize(
  apiKey: string,
  input: {
    fieldType: 'dropdown' | 'multiselect' | 'lookup';
    fieldLabel: string;
    candidates: StandardizeCandidate[];
    rawValues: string[];
    language?: AgentLanguage;
  },
): Promise<ValueDecisionOut[]> {
  const isLookup = input.fieldType === 'lookup';
  const allowed = input.candidates
    .map((c, i) => {
      if (isLookup) return `${i + 1}. id=${c.id ?? ''} → "${c.display ?? ''}"`;
      return `${i + 1}. "${c.label_en ?? ''}" / "${c.label_ar ?? ''}"`;
    })
    .join('\n');
  const raw = input.rawValues.map((v, i) => `${i + 1}. "${v}"`).join('\n');
  const userMsg = `FIELD: "${input.fieldLabel}" (type=${input.fieldType})\n\nALLOWED VALUES:\n${allowed || '(none yet — every value would be new)'}\n\nDISTINCT RAW VALUES:\n${raw}`;

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: STANDARDIZE_MODEL,
    max_tokens: 4000,
    system: STANDARDIZE_SYSTEM + langLine(input.language ?? 'ar', 'reason'),
    tools: [STANDARDIZE_TOOL],
    tool_choice: { type: 'tool', name: 'emit_value_standardization' },
    messages: [{ role: 'user', content: userMsg }],
  });
  const tb = response.content.find((b) => b.type === 'tool_use');
  if (!tb || tb.type !== 'tool_use') throw new Error('Standardization model did not respond');
  const out = tb.input as { decisions?: unknown };
  const arr = Array.isArray(out.decisions) ? out.decisions : [];
  return arr.map((d): ValueDecisionOut => {
    const o = d as Record<string, unknown>;
    const kind = o.kind === 'match' || o.kind === 'new' || o.kind === 'unmatched' ? o.kind : 'unmatched';
    const cid = typeof o.candidateId === 'string' && o.candidateId.trim() ? o.candidateId.trim() : null;
    return {
      rawValue: typeof o.rawValue === 'string' ? o.rawValue : '',
      kind,
      candidateId: cid,
      canonical: typeof o.canonical === 'string' ? o.canonical : '',
      confidence: Number(o.confidence) || 0,
      reason: typeof o.reason === 'string' ? o.reason : '',
    };
  });
}
