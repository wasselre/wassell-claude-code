import type { AppModel, AppRecord } from '@/types';

/** The custom-UI system model name (matches the seed in seedModels.ts). */
export const DATA_MIGRATION_MODEL_NAME = 'data_migration';

/**
 * Models that are NOT valid migration targets: this model itself, the
 * custom-UI system models (which have no generic record form), and the
 * singleton / sidecar config models. Everything else — clients, units,
 * all_projects, competitors, and any user-built model — is importable.
 */
export const NON_TARGET_MODEL_NAMES = new Set<string>([
  'data_migration',
  'chats',
  'ai_chats',
  'decks',
  'image_chats',
  'chat_templates',
  'site_settings',
  'project_details',
]);

export function listTargetModels(models: AppModel[]): AppModel[] {
  return models.filter((m) => !NON_TARGET_MODEL_NAMES.has(m.name));
}

/**
 * Models whose migration runs in PROJECT-PROFILE mode: extraction returns ONE
 * row per project (the project's general information in detail — units are
 * read deeply but aggregated, never enumerated as a unit table) PLUS an Arabic
 * marketing document that is saved into the project record's
 * `marketing_document` field at import. The document is the content writers'
 * source of truth, so they never have to read unit tables.
 */
export const PROJECT_PROFILE_MODEL_NAMES = new Set<string>(['all_projects']);

export function isProjectProfileTarget(model: AppModel): boolean {
  return PROJECT_PROFILE_MODEL_NAMES.has(model.name);
}

/** Target-model field slug that receives the generated marketing document. */
export const MARKETING_DOC_FIELD = 'marketing_document';

/** Target-model field slug (all_projects) that receives the rendered project
 * analysis — the extraction's intelligence sections (overview, location, pricing,
 * audience…) flattened into one Markdown document. */
export const ANALYSIS_DOC_FIELD = 'project_analysis';

/** One titled section of the project-level intelligence layer (PROJECT-PROFILE
 * mode): overview, concept & positioning, target audience, design philosophy,
 * pricing/area insights… Wizard-facing understanding of the whole project. */
export interface ProjectIntelligenceSection {
  title: string;
  content: string;
}

/** Fine-grained wizard position, persisted on `record.data.step`. */
export type MigrationStep =
  | 'pick_model'
  | 'upload'
  | 'extracting'
  | 'review_raw'
  | 'mapping'
  | 'standardize'
  | 'preview'
  | 'migrating'
  | 'done';

export const MIGRATION_STEP_ORDER: MigrationStep[] = [
  'pick_model',
  'upload',
  'review_raw',
  'mapping',
  'standardize',
  'preview',
  'done',
];

/** Coarse list-pill state, persisted on `record.data.status`. */
export type MigrationStatus = 'draft' | 'extracting' | 'migrating' | 'done' | 'failed';

/**
 * One unit entity discovered across all uploaded sources (records-mode
 * source-fusion, phase 1). Identifiers only — the heavy per-unit facts are
 * resolved later, per batch, in the fusion phase. `key` is stable across phases.
 */
export interface DiscoveredUnit {
  key: string;
  unit_number?: string;
  model?: string;
  block?: string;
  floor?: string;
  source_refs?: string[];
}

/**
 * A cross-source disagreement about one resolved unit+column, preserved for
 * human review in the review step. The chosen value already sits in the row —
 * this is the audit trail (which sources said what, what was picked, why).
 */
export interface RawCellConflict {
  rowKey: string;
  header: string;
  candidates: { source: string; value: string }[];
  chosen: string;
  note: string;
}

/**
 * A flat raw table — the exact shape `readExcelFile` returns and
 * `mapImportedRows` consumes (src/lib/excelUtils.ts). Multiselect cells stay
 * multi-value as comma / `،`-separated text; they are split into arrays at
 * import time, never collapsed to a single value.
 */
