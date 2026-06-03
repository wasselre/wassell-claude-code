/**
 * Anthropic helpers for the Data Migration wizard (POST /api/migrate).
 *
 * Four actions, each forced-tool so the model always returns structured JSON:
 *   - extract          : files (PDF/image) → ONE unified raw table. Model-aware
 *                        (given the target model's fields as a hunt-list),
 *                        numeric (bare numbers for counts/quantities), and
 *                        plan-deep (counts a unit's components from its floor
 *                        plan, combined with the text). Returns a `summary`.
 *   - suggest_mappings : raw headers + sample rows + target fields → column→field map
 *   - standardize      : a dropdown/multiselect/lookup column's distinct values →
 *                        canonical option / lookup matches
 *   - discuss          : multi-turn chat about the extracted table — explain how
 *                        a value was derived, or revise the table (recount / add
 *                        / fill a column by re-reading the brochure)
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
  /** Human-readable report of what was extracted — esp. how each numeric column
   * was derived (which text mentions / plan features) and its source. */
  summary?: string;
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
      summary: {
        type: 'string',
        description:
          'A short report of what you extracted, for the operator to verify. For EVERY numeric column (counts, prices, areas) state how you derived the values — which text mentions and/or which floor-plan features you counted — and the source of each (text / plan / both). Mention any unit where the plan and text disagreed and which you trusted.',
      },
      truncated: {
        type: 'boolean',
        description: 'True if you could not include every row/page because the input was larger than what fits in one response.',
      },
    },
    required: ['headers', 'rows', 'truncated'],
  },
};

const EXTRACT_SYSTEM = `You extract structured data from messy real-estate documents for a Saudi Arabian CRM (Wassel / وصل العقارية). Files are developer hand-offs — unit lists, price tables, project specs, brochures with floor plans — as PDFs, screenshots, or photos, usually in Arabic.

Always call the \`emit_raw_table\` tool — never reply in prose.

WHAT TO LOOK FOR — the destination model's fields:
You are given the list of fields the destination cares about. Use it ONLY to know what information to hunt for: find a value for each field wherever the source has one, and make it a column. This is GUIDANCE, not a constraint:
- Do NOT normalize, translate, reformat, standardize spelling, or coerce values to match those fields or the system. Capture values RAW and verbatim ("120 م²", "450,000 ر.س", "شقه"). Cleaning + matching happen LATER with human approval — your only job here is faithful, COMPLETE capture of the right information.
- If the source has other useful data beyond those fields, ADD extra columns for it. More signal is good.

NUMBERS — output bare numbers:
For any data that is a count or quantity (bathrooms, bedrooms, kitchens, floors, parking, price, area…), put a PLAIN NUMBER in the cell — \`3\`, never "3 دورات مياه" / "ثلاث حمامات" / "3 bathrooms". (A measurement column may keep its unit only if the column is inherently a measurement; pure counts are bare integers.)

FLOOR PLANS — analyze them deeply (critical):
Brochures include architectural floor plans. For every plan:
- Work out which unit it belongs to — match by the unit/type label that appears BOTH on the plan and in the text (a plan titled "نموذج A1" is the A1 unit). Units of the same type share one plan.
- COUNT the unit's components from the DRAWING: bathrooms = distinct WC / toilet fixtures, bedrooms = bedroom rooms, plus kitchens, living rooms (صالة), maid's rooms, etc.
- COMBINE the plan with the text for the same unit — they are two views of one unit. When the plan and the text DISAGREE, TRUST THE PLAN (it is ground truth). Resolve ambiguities like "2 دورة مياة" + "الجناح الرئيسي يحتوي على دورة مياة" by counting the fixtures actually drawn (here: 3, not 2).

ONE TABLE:
1. Merge every table / list across all files into ONE table; union columns (same concept → same column); a row missing a column gets "".
2. One logical record per row (one unit per row).
3. Keep Arabic in Arabic; keep a multi-value cell (e.g. amenities) comma-separated — never drop any value.
4. Use clear, human-readable headers (from the source, or your own where you derived a column like a plan-based count).
5. If the input is larger than you can faithfully fit, extract as many COMPLETE rows as possible and set "truncated": true. Never invent or pad.`;

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
 * Fetch each signed-URL file (image/PDF) and build Claude content blocks.
 * Skips unsupported/oversized files (reported, never silently dropped).
 * Shared by extract + discuss.
 */
