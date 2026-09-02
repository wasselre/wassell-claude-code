/**
 * Script writer v2 — shared types.
 *
 * Mirrors docs/marketing-script-visual-contracts.md §5 (authoritative). Extra
 * fields beyond the contract are marked `// ext:` and are additive only.
 */

// ── AI role adapter (contract §4) — structural twins so the pure modules never
//    import worker/src/ai/** (owned by W-AI). The orchestrator binds the real
//    functions at runtime.
export type RoleKey =
  | 'script_writer' | 'script_reviewer' | 'claim_classifier' | 'frame_describer'
  | 'shot_analyzer' | 'reference_explainer' | 'embed_text' | 'embed_image';

export type JSONSchema = Record<string, unknown>;

/** Structural twin of worker/src/ai CallRequest (the script never attaches images). */
export interface RoleCallInput {
  system: string;
  user: string;
  schema: JSONSchema;
  cache?: boolean;
}

/** Structural twin of worker/src/ai CallResult<T> — `cost_usd: null` = unknown, never 0. */
export interface RoleCallResult<T> {
  output: T;
  usage: { in: number; out: number; cache_read?: number; cache_write?: number };
  cost_usd: number | null;
  provider: string;
  model: string;
  version: string | null;
  latency_ms: number;
  structured_via?: 'format' | 'tool';
}

export type CallRole = <T>(role: RoleKey, input: RoleCallInput) => Promise<RoleCallResult<T>>;

/** Structural twin of worker/src/ai EmbedResult. */
export interface EmbedResult { vectors: number[][]; model: string; version: string; dim: number; cost_usd: number | null; provider: string; latency_ms: number }
export type EmbedFn = (role: RoleKey, input: { texts?: string[]; image_urls?: string[] }) => Promise<EmbedResult>;

// ── Recipes / rules (DB rows) ────────────────────────────────────────────────
export interface RecipeRow {
  key: string;
  label_ar: string;
  label_en: string;
  structure: string[];
  guidance: string;
  default_duration_sec: number;
  scene_count_hint: number;
  retrieval_content_types: string[];
  requires_facts: string[];
  version: number;
  is_active: boolean;
}

/** mos_settings.script_writer_rules — editable by the team without a deploy. */
export interface ScriptWriterRules {
  marketer_name: string;
  cta_default: string;
  allow_developer_name: boolean;
  numerals_on_screen: 'arabic_indic' | 'western';
  hook_style: string;
  forbidden_claim_classes: string[];
  max_exemplar_overlap_words: number;
  /** ext: free-form operator notes appended to the system prompt verbatim. */
  extra_rules?: string[];
}

export const DEFAULT_RULES: ScriptWriterRules = {
  marketer_name: 'وصل العقارية',
  cta_default: 'للحجز والاستفسار: وصل العقارية',
  allow_developer_name: true,
  numerals_on_screen: 'arabic_indic',
  hook_style: 'question_or_variety_or_price_never_greeting',
  forbidden_claim_classes: ['return', 'financing', 'yield'],
  max_exemplar_overlap_words: 12,
};

// ── Brief (contract §5) ──────────────────────────────────────────────────────
export type Funnel = 'top' | 'mid' | 'bottom';
export type Purpose = 'organic' | 'paid' | 'both' | 'unknown';

export interface BriefCampaign {
  id: string;
  name: string | null;
  objective: string | null;
  kind: string | null;
  offer: string | null;
  audience_text: string | null;
  audience_id: string | null;
}

export interface ExistingScene {
  position: number;
  visual: string | null;
  voiceover: string | null;
  on_screen_text: string | null;
  footage_status: string | null;
}

export interface Brief {
  content_id: string;
  project_id: string;
  project_ids: string[];
  multi_project_warning: boolean;
  campaign?: BriefCampaign;
  purpose: Purpose;
  platforms: string[];
  objective: string | null;
  audience: string | null;
  language: 'ar' | 'en';
  cta: string;
  core_message?: string;
  idea?: string;
  hook?: string;
  recipe: string;
  duration_sec: number;
  scene_count_hint: number;
  funnel: Funnel;
  objection?: string;
  existing_scenes: ExistingScene[];
  assets_summary: { count: number; kinds: Record<string, number> };
  // ext:
  title?: string;
  angle?: string;
  project_name?: string;
  warnings: string[];
}

export interface BriefOverrides {
  recipe?: string | null;
  duration_sec?: number | null;
  audience?: string | null;
  objection?: string | null;
}

// ── Facts (contract §5) ──────────────────────────────────────────────────────
export type FactClass =
  | 'price' | 'area' | 'unit_count' | 'date' | 'distance' | 'duration' | 'availability'
  | 'guarantee' | 'payment' | 'unit_type' | 'feature' | 'landmark' | 'status' | 'name'
  | 'location' | 'other';

export interface Fact {
  id: string; // F1..
  key: string;
  class: FactClass;
  value: unknown;
  rendered_ar: string;
  source_field: string;
  verified_at: string | null;
  claimable: boolean;
  note?: string;
}

