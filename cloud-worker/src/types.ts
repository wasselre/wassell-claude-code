// Mirrored from src/types/index.ts — kept narrow on purpose. The cloud
// worker only needs the fields it reads/writes, not the full PresentationJob
// shape the frontend uses.

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

export type PresentationToolName =
  | 'web_search'
  | 'web_fetch'
  | 'code_execution'
  | 'record_lookup'
  | 'drive_upload';

export type PresentationStepKind = 'research' | 'outline' | 'build' | 'review' | 'custom';

export interface PresentationStep {
  id: string;
  kind: PresentationStepKind;
  label_ar?: string;
  label_en?: string;
  prompt: string;
  tools: PresentationToolName[];
}

export interface PresentationTemplateRow {
  id: string;
  slug: string;
  label_ar: string;
  label_en: string;
  tools: PresentationToolName[];
  steps: PresentationStep[];
  is_user_authored: boolean;
}

export type PresentationStepOutputStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface PresentationStepOutput {
  step_id: string;
  kind: PresentationStepKind;
  status: PresentationStepOutputStatus;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  output_text?: string;
  tool_calls?: Array<{ name: string; ok: boolean }>;
  drive_url?: string;
  usage?: { input_tokens: number; output_tokens: number };
  error?: string;
}

export interface PresentationJobRow {
  id: string;
  template_id: string;
  template_slug: string;
  /** Frozen template snapshot — Phase 3 reads `tools` and `steps` from here
   *  so an in-flight job isn't disturbed if the template is edited mid-run. */
  template_snapshot: PresentationTemplateRow;
  status: PresentationJobStatus;
  inputs: Record<string, unknown>;
  record_id: string | null;
  record_model_id: string | null;
  claimed_by: string | null;
  started_at: string | null;
  /** Phase 3.1 — present when the job was queued for re-run (a Retry from
   *  a particular step). The runner reads this on claim and skips any
   *  steps already marked `completed`, resuming from the first `pending`
   *  one. Empty/undefined for first-run jobs. */
  step_outputs?: PresentationStepOutput[];
}
