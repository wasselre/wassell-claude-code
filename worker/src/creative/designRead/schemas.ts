/**
 * Design-read JSON schemas + runtime validators (worker path).
 *
 * The JSON schemas are sent to the model via structured outputs; the runtime
 * validators re-check the parsed output before it is persisted (the schema
 * constrains shape at the API, the validator is the belt-and-braces gate the
 * runner path also applies — scripts/lib/visual-design-validate.mjs, of which
 * the validators here are a TypeScript PORT; the worker is a standalone
 * package and cannot import scripts/). Keep both in sync.
 *
 * Vocabulary source of truth: src/lib/creative/contracts.ts (SlideRead /
 * PostRead) — mirrored in docs/creative-director/design-read-vocab.md.
 */

import type { JSONSchema } from '../../ai/index.js';
import type { PostRead, SlideRead } from '../contracts.js';

// ── enum sets (mirror contracts.ts exactly) ─────────────────────────────────
const SLIDE_ROLES = ['cover', 'feature', 'specs', 'offer', 'location', 'proof', 'lifestyle', 'cta', 'brand', 'other'] as const;
const LAYOUTS = ['full_bleed_photo_text_bottom', 'full_bleed_photo_text_top', 'split_horizontal', 'split_vertical', 'text_only', 'grid', 'framed', 'collage', 'other'] as const;
const TEXT_POSITIONS = ['top', 'center', 'bottom', 'left', 'right', 'band_bottom', 'band_top', 'overlay_center', 'none'] as const;
const DENSITIES = ['low', 'medium', 'high'] as const;
const ARABIC_STYLES = ['naskh', 'kufi', 'modern_sans', 'calligraphic', 'mixed', 'none'] as const;
const WEIGHT_CONTRASTS = ['low', 'high'] as const;
const NUMERALS = ['arabic_indic', 'western', 'mixed', 'none'] as const;
const PALETTE_ROLES = ['background', 'text', 'accent', 'logo', 'band', 'other'] as const;
const PALETTE_FAMILIES = ['warm', 'cool', 'neutral', 'high_contrast'] as const;
const IMAGE_KINDS = ['photo', 'render', 'illustration', 'graphic', 'none'] as const;
const IMAGE_SUBJECTS = ['exterior', 'interior', 'plan', 'aerial', 'lifestyle', 'people', 'abstract', 'none'] as const;
const LOGO_SIZES = ['small', 'medium', 'large'] as const;
const CTA_TREATMENTS = ['button', 'line', 'phone', 'arrow', 'none'] as const;
const NEGATIVE_SPACES = ['tight', 'balanced', 'generous'] as const;
const FORMATS = ['single', 'carousel'] as const;
const PROGRESSIONS = ['broad_to_specific', 'specific_to_broad', 'flat', 'alternating'] as const;
const CTA_TYPES = ['dm', 'call', 'link', 'visit', 'none'] as const;
const RELATIONS = ['continues', 'contrasts', 'zooms_in', 'proves', 'repeats'] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

type Rec = Record<string, unknown>;
const isObj = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isInt = (v: unknown, lo: number, hi?: number): boolean => Number.isInteger(v) && (v as number) >= lo && (hi === undefined || (v as number) <= hi);
const isStrArr = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
const brandingOk = (v: unknown): boolean => v === 0 || v === 1 || v === 2 || v === 3;
const oneOf = (v: unknown, set: readonly string[]): boolean => typeof v === 'string' && (set as readonly string[]).includes(v);

// ── JSON Schemas (structured outputs) ────────────────────────────────────────

