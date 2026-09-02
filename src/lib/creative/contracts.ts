/**
 * Post Creative Director — canonical shared types (SPA + api).
 *
 * THIS FILE IS THE CONTRACT. It is copied VERBATIM to worker/src/creative/contracts.ts
 * (the worker is a standalone package and cannot import from src/). Change both
 * together; the lead owns this file — agents propose edits, never fork it.
 *
 * Spec: docs/creative-director-contracts.md. Sibling contract for the video
 * writer + video visual intelligence: docs/marketing-script-visual-contracts.md
 * (whose worker/src/ai/** role adapter and worker/src/marketing/script/{facts,
 * claims,entities,types}.ts we REUSE, never duplicate).
 */

// ── Enumerations (mirror the DB CHECKs exactly) ──────────────────────────────
export type CreativeJobKind = 'post_concepts' | 'post_package' | 'post_regenerate' | 'post_derivatives';
export type CreativeJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type CreativeJobStage = 'brief' | 'facts' | 'brand' | 'references' | 'assets' | 'targets' | 'concepts' | 'package' | 'derivatives' | 'validate' | 'persist';

export type PackageStage = 'concepts' | 'package';
export type PackageStatus = 'draft' | 'applied' | 'superseded' | 'rejected';
export type IntendedUse = 'organic' | 'paid' | 'both';
export type PostFormat = 'single' | 'carousel';

export type TargetKind = 'organic' | 'paid';
/** Placement type keys — MUST match PLACEMENT_SPECS in src/lib/marketingOS/platformRules.ts */
export type PlacementType =
  | 'feed' | 'carousel' | 'story' | 'reel_cover' | 'photo_mode' | 'post'
  | 'ad_feed' | 'ad_story' | 'ad_carousel' | 'ad_reels' | 'ad_display';
export type DerivativeStatus = 'draft' | 'applied' | 'superseded';

export type RefRole = 'reference' | 'selected_asset';
export type RefKind = 'competitor_post' | 'competitor_media' | 'wassel_content' | 'wassel_file' | 'file';
export type RefLevel = 'slide' | 'post';
export type RefAspect = 'composition' | 'hierarchy' | 'colors' | 'carousel_structure' | 'typography' | 'image_treatment' | 'cta' | 'copy_structure' | 'density' | 'branding' | 'other';
export type AssetUsage = 'direct' | 'crop' | 'retouch' | 'color_correct' | 'ai_edit' | 'ai_extend' | 'combine' | 'reference_only';

export type ReadSubjectKind = 'competitor_media' | 'competitor_post' | 'wassel_file' | 'wassel_content';
export type ReadLevel = 'slide' | 'post';

export type AiMode = 'cleanup' | 'crop' | 'color_correct' | 'extend_background' | 'remove_clutter' | 'combine' | 'supporting_visual' | 'remove_text' | 'request_photo';
export type AiRecommendationStatus = 'recommended' | 'approved' | 'queued' | 'running' | 'completed' | 'failed' | 'dismissed';

export type ExampleKind = 'approved_wassel' | 'study_only';
export type BrandKitStatus = 'draft' | 'reviewed';
export type BrandKitMode = 'advisory' | 'constraint';

/** Rights as they exist on files.usage_rights (file_vocabularies) */
export type UsageRights = 'approved' | 'use_after_edit' | 'attribution_required' | 'internal_only' | 'restricted' | 'do_not_use' | 'needs_review';
export type RightsProvenance = 'human_approved' | 'human_modified' | 'ai_suggested' | 'unknown';
export type AssetNature = 'real' | 'ai_generated' | 'ai_edited' | 'cgi_render' | 'graphic_design' | 'screenshot';
export type AcquisitionSource = 'developer' | 'internal' | 'competitor' | 'client' | 'partner' | 'public' | 'unknown';
export type ProductionState = 'raw' | 'edited' | 'final' | 'published';

// ── Facts (structural twin of worker/src/marketing/script/types.ts Fact) ─────
export interface FactRef { id: string; key: string; rendered_ar: string; source_field: string; claimable: boolean }

// ── Placement specs (data — src/lib/marketingOS/platformRules.ts) ────────────
export interface PlacementSpec {
  platform: string;
  placement_type: PlacementType;
  target_kind: TargetKind;
  aspects: string[];                       // first = preferred
  px: Record<string, [number, number]>;    // aspect → [w,h]
  safe_zones?: { top?: number; bottom?: number; left?: number; right?: number }; // px at the reference size
  max_slides?: number;
  formats?: string[];                      // 'jpg' | 'webp' | 'png' | 'mp4'
  caption_max?: number;
  hashtags_max?: number;
  manual_publish?: boolean;                // no automated publish (X, website, google display)
  notes?: string;
}

