/**
 * Anthropic helpers for the Data Migration wizard (POST /api/migrate).
 *
 * Four actions, each forced-tool so the model always returns structured JSON:
 *   - extract          : files (PDF/image/CSV-text) → ONE unified raw table. Model-aware
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

/**
 * How extraction reads the files:
 *  - 'records' (default): one logical record per ROW — the classic unit-list /
 *    client-list import.
 *  - 'project': the destination is a PROJECTS model. One row per PROJECT
 *    (normally exactly one) with the project's general information in detail —
 *    units are read deeply but AGGREGATED, never enumerated as rows. The model
 *    additionally writes `document`: a comprehensive Arabic marketing /
 *    reference document for the project (the content writers' source of truth).
 */
export type ExtractMode = 'records' | 'project';

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

/**
 * A model call whose forced-tool output was cut off by the `max_tokens` ceiling.
 * The structured result is incomplete and MUST NOT be persisted — thrown loudly
 * so the wizard surfaces an error + retry instead of silently banking a partial
 * or empty table (the exact silent-failure class CLAUDE.md forbids). The
 * /api/migrate handler maps it to `code:'max_tokens'` so the client can re-batch
 * (split the unit batch in half and retry) rather than fail the whole run.
 */
export class ExtractionTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionTruncatedError';
  }
}

/**
 * Pull the forced tool-call input, failing LOUDLY on truncation or a missing
 * tool block. Shared by every extraction phase (extract / discover / fuse) so
 * none of them can silently return an empty or partial table.
 */
function requireToolInput(
  response: Anthropic.Message,
  toolName: string,
  context: string,
): Record<string, unknown> {
  if (response.stop_reason === 'max_tokens') {
    throw new ExtractionTruncatedError(
      `${context} hit the output token limit before finishing — the result is incomplete and was not saved.`,
    );
  }
  const tb = response.content.find((b) => b.type === 'tool_use' && b.name === toolName);
  if (!tb || tb.type !== 'tool_use') {
    throw new Error(`${context}: the model did not return the expected result.`);
  }
  return tb.input as Record<string, unknown>;
}

/**
 * Appended to the extraction system prompt when the destination has any `table`
 * field, so the model knows to SEGMENT a combined entry into the table's
 * sub-columns and ALIGN multiple entries as parallel lists — instead of dumping
 * a whole phrase ("AC guarantee from ABC for 5 years") into one column. The
 * parallel-list shape is exactly what the importer assembles into table rows
 * (sub-columns zip by index).
 */
const TABLE_FIELDS_RULE = `

TABLE (MULTI-COLUMN) DESTINATION FIELDS:
Some destination fields are TABLES — ONE field that holds MULTIPLE ROWS, each split into named SUB-COLUMNS (shown grouped under "TABLE «…»" in the field list). Do NOT dump a whole entry into a single column. Instead:
- SEGMENT each entry into the table's sub-columns. Example — a Guarantees table with sub-columns (type / company / years) and source text "ضمان تكييف من شركة ABC لمدة 5 سنوات" → type="تكييف", company="ABC", years="5".
- Output ONE COLUMN PER SUB-COLUMN, headed by that sub-column's label.
- For MULTIPLE entries, list them as PARALLEL comma/'،'-separated lists in the SAME ORDER across ALL of that table's sub-columns, so position N lines up into one row — e.g. type="تكييف، سباكة" · company="ABC، XYZ" · years="5، 10" → two rows. Keep the lists the same length; use "" to hold a slot when an entry lacks that sub-column.`;

/**
 * Render the destination-field hunt-list, GROUPING a table field's sub-columns
 * under a "TABLE «…»" header (with the segment-and-align instruction) so the
 * model treats them as one structured field rather than unrelated columns.
 * Scalar fields render flat as before.
 */
function renderHuntList(fields: TargetFieldLite[]): string {
  if (!fields.length) return '';
  const scalars: TargetFieldLite[] = [];
  const tables = new Map<string, { label: string; cols: TargetFieldLite[] }>();
  for (const f of fields) {
    if (f.table) {
      const g = tables.get(f.table.name) ?? { label: `${f.table.label_en} / ${f.table.label_ar}`, cols: [] };
      g.cols.push(f);
      tables.set(f.table.name, g);
    } else {
      scalars.push(f);
    }
  }
  const lines = scalars.map((f) => `- ${f.label_en} / ${f.label_ar} (${f.type})`);
  for (const [, g] of tables) {
    lines.push(
      `- TABLE «${g.label}» — a multi-row field; SEGMENT each entry across these sub-columns and emit one column per sub-column (multiple entries → parallel same-order lists):`,
    );
    for (const c of g.cols) lines.push(`    · ${c.label_en} / ${c.label_ar}`);
  }
  return lines.join('\n');
}

/** True when any destination field is a table sub-column (drives whether the
 * TABLE_FIELDS_RULE is appended to the system prompt). */
function hasTableField(fields: TargetFieldLite[]): boolean {
  return fields.some((f) => !!f.table);
}

/** One uploaded source file, addressed by a short-lived signed URL the client
 * minted from the wassel-migrations bucket (RLS-scoped to the owner). */
export interface ExtractFileInput {
  name: string;
  mimeType: string;
  url: string;
}

/** One titled section of the project-level intelligence layer (mode='project'). */
export interface ProjectIntelligenceSection {
  title: string;
  content: string;
}

export interface RawTableResult {
  headers: string[];
  rows: string[][];
  notes?: string;
  /** Human-readable report of what was extracted — esp. how each numeric column
   * was derived (which text mentions / plan features) and its source. */
  summary?: string;
  /** mode='project' only: the project-level intelligence layer — titled
   * sections (overview, positioning, target audience, design, pricing/area
   * insights…) that explain the PROJECT as a whole. Wizard-facing; persisted
   * on the migration record, never written into the imported record. */
  intelligence?: ProjectIntelligenceSection[];
  /** mode='project' only: the Arabic project knowledge document (source of
   * truth for sales / content / marketing) — saved onto the project record's
   * marketing_document field at import time. */
  document?: string;
  truncated: boolean;
  files_processed: number;
  files_skipped: { name: string; reason: string }[];
}

// Claude vision accepts these image media types only.
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// Spreadsheet/text sources (the client converts .xlsx sheets to CSV text —
// Claude can't ingest raw workbooks) are included as plain text blocks.
const TEXT_MEDIA_TYPES = new Set(['text/csv', 'text/plain', 'text/tab-separated-values']);
const MAX_FILES = 20;
// Keep comfortably under the Anthropic ~32 MB request cap once base64-inflated.
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
// Text files are token-bounded separately (they go into the prompt verbatim).
const MAX_TEXT_CHARS_PER_FILE = 120_000;
const MAX_TEXT_CHARS_TOTAL = 300_000;