export const SLIDE_READ_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    slide_role: { type: 'string', enum: SLIDE_ROLES },
    layout: { type: 'string', enum: LAYOUTS },
    text_position: { type: 'string', enum: TEXT_POSITIONS },
    text_share: { type: 'number', minimum: 0, maximum: 1 },
    density: { type: 'string', enum: DENSITIES },
    hierarchy: { type: 'array', items: { type: 'string' } },
    typography: {
      type: 'object', additionalProperties: false,
      properties: {
        arabic_style: { type: 'string', enum: ARABIC_STYLES },
        size_levels: { type: 'integer', minimum: 1 },
        weight_contrast: { type: 'string', enum: WEIGHT_CONTRASTS },
        latin_present: { type: 'boolean' },
        numerals: { type: 'string', enum: NUMERALS },
      },
      required: ['arabic_style', 'size_levels', 'weight_contrast', 'latin_present', 'numerals'],
    },
    palette: {
      type: 'array', minItems: 1, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          hex: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
          role: { type: 'string', enum: PALETTE_ROLES },
          share: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['hex', 'role', 'share'],
      },
    },
    palette_family: { type: 'string', enum: PALETTE_FAMILIES },
    image: {
      type: 'object', additionalProperties: false,
      properties: {
        present: { type: 'boolean' },
        kind: { type: 'string', enum: IMAGE_KINDS },
        subject: { type: 'string', enum: IMAGE_SUBJECTS },
        treatment: { type: 'array', items: { type: 'string' } },
      },
      required: ['present', 'kind', 'subject', 'treatment'],
    },
    logo: {
      type: 'object', additionalProperties: false,
      properties: {
        present: { type: 'boolean' },
        position: { type: ['string', 'null'] },
        variant: { type: ['string', 'null'] },
        size: { type: ['string', 'null'], enum: [...LOGO_SIZES, null] },
      },
      required: ['present', 'position', 'variant', 'size'],
    },
    cta: {
      type: 'object', additionalProperties: false,
      properties: {
        present: { type: 'boolean' },
        treatment: { type: 'string', enum: CTA_TREATMENTS },
      },
      required: ['present', 'treatment'],
    },
    decoration: { type: 'array', items: { type: 'string' } },
    branding_intensity: { type: 'integer', enum: [0, 1, 2, 3] },
    mood: { type: 'array', items: { type: 'string' } },
    negative_space: { type: 'string', enum: NEGATIVE_SPACES },
    readability: {
      type: 'object', additionalProperties: false,
      properties: { contrast_ok: { type: 'boolean' }, notes: { type: 'string' } },
      required: ['contrast_ok', 'notes'],
    },
    style_tags: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: [
    'slide_role', 'layout', 'text_position', 'text_share', 'density', 'hierarchy',
    'typography', 'palette', 'palette_family', 'image', 'logo', 'cta', 'decoration',
    'branding_intensity', 'mood', 'negative_space', 'readability', 'style_tags', 'notes',
  ],
};

export const POST_READ_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    format: { type: 'string', enum: FORMATS },
    slide_count: { type: 'integer', minimum: 1 },
    role_sequence: { type: 'array', items: { type: 'string', enum: SLIDE_ROLES } },
    narrative_arc: { type: 'string' },
    information_progression: { type: 'string', enum: PROGRESSIONS },
    cover_to_cta: {
      type: 'object', additionalProperties: false,
      properties: {
        promise_kept: { type: 'boolean' },
        cta_slide_index: { type: ['integer', 'null'], minimum: 1 },
        cta_type: { type: 'string', enum: CTA_TYPES },
        notes: { type: 'string' },
      },
      required: ['promise_kept', 'cta_slide_index', 'cta_type', 'notes'],
    },
    slide_relationships: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          from: { type: 'integer', minimum: 1 },
          to: { type: 'integer', minimum: 1 },
          relation: { type: 'string', enum: RELATIONS },
        },
        required: ['from', 'to', 'relation'],
      },
    },
    recurring_layout: {
      type: 'object', additionalProperties: false,
      properties: {
        template_used: { type: 'boolean' },
        layout_family: { type: 'string' },
        varies_on: { type: 'array', items: { type: 'string' } },
        fixed: { type: 'array', items: { type: 'string' } },
      },
      required: ['template_used', 'layout_family', 'varies_on', 'fixed'],
    },
    visual_continuity: {
      type: 'object', additionalProperties: false,
      properties: {
        palette_consistent: { type: 'boolean' },
        typography_consistent: { type: 'boolean' },
        logo_consistent: { type: 'boolean' },
        image_treatment_consistent: { type: 'boolean' },
        score: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['palette_consistent', 'typography_consistent', 'logo_consistent', 'image_treatment_consistent', 'score'],
    },
    design_system: {
      type: 'object', additionalProperties: false,
      properties: {
        palette: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            properties: { hex: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, role: { type: 'string' } },
            required: ['hex', 'role'],
          },
        },
        typography: { type: 'object' },
        decoration: { type: 'array', items: { type: 'string' } },
        logo_rules: { type: 'string' },
      },
      required: ['palette', 'typography', 'decoration', 'logo_rules'],
    },
    content_density_profile: { type: 'array', items: { type: 'string', enum: DENSITIES } },
    branding_intensity: { type: 'integer', enum: [0, 1, 2, 3] },
    image_strategy: {
      type: 'object', additionalProperties: false,
      properties: {
        mix: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } },
        asset_dependency: { type: 'string' },
        reusability: { type: 'string' },
      },
      required: ['mix', 'asset_dependency', 'reusability'],
    },
    copy_design_relationship: { type: 'string' },
    mood: { type: 'array', items: { type: 'string' } },
    style_tags: { type: 'array', items: { type: 'string' } },
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } },
    learnable: {
      type: 'object', additionalProperties: false,
      properties: { structure: { type: 'string' }, hierarchy: { type: 'string' }, avoid: { type: 'string' } },
      required: ['structure', 'hierarchy', 'avoid'],
    },
    summary: { type: 'string' },
  },
  required: [
    'format', 'slide_count', 'role_sequence', 'narrative_arc', 'information_progression',
    'cover_to_cta', 'slide_relationships', 'recurring_layout', 'visual_continuity',
    'design_system', 'content_density_profile', 'branding_intensity', 'image_strategy',
    'copy_design_relationship', 'mood', 'style_tags', 'strengths', 'weaknesses',
    'learnable', 'summary',
  ],
};