// ── Concepts (stage 1) ───────────────────────────────────────────────────────
export interface Concept {
  id: string;                              // 'c1' | 'c2' | 'c3'
  title: string;
  angle: string;
  format: PostFormat;
  one_line_design_idea: string;
  leans_on_reference: { ref_kind: RefKind; ref_id: string; aspect: RefAspect } | null;
  suggested_targets: string[];             // 'instagram:carousel'
  why: string;
}
export interface ConceptsOutput {
  concepts: Concept[];                     // 2–3
  recommended: string;
  warnings: string[];
  missing: string[];
}

// ── Base creative (stage 2) ──────────────────────────────────────────────────
export interface Strategy {
  objective: string;
  audience: string;
  audience_source: 'campaign' | 'content' | 'inferred';
  campaign_context: { campaign_id: string | null; objective: string | null; offer: string | null };
  angle: string;
  main_message: string;
  desired_response: 'save' | 'dm' | 'call' | 'visit' | 'share';
  format: PostFormat;
  format_rationale: string;
  intended_use: IntendedUse;
  master_aspect: string;                   // chosen to serve the selected targets with the fewest re-layouts
  master_aspect_rationale: string;
  language: string;                        // copied from mos_content.language
}

export interface DesignText {
  project_name_lead: string;               // ALWAYS present; the name need not repeat in headlines
  latin_name: string | null;               // only when the identity is bilingual
  headlines: string[];                     // 1–4 short lines (single); for carousels the cover's lines
  cta_on_design: string | null;
  fact_refs: string[];                     // every number in the design text cites a Fact id
}

export interface SlidePlan {
  index: number;                           // 1-based
  role: 'cover' | 'feature' | 'specs' | 'offer' | 'location' | 'proof' | 'lifestyle' | 'cta' | 'brand' | 'other';
  purpose: string;
  headline: string;
  support: string | null;
  asset_ref: string | null;                // file id from `assets`
  fact_refs: string[];
  continuity: string;
}

export interface VisualDirection {
  concept: string;
  mood: string[];
  composition: string;
  layout: string;                          // layout family, see design read vocab
  hierarchy: string[];
  typography: { display: string; size_levels: number; numerals: 'arabic_indic' | 'western'; notes?: string };
  image_treatment: string;
  background: string;
  decoration: string[];
  logo: { variant: string; position: string; color: string };
  cta_placement: string;
  negative_space: string;
  continuity: string | null;
  safe_zones_note: string;
}

export interface PaletteEntry { hex: string; name: string; role: string; source: 'brand_kit' | 'project_identity' | 'asset'; }

export interface AssetPick {
  file_id: string;
  nature: AssetNature | null;
  source: AcquisitionSource | null;
  rights: UsageRights | null;
  rights_verified: boolean;
  production_state: ProductionState | null;
  placement: string;                       // 'slide 1 primary' | 'background' | …
  usage: AssetUsage;
  treatment: string;
  why: string;
  is_production: boolean;                  // false → reference only
  needs_rights_confirmation: boolean;      // unclear/AI-suggested rights → human confirm before final approval
}

export interface ReferencePick {
  ref_kind: RefKind;
  ref_id: string;                          // mkt_content_media.id | mkt_content_posts.id | files.id | mos_content.id
  post_id: string | null;
  slide_index: number | null;
  level: RefLevel;
  preview_url: string | null;
  aspect: RefAspect;
  why: string;
  study: string;
  adapt: string;
  do_not_copy: string;
  differ: string;
}

export interface AiRecommendation {
  index: number;
  mode: AiMode;
  source_file_ids: string[];
  prompt: string;                          // execution-ready
  must_keep: string[];
  must_change: string[];
  aspect: string;
  constraints: string[];
  policy_check: string;                    // the fabrication rule statement it satisfies
  status: AiRecommendationStatus;
  execution?: { job_id: string | null; output_file_id: string | null; error: string | null; approved_by: string | null; approved_at: string | null };
}

export interface BasePackage {
  strategy: Strategy;
  design_text: DesignText;
  slides: SlidePlan[];                     // [] for single
  visual_direction: VisualDirection;
  palette: PaletteEntry[];
  palette_rationale: string;
  brand_kit: { version: number; mode: BrandKitMode; deviations: string[] };
  assets: AssetPick[];
  references: ReferencePick[];
  ai_recommendations: AiRecommendation[];
  warnings: string[];
  missing: string[];
  facts_used: string[];                    // Fact ids
  confidence: { copy: number; assets: number; references: number };
  rationale: string;
}