function buildExtractTool(mode: ExtractMode): Anthropic.Tool {
  const properties: Record<string, unknown> = {
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
  };
  if (mode === 'project') {
    properties.intelligence = {
      type: 'array',
      description:
        'PROJECT-LEVEL INTELLIGENCE: titled sections that explain the project as a whole (overview, developer, ' +
        'location & neighborhood, concept & positioning, target audience, advantages, amenities, construction status, ' +
        'guarantees, design philosophy, architecture & facades, unit mix, pricing insights, area insights, ' +
        'distinguishing features, unique selling points, anything else important). Concise and factual; ' +
        'OMIT any section the files do not support.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short section title.' },
          content: { type: 'string', description: 'The section briefing — a few sentences or bullet lines ("- ").' },
        },
        required: ['title', 'content'],
      },
    };
    properties.document = {
      type: 'string',
      description:
        'The complete Arabic Project Knowledge Document (Markdown, with headings) — the permanent source of truth ' +
        'for sales / content / marketing teams. Comprehensive: description & story, positioning, location, developer, ' +
        'unit models & categories, design & architecture, construction info, finishes, amenities, guarantees, ' +
        'prices / payment terms as stated, key selling points, competitive advantages, target customer profile, ' +
        'and a quick-facts list. Grounded ONLY in the files — never invent.',
    };
  }
  return {
    name: 'emit_raw_table',
    description:
      mode === 'project'
        ? 'Return the PROJECT-level information extracted from the uploaded files as ONE table (one row per project — ' +
          'normally exactly one row), PLUS the project intelligence sections, PLUS the Arabic Project Knowledge Document.'
        : 'Return ALL tabular data extracted from the uploaded files as ONE unified table. ' +
          'Union every distinct column seen across files into a single header row; a row ' +
          'lacking a column gets an empty string. One logical record per row.',
    input_schema: {
      type: 'object',
      properties,
      required:
        mode === 'project'
          ? ['headers', 'rows', 'truncated', 'intelligence', 'document']
          : ['headers', 'rows', 'truncated'],
    } as Anthropic.Tool['input_schema'],
  };
}

/**
 * Operator guidance block — the free-text instructions the user wrote in the
 * pre-extraction PREP step, plus the clarifications resolved there and the
 * confirmed table structure. Threaded into every extraction phase (discover /
 * fuse / project extract) so the user's intent steers the run. ADDITIVE
 * instruction only — it never licenses cleaning / translating / coercing raw
 * cell values (the verbatim-capture rules still hold).
 */
function renderGuidance(guidance?: string): string {
  const g = (guidance ?? '').trim();
  if (!g) return '';
  return (
    '\n\nOPERATOR GUIDANCE (the user gave this before extraction — FOLLOW it; it overrides the defaults above where they conflict, but never clean / translate / coerce raw cell values):\n' +
    g +
    '\n'
  );
}

const EXTRACT_SYSTEM = `You extract structured data from messy real-estate documents for a Saudi Arabian CRM (Wassel / وصل العقارية). Files are developer hand-offs — unit lists, price tables, project specs, brochures with floor plans — as PDFs, screenshots, photos, or spreadsheet text (CSV converted from Excel, one file per sheet), usually in Arabic.

SPREADSHEET (CSV) FILES:
A CSV file is one sheet of a workbook, raw. Real-world sheets are MESSY: title/logo rows above the real header, merged cells appearing as blanks, repeated header rows, several sub-tables on one sheet, footer notes. Find the real tabular data, use the true header row, fill values implied by merged cells (a project name spanning rows applies to each row), and ignore decoration — same judgment as reading a PDF page.

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

/** Appended to EXTRACT_SYSTEM when mode='project' — overrides the one-row-per-
 * unit framing: the destination is the PROJECTS model, so the operator wants
 * the project itself (plus the intelligence layer + the Arabic knowledge
 * document), never a unit table. */
const EXTRACT_PROJECT_MODE = `

PROJECT-PROFILE MODE — THIS RUN OVERRIDES "one unit per row":
The destination is the PROJECTS model. The operator wants a detailed understanding of the PROJECT as a whole — NOT individual unit records. You produce THREE outputs in one tool call: (1) the migration table, (2) the project intelligence sections, (3) the Arabic Project Knowledge Document.

1) THE TABLE — one row per project:
- Output ONE ROW PER PROJECT (normally exactly one row). NEVER one row per unit — do not produce a unit table.
- Columns = project-level facts, in DETAIL: project name, developer, city / district, location link, project type, construction status, total number of units (as the source states or as you count), unit TYPES / MODELS offered (comma-separated, e.g. "شقة، دوبلكس، فيلا" or model names "نموذج A، نموذج B"), amenities & services, guarantees / warranties (الضمانات), payment terms, handover / completion date, licenses (رخصة البيع على الخارطة، الوسيط العقاري…), and ANY other project-level information the files contain.
- STILL read every unit list and floor plan DEEPLY — but to UNDERSTAND the project as a whole: aggregate what you learn (which models exist, what each model offers, the span of areas / prices / rooms across the project). That understanding feeds the table, the intelligence, and the document — it must NOT become per-unit rows.

2) THE INTELLIGENCE ("intelligence", required) — the project-level understanding layer:
Titled sections, each a concise factual briefing (a few sentences or "- " bullet lines) that together explain the project itself. Cover every dimension the files support — typically:
- نظرة عامة على المشروع (overview) · المطوّر (developer) · الموقع والحي (location & neighborhood)
- مفهوم المشروع وتموضعه (concept & positioning) · الجمهور المستهدف (target audience)
- مزايا المشروع (advantages) · المرافق والخدمات (amenities & facilities) · حالة الإنشاء (construction status)
- الضمانات (guarantees & warranties) · الفلسفة التصميمية (design philosophy) · العمارة والواجهات (architecture & facades)
- مزيج الوحدات وأنواعها (unit mix & types) · رؤى الأسعار (pricing insights) · رؤى المساحات (area insights)
- الملامح المميزة (distinguishing features) · نقاط البيع الفريدة (unique selling points) · plus any other important project-level dimension you find.
Rules: factual and analytical, grounded ONLY in the files. Insights may include arithmetic DERIVED from in-file numbers (e.g. price-per-m² from a stated price and area) — clearly phrased as derived — but NEVER external market knowledge. Where the files imply but don't state a dimension (e.g. target audience implied by unit sizes and tone), say so explicitly ("يُستدل من…"). OMIT dimensions with nothing to support them — no padding.

