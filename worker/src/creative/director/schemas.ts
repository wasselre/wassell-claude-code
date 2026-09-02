/**
 * JSON Schemas for the three director stage outputs — they mirror
 * `worker/src/creative/contracts.ts` EXACTLY (enums as `enum`, required
 * arrays covering every property the contract marks non-optional). The AI
 * role adapter sends these as `output_config.format` (with a forced-tool
 * fallback), so `additionalProperties:false` everywhere keeps the model from
 * inventing extra keys; nullable contract fields are `type:[..., 'null']`.
 *
 * `AiRecommendation.execution` is deliberately ABSENT (it is optional in the
 * contract and only ever written by the image lane via
 * `mos_creative_package_patch` — the model has no business emitting it).
 */
import type { JSONSchema } from '../../ai/index.js';

// ── Shared enum mirrors (contracts.ts) ───────────────────────────────────────
const POST_FORMAT = ['single', 'carousel'] as const;
const REF_KIND = ['competitor_post', 'competitor_media', 'wassel_content', 'wassel_file', 'file'] as const;
const REF_ASPECT = ['composition', 'hierarchy', 'colors', 'carousel_structure', 'typography', 'image_treatment', 'cta', 'copy_structure', 'density', 'branding', 'other'] as const;
const REF_LEVEL = ['slide', 'post'] as const;
const INTENDED_USE = ['organic', 'paid', 'both'] as const;
const AUDIENCE_SOURCE = ['campaign', 'content', 'inferred'] as const;
const DESIRED_RESPONSE = ['save', 'dm', 'call', 'visit', 'share'] as const;
const NUMERALS = ['arabic_indic', 'western'] as const;
const SLIDE_ROLE = ['cover', 'feature', 'specs', 'offer', 'location', 'proof', 'lifestyle', 'cta', 'brand', 'other'] as const;
const PALETTE_SOURCE = ['brand_kit', 'project_identity', 'asset'] as const;
const ASSET_NATURE = ['real', 'ai_generated', 'ai_edited', 'cgi_render', 'graphic_design', 'screenshot'] as const;
const ACQUISITION_SOURCE = ['developer', 'internal', 'competitor', 'client', 'partner', 'public', 'unknown'] as const;
const USAGE_RIGHTS = ['approved', 'use_after_edit', 'attribution_required', 'internal_only', 'restricted', 'do_not_use', 'needs_review'] as const;
const PRODUCTION_STATE = ['raw', 'edited', 'final', 'published'] as const;
const ASSET_USAGE = ['direct', 'crop', 'retouch', 'color_correct', 'ai_edit', 'ai_extend', 'combine', 'reference_only'] as const;
const AI_MODE = ['cleanup', 'crop', 'color_correct', 'extend_background', 'remove_clutter', 'combine', 'supporting_visual', 'remove_text', 'request_photo'] as const;
const AI_STATUS = ['recommended', 'approved', 'queued', 'running', 'completed', 'failed', 'dismissed'] as const;
const BRAND_KIT_MODE = ['advisory', 'constraint'] as const;
const TARGET_KIND = ['organic', 'paid'] as const;
const PLACEMENT_TYPE = ['feed', 'carousel', 'story', 'reel_cover', 'photo_mode', 'post', 'ad_feed', 'ad_story', 'ad_carousel', 'ad_reels', 'ad_display'] as const;
const IMAGE_CHANGE = ['none', 'crop', 'extend', 'replace'] as const;

const str = { type: 'string' } as const;
const strOrNull = { type: ['string', 'null'] } as const;
const intOrNull = { type: ['integer', 'null'] } as const;
const strArr = { type: 'array', items: str } as const;
const enumOf = (values: readonly string[]) => ({ type: 'string', enum: [...values] }) as const;
// Nullable enum. Anthropic's structured-output (output_config.format) validator
// REJECTS an `enum` combined with a UNION type (`type:['string','null']`):
//   "Enum value 'real' does not match declared type '['string', 'null']'"
// which silently forced the whole PACKAGE call onto the forced-tool fallback
// (live أكنان 25). The anyOf form is the nullable-enum shape it accepts.
const enumOrNull = (values: readonly string[]) => ({ anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }] }) as const;
const pxPair = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } as const;

// ── Stage 1: ConceptsOutput ──────────────────────────────────────────────────
const CONCEPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: str,
    title: str,
    angle: str,
    format: enumOf(POST_FORMAT),
    one_line_design_idea: str,
    leans_on_reference: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref_kind: enumOf(REF_KIND),
            ref_id: str,
            aspect: enumOf(REF_ASPECT),
          },
          required: ['ref_kind', 'ref_id', 'aspect'],
        },
        { type: 'null' },
      ],
    },
    suggested_targets: strArr,
    why: str,
  },
  required: ['id', 'title', 'angle', 'format', 'one_line_design_idea', 'leans_on_reference', 'suggested_targets', 'why'],
} as const;