async function buildFileBlocks(
  files: ExtractFileInput[],
): Promise<{ blocks: Anthropic.ContentBlockParam[]; skipped: { name: string; reason: string }[]; truncated: boolean; used: number }> {
  const skipped: { name: string; reason: string }[] = [];
  const blocks: Anthropic.ContentBlockParam[] = [];
  let totalBytes = 0;
  let used = 0;
  let truncated = false;

  for (const file of files) {
    if (used >= MAX_FILES) {
      truncated = true;
      skipped.push({ name: file.name, reason: 'file limit reached' });
      continue;
    }
    const mime = (file.mimeType && file.mimeType !== 'application/octet-stream')
      ? file.mimeType
      : (fileExtensionMime(file.name) ?? file.mimeType);

    const isImage = IMAGE_MEDIA_TYPES.has(mime);
    const isPdf = mime === 'application/pdf';
    if (!isImage && !isPdf) {
      skipped.push({ name: file.name, reason: `unsupported type "${mime || 'unknown'}" — convert to PNG/JPG/PDF` });
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
      truncated = true;
      skipped.push({ name: file.name, reason: 'total upload size limit reached' });
      continue;
    }
    totalBytes += bytes.byteLength;
    const data = Buffer.from(bytes).toString('base64');

    blocks.push({ type: 'text', text: `File: ${file.name}` });
    if (isImage) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime as 'image/png', data } });
    } else {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    }
    used += 1;
  }

  return { blocks, skipped, truncated, used };
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
  targetFields: TargetFieldLite[] = [],
): Promise<RawTableResult> {
  const { blocks: fileBlocks, skipped, truncated: truncatedInput, used } = await buildFileBlocks(files);
  if (used === 0) {
    throw new Error(
      `No extractable files. ${skipped.map((s) => `${s.name}: ${s.reason}`).join('; ') || 'No files provided.'}`,
    );
  }
  const fieldList = targetFields.length
    ? targetFields.map((f) => `- ${f.label_en} / ${f.label_ar} (${f.type})`).join('\n')
    : '';
  const blocks: Anthropic.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        'Extract every record from the file(s) below into one unified table, following the rules.\n\n' +
        (fieldList
          ? 'The destination model cares about these fields — use them as your hunt-list (find a value for each where the source has one; add extra columns for any other useful data; do NOT clean or coerce):\n' +
            fieldList +
            '\n\n'
          : '') +
        "Preserve non-numeric values verbatim; output bare numbers for counts/quantities; deeply analyze the floor plans and combine them with the text to count each unit's components.",
    },
    ...fileBlocks,
  ];

  const client = new Anthropic({ apiKey });
  const langNote =
    language === 'ar'
      ? '\n\nIMPORTANT: Write your "notes" and "summary" in Arabic (العربية). Never translate or alter the extracted cell DATA itself.'
      : '\n\nIMPORTANT: Write your "notes" and "summary" in English. Never translate or alter the extracted cell DATA itself.';
  const call = (model: string) =>
    client.messages.create({
      model,
      max_tokens: 16000,
      system: EXTRACT_SYSTEM + langNote,
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
    summary?: unknown;
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
    summary: typeof out.summary === 'string' ? out.summary : undefined,
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

// ============================================================================
// discuss — a multi-turn chat about the extracted table. The operator asks the
// AI to explain its work (especially how it derived each number from the floor
// plans + text) and/or to revise the table (add / fill / recount a column,
// re-read the brochure). The model replies conversationally and may return
// column edits the client merges. Supersedes the old one-shot "enrich"; step-2
// counting was removed — counting now happens during extraction.
// ============================================================================

export interface EnrichColumn {
  header: string;
  values: string[]; // one per table row, in row order; '' = unknown
}

export interface DiscussTurn {
  role: 'user' | 'assistant';
  content: string;
}

const DISCUSS_ROW_CAP = 250;

const DISCUSS_TOOL: Anthropic.Tool = {
  name: 'emit_discussion',
  description:
    'Reply to the operator about the extracted table. ALWAYS include "reply". ' +
    'Only include "columns" when the operator asked you to add / fill / recount / fix data.',
  input_schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description:
          "Your conversational answer — explain your reasoning, cite the source (text / floor plan / both), or describe the change you made.",
      },
      columns: {
        type: 'array',
        description: 'OMIT unless the operator asked to change the table. Each entry adds (new header) or fills/replaces (existing header) one column.',
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'EXACT existing header (to fill/replace that column) or a new header (to add one).' },
            values: {
              type: 'array',
              items: { type: 'string' },
              description: 'One value per table row, in the SAME ORDER as the rows given (row 0 first). "" where unknown.',
            },
          },
          required: ['header', 'values'],
        },
      },
    },
    required: ['reply'],
  },
};