// ── runtime validators (TS port of scripts/lib/visual-design-validate.mjs) ───

/** Validate one SlideRead-shaped object. Returns problem strings ([] = valid). */
export function slideReadProblems(read: unknown, path = 'read'): string[] {
  const errs: string[] = [];
  if (!isObj(read)) return [`${path}: not an object`];
  if (!oneOf(read.slide_role, SLIDE_ROLES)) errs.push(`${path}.slide_role: invalid enum value ${JSON.stringify(read.slide_role)}`);
  if (!oneOf(read.layout, LAYOUTS)) errs.push(`${path}.layout: invalid enum value ${JSON.stringify(read.layout)}`);
  if (!oneOf(read.text_position, TEXT_POSITIONS)) errs.push(`${path}.text_position: invalid enum value ${JSON.stringify(read.text_position)}`);
  if (!isNum(read.text_share, 0, 1)) errs.push(`${path}.text_share: must be 0..1`);
  if (!oneOf(read.density, DENSITIES)) errs.push(`${path}.density: invalid enum value ${JSON.stringify(read.density)}`);
  if (!isStrArr(read.hierarchy)) errs.push(`${path}.hierarchy: must be string[]`);

  const t = read.typography;
  if (!isObj(t)) errs.push(`${path}.typography: missing`);
  else {
    if (!oneOf(t.arabic_style, ARABIC_STYLES)) errs.push(`${path}.typography.arabic_style: invalid enum value`);
    if (!isInt(t.size_levels, 1)) errs.push(`${path}.typography.size_levels: must be int ≥ 1`);
    if (!oneOf(t.weight_contrast, WEIGHT_CONTRASTS)) errs.push(`${path}.typography.weight_contrast: invalid enum value`);
    if (typeof t.latin_present !== 'boolean') errs.push(`${path}.typography.latin_present: must be boolean`);
    if (!oneOf(t.numerals, NUMERALS)) errs.push(`${path}.typography.numerals: invalid enum value`);
  }

  if (!Array.isArray(read.palette) || read.palette.length < 1 || read.palette.length > 6) {
    errs.push(`${path}.palette: must be 1..6 entries`);
  } else {
    read.palette.forEach((p, i) => {
      const pp = `${path}.palette[${i}]`;
      if (!isObj(p)) { errs.push(`${pp}: not an object`); return; }
      if (typeof p.hex !== 'string' || !HEX.test(p.hex)) errs.push(`${pp}.hex: must be #RRGGBB`);
      if (!oneOf(p.role, PALETTE_ROLES)) errs.push(`${pp}.role: invalid enum value`);
      if (!isNum(p.share, 0, 1)) errs.push(`${pp}.share: must be 0..1`);
    });
  }
  if (!oneOf(read.palette_family, PALETTE_FAMILIES)) errs.push(`${path}.palette_family: invalid enum value`);

  const im = read.image;
  if (!isObj(im)) errs.push(`${path}.image: missing`);
  else {
    if (typeof im.present !== 'boolean') errs.push(`${path}.image.present: must be boolean`);
    if (!oneOf(im.kind, IMAGE_KINDS)) errs.push(`${path}.image.kind: invalid enum value`);
    if (!oneOf(im.subject, IMAGE_SUBJECTS)) errs.push(`${path}.image.subject: invalid enum value`);
    if (!isStrArr(im.treatment)) errs.push(`${path}.image.treatment: must be string[]`);
  }

  const lg = read.logo;
  if (!isObj(lg)) errs.push(`${path}.logo: missing`);
  else {
    if (typeof lg.present !== 'boolean') errs.push(`${path}.logo.present: must be boolean`);
    if (!(lg.position === null || typeof lg.position === 'string')) errs.push(`${path}.logo.position: string|null`);
    if (!(lg.variant === null || typeof lg.variant === 'string')) errs.push(`${path}.logo.variant: string|null`);
    if (!(lg.size === null || oneOf(lg.size, LOGO_SIZES))) errs.push(`${path}.logo.size: small|medium|large|null`);
  }

  const cta = read.cta;
  if (!isObj(cta)) errs.push(`${path}.cta: missing`);
  else {
    if (typeof cta.present !== 'boolean') errs.push(`${path}.cta.present: must be boolean`);
    if (!oneOf(cta.treatment, CTA_TREATMENTS)) errs.push(`${path}.cta.treatment: invalid enum value`);
  }

  if (!isStrArr(read.decoration)) errs.push(`${path}.decoration: must be string[]`);
  if (!brandingOk(read.branding_intensity)) errs.push(`${path}.branding_intensity: must be 0|1|2|3`);
  if (!isStrArr(read.mood)) errs.push(`${path}.mood: must be string[]`);
  if (!oneOf(read.negative_space, NEGATIVE_SPACES)) errs.push(`${path}.negative_space: invalid enum value`);

  const rb = read.readability;
  if (!isObj(rb)) errs.push(`${path}.readability: missing`);
  else {
    if (typeof rb.contrast_ok !== 'boolean') errs.push(`${path}.readability.contrast_ok: must be boolean`);
    if (typeof rb.notes !== 'string') errs.push(`${path}.readability.notes: must be string`);
  }
  if (!isStrArr(read.style_tags)) errs.push(`${path}.style_tags: must be string[]`);
  if (typeof read.notes !== 'string') errs.push(`${path}.notes: must be string`);
  return errs;
}