3) THE DOCUMENT ("document", required) — the Arabic Project Knowledge Document:
A comprehensive Arabic document — the PERMANENT source of truth about this project for the sales, content, and marketing teams, so they understand the entire project without reading brochures, floor plans, or unit tables. Markdown with clear headings. Informative and marketing-oriented prose (not raw extracted data). Cover everything the files support, typically:
- نظرة عامة ووصف كامل للمشروع (complete description) · قصة المشروع وتموضعه (story & positioning)
- الموقع وسهولة الوصول (district, city, nearby landmarks/roads as stated) · المطوّر (who they are, as stated)
- نماذج الوحدات وفئاتها (one subsection PER MODEL/TYPE: its areas, rooms, components — combine the floor plan and the text)
- الفلسفة التصميمية والعمارة والواجهات (design features) · المواصفات والتشطيبات
- معلومات الإنشاء والتسليم · المرافق والخدمات · الضمانات
- الأسعار وخطط السداد (exactly as the source states them)
- أبرز نقاط البيع (key selling points) · المزايا التنافسية (competitive advantages, as supported by the files)
- العميل المستهدف (target customer profile, where supported or clearly implied)
- حقائق سريعة (a closing quick-facts list of the most frequently referenced numbers: prices, areas, yields, dates, contacts)
Rules for the document: write it in Arabic ALWAYS (regardless of the UI language); a confident marketing register but 100% grounded — every claim must come from the files; if the files don't state something, OMIT it (never invent, never pad with generic real-estate filler); keep numbers exactly as the source gives them.`;

function fileExtensionMime(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'pdf': return 'application/pdf';
    case 'csv': return 'text/csv';
    case 'tsv': return 'text/tab-separated-values';
    case 'txt': return 'text/plain';
    default: return null;
  }
}

/**
 * Fetch each signed-URL file (image / PDF / CSV-text) and build Claude content
 * blocks. Spreadsheets arrive as CSV text (the client converts workbooks per
 * sheet) and are inlined as fenced text blocks, char-capped. Skips
 * unsupported/oversized files (reported, never silently dropped).
 * Shared by extract + discuss.
 */