// ── Derivatives (stage 3) ────────────────────────────────────────────────────
export interface DerivativeTarget {
  target_kind: TargetKind;
  platform: string;
  placement_type: PlacementType;
  target_ref: { publication_id?: string; execution_id?: string; ad_set_id?: string; ad_id?: string };
}

export interface VisualAdaptation {
  aspect: string;
  px: [number, number];
  safe_zones: { top?: number; bottom?: number; left?: number; right?: number };
  requires_separate_design: boolean;       // true when a re-layout (not a crop) is needed
  image_change: 'none' | 'crop' | 'extend' | 'replace';
  image_instructions: string;
  text_reposition: string;
  logo_reposition: string;
  layout_changes: string;
  element_scaling: string;
  slide_mapping: Array<{ from_index: number; to_index: number | null; note: string }>; // carousel → target
  asset_substitutions: Array<{ from_file_id: string; to_file_id: string | null; reason: string }>;
}

export interface OrganicCopy { caption: string; hashtags: string[]; char_count: number; fact_refs: string[] }
export interface PaidCopy { primary_text: string; headline: string; description: string; cta: string; destination_url: string | null; fact_refs: string[] }

export interface Derivative {
  target: DerivativeTarget;
  dimensions: { aspect: string; px: [number, number] };
  adaptation: VisualAdaptation;
  copy: OrganicCopy | PaidCopy;
  limits: Record<string, unknown>;         // the PLACEMENT_SPECS ceilings that applied
  warnings: string[];
}
export interface DerivativesOutput { derivatives: Derivative[] }

// ── Rows (as returned by the API) ────────────────────────────────────────────
export interface CreativeJobRow {
  id: string; content_id: string; kind: CreativeJobKind; status: CreativeJobStatus; stage: CreativeJobStage | null;
  params: Record<string, unknown>; result: Record<string, unknown> | null; error: string | null; error_kind: string | null;
  attempts: number; created_at: string; started_at: string | null; finished_at: string | null;
}
export interface CreativePackageRow {
  id: string; content_id: string; round: number; version: number; stage: PackageStage; status: PackageStatus;
  intended_use: IntendedUse; language: string; recipe: string | null; concept_id: string | null;
  concepts: ConceptsOutput | null; base: BasePackage | null; facts: unknown; facts_used: string[];
  brand_kit_version: number | null; brand_kit_mode: BrandKitMode | null;
  roles: Record<string, unknown> | null; cost_usd: number | null; generated_by: 'ai' | 'human';
  job_id: string | null; created_by_user_id: string | null; applied_at: string | null; applied_snapshot: unknown;
  revision_note: string | null; created_at: string; updated_at: string;
}
export interface CreativeDerivativeRow {
  id: string; package_id: string; target_kind: TargetKind; platform: string; placement_type: PlacementType;
  target_ref: Record<string, string>; dimensions: { aspect: string; px: [number, number] }; adaptation: VisualAdaptation;
  copy: OrganicCopy | PaidCopy; limits: Record<string, unknown>; warnings: string[]; status: DerivativeStatus; applied_at: string | null; created_at: string;
}
export interface CreativeRefRow {
  id: string; package_id: string; role: RefRole; ref_kind: RefKind; ref_id: string; slide_index: number | null; level: RefLevel | null;
  aspect: RefAspect | null; usage: AssetUsage | null; rights_snapshot: Record<string, unknown> | null; rationale: Record<string, unknown>;
  preview_url: string | null;
}

// ── Design reads (visual intelligence) ───────────────────────────────────────
export interface SlideRead {
  slide_role: 'cover' | 'feature' | 'specs' | 'offer' | 'location' | 'proof' | 'lifestyle' | 'cta' | 'brand' | 'other';
  layout: 'full_bleed_photo_text_bottom' | 'full_bleed_photo_text_top' | 'split_horizontal' | 'split_vertical' | 'text_only' | 'grid' | 'framed' | 'collage' | 'other';
  text_position: 'top' | 'center' | 'bottom' | 'left' | 'right' | 'band_bottom' | 'band_top' | 'overlay_center' | 'none';
  text_share: number;                      // 0..1
  density: 'low' | 'medium' | 'high';
  hierarchy: string[];
  typography: { arabic_style: 'naskh' | 'kufi' | 'modern_sans' | 'calligraphic' | 'mixed' | 'none'; size_levels: number; weight_contrast: 'low' | 'high'; latin_present: boolean; numerals: 'arabic_indic' | 'western' | 'mixed' | 'none' };
  palette: Array<{ hex: string; role: 'background' | 'text' | 'accent' | 'logo' | 'band' | 'other'; share: number }>;
  palette_family: 'warm' | 'cool' | 'neutral' | 'high_contrast';
  image: { present: boolean; kind: 'photo' | 'render' | 'illustration' | 'graphic' | 'none'; subject: 'exterior' | 'interior' | 'plan' | 'aerial' | 'lifestyle' | 'people' | 'abstract' | 'none'; treatment: string[] };
  logo: { present: boolean; position: string | null; variant: string | null; size: 'small' | 'medium' | 'large' | null };
  cta: { present: boolean; treatment: 'button' | 'line' | 'phone' | 'arrow' | 'none' };
  decoration: string[];
  branding_intensity: 0 | 1 | 2 | 3;
  mood: string[];
  negative_space: 'tight' | 'balanced' | 'generous';
  readability: { contrast_ok: boolean; notes: string };
  style_tags: string[];
  notes: string;
}