const DISCUSS_SYSTEM = `You are discussing an EXTRACTED data table with the operator of a Saudi Arabian real-estate CRM (Wassel / وصل العقارية). The table was just extracted from developer files — brochures with floor plans, price lists, specs. Always call the emit_discussion tool.

In this chat you:
- ANSWER the operator's question conversationally in "reply". When they ask how you got a value — especially a NUMBER — explain which text mentions and/or which floor-plan features you counted, and the source (text / plan / both).
- When they ask you to add, fill, recount, or fix data, ALSO return the affected column(s) in "columns" (one value per table row, in row order). For counts, re-read the attached floor plans and combine them with the text — the plan is ground truth on disagreement. Otherwise OMIT "columns" entirely.

Rules:
- Output bare numbers for counts/quantities (3, not "3 دورات مياه").
- Do NOT clean / normalize / coerce values to the system — keep them raw (cleaning happens later with approval). You may add a column, fill blanks, or correct a value the operator flags as wrong.
- Use "" for any row you genuinely cannot determine — NEVER fabricate.
- Answer in the language of the data (Arabic data → Arabic).`;

export async function runDiscuss(
  apiKey: string,
  input: {
    messages: DiscussTurn[];
    headers: string[];
    rows: string[][];
    fields?: TargetFieldLite[];
    files?: ExtractFileInput[];
    language?: AgentLanguage;
  },
): Promise<{ reply: string; columns: EnrichColumn[]; truncated: boolean }> {
  const rowsForAi = input.rows.slice(0, DISCUSS_ROW_CAP);
  const truncated = input.rows.length > DISCUSS_ROW_CAP;

  const tableText =
    `| # | ${input.headers.join(' | ')} |\n` +
    rowsForAi
      .map((r, i) => `| ${i} | ${input.headers.map((_, c) => (r[c] ?? '').replace(/\|/g, '/')).join(' | ')} |`)
      .join('\n');

  const fieldList = input.fields?.length
    ? '\n\nDESTINATION FIELDS (context only — do NOT coerce values to them):\n' +
      input.fields.map((f) => `- ${f.label_en} / ${f.label_ar} (${f.type})`).join('\n')
    : '';

  const fileResult = input.files && input.files.length > 0 ? await buildFileBlocks(input.files) : null;
  const fileBlocks = fileResult?.blocks ?? [];

  const history = input.messages.length ? input.messages : [{ role: 'user' as const, content: '(no message)' }];
  const lastIdx = history.length - 1;
  const convo: Anthropic.MessageParam[] = history.map((m, i): Anthropic.MessageParam => {
    // Attach the table + fields + source files to the LATEST user turn only
    // (re-sending the brochure on every turn would balloon cost).
    if (i === lastIdx && m.role === 'user') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `${m.content}\n\nCURRENT TABLE (${rowsForAi.length} rows; any "columns" you return must align to these row numbers):\n${tableText}${fieldList}` +
              (fileBlocks.length > 0 ? '\n\nThe source file(s) are attached below — re-read them (including floor plans) as needed.' : ''),
          },
          ...fileBlocks,
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  const client = new Anthropic({ apiKey });
  // Vision model when files are attached (reading the brochure); else Sonnet.
  const model = fileBlocks.length > 0 ? EXTRACT_MODEL : MAP_MODEL;
  const call = (m: string) =>
    client.messages.create({
      model: m,
      max_tokens: 8000,
      system: DISCUSS_SYSTEM + langLine(input.language ?? 'ar', 'reply'),
      tools: [DISCUSS_TOOL],
      tool_choice: { type: 'tool', name: 'emit_discussion' },
      messages: convo,
    });

  let response;
  try {
    response = await call(model);
  } catch {
    response = await call(EXTRACT_FALLBACK_MODEL);
  }

  const tb = response.content.find((b) => b.type === 'tool_use');
  if (!tb || tb.type !== 'tool_use') throw new Error('Discussion model did not respond');
  const out = tb.input as { reply?: unknown; columns?: unknown };
  const rawCols = Array.isArray(out.columns) ? out.columns : [];
  const columns: EnrichColumn[] = rawCols
    .map((c) => {
      const o = c as Record<string, unknown>;
      return {
        header: typeof o.header === 'string' ? o.header.trim() : '',
        values: Array.isArray(o.values) ? o.values.map((v) => String(v ?? '')) : [],
      };
    })
    .filter((c) => c.header);

  return {
    reply: typeof out.reply === 'string' ? out.reply : '',
    columns,
    truncated,
  };
}