async function buildFileBlocks(
  files: ExtractFileInput[],
  opts: { cacheLast?: boolean } = {},
): Promise<{ blocks: Anthropic.ContentBlockParam[]; skipped: { name: string; reason: string }[]; truncated: boolean; used: number }> {
  const skipped: { name: string; reason: string }[] = [];
  const blocks: Anthropic.ContentBlockParam[] = [];
  let totalBytes = 0;
  let totalTextChars = 0;
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
    const isText = TEXT_MEDIA_TYPES.has(mime);
    if (!isImage && !isPdf && !isText) {
      skipped.push({ name: file.name, reason: `unsupported type "${mime || 'unknown'}" — convert to PNG/JPG/PDF/CSV` });
      continue;
    }

    if (isText) {
      if (totalTextChars >= MAX_TEXT_CHARS_TOTAL) {
        truncated = true;
        skipped.push({ name: file.name, reason: 'total text size limit reached' });
        continue;
      }
      let text: string;
      try {
        const res = await fetch(file.url);
        if (!res.ok) {
          skipped.push({ name: file.name, reason: `download failed (${res.status})` });
          continue;
        }
        text = await res.text();
      } catch (err) {
        skipped.push({ name: file.name, reason: `download error: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      const budget = Math.min(MAX_TEXT_CHARS_PER_FILE, MAX_TEXT_CHARS_TOTAL - totalTextChars);
      let body = text;
      if (body.length > budget) {
        // Cut on a line boundary so the model never sees half a row.
        body = body.slice(0, budget);
        const lastNl = body.lastIndexOf('\n');
        if (lastNl > 0) body = body.slice(0, lastNl);
        body += '\n… (truncated)';
        truncated = true;
      }
      totalTextChars += body.length;
      blocks.push({
        type: 'text',
        text: `File: ${file.name} (spreadsheet/text — CSV content below)\n\`\`\`csv\n${body}\n\`\`\``,
      });
      used += 1;
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

  // Prompt caching: mark the last file block as a cache breakpoint so the whole
  // system + tools + file prefix is cached. Across fusion batches (same files,
  // only the trailing per-batch unit list differs) this turns N re-reads of the
  // brochure/plans into one cache write + cheap cache reads. No-op when there is
  // nothing to cache.
  if (opts.cacheLast && blocks.length > 0) {
    (blocks[blocks.length - 1] as { cache_control?: { type: 'ephemeral' } }).cache_control = {
      type: 'ephemeral',
    };
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
  mode: ExtractMode = 'records',
  guidance?: string,
): Promise<RawTableResult> {
  const { blocks: fileBlocks, skipped, truncated: truncatedInput, used } = await buildFileBlocks(files);
  if (used === 0) {
    throw new Error(
      `No extractable files. ${skipped.map((s) => `${s.name}: ${s.reason}`).join('; ') || 'No files provided.'}`,
    );
  }
  const fieldList = renderHuntList(targetFields);
  const blocks: Anthropic.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        (mode === 'project'
          ? 'Extract the PROJECT-level information from the file(s) below into one table (one row per project — normally exactly one), and write the Arabic marketing document, following the rules.\n\n'
          : 'Extract every record from the file(s) below into one unified table, following the rules.\n\n') +
        (fieldList
          ? 'The destination model cares about these fields — use them as your hunt-list (find a value for each where the source has one; add extra columns for any other useful data; do NOT clean or coerce):\n' +
            fieldList +
            '\n\n'
          : '') +
        "Preserve non-numeric values verbatim; output bare numbers for counts/quantities; deeply analyze the floor plans and combine them with the text to count each unit's components." +
        renderGuidance(guidance),
    },
    ...fileBlocks,
  ];

  const client = new Anthropic({ apiKey });
  const langNote =
    language === 'ar'
      ? '\n\nIMPORTANT: Write your "notes" and "summary" in Arabic (العربية). Never translate or alter the extracted cell DATA itself.'
      : '\n\nIMPORTANT: Write your "notes" and "summary" in English. Never translate or alter the extracted cell DATA itself.';
  const extractTool = buildExtractTool(mode);
  const call = (model: string) =>
    client.messages.create({
      model,
      max_tokens: 16000,
      system:
        EXTRACT_SYSTEM +
        (mode === 'project' ? EXTRACT_PROJECT_MODE : '') +
        (hasTableField(targetFields) ? TABLE_FIELDS_RULE : '') +
        langNote,
      tools: [extractTool],
      tool_choice: { type: 'tool', name: 'emit_raw_table' },
      messages: [{ role: 'user', content: blocks }],
    });

  let response;
  try {
    response = await call(EXTRACT_MODEL);
  } catch {
    response = await call(EXTRACT_FALLBACK_MODEL);
  }

  // Fail LOUDLY on truncation / missing tool — never bank a silent empty table.
  const out = requireToolInput(response, 'emit_raw_table', 'Extraction') as {
    headers?: unknown;
    rows?: unknown;
    notes?: unknown;
    summary?: unknown;
    intelligence?: unknown;
    document?: unknown;
    truncated?: unknown;
  };

  const headers = Array.isArray(out.headers) ? out.headers.map((h) => String(h ?? '')) : [];
  const rawRows = Array.isArray(out.rows) ? out.rows : [];
  const rows: string[][] = rawRows.map((r) =>
    Array.isArray(r) ? r.map((c) => String(c ?? '')) : [],
  );
  // A header row with zero data rows means extraction read nothing usable (or
  // was cut off in a way that dropped the rows array) — surface it, don't save
  // an empty table as if it succeeded.
  if (rows.length === 0) {
    throw new Error(
      'Extraction returned no rows — the model could not read any records from the files.',
    );
  }

  const intelligence: ProjectIntelligenceSection[] | undefined =
    mode === 'project' && Array.isArray(out.intelligence)
      ? out.intelligence
          .map((s) => {
            const o = s as Record<string, unknown>;
            return {
              title: typeof o.title === 'string' ? o.title.trim() : '',
              content: typeof o.content === 'string' ? o.content.trim() : '',
            };
          })
          .filter((s) => s.title && s.content)
      : undefined;

  return {
    headers,
    rows,
    notes: typeof out.notes === 'string' ? out.notes : undefined,
    summary: typeof out.summary === 'string' ? out.summary : undefined,
    intelligence: intelligence && intelligence.length > 0 ? intelligence : undefined,
    document:
      mode === 'project' && typeof out.document === 'string' && out.document.trim()
        ? out.document
        : undefined,
    truncated: Boolean(out.truncated) || truncatedInput,
    files_processed: used,
    files_skipped: skipped,
  };
}

// ============================================================================
// SOURCE-FUSION EXTRACTION (records mode) — discover → fuse_batch
//
// Replaces the single "re-type every cell in one tool call" extract for the
// per-record (units / clients / …) targets, which overflowed the output-token
// cap on any sizable list and silently banked zero rows. Two phases, both
// model-aware and vision-deep, orchestrated by the client (jobRunner):
//   1. discover  — inventory the sources, identify EVERY unit entity across all
//                  files, return a compact unit INDEX (identifiers only) + the
//                  canonical header set. Output stays small (keys only).
//   2. fuse_batch — for a BATCH of units, merge facts about each unit from ALL
//                  sources (sheet + price PDF + brochure + floor plans + images)
//                  into one resolved row, flagging cross-source conflicts. The
//                  client batches the index so no single response can overflow,
//                  prompt-caches the files across batches, and auto-splits a
//                  batch that still truncates.
// ============================================================================

/** One unit entity found during discovery — identifiers only (the heavy facts
 * are resolved later, per batch, in fusion). `key` is stable across phases. */
export interface DiscoveredUnit {
  key: string;
  unit_number?: string;
  model?: string;
  block?: string;
  floor?: string;
  /** Which uploaded files mention this unit (file names / page hints). */
  source_refs?: string[];
}

/** One uploaded file, classified by the discovery phase. */
export interface SourceClassification {
  name: string;
  kind: string;
  note?: string;
}

export interface DiscoverResult {
  /** The canonical header set the fusion phase fills per unit. */
  headers: string[];
  units: DiscoveredUnit[];
  sources: SourceClassification[];
  notes?: string;
  truncated: boolean;
  files_processed: number;
  files_skipped: { name: string; reason: string }[];
}

/** A cross-source disagreement about one unit+field — preserved for human
 * review (never silently resolved). */
export interface UnitFactConflict {
  unitKey: string;
  header: string;
  candidates: { source: string; value: string }[];
  chosen: string;
  note: string;
}

export interface FuseBatchResult {
  /** One row per requested unit key; `values` aligns 1:1 to the given headers. */
  rows: { key: string; values: string[] }[];
  conflicts: UnitFactConflict[];
  notes?: string;
  truncated: boolean;
}

const DISCOVER_SYSTEM = `You are the SOURCE-INVENTORY + UNIT-DISCOVERY phase of a data-migration pipeline for a Saudi Arabian real-estate CRM (Wassel / وصل العقارية). The operator uploaded developer hand-off files for ONE project. They may include a unit price list, an availability sheet, a unit table, a brochure, architectural floor plans, component descriptions, project-level metadata, and images/screenshots — as PDFs, images, or spreadsheet text (CSV). Usually Arabic.

Your job in THIS phase is NOT to output unit data. It is to:
1. INVENTORY the sources — classify what each uploaded file contains.
2. DISCOVER every UNIT ENTITY referenced across ALL files, and return a compact unit INDEX (identifiers only — no full details yet).
3. Propose the CANONICAL HEADER SET — the unified columns the next phase will fill per unit.

Always call the \`emit_unit_index\` tool. Never reply in prose.

SOURCE INVENTORY:
For each file give its kind (one of: unit_table, price_list, availability, brochure, floor_plans, component_descriptions, project_metadata, images, other) and a one-line note on what it holds.

UNIT DISCOVERY:
- A unit entity may be identified by unit number, unit code, model, building/block number, floor, area, price, or a source row/page reference.
- CROSS-REFERENCE: the SAME unit usually appears in several files (e.g. number 104 in the Excel, in the price PDF, and on a floor plan). That is ONE unit, not three — merge them into a single index entry.
- Return ONE entry per distinct unit with a STABLE \`key\`. Prefer the unit number; if numbers repeat across blocks/buildings, qualify the key (e.g. "B1-104"). Fill whatever identifiers you can (unit_number, model, block, floor) and list which sources mention it.
- A spreadsheet is ONE source of units — include its rows, but do NOT assume it lists EVERY unit, nor that a unit missing from it doesn't exist. A unit seen only in the brochure or a floor plan still counts.
- Be COMPLETE: enumerate every individual unit. Do NOT collapse ranges into a summary — the index is identifiers only, so it stays small even for hundreds of units.

CANONICAL HEADERS:
- Use the destination model's fields (given below) as a hunt-list, PLUS any extra useful columns the sources contain. Clear, human-readable labels (Arabic where the data is Arabic). This exact header list is what the next phase fills per unit, so make it the complete set you want resolved.

If the input is too large to enumerate every unit in one response, include as many COMPLETE entries as you can and set "truncated": true. Never invent units.`;

const DISCOVER_TOOL: Anthropic.Tool = {
  name: 'emit_unit_index',
  description:
    'Return the source inventory, the canonical header set, and the index of every distinct unit entity discovered across all uploaded files.',
  input_schema: {
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        description: 'One entry per uploaded file: what it contains.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The file name.' },
            kind: {
              type: 'string',
              description:
                'unit_table | price_list | availability | brochure | floor_plans | component_descriptions | project_metadata | images | other',
            },
            note: { type: 'string', description: 'One line on what this file holds.' },
          },
          required: ['name', 'kind'],
        },
      },
      headers: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The canonical, unified column set the next phase fills per unit (destination-field hunt-list ∪ extra useful source columns). Clear human-readable labels.',
      },
      units: {
        type: 'array',
        description: 'The unit index — ONE entry per distinct unit, identifiers only.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Stable unique key (prefer unit number; qualify if it repeats, e.g. "B1-104").' },
            unit_number: { type: 'string' },
            model: { type: 'string' },
            block: { type: 'string' },
            floor: { type: 'string' },
            source_refs: {
              type: 'array',
              items: { type: 'string' },
              description: 'File names / page hints where this unit appears.',
            },
          },
          required: ['key'],
        },
      },
      notes: { type: 'string', description: 'Ambiguities — duplicate numbers, unreadable regions, units inferred from a plan, etc.' },
      truncated: { type: 'boolean', description: 'True if you could not enumerate every unit in one response.' },
    },
    required: ['headers', 'units', 'truncated'],
  } as Anthropic.Tool['input_schema'],
};