export interface PostRead {
  format: PostFormat;
  slide_count: number;
  role_sequence: string[];
  narrative_arc: string;
  information_progression: 'broad_to_specific' | 'specific_to_broad' | 'flat' | 'alternating';
  cover_to_cta: { promise_kept: boolean; cta_slide_index: number | null; cta_type: 'dm' | 'call' | 'link' | 'visit' | 'none'; notes: string };
  slide_relationships: Array<{ from: number; to: number; relation: 'continues' | 'contrasts' | 'zooms_in' | 'proves' | 'repeats' }>;
  recurring_layout: { template_used: boolean; layout_family: string; varies_on: string[]; fixed: string[] };
  visual_continuity: { palette_consistent: boolean; typography_consistent: boolean; logo_consistent: boolean; image_treatment_consistent: boolean; score: number };
  design_system: { palette: Array<{ hex: string; role: string }>; typography: Record<string, unknown>; decoration: string[]; logo_rules: string };
  content_density_profile: Array<'low' | 'medium' | 'high'>;
  branding_intensity: 0 | 1 | 2 | 3;
  image_strategy: { mix: Record<string, number>; asset_dependency: string; reusability: string };
  copy_design_relationship: string;
  mood: string[];
  style_tags: string[];
  strengths: string[];
  weaknesses: string[];
  learnable: { structure: string; hierarchy: string; avoid: string };
  summary: string;
}

export interface VisualDesignReadRow {
  id: string; subject_kind: ReadSubjectKind; subject_id: string; level: ReadLevel; post_id: string | null; slide_index: number | null;
  model_task: string; model_used: string; rule_version: string; read: SlideRead | PostRead; confidence: number | null; cost_usd: number | null;
  status: 'done' | 'failed'; failure_reason: string | null; created_at: string;
}

// ── Brand kit ────────────────────────────────────────────────────────────────
export interface BrandKit {
  version: number;
  status: BrandKitStatus;
  mode: BrandKitMode;                      // advisory until reviewed
  reviewed_by: string | null; reviewed_at: string | null;
  sources: string[];
  palette: Array<{ name: string; hex: string; roles: string[]; notes?: string }>;
  usage_ratio: Record<string, number>;
  combinations_allowed: string[][];
  combinations_avoid: string[][];
  typography: { display: string; body: string; numerals: 'arabic_indic' | 'western'; max_sizes_per_slide: number; latin_policy: string; notes?: string };
  logo: { variants: string[]; on_dark: string; on_light: string; clear_space: string; min_size: string; default_position: string };
  character: { statement: string; motifs: string[]; negative_space: string };
  image_treatment: { allowed: string[]; avoid: string[] };
  prohibited: string[];
  approved_example_ids: string[];          // mos_design_examples ids
}

export interface WriterRules { shared: string[]; post: string[]; video?: string[]; decisions_log: Array<{ date: string; note: string; source?: string }> }
export interface RoleMap { design_owner: string; design_reviewer: string }
export interface CreativeFlags { post_enabled: boolean; ai_image_execution: boolean; design_reads_enabled: boolean; asset_enrich_v2: boolean; backfill_enabled: boolean }

// ── Designer handoff (rendered from an applied package) ──────────────────────
export interface DesignerHandoff {
  content_id: string; package_id: string; title: string;
  message: string; objective: string; audience: string; intended_use: IntendedUse;
  targets: Array<{ platform: string; placement_type: PlacementType; aspect: string; px: [number, number]; requires_separate_design: boolean }>;
  master_aspect: string;
  design_text: DesignText;
  slides: SlidePlan[];
  palette: PaletteEntry[];
  assets: Array<AssetPick & { preview_url: string | null; file_name: string | null }>;
  references: ReferencePick[];
  visual_direction: VisualDirection;
  adaptations: Array<{ target: DerivativeTarget; adaptation: VisualAdaptation }>;
  ai_production: AiRecommendation[];       // only approved / completed
  ai_suggested_not_approved: number;
  warnings: string[]; missing: string[];
  language: string;
}