/** Validate one PostRead-shaped object against the post's actual slide count. */
export function postReadProblems(read: unknown, path = 'read', slideCount = 1): string[] {
  const errs: string[] = [];
  if (!isObj(read)) return [`${path}: not an object`];
  if (!oneOf(read.format, FORMATS)) errs.push(`${path}.format: invalid enum value`);
  if (!isInt(read.slide_count, 1)) errs.push(`${path}.slide_count: must be int ≥ 1`);
  else if (read.slide_count !== slideCount) errs.push(`${path}.slide_count ${read.slide_count} ≠ slides ${slideCount}`);
  if (read.format === 'single' && slideCount !== 1) errs.push(`${path}: format 'single' but ${slideCount} slides`);
  if (!Array.isArray(read.role_sequence) || read.role_sequence.length !== slideCount) {
    errs.push(`${path}.role_sequence: must be an array of length ${slideCount}`);
  } else {
    read.role_sequence.forEach((r, i) => { if (!oneOf(r, SLIDE_ROLES)) errs.push(`${path}.role_sequence[${i}]: invalid enum value`); });
  }
  if (typeof read.narrative_arc !== 'string') errs.push(`${path}.narrative_arc: must be string`);
  if (!oneOf(read.information_progression, PROGRESSIONS)) errs.push(`${path}.information_progression: invalid enum value`);

  const c2c = read.cover_to_cta;
  if (!isObj(c2c)) errs.push(`${path}.cover_to_cta: missing`);
  else {
    if (typeof c2c.promise_kept !== 'boolean') errs.push(`${path}.cover_to_cta.promise_kept: must be boolean`);
    if (!(c2c.cta_slide_index === null || isInt(c2c.cta_slide_index, 1, slideCount)))
      errs.push(`${path}.cover_to_cta.cta_slide_index: null or int 1..${slideCount}`);
    if (!oneOf(c2c.cta_type, CTA_TYPES)) errs.push(`${path}.cover_to_cta.cta_type: invalid enum value`);
    if (typeof c2c.notes !== 'string') errs.push(`${path}.cover_to_cta.notes: must be string`);
  }

  if (!Array.isArray(read.slide_relationships)) errs.push(`${path}.slide_relationships: must be array`);
  else read.slide_relationships.forEach((r, i) => {
    const pp = `${path}.slide_relationships[${i}]`;
    if (!isObj(r)) { errs.push(`${pp}: not an object`); return; }
    if (!isInt(r.from, 1, slideCount) || !isInt(r.to, 1, slideCount)) errs.push(`${pp}: from/to must be int 1..${slideCount}`);
    if (!oneOf(r.relation, RELATIONS)) errs.push(`${pp}.relation: invalid enum value`);
  });

  const rl = read.recurring_layout;
  if (!isObj(rl)) errs.push(`${path}.recurring_layout: missing`);
  else {
    if (typeof rl.template_used !== 'boolean') errs.push(`${path}.recurring_layout.template_used: must be boolean`);
    if (typeof rl.layout_family !== 'string') errs.push(`${path}.recurring_layout.layout_family: must be string`);
    if (!isStrArr(rl.varies_on)) errs.push(`${path}.recurring_layout.varies_on: must be string[]`);
    if (!isStrArr(rl.fixed)) errs.push(`${path}.recurring_layout.fixed: must be string[]`);
  }

  const vc = read.visual_continuity;
  if (!isObj(vc)) errs.push(`${path}.visual_continuity: missing`);
  else {
    for (const k of ['palette_consistent', 'typography_consistent', 'logo_consistent', 'image_treatment_consistent'] as const)
      if (typeof vc[k] !== 'boolean') errs.push(`${path}.visual_continuity.${k}: must be boolean`);
    if (!isNum(vc.score, 0, 1)) errs.push(`${path}.visual_continuity.score: must be 0..1`);
  }

  const ds = read.design_system;
  if (!isObj(ds)) errs.push(`${path}.design_system: missing`);
  else {
    if (!Array.isArray(ds.palette)) errs.push(`${path}.design_system.palette: must be array`);
    else ds.palette.forEach((p, i) => {
      if (!isObj(p) || typeof p.hex !== 'string' || !HEX.test(p.hex) || typeof p.role !== 'string')
        errs.push(`${path}.design_system.palette[${i}]: must be {hex:#RRGGBB, role:string}`);
    });
    if (!isObj(ds.typography)) errs.push(`${path}.design_system.typography: must be object`);
    if (!isStrArr(ds.decoration)) errs.push(`${path}.design_system.decoration: must be string[]`);
    if (typeof ds.logo_rules !== 'string') errs.push(`${path}.design_system.logo_rules: must be string`);
  }

  if (!Array.isArray(read.content_density_profile) || read.content_density_profile.length !== slideCount) {
    errs.push(`${path}.content_density_profile: must be an array of length ${slideCount}`);
  } else {
    read.content_density_profile.forEach((d, i) => { if (!oneOf(d, DENSITIES)) errs.push(`${path}.content_density_profile[${i}]: invalid enum value`); });
  }
  if (!brandingOk(read.branding_intensity)) errs.push(`${path}.branding_intensity: must be 0|1|2|3`);

  const st = read.image_strategy;
  if (!isObj(st)) errs.push(`${path}.image_strategy: missing`);
  else {
    if (!isObj(st.mix)) errs.push(`${path}.image_strategy.mix: must be object`);
    else for (const [k, v] of Object.entries(st.mix)) if (!isNum(v, 0, 1)) errs.push(`${path}.image_strategy.mix.${k}: must be 0..1`);
    if (typeof st.asset_dependency !== 'string') errs.push(`${path}.image_strategy.asset_dependency: must be string`);
    if (typeof st.reusability !== 'string') errs.push(`${path}.image_strategy.reusability: must be string`);
  }

  if (typeof read.copy_design_relationship !== 'string') errs.push(`${path}.copy_design_relationship: must be string`);
  if (!isStrArr(read.mood)) errs.push(`${path}.mood: must be string[]`);
  if (!isStrArr(read.style_tags)) errs.push(`${path}.style_tags: must be string[]`);
  if (!isStrArr(read.strengths)) errs.push(`${path}.strengths: must be string[]`);
  if (!isStrArr(read.weaknesses)) errs.push(`${path}.weaknesses: must be string[]`);
  const ln = read.learnable;
  if (!isObj(ln)) errs.push(`${path}.learnable: missing`);
  else for (const k of ['structure', 'hierarchy', 'avoid'] as const) if (typeof ln[k] !== 'string') errs.push(`${path}.learnable.${k}: must be string`);
  if (typeof read.summary !== 'string') errs.push(`${path}.summary: must be string`);
  return errs;
}

/** Throw `validation_unrepaired:` when a read fails validation. */
export function assertValidRead(level: 'slide' | 'post', read: unknown, slideCount: number): asserts read is SlideRead | PostRead {
  const problems = level === 'slide' ? slideReadProblems(read) : postReadProblems(read, 'read', slideCount);
  if (problems.length > 0) {
    throw new Error(`validation_unrepaired: ${level} design read failed validation: ${problems.slice(0, 4).join('; ')}`);
  }
}