/**
 * Phase 1 — read ALL files, classify them, and return the unit index + the
 * canonical header set. Output is identifiers-only so it does not overflow even
 * for hundreds of units. Fails loudly on truncation / no-units.
 */
export async function runDiscover(
  apiKey: string,
  files: ExtractFileInput[],
  language: AgentLanguage = 'ar',
  targetFields: TargetFieldLite[] = [],
  guidance?: string,
): Promise<DiscoverResult> {
  const { blocks: fileBlocks, skipped, truncated: truncatedInput, used } = await buildFileBlocks(files);
  if (used === 0) {
    throw new Error(
      `No extractable files. ${skipped.map((s) => `${s.name}: ${s.reason}`).join('; ') || 'No files provided.'}`,
    );
  }
  const fieldList = renderHuntList(targetFields);
  const blocks: Anthropic.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        'Inventory the sources and discover every unit across the file(s) below, following the rules.\n\n' +
        (fieldList
          ? "The destination model's fields (use as the header hunt-list):\n" + fieldList + '\n\n'
          : '') +
        'Return the source inventory, the canonical headers, and the complete unit index (identifiers only).' +
        renderGuidance(guidance),
    },
    ...fileBlocks,
  ];

  const client = new Anthropic({ apiKey });
  const langNote =
    language === 'ar'
      ? '\n\nIMPORTANT: Write your "notes" and any source "note" in Arabic (العربية). Keep unit identifiers verbatim.'
      : '\n\nIMPORTANT: Write your "notes" and any source "note" in English. Keep unit identifiers verbatim.';
  // Discovery emits the WHOLE unit index in one response, which is large for a
  // several-hundred-unit project (الماجدية 163 overflowed 16k). Use STREAMING
  // (`messages.stream().finalMessage()`) so we can raise max_tokens past the
  // SDK's non-streaming ceiling — it refuses a plain `create` whose max_tokens
  // implies a >10-min worst case ("Streaming is required…"), but streaming is
  // exempt. This is internal (server↔Anthropic); the /api/migrate request still
  // returns one JSON blob, so it is NOT client-facing SSE. 32000 covers far
  // bigger indexes; a still-larger one trips the loud truncation guard below.
  const call = (model: string) =>
    client.messages
      .stream({
        model,
        max_tokens: 32000,
        system: DISCOVER_SYSTEM + (hasTableField(targetFields) ? TABLE_FIELDS_RULE : '') + langNote,
        tools: [DISCOVER_TOOL],
        tool_choice: { type: 'tool', name: 'emit_unit_index' },
        messages: [{ role: 'user', content: blocks }],
      })
      .finalMessage();

  let response;
  try {
    response = await call(EXTRACT_MODEL);
  } catch {
    response = await call(EXTRACT_FALLBACK_MODEL);
  }

  const out = requireToolInput(response, 'emit_unit_index', 'Unit discovery');
  const headers = Array.isArray(out.headers) ? out.headers.map((h) => String(h ?? '')).filter(Boolean) : [];
  const rawUnits = Array.isArray(out.units) ? out.units : [];
  const seen = new Set<string>();
  const units: DiscoveredUnit[] = [];
  for (const u of rawUnits) {
    const o = u as Record<string, unknown>;
    const key = typeof o.key === 'string' && o.key.trim() ? o.key.trim() : '';
    if (!key || seen.has(key)) continue; // de-dup defensively on the stable key
    seen.add(key);
    units.push({
      key,
      unit_number: typeof o.unit_number === 'string' ? o.unit_number : undefined,
      model: typeof o.model === 'string' ? o.model : undefined,
      block: typeof o.block === 'string' ? o.block : undefined,
      floor: typeof o.floor === 'string' ? o.floor : undefined,
      source_refs: Array.isArray(o.source_refs) ? o.source_refs.map((s) => String(s ?? '')) : undefined,
    });
  }
  if (headers.length === 0 || units.length === 0) {
    throw new Error(
      'Unit discovery found no units in the uploaded files. Check that the files contain a unit list / table, or split a very large input.',
    );
  }
  const sources: SourceClassification[] = (Array.isArray(out.sources) ? out.sources : [])
    .map((s) => {
      const o = s as Record<string, unknown>;
      return {
        name: typeof o.name === 'string' ? o.name : '',
        kind: typeof o.kind === 'string' ? o.kind : 'other',
        note: typeof o.note === 'string' ? o.note : undefined,
      };
    })
    .filter((s) => s.name);

  return {
    headers,
    units,
    sources,
    notes: typeof out.notes === 'string' ? out.notes : undefined,
    truncated: Boolean(out.truncated) || truncatedInput,
    files_processed: used,
    files_skipped: skipped,
  };
}