export interface RawTable {
  headers: string[];
  rows: string[][];
  /** Where the table came from — drives the review banner. */
  source?: 'ai_extract' | 'excel_upload' | 'manual';
  /** AI-extraction notes / ambiguities, surfaced to the user. */
  notes?: string;
  /** AI's plain-English report of what it extracted — esp. how each number was
   * derived (text mentions / floor-plan features) and its source. Seeds the
   * first message of the post-extraction discussion. */
  summary?: string;
  /** True if extraction could not include every page/row of the input. */
  truncated?: boolean;
  pages_processed?: number;
  /** Source-fusion (records mode): cross-source disagreements flagged for human
   * review. The chosen value is already in `rows`; this is the audit trail. */
  conflicts?: RawCellConflict[];
  /** Source-fusion: per-file classification from the discovery phase. */
  sources?: { name: string; kind: string; note?: string }[];
  /** Source-fusion: the stable unit key per row, index-aligned to `rows`. */
  row_keys?: string[];
}

/**
 * Freeform JSON stored on a `data_migration` record's `data`. Grows across
 * build phases — standardization plans and the result summary are added with
 * their step. `record.data` is `Record<string, unknown>`; read it through
 * `readMigrationData` to get this typed view.
 */
export interface MigrationData {
  title?: string;
  /** Optional sidebar group/folder label. Migrations with the same `group`
   * render under one collapsible header; empty/undefined = "Ungrouped". */
  group?: string;
  status?: MigrationStatus;
  step?: MigrationStep;
  target_model_id?: string;
  error_message?: string | null;
  /** Realtime progress sub-phase for the async (worker) steps. */
  phase?: string;
  raw_table?: RawTable;
  /** PROJECT-PROFILE mode only: the Arabic Project Knowledge Document the
   * extraction wrote about the project. Editable in the review step; injected
   * into the target record's `marketing_document` field by buildMigrationPlan. */
  project_document?: string;
  /** PROJECT-PROFILE mode only: the project-level intelligence sections —
   * shown read-only in the review step; persisted here for later reference,
   * never written into the imported record (the document is the permanent
   * artifact). */
  project_intelligence?: ProjectIntelligenceSection[];
  /** Uploaded source files (storage paths) — kept so the post-extraction
   * discussion can re-read the brochure (incl. floor plans). */
  source_files?: { path: string; name: string; mimeType: string; size: number }[];
  /** Column index → target field slug (`slug` or range `slug.min`/`slug.max`), or null to skip. */
  mappings?: Record<number, string | null>;
  /** Raw AI suggestions (confidence/reason) shown next to each column in the mapping step. */
  mapping_suggestions?: ColumnMappingSuggestion[];
  /** Per dropdown/multiselect/lookup column: the value-standardization plan + decisions. */
  standardization?: Record<number, ColumnStandardization>;
  /** The post-extraction discussion: the AI's extraction summary is seeded as
   * the first assistant turn, then the operator and AI chat about the data. */
  chat?: ChatMessage[];
  /** Source row indices the user un-approved in the preview step (not migrated). */
  excluded_rows?: number[];
  /** Final import summary, set when status='done'. */
  result?: MigrationResult;
}

/** One turn in the post-extraction discussion (summary + operator chat). */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts?: string;
}

export interface ColumnMappingSuggestion {
  columnIndex: number;
  fieldName: string | null;
  confidence: number;
  reason: string;
}

export type StandardizableType = 'dropdown' | 'multiselect' | 'lookup';

export type ValueDecisionKind =
  | 'option' // dropdown/multiselect: store this option value
  | 'lookup_record' // lookup: link this existing record id
  | 'create_option' // dropdown/multiselect: create a new option
  | 'create_record' // lookup: create a new target record
  | 'unmatched' // leave blank
  | 'route_to_field'; // send this value's rows to a DIFFERENT target field

/**
 * How a ROUTED value resolves against its DESTINATION field — the exact same set
 * of choices a non-routed value has (match an existing option / record, create a
 * new one, or leave blank), just applied to the field it was moved to. Only the
 * resolution kinds make sense here (a routed value can't itself be re-routed).
 * Absent on a `route_to_field` decision = legacy deterministic match-or-fail.
 */
export interface RouteResolution {
  kind: 'option' | 'create_option' | 'lookup_record' | 'create_record' | 'unmatched';
  optionValue?: string; // kind=option — the destination option's value
  recordId?: string; // kind=lookup_record — the destination lookup record id
  newLabel?: string; // kind=create_option | create_record — label of the value to create
}

