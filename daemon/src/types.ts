// Mirror of the presentation shapes in `src/types/index.ts`. We duplicate them
// here rather than import from the frontend because the daemon has its own
// tsconfig and its own dependency tree. Keep in sync if the frontend types
// change — nothing enforces it automatically today (room for a lint script
// later).

export type PresentationJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled';

export type PresentationErrorCode =
  | 'chrome_session_expired'
  | 'drive_upload_failed'
  | 'claude_error'
  | 'timeout'
  | 'daemon_restarted'
  | 'validation_failed'
  | 'unknown';

export type PresentationInputType = 'text' | 'textarea' | 'number' | 'date' | 'dropdown';
export type PresentationInputSource = 'user' | 'record_field';

export interface PresentationInputDropdownOption {
  value: string;
  label_ar: string;
  label_en: string;
}

export interface PresentationInput {
  name: string;
  label_ar: string;
  label_en: string;
  type: PresentationInputType;
  required: boolean;
  source: PresentationInputSource;
  record_field?: string;
  default_value?: string | number;
  placeholder_ar?: string;
  placeholder_en?: string;
  options?: PresentationInputDropdownOption[];
}

export interface PresentationRecordBinding {
  model_slug: string;
  optional: boolean;
}

export interface PresentationTemplate {
  id: string;
  slug: string;
  label_ar: string;
  label_en: string;
  description_ar?: string | null;
  description_en?: string | null;
  command: string;
  icon: string;
  input_schema: PresentationInput[];
  record_binding: PresentationRecordBinding | null;
  estimated_duration_seconds: number | null;
  is_available: boolean;
  manifest_path: string | null;
  manifest_synced_at: string;
  created_at: string;
  updated_at: string;
}

/** Shape the daemon expects to find in each `template.json` on disk. */
export interface TemplateManifest {
  /** Stable UUID for this template. Survives renames. Re-use the same id
   *  across users/machines so jobs queued on one machine make sense on
   *  another. */
  id: string;
  slug: string;
  label_ar: string;
  label_en: string;
  description_ar?: string;
  description_en?: string;
  command: string;
  icon?: string;
  inputs: PresentationInput[];
  record_binding?: PresentationRecordBinding;
  estimated_duration_seconds?: number;
}

export interface PresentationJobResult {
  ok: boolean;
  drive_folder_url?: string;
  drive_deck_url?: string;
  drive_sheet_url?: string;
  local_paths?: Record<string, string>;
  warnings?: string[];
  research_stats?: {
    filled: number;
    total: number;
    gaps: number;
    conflicts: number;
  };
}

export interface PresentationJob {
  id: string;
  template_id: string;
  template_slug: string;
  template_snapshot: PresentationTemplate;
  record_id: string | null;
  record_model_id: string | null;
  record_snapshot: Record<string, unknown> | null;
  inputs: Record<string, unknown>;
  client_dedup_key: string | null;
  requested_by_user_id: string | null;
  status: PresentationJobStatus;
  progress_stage: string | null;
  progress_message_ar: string | null;
  progress_message_en: string | null;
  claimed_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  result: PresentationJobResult | null;
  drive_folder_url: string | null;
  drive_deck_url: string | null;
  error_code: PresentationErrorCode | null;
  error_message: string | null;
  error_detail: string | null;
  created_at: string;
  updated_at: string;
}