const FUSE_SYSTEM = `You are the SOURCE-FUSION phase of a data-migration pipeline for a Saudi Arabian real-estate CRM (Wassel / وصل العقارية). You are given the uploaded project files (unit tables, price lists, availability sheets, brochure, floor plans, images, CSV — usually Arabic), a CANONICAL HEADER SET, and a BATCH of specific unit entities to resolve.

For EACH unit in the batch, produce ONE fully-resolved row by MERGING facts about THAT unit from ALL sources:
- Pull each header's value from wherever the sources have it — e.g. unit number / status from the sheet, price from the price list, area from the brochure table, floor from the unit table, facade from the availability sheet.
- FLOOR PLANS (critical): for bedrooms / bathrooms / components, ANALYZE the unit's floor plan. Find the plan for the unit's model (a plan titled "نموذج A1" is the A1 model; units of the same model share a plan) and COUNT from the DRAWING — bathrooms = distinct WC / toilet fixtures, bedrooms = bedroom rooms, plus kitchens, living rooms (صالة), maid's rooms, etc.
- Output BARE NUMBERS for counts/quantities (3, not "3 دورات مياه"). Keep every other value RAW and verbatim ("471.99", "3,434,000", "تاون هاوس") — cleaning / standardization happen LATER with human approval. Use "" for any header a unit genuinely has no source for. NEVER invent or pad.

CONFLICTS — when sources disagree about the SAME unit+field:
- Choose a value, put it in the row, AND record the disagreement in \`conflicts\`: the unit key, the header, EVERY candidate value with its source, your chosen value, and a one-line note.
- Precedence: for COMPONENT COUNTS (bathrooms / bedrooms / rooms) trust the FLOOR PLAN over text or sheets. For PRICE trust the most authoritative / latest price list. Otherwise choose the most likely value but say in the note that it needs human review.
- NEVER silently pick — every disagreement must appear in \`conflicts\`.

Always call the \`emit_fused_units\` tool. Emit EXACTLY one row per requested unit key, with \`values\` aligned 1:1 to the given headers (same length and order). If you cannot fit every requested unit in this response, set "truncated": true (the pipeline will re-batch and retry) — but never emit a half-written row.`;

const FUSE_TOOL: Anthropic.Tool = {
  name: 'emit_fused_units',
  description: 'Return one fully-resolved row per requested unit key (merged across all sources), plus any cross-source conflicts.',
  input_schema: {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        description: 'One entry per requested unit key.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The unit key from the batch, echoed exactly.' },
            values: {
              type: 'array',
              items: { type: 'string' },
              description: 'Cell values aligned 1:1 to the canonical headers (same length and order). "" where no source has it.',
            },
          },
          required: ['key', 'values'],
        },
      },
      conflicts: {
        type: 'array',
        description: 'Every cross-source disagreement, one entry per conflicting unit+field. OMIT if none.',
        items: {
          type: 'object',
          properties: {
            unitKey: { type: 'string' },
            header: { type: 'string', description: 'The canonical header in dispute.' },
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  source: { type: 'string', description: 'Which file/source gave this value.' },
                  value: { type: 'string' },
                },
                required: ['source', 'value'],
              },
            },
            chosen: { type: 'string', description: 'The value you put in the row.' },
            note: { type: 'string', description: 'One line: why this was chosen / whether it needs review.' },
          },
          required: ['unitKey', 'header', 'candidates', 'chosen', 'note'],
        },
      },
      notes: { type: 'string', description: 'Optional batch-level notes.' },
      truncated: { type: 'boolean', description: 'True if you could not resolve every requested unit in one response.' },
    },
    required: ['rows', 'truncated'],
  } as Anthropic.Tool['input_schema'],
};

/**
 * Phase 2 — resolve ONE batch of units by fusing facts across every source.
 * The files are prompt-cached (shared prefix across batches); only the trailing
 * per-batch unit list varies. Fails loudly (ExtractionTruncatedError) on a
 * max_tokens cut-off OR a self-reported truncation, so the client can split the
 * batch and retry instead of banking a partial result.
 */
export async function runFuseBatch(
  apiKey: string,
  files: ExtractFileInput[],
  language: AgentLanguage,
  targetFields: TargetFieldLite[],
  headers: string[],
  units: DiscoveredUnit[],
  guidance?: string,
): Promise<FuseBatchResult> {
  if (headers.length === 0) throw new Error('Fusion requires the canonical headers from discovery.');
  if (units.length === 0) return { rows: [], conflicts: [], truncated: false };

  const { blocks: fileBlocks, used } = await buildFileBlocks(files, { cacheLast: true });
  if (used === 0) throw new Error('Fusion has no readable source files.');

  const headerLine = headers.map((h, i) => `[${i}] ${h}`).join('\n');
  const fieldHints = targetFields.length
    ? '\n\nDestination fields (context only — do NOT coerce values to them):\n' + renderHuntList(targetFields)
    : '';
  const unitLine = units
    .map((u) => {
      const id = [
        u.unit_number ? `no.${u.unit_number}` : '',
        u.model ? `model ${u.model}` : '',
        u.block ? `block ${u.block}` : '',
        u.floor ? `floor ${u.floor}` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return `- key="${u.key}"${id ? ` (${id})` : ''}`;
    })
    .join('\n');

  // Cached prefix = system + tools + [instruction text + file blocks]. Only the
  // trailing batch list changes between batches → cache hits on the heavy files.
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        'Resolve the units listed at the END of this message by fusing the file(s) below, following the rules.\n\n' +
        'CANONICAL HEADERS — your `values` array MUST have EXACTLY this many entries, in THIS order:\n' +
        headerLine +
        fieldHints +
        renderGuidance(guidance),
    },
    ...fileBlocks,
    {
      type: 'text',
      text:
        `UNITS TO RESOLVE IN THIS BATCH (emit one row per key, echoing the key exactly):\n${unitLine}`,
    },
  ];

  const client = new Anthropic({ apiKey });
  const langNote =
    language === 'ar'
      ? '\n\nIMPORTANT: Write "notes" and conflict "note" text in Arabic. Keep cell DATA verbatim.'
      : '\n\nIMPORTANT: Write "notes" and conflict "note" text in English. Keep cell DATA verbatim.';
  const call = (model: string) =>
    client.messages.create({
      model,
      max_tokens: 16000,
      system: FUSE_SYSTEM + (hasTableField(targetFields) ? TABLE_FIELDS_RULE : '') + langNote,
      tools: [FUSE_TOOL],
      tool_choice: { type: 'tool', name: 'emit_fused_units' },
      messages: [{ role: 'user', content }],
    });

  let response;
  try {
    response = await call(EXTRACT_MODEL);
  } catch {
    response = await call(EXTRACT_FALLBACK_MODEL);
  }

  const out = requireToolInput(response, 'emit_fused_units', 'Unit fusion');
  // A self-reported truncation is just as unsafe as a max_tokens cut-off — bounce
  // it so the client splits the batch and retries (never bank a partial batch).
  if (out.truncated === true) {
    throw new ExtractionTruncatedError('Unit fusion could not fit the whole batch in one response.');
  }

  const rawRows = Array.isArray(out.rows) ? out.rows : [];
  const rows = rawRows
    .map((r) => {
      const o = r as Record<string, unknown>;
      const key = typeof o.key === 'string' ? o.key.trim() : '';
      const vals = Array.isArray(o.values) ? o.values.map((v) => String(v ?? '')) : [];
      // Normalize to the header count so a stray short/long row can't misalign.
      const values =
        vals.length === headers.length
          ? vals
          : headers.map((_, i) => vals[i] ?? '');
      return { key, values };
    })
    .filter((r) => r.key);

  const conflicts: UnitFactConflict[] = (Array.isArray(out.conflicts) ? out.conflicts : [])
    .map((c) => {
      const o = c as Record<string, unknown>;
      return {
        unitKey: typeof o.unitKey === 'string' ? o.unitKey : '',
        header: typeof o.header === 'string' ? o.header : '',
        candidates: Array.isArray(o.candidates)
          ? o.candidates.map((x) => {
              const xo = x as Record<string, unknown>;
              return { source: String(xo.source ?? ''), value: String(xo.value ?? '') };
            })
          : [],
        chosen: typeof o.chosen === 'string' ? o.chosen : '',
        note: typeof o.note === 'string' ? o.note : '',
      };
    })
    .filter((c) => c.unitKey && c.header);

  return {
    rows,
    conflicts,
    notes: typeof out.notes === 'string' ? out.notes : undefined,
    truncated: false,
  };
}

