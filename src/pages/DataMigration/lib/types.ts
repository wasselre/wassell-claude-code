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
}

/**
 * Freeform JSON stored on a `data_migration` record's `data`. Grows across
 * build phases — standardization plans and the result summary are added with
 * their step. `record.data` is `Record<string, unknown>`; read it through
 * `readMigrationData` to get this typed view.
 */
export interface MigrationData {
  title?: string;
  status?: MigrationStatus;
  step?: MigrationStep;
  target_model_id?: string;
  error_message?: string | null;
  /** Realtime progress sub-phase for the async (worker) steps. */
  phase?: string;
  raw_table?: RawTable;
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
  };
}

export interface ColumnStandardization {
  colIndex: number;
  fieldName: string; // the column's primary mapped field slug
  fieldType: StandardizableType;
  values: ValueDecision[];
}

export interface MigrationResult {
  imported: number;
  skipped: number;
  new_lookup_records: number;
  errors: { id?: string; error: string }[];
}

export function readMigrationData(record: AppRecord): MigrationData {
  return (record.data ?? {}) as MigrationData;
}