/** One distinct raw value in a standardizable column + the AI proposal and the
 * user's resolved decision (defaults to the proposal until they change it). */
export interface ValueDecision {
  raw: string;
  count: number;
  proposal: {
    kind: ValueDecisionKind;
    optionValue?: string;
    recordId?: string;
    label: string;
    confidence: number;
    reason?: string;
  };
  decision: {
    kind: ValueDecisionKind;
    optionValue?: string; // kind=option
    recordId?: string; // kind=lookup_record
    newLabel?: string; // kind=create_option | create_record
    routeFieldName?: string; // kind=route_to_field — a different target field's slug
    routeValue?: string; // the value to write into that other field
    /** kind=route_to_field — how the routed value resolves in the destination
     * field (controlled destinations only). Absent = legacy match-or-fail. */
    routeDecision?: RouteResolution;
  };
}

export interface ColumnStandardization {
  colIndex: number;
  fieldName: string; // the column's primary mapped field slug
  fieldType: StandardizableType;
  values: ValueDecision[];
}

// ─── Strict migration plan (preview + migrate share it) ─────────────────────

/** A dropdown/multi-select option that will be added to the model schema at
 * migration time (only if its rows actually migrate). `value` is the
 * deterministic slug (`slugifyOptionLabel`); records already store it. */
export interface PendingNewOption {
  fieldId: string;
  fieldName: string;
  fieldLabel: string;
  label: string; // the new option's display label (editable before migrating)
  value: string; // deterministic machine value (slug)
  /** Target model is frozen — options are JSONB-schema-only so this is still
   * safe (no DDL); surfaced for transparency, not a blocker. */
  frozen: boolean;
}

/** A lookup-target record that will be created at migration time. `tempId` is
 * assigned at build time and reused as the real record id when created, so the
 * main records' links resolve without a second mapping pass. */
export interface PendingNewLookupRecord {
  tempId: string;
  targetModelId: string;
  targetModelLabel: string;
  displayField: string;
  label: string; // raw value → written as the display field value
}

export type RowIssueSeverity = 'error' | 'warning';

export type RowIssueCode =
  | 'unresolved_option' // controlled value didn't match any option and wasn't blanked
  | 'unresolved_lookup' // lookup value didn't match a record / pending create
  | 'required_blank' // a required field has no value
  | 'route_invalid' // a routed value can't be resolved for its destination field
  | 'create_blocked' // create-new can't run (target requires fields we can't fill)
  | 'invalid_number' // numeric/range cell couldn't be parsed
  | 'invalid_value'; // catch-all for an otherwise-unstorable value

/** One validation problem on a built record. `error` blocks the row from
 * migrating; `warning` is shown but doesn't block. */
export interface RowIssue {
  fieldName: string;
  fieldLabel: string;
  severity: RowIssueSeverity;
  code: RowIssueCode;
  raw?: string; // the offending raw value, when relevant
  detail?: string; // extra human context (e.g. the blocked-create reason)
}

/** What happened to a single controlled-field cell — drives the auditable
 * preview (raw → resolved, with a marker for links/creates/routes/blanks). */
export interface PreviewCellMeta {
  raw: string;
  action: 'option' | 'create_option' | 'link' | 'create_record' | 'route' | 'blank' | 'invalid';
  /** Destination field slug when action='route'. */
  routeFieldName?: string;
}

/** One record that WOULD be created, tagged with its source row + full audit. */
export interface BuiltRecord {
  rowIndex: number;
  data: Record<string, unknown>;
  issues: RowIssue[];
  /** fieldName → audit meta for controlled fields (raw value + the action taken). */
  audit: Record<string, PreviewCellMeta>;
}

export interface MigrationResult {
  imported: number;
  skipped: number;
  new_lookup_records: number;
  /** New dropdown/multi-select options added to the model schema. */
  new_options: number;
  /** Rows that were not migrated because they had blocking validation errors. */
  invalid_skipped: number;
  errors: { id?: string; error: string }[];
}

export function readMigrationData(record: AppRecord): MigrationData {
  return (record.data ?? {}) as MigrationData;
}