// ============================================================================
// suggest_mappings — column → target field
// ============================================================================

export interface TargetFieldLite {
  name: string; // slug, or a range half "slug.min" / "slug.max", or a table sub-column "slug.colName"
  label_ar: string;
  label_en: string;
  type: string;
  required: boolean;
  /** Set when this entry is a SUB-COLUMN of a `table` field — the parent table's
   * name + labels. Lets extraction group the sub-columns and segment + align a
   * table's data into them, instead of treating them as unrelated fields. */
  table?: { name: string; label_ar: string; label_en: string };
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
- A table field appears as one entry per sub-column, "slug.colName" (e.g. "services.col_1"). Map a column to the matching sub-column; a single source cell holding a comma/newline-separated list is split into one table row per item.
- Do not map two different columns to the same field, UNLESS they are the two halves of a range or distinct sub-columns of the same table.
- Be conservative: if no field clearly fits a column, return "" for it. A skipped column is better than a wrong mapping — the user can fix mappings, but a wrong one silently corrupts data.
- Match across languages (an Arabic header can map to an English-labelled field and vice-versa).
- Keep each \`reason\` to a few words (the output must stay compact — wide tables have many columns).
- Emit one entry for EVERY source column index, in order.`;

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
    // One mapping object per column, each with a reason → output grows with the
    // column count. 2000 truncated wide tables (e.g. a 32-column projects
    // export) mid-JSON, so the tool input came back unparseable and we returned
    // ZERO mappings silently. Budget generously for many columns.
    max_tokens: 16000,
    system: SUGGEST_SYSTEM + langLine(input.language ?? 'ar', 'reason'),
    tools: [SUGGEST_TOOL],
    tool_choice: { type: 'tool', name: 'emit_column_mappings' },
    messages: [{ role: 'user', content: userMsg }],
  });
  const tb = response.content.find((b) => b.type === 'tool_use');
  if (!tb || tb.type !== 'tool_use') throw new Error('Mapping model did not respond');
  const out = tb.input as { mappings?: unknown };
  const arr = Array.isArray(out.mappings) ? out.mappings : [];
  // Fail LOUDLY on a truncated tool output (CLAUDE.md: never silently swallow).
  // A cut-off tool JSON yields no usable mappings; returning [] would look to
  // the user like "the AI matched nothing" instead of "it ran out of room".
  if (arr.length === 0 && response.stop_reason === 'max_tokens') {
    throw new Error(
      'The column-mapping response was too long to finish (too many columns). Map the columns manually, or split the table into fewer columns and retry.',
    );
  }
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

// ============================================================================
// PRE-EXTRACTION PLANNING (prep step) — plan
//
// Runs BEFORE any table is extracted. The operator uploads files and (optionally)
// writes instructions; this phase reads the files, follows the instructions,
// surfaces contradictions + unclear items as QUESTIONS, and proposes the table
// STRUCTURE (columns + how each is derived) — a back-and-forth the operator
// drives until satisfied, then triggers the real extraction (discover/fuse/
// extract), which receives the resolved guidance via `renderGuidance`.
// ============================================================================

/** One column the planning phase proposes to produce, with how its values are
 * derived. Mirrors the structure the operator confirms before extraction. */
export interface PlanColumn {
  header: string;
  description: string;
}

/** One open question / contradiction the planning phase surfaces — rendered as
 * an answerable card the operator must resolve before extraction. */
export interface PlanQuestion {
  question: string;
  kind?: string;
  detail?: string;
}