export const CONCEPTS_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    concepts: { type: 'array', minItems: 2, maxItems: 3, items: CONCEPT_SCHEMA },
    recommended: str,
    warnings: strArr,
    missing: strArr,
  },
  required: ['concepts', 'recommended', 'warnings', 'missing'],
} as const satisfies JSONSchema;

// ── Stage 2: BasePackage ─────────────────────────────────────────────────────
const STRATEGY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objective: str,
    audience: str,
    audience_source: enumOf(AUDIENCE_SOURCE),
    campaign_context: {
      type: 'object',
      additionalProperties: false,
      properties: { campaign_id: strOrNull, objective: strOrNull, offer: strOrNull },
      required: ['campaign_id', 'objective', 'offer'],
    },
    angle: str,
    main_message: str,
    desired_response: enumOf(DESIRED_RESPONSE),
    format: enumOf(POST_FORMAT),
    format_rationale: str,
    intended_use: enumOf(INTENDED_USE),
    master_aspect: str,
    master_aspect_rationale: str,
    language: str,
  },
  required: [
    'objective', 'audience', 'audience_source', 'campaign_context', 'angle', 'main_message',
    'desired_response', 'format', 'format_rationale', 'intended_use', 'master_aspect',
    'master_aspect_rationale', 'language',
  ],
} as const;

const DESIGN_TEXT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    project_name_lead: str,
    latin_name: strOrNull,
    headlines: strArr,
    cta_on_design: strOrNull,
    fact_refs: strArr,
  },
  required: ['project_name_lead', 'latin_name', 'headlines', 'cta_on_design', 'fact_refs'],
} as const;

const SLIDE_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer' },
    role: enumOf(SLIDE_ROLE),
    purpose: str,
    headline: str,
    support: strOrNull,
    asset_ref: strOrNull,
    fact_refs: strArr,
    continuity: str,
  },
  required: ['index', 'role', 'purpose', 'headline', 'support', 'asset_ref', 'fact_refs', 'continuity'],
} as const;

const VISUAL_DIRECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    concept: str,
    mood: strArr,
    composition: str,
    layout: str,
    hierarchy: strArr,
    typography: {
      type: 'object',
      additionalProperties: false,
      properties: {
        display: str,
        size_levels: { type: 'integer' },
        numerals: enumOf(NUMERALS),
        notes: strOrNull,
      },
      required: ['display', 'size_levels', 'numerals', 'notes'],
    },
    image_treatment: str,
    background: str,
    decoration: strArr,
    logo: {
      type: 'object',
      additionalProperties: false,
      properties: { variant: str, position: str, color: str },
      required: ['variant', 'position', 'color'],
    },
    cta_placement: str,
    negative_space: str,
    continuity: strOrNull,
    safe_zones_note: str,
  },
  required: [
    'concept', 'mood', 'composition', 'layout', 'hierarchy', 'typography', 'image_treatment',
    'background', 'decoration', 'logo', 'cta_placement', 'negative_space', 'continuity', 'safe_zones_note',
  ],
} as const;

const PALETTE_ENTRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { hex: str, name: str, role: str, source: enumOf(PALETTE_SOURCE) },
  required: ['hex', 'name', 'role', 'source'],
} as const;

const ASSET_PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file_id: str,
    nature: enumOrNull(ASSET_NATURE),
    source: enumOrNull(ACQUISITION_SOURCE),
    rights: enumOrNull(USAGE_RIGHTS),
    rights_verified: { type: 'boolean' },
    production_state: enumOrNull(PRODUCTION_STATE),
    placement: str,
    usage: enumOf(ASSET_USAGE),
    treatment: str,
    why: str,
    is_production: { type: 'boolean' },
    needs_rights_confirmation: { type: 'boolean' },
  },
  required: [
    'file_id', 'nature', 'source', 'rights', 'rights_verified', 'production_state',
    'placement', 'usage', 'treatment', 'why', 'is_production', 'needs_rights_confirmation',
  ],
} as const;

const REFERENCE_PICK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref_kind: enumOf(REF_KIND),
    ref_id: str,
    post_id: strOrNull,
    slide_index: intOrNull,
    level: enumOf(REF_LEVEL),
    preview_url: strOrNull,
    aspect: enumOf(REF_ASPECT),
    why: str,
    study: str,
    adapt: str,
    do_not_copy: str,
    differ: str,
  },
  required: ['ref_kind', 'ref_id', 'post_id', 'slide_index', 'level', 'preview_url', 'aspect', 'why', 'study', 'adapt', 'do_not_copy', 'differ'],
} as const;

const AI_RECOMMENDATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer' },
    mode: enumOf(AI_MODE),
    source_file_ids: strArr,
    prompt: str,
    must_keep: strArr,
    must_change: strArr,
    aspect: str,
    constraints: strArr,
    policy_check: str,
    status: enumOf(AI_STATUS),
  },
  required: ['index', 'mode', 'source_file_ids', 'prompt', 'must_keep', 'must_change', 'aspect', 'constraints', 'policy_check', 'status'],
} as const;