export type Readiness = 'off_plan' | 'ready' | 'unknown' | 'conflict';

export interface FactsPackage {
  project_name: string;
  readiness: Readiness;
  sold_out: boolean;
  facts: Fact[];
  warnings: string[];
  viable: boolean;
  missing: string[];
  // ext: names that the entity gate needs (never rendered to the model unless allowed)
  developer_name?: string | null;
  marketer_name?: string | null;
}

// ── Exemplars (contract §5) ──────────────────────────────────────────────────
export interface Exemplar {
  id: string; // E1..
  content_post_id: string;
  organization_id: string | null;
  org_name: string | null;
  platform: string | null;
  content_type: string | null;
  language: string | null;
  views: number | null;
  similarity: number;
  transcript: string;
  ocr: string;
  campaign_message: string | null;
  selling_points: string[];
  structure?: string[];
  // ext: retrieval bookkeeping (kept on the draft for auditability)
  score?: number;
  post_url?: string | null;
  district?: string | null;
  offer?: string | null;
  unit_types?: string[];
}

/** Row shape returned by RPC mkt_script_exemplars (migration 2026-09-02_13). */
export interface ExemplarRow {
  content_post_id: string;
  organization_id: string | null;
  org_name: string | null;
  platform: string | null;
  post_type: string | null;
  content_type: string | null;
  language: string | null;
  views: number | string | null;
  similarity: number | string | null;
  transcript_text: string | null;
  transcript_segments: unknown;
  transcript_language?: string | null;
  ocr_text: string | null;
  campaign_message: string | null;
  selling_points: unknown;
  offer: string | null;
  unit_types: unknown;
  district: string | null;
  published_at: string | null;
  post_url: string | null;
}

// ── Generation output (contract §5) ──────────────────────────────────────────
export type ScenePurpose = 'hook' | 'location' | 'product' | 'feature' | 'proof' | 'offer' | 'comparison' | 'cta' | 'brand';

export interface VisualIntent {
  shot_size: string;
  subject: string;
  setting: string;
  interior_exterior: 'interior' | 'exterior' | 'graphic' | 'mixed';
  motion: string;
  graphic_kind: 'none' | 'text_overlay' | 'animated_map' | '3d_render' | 'motion_graphic' | 'split_screen';
  mood: string;
}

export interface DraftScene {
  order: number;
  purpose: ScenePurpose;
  duration_sec: number;
  start_sec: number;
  end_sec: number;
  voiceover: string;
  on_screen_text: string;
  visual: string;
  visual_intent: VisualIntent;
  angle: string;
  fact_refs: string[];
  learned_from: string[];
  asset_requirement: 'footage' | 'image' | 'graphic' | 'animation' | 'template' | 'none';
  production_note: string;
  warnings: string[];
}

export interface GenerationOutput {
  patterns_learned: Array<{ pattern: string; from: string[] }>;
  scene_plan: Array<{ order: number; purpose: string; goal: string; facts: string[] }>;
  scenes: DraftScene[];
  hooks: string[];
}

// ── Validation / review (contract §5) ────────────────────────────────────────
export interface ClaimVerdict {
  scene: number;
  field: 'voiceover' | 'on_screen_text';
  mention: string;
  class: string;
  verdict: 'pass' | 'fail' | 'review';
  fact_id?: string;
  reason: string;
}

export interface EntityHit { scene: number; mention: string; kind: string; field?: 'voiceover' | 'on_screen_text' | 'visual' }

export interface ValidatorCheck { key: string; level: 'pass' | 'warn' | 'fail'; detail: string }

export interface ValidatorReport {
  claims: ClaimVerdict[];
  entities: EntityHit[];
  checks: ValidatorCheck[];
}

export interface JudgeReport {
  overall: 'pass' | 'revise' | 'reject';
  dialect: number;
  hook: number;
  progression: number;
  fit: number;
  completeness: number;
  notes: Array<{ scene: number; note: string }>;
}

export interface ReviewReport {
  validator: ValidatorReport;
  judge?: JudgeReport;
  repaired: boolean;
  final: 'ok' | 'needs_attention';
}

// ── Claims (internal) ────────────────────────────────────────────────────────
export type MentionClass = FactClass | 'rhetorical_enumeration' | 'scene_numbering' | 'return' | 'financing' | 'yield' | 'other';

export interface Mention {
  raw: string;
  /** Parsed numeric value (Western digits, multipliers applied) or null for pure words. */
  value: number | null;
  /** Second value for ranges like ١٢٠–١٥٠ م². */
  value2?: number | null;
  unit: string | null;
  /** ±25 chars around the mention, used by deterministic rules + the classifier. */
  context: string;
  index: number;
  /** true when the number was written as a word (ثلاث) or a multiplier (ألف/مليون) was applied. */
  approximate: boolean;
}

export interface ClassifiedMention extends Mention { class: MentionClass; confident: boolean }