const PLAN_SYSTEM = `You are the PRE-EXTRACTION PLANNING phase of a data-migration pipeline for a Saudi Arabian real-estate CRM (Wassel / وصل العقارية). The operator uploaded developer hand-off files (unit lists, price tables, project specs, brochures with floor plans — PDFs, images, or spreadsheet text, usually Arabic) and may have written INSTRUCTIONS for how they want the data extracted.

Your job in THIS phase is NOT to extract the full table. It is to PLAN the extraction WITH the operator BEFORE any table is produced:
1. READ the files and FOLLOW the operator's instructions.
2. Surface every CONTRADICTION between sources (e.g. the sheet says 3 bedrooms but the floor plan shows 2; two files give different prices for the same unit) as its own QUESTION in "questions".
3. Surface anything UNCLEAR or ambiguous (illegible regions, an instruction you can't apply, a column you're unsure how to fill, an unexpected data shape) as its own QUESTION in "questions".
4. PROPOSE the table STRUCTURE in "proposed_columns": one entry per column you intend to produce, each with the column header AND a short description of HOW you will derive its values (which source, text / floor-plan / both, bare-number vs verbatim).

Always call the \`emit_plan\` tool — never reply in prose.

HOW YOUR QUESTIONS ARE SHOWN (important):
The operator answers your questions as CARDS — a short quiz — and is BLOCKED from starting the extraction until every question is resolved. So:
- Ask ONLY what genuinely needs the operator's decision (a real contradiction, or a real ambiguity you can't resolve from the files + instructions). Don't pad the quiz.
- Phrase each as ONE directly answerable question, as its own entry in "questions". A contradiction between sources → kind:"contradiction" with the competing values in "detail". Something unclear/ambiguous → kind:"clarification".
- Each turn, return the CURRENT open questions ONLY: DROP every question the operator has just answered (never repeat an answered one); add a follow-up only if their answer truly needs one.
- "reply" stays a short conversational message (what you see + your plan) — do NOT also list the questions in prose; they live in the cards.

Rules:
- Write "reply" in the operator's language.
- "proposed_columns" reflects the structure you WILL produce — refine it as the operator answers. Counts / quantities will be BARE NUMBERS; everything else stays RAW and verbatim (no cleaning / translation — that happens later with human approval).
- Set "ready": true and "questions": [] ONLY when no questions remain and the structure is stable; otherwise "ready": false.
- Do NOT output the actual row data here. Planning only.`;

const PLAN_TOOL: Anthropic.Tool = {
  name: 'emit_plan',
  description:
    'Return your pre-extraction plan: a conversational reply, any clarifying questions (contradictions / unclear items), and the proposed table structure (columns + how each is derived).',
  input_schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description:
          'Your conversational message to the operator — what the files contain, your extraction plan, and your open questions.',
      },
      questions: {
        type: 'array',
        description:
          'The CURRENT open questions for the operator, each shown as an answerable card. Include EVERY unresolved contradiction and everything unclear; DROP a question once the operator has answered it. Empty array when nothing remains.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question, phrased so the operator can answer it directly.' },
            kind: { type: 'string', description: '"contradiction" (sources disagree) or "clarification" (unclear / ambiguous).' },
            detail: { type: 'string', description: 'Optional specifics — the conflicting values / units, or why it is unclear.' },
          },
          required: ['question'],
        },
      },
      proposed_columns: {
        type: 'array',
        description: 'The table structure you intend to produce — one entry per column.',
        items: {
          type: 'object',
          properties: {
            header: { type: 'string', description: 'The column header (Arabic where the data is Arabic).' },
            description: {
              type: 'string',
              description:
                "How you will derive this column's values — which source, text / floor-plan / both, bare-number vs verbatim.",
            },
          },
          required: ['header', 'description'],
        },
      },
      ready: {
        type: 'boolean',
        description: 'True when you have no blocking questions and the proposed structure is stable; false while questions remain.',
      },
    },
    required: ['reply'],
  } as Anthropic.Tool['input_schema'],
};

/**
 * The pre-extraction planning turn. Reads the files (vision), follows the
 * operator's instructions, and returns its reply + clarifying questions +
 * proposed table structure. Forced-tool so it always returns structured JSON.
 * Files + instructions + field hunt-list are attached to the LATEST user turn
 * only (re-sending the brochure every turn would balloon cost — same pattern as
 * runDiscuss).
 */
export async function runPlan(
  apiKey: string,
  input: {
    messages: DiscussTurn[];
    instructions?: string;
    fields?: TargetFieldLite[];
    files?: ExtractFileInput[];
    language?: AgentLanguage;
  },
): Promise<{ reply: string; questions: PlanQuestion[]; proposedColumns: PlanColumn[]; ready: boolean }> {
  const instructions = (input.instructions ?? '').trim();

  const fieldList = input.fields?.length
    ? '\n\nDESTINATION FIELDS (your hunt-list — find a value for each where the source has one; add extra useful columns; do NOT coerce values to them):\n' +
      renderHuntList(input.fields)
    : '';

  const fileResult = input.files && input.files.length > 0 ? await buildFileBlocks(input.files) : null;
  const fileBlocks = fileResult?.blocks ?? [];

  const history = input.messages.length ? input.messages : [{ role: 'user' as const, content: '(no message)' }];
  const lastIdx = history.length - 1;
  const convo: Anthropic.MessageParam[] = history.map((m, i): Anthropic.MessageParam => {
    if (i === lastIdx && m.role === 'user') {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `${m.content}` +
              (instructions
                ? `\n\nOPERATOR INSTRUCTIONS (how they want the extraction done):\n${instructions}`
                : '') +
              fieldList +
              (fileBlocks.length > 0
                ? '\n\nThe source file(s) are attached below — read them (including floor plans) to plan the extraction and find any contradictions.'
                : ''),
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
      max_tokens: 4000,
      system: PLAN_SYSTEM + langLine(input.language ?? 'ar', 'reply'),
      tools: [PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'emit_plan' },
      messages: convo,
    });

  let response;
  try {
    response = await call(model);
  } catch {
    response = await call(EXTRACT_FALLBACK_MODEL);
  }

  const tb = response.content.find((b) => b.type === 'tool_use');
  if (!tb || tb.type !== 'tool_use') throw new Error('Planning model did not respond');
  const out = tb.input as {
    reply?: unknown;
    questions?: unknown;
    proposed_columns?: unknown;
    ready?: unknown;
  };
  const questions: PlanQuestion[] = (Array.isArray(out.questions) ? out.questions : [])
    .map((q) => {
      // Defensive: accept a bare string too (older shape) and wrap it.
      if (typeof q === 'string') return { question: q.trim() };
      const o = q as Record<string, unknown>;
      return {
        question: typeof o.question === 'string' ? o.question.trim() : '',
        kind: typeof o.kind === 'string' ? o.kind.trim() : undefined,
        detail: typeof o.detail === 'string' ? o.detail.trim() : undefined,
      };
    })
    .filter((q) => q.question);
  const proposedColumns: PlanColumn[] = (Array.isArray(out.proposed_columns) ? out.proposed_columns : [])
    .map((c) => {
      const o = c as Record<string, unknown>;
      return {
        header: typeof o.header === 'string' ? o.header.trim() : '',
        description: typeof o.description === 'string' ? o.description.trim() : '',
      };
    })
    .filter((c) => c.header);

  return {
    reply: typeof out.reply === 'string' ? out.reply : '',
    questions,
    proposedColumns,
    ready: out.ready === true,
  };
}