export const BASE_PACKAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    strategy: STRATEGY_SCHEMA,
    design_text: DESIGN_TEXT_SCHEMA,
    slides: { type: 'array', items: SLIDE_PLAN_SCHEMA },
    visual_direction: VISUAL_DIRECTION_SCHEMA,
    palette: { type: 'array', items: PALETTE_ENTRY_SCHEMA },
    palette_rationale: str,
    brand_kit: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { type: 'integer' },
        mode: enumOf(BRAND_KIT_MODE),
        deviations: strArr,
      },
      required: ['version', 'mode', 'deviations'],
    },
    assets: { type: 'array', items: ASSET_PICK_SCHEMA },
    references: { type: 'array', items: REFERENCE_PICK_SCHEMA },
    ai_recommendations: { type: 'array', items: AI_RECOMMENDATION_SCHEMA },
    warnings: strArr,
    missing: strArr,
    facts_used: strArr,
    confidence: {
      type: 'object',
      additionalProperties: false,
      properties: {
        copy: { type: 'number' },
        assets: { type: 'number' },
        references: { type: 'number' },
      },
      required: ['copy', 'assets', 'references'],
    },
    rationale: str,
  },
  required: [
    'strategy', 'design_text', 'slides', 'visual_direction', 'palette', 'palette_rationale',
    'brand_kit', 'assets', 'references', 'ai_recommendations', 'warnings', 'missing',
    'facts_used', 'confidence', 'rationale',
  ],
} as const satisfies JSONSchema;

// ── Stage 3: DerivativesOutput ───────────────────────────────────────────────
const DERIVATIVE_TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target_kind: enumOf(TARGET_KIND),
    platform: str,
    placement_type: enumOf(PLACEMENT_TYPE),
    target_ref: {
      type: 'object',
      additionalProperties: false,
      properties: {
        publication_id: strOrNull,
        execution_id: strOrNull,
        ad_set_id: strOrNull,
        ad_id: strOrNull,
      },
      required: ['publication_id', 'execution_id', 'ad_set_id', 'ad_id'],
    },
  },
  required: ['target_kind', 'platform', 'placement_type', 'target_ref'],
} as const;

const SAFE_ZONES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    top: { type: ['number', 'null'] },
    bottom: { type: ['number', 'null'] },
    left: { type: ['number', 'null'] },
    right: { type: ['number', 'null'] },
  },
  required: ['top', 'bottom', 'left', 'right'],
} as const;

const VISUAL_ADAPTATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    aspect: str,
    px: pxPair,
    safe_zones: SAFE_ZONES_SCHEMA,
    requires_separate_design: { type: 'boolean' },
    image_change: enumOf(IMAGE_CHANGE),
    image_instructions: str,
    text_reposition: str,
    logo_reposition: str,
    layout_changes: str,
    element_scaling: str,
    slide_mapping: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from_index: { type: 'integer' },
          to_index: intOrNull,
          note: str,
        },
        required: ['from_index', 'to_index', 'note'],
      },
    },
    asset_substitutions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from_file_id: str,
          to_file_id: strOrNull,
          reason: str,
        },
        required: ['from_file_id', 'to_file_id', 'reason'],
      },
    },
  },
  required: [
    'aspect', 'px', 'safe_zones', 'requires_separate_design', 'image_change',
    'image_instructions', 'text_reposition', 'logo_reposition', 'layout_changes',
    'element_scaling', 'slide_mapping', 'asset_substitutions',
  ],
} as const;

const ORGANIC_COPY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    caption: str,
    hashtags: strArr,
    char_count: { type: 'integer' },
    fact_refs: strArr,
  },
  required: ['caption', 'hashtags', 'char_count', 'fact_refs'],
} as const;

const PAID_COPY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    primary_text: str,
    headline: str,
    description: str,
    cta: str,
    destination_url: strOrNull,
    fact_refs: strArr,
  },
  required: ['primary_text', 'headline', 'description', 'cta', 'destination_url', 'fact_refs'],
} as const;

const DERIVATIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    target: DERIVATIVE_TARGET_SCHEMA,
    dimensions: {
      type: 'object',
      additionalProperties: false,
      properties: { aspect: str, px: pxPair },
      required: ['aspect', 'px'],
    },
    adaptation: VISUAL_ADAPTATION_SCHEMA,
    copy: { anyOf: [ORGANIC_COPY_SCHEMA, PAID_COPY_SCHEMA] },
    limits: { type: 'object' },
    warnings: strArr,
  },
  required: ['target', 'dimensions', 'adaptation', 'copy', 'limits', 'warnings'],
} as const;

export const DERIVATIVES_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    derivatives: { type: 'array', items: DERIVATIVE_SCHEMA },
  },
  required: ['derivatives'],
} as const satisfies JSONSchema;
