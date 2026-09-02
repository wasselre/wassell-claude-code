// ============================================================================
// Competitor Visual Intelligence — shared types for the cv lanes (W-CV).
//
// Source of truth: docs/marketing-script-visual-contracts.md §1.2 (rows),
// §2 (Modal manifest), §3 (Modal HTTP), §4 (AI role adapter). Keep the shapes
// here identical to the contract; propose changes to the coordinator instead
// of drifting.
// ============================================================================

// ── job queue ────────────────────────────────────────────────────────────────
export type CvJobKind = 'cv_process' | 'cv_analyze' | 'cv_describe_frame' | 'cv_embed_wassel';

export interface CvJob {
  id: string;
  kind: CvJobKind;
  videoId: string | null;
  frameId: string | null;
  params: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

// ── rows (subset of columns the worker reads/writes) ─────────────────────────
export type CvVideoStatus = 'queued' | 'processing' | 'frames_done' | 'analyzing' | 'analyzed' | 'failed' | 'partial';
export type CvTransition = 'cut' | 'fade' | 'dissolve' | 'graphic' | 'start' | 'end';
export type CvOwner = 'competitor' | 'wassel';

export interface CvVideoRow {
  id: string;
  content_media_id: string | null;
  content_post_id: string | null;
  organization_id: string | null;
  owner: CvOwner;
  wassel_asset_id: string | null;
  source_url: string | null;
  duration_ms: number | null;
  status: CvVideoStatus;
  shot_count: number;
  error: string | null;
}

export interface CvShotRow {
  id: string;
  video_id: string;
  shot_no: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  transition_in: CvTransition | null;
  transition_out: CvTransition | null;
  is_static: boolean;
  is_micro: boolean;
  internal_change: boolean;
  edit_pace_local: number | null;
  representative_frame_id: string | null;
  keyframe_ids: string[];
  summary: string | null;
  analysis: ShotAnalysis | null;
  analysis_status: 'pending' | 'done' | 'failed';
}

export interface CvFrameOcr {
  text?: string | null;
  lang?: string | null;
  boxes?: unknown[];
  inherited_from?: string | null;
  inherited_from_ts_ms?: number | null;
}

export interface CvFrameRow {
  id: string;
  video_id: string;
  shot_id: string | null;
  ts_ms: number;
  is_keyframe: boolean;
  public_url: string | null;
  ocr: CvFrameOcr | null;
  labels: string[];
  /** pgvector comes back from PostgREST as a string literal; see parseVector(). */
  embedding: string | number[] | null;
  analysis: FrameAnalysis | null;
}

export interface TranscriptSegment { start_ms: number; end_ms: number; text: string }

// ── Modal manifest (§2) ──────────────────────────────────────────────────────
export interface ManifestVideo {
  duration_ms: number;
  fps: number;
  width: number;
  height: number;
  detector_version: string;
  embedding_version: string;
  ocr_engine?: string;
}

export interface ManifestShot {
  shot_no: number;
  start_ms: number;
  end_ms: number;
  transition_in: CvTransition;
  transition_out: CvTransition;
  is_static: boolean;
  internal_change: boolean;
  representative_ts_ms: number;
  keyframe_ts_ms: number[];
}

export interface ManifestFrame {
  ts_ms: number;
  shot_no: number;
  frame_no?: number;
  is_boundary: boolean;
  phash: string | null;
  dup_group: number | null;
  storage_path: string;
  public_url: string;
  width: number;
  height: number;
  bytes: number;
  quality: { blur?: number; dark?: number; obstruction?: number } | null;
  ocr: { text: string; lang: string | null; boxes: unknown[]; inherited_from_ts_ms: number | null } | null;
  labels: string[];
  embedding: number[] | null;
}

export interface ManifestDupGroup { group: number; representative_ts_ms: number; size: number }

export interface CvManifest {
  video: ManifestVideo;
  shots: ManifestShot[];
  frames: ManifestFrame[];
  dup_groups: ManifestDupGroup[];
  cost_usd: number;
  /** Long videos: Modal stops early and says why. */
  partial?: boolean;
  partial_reason?: string;
  reason?: string;
}

/** Payload shapes for the finalize RPC (§1.3). */
export interface FinalizeGroup { group: number; representative_ts_ms: number; members_ts_ms: number[]; size: number }
export interface ShotKeyframes { shot_no: number; representative_ts_ms: number; keyframe_ts_ms: number[] }

// ── Modal HTTP (§3) ──────────────────────────────────────────────────────────
export interface ModalProcessConfig {
  frame_interval_ms: number;
  max_frames: number;
  min_shot_ms: number;
  ocr: boolean;
  labels: boolean;
}

export interface ModalEmbedResponse { model: string; version: string; dim: number; vectors: number[][] }

export interface ModalCvClient {
  process(videoId: string, videoUrl: string, config: ModalProcessConfig): Promise<CvManifest>;
  embedImages(urls: string[]): Promise<ModalEmbedResponse>;
  embedText(texts: string[]): Promise<ModalEmbedResponse>;
}

// ── AI role adapter (§4) — the cv modules code against THIS interface; the
//    concrete implementation (worker/src/ai/roles.ts) is owned by W-AI and is
//    bridged in aiAdapter.ts. Tests inject a fake. ─────────────────────────────
export type RoleKey =
  | 'script_writer' | 'script_reviewer' | 'claim_classifier'
  | 'frame_describer' | 'shot_analyzer' | 'reference_explainer'
  | 'embed_text' | 'embed_image';

export interface RoleImage { url?: string; base64?: string; mime: string }

export interface CallRoleInput {
  system: string;
  user: string;
  images?: RoleImage[];
  schema: Record<string, unknown>;
  cache?: boolean;
}

export interface CallRoleResult<T> {
  output: T;
  usage: { in: number; out: number };
  /** null when the model is not in the pricing table — never a wrong number. */
  cost_usd: number | null;
  provider: string;
  model: string;
  version: string | null;
  latency_ms: number;
}

export interface EmbedInput { texts?: string[]; image_urls?: string[] }
export interface EmbedResult { vectors: number[][]; model: string; version: string | null; dim: number }

export interface CvAi {
  callRole<T>(role: RoleKey, input: CallRoleInput): Promise<CallRoleResult<T>>;
  embed(role: RoleKey, input: EmbedInput): Promise<EmbedResult>;
}

/** What we stamp on rows (describe_role / analysis_role) and the ledger. */
export interface RoleStamp {
  role: RoleKey;
  provider: string;
  model: string;
  version: string | null;
  cost_usd: number | null;
  latency_ms: number;
}

// ── analysis payloads ────────────────────────────────────────────────────────
// Key names are a CONTRACT with the Competitor Watch drawer (UI-CW reads
// exactly these from mkt_cv_frames.analysis / mkt_cv_shots.analysis). Rename
// nothing without the coordinator.
export type Difficulty = 'easy' | 'moderate' | 'hard';
export type Pace = 'slow' | 'medium' | 'fast';

export interface FrameAnalysis {
  description: string;
  main_subject: string;
  secondary_objects: string[];
  /** Who is in frame and what they are doing; null when nobody. */
  people_activity: string | null;
  room_class: string | null;
  shot_size: string;
  camera_angle: string;
  composition: string;
  subject_position: string;
  foreground: string;
  background: string;
  lighting: string;
  palette: string[];
  style: string;
  text_placement: string | null;
  typography: string | null;
  branding: string[];
  graphic_elements: string[];
  confidence: number;
  /** Controlled-vocabulary tags (model tags ∪ Modal zero-shot labels). */
  tags: string[];
  /** Tags the model proposed that are not in the controlled vocabulary. Kept
   *  for diagnosis; never written into `tags`. */
  rejected_tags?: string[];
  /** On-demand path: copied from this representative frame (no model call). */
  inherited_from?: string;
  inherited_distance?: number;
}

/** What the shot_analyzer role returns (flat, per the drawer contract). */
export interface ShotAnalyzerOutput {
  summary_ar: string;
  summary_en: string;
  purpose: string;
  angle: string;
  camera_movement: string;
  pace: Pace;
  visual_progression: string;
  emotional_effect: string;
  intended_audience: string;
  production_method: string;
  production_difficulty: Difficulty;
  production_resources: string[];
  reproducibility: Difficulty;
  suitable_platforms: string[];
  suitable_content_types: string[];
  mood: string;
  confidence: number;
  tags: string[];
}

/** Stored on mkt_cv_shots.analysis = model output + DB-derived facts. */
export interface ShotAnalysis extends Omit<ShotAnalyzerOutput, 'tags'> {
  /** Measured cuts/min around this shot (edit_pace_local), not a judgement. */
  pace_cpm: number | null;
  transitions: { in: string | null; out: string | null };
  rejected_tags?: string[];
  /** Set on micro shots that were summarised from neighbours without an LLM call. */
  micro?: boolean;
}

export interface VideoStructure {
  version: string;
  shot_count: number;
  micro_count: number;
  analyzed_count: number;
  failed_count: number;
  duration_ms: number | null;
  /** Cuts per minute over the whole video. */
  pace_cuts_per_min: number | null;
  /** Ordered purpose per non-micro shot (`hook`, `location`, …). */
  purposes: string[];
  /** Collapsed run-length version of `purposes` — the "recipe" of the video. */
  purpose_sequence: string[];
}
