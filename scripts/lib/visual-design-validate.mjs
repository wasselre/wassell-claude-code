// Pure validation of the design-read Skills' JSON output (slide + post level).
// Claude never writes to the DB directly — this gate enforces the controlled
// vocabulary (docs/creative-director/design-read-vocab.md, mirroring
// src/lib/creative/contracts.ts SlideRead/PostRead) BEFORE the runner persists
// via visual_design_read_upsert. Posture: REJECT on a bad enum (a coerced enum
// would silently corrupt the ranking generated columns); never fabricate ids —
// a result row whose media_id/post_id is not in the manifest is dropped.

const SLIDE_ROLES = new Set(['cover', 'feature', 'specs', 'offer', 'location', 'proof', 'lifestyle', 'cta', 'brand', 'other']);
const LAYOUTS = new Set(['full_bleed_photo_text_bottom', 'full_bleed_photo_text_top', 'split_horizontal', 'split_vertical', 'text_only', 'grid', 'framed', 'collage', 'other']);
const TEXT_POSITIONS = new Set(['top', 'center', 'bottom', 'left', 'right', 'band_bottom', 'band_top', 'overlay_center', 'none']);
const DENSITIES = new Set(['low', 'medium', 'high']);
const ARABIC_STYLES = new Set(['naskh', 'kufi', 'modern_sans', 'calligraphic', 'mixed', 'none']);
const WEIGHT_CONTRASTS = new Set(['low', 'high']);
const NUMERALS = new Set(['arabic_indic', 'western', 'mixed', 'none']);
const PALETTE_ROLES = new Set(['background', 'text', 'accent', 'logo', 'band', 'other']);
const PALETTE_FAMILIES = new Set(['warm', 'cool', 'neutral', 'high_contrast']);
const IMAGE_KINDS = new Set(['photo', 'render', 'illustration', 'graphic', 'none']);
const IMAGE_SUBJECTS = new Set(['exterior', 'interior', 'plan', 'aerial', 'lifestyle', 'people', 'abstract', 'none']);
const LOGO_SIZES = new Set(['small', 'medium', 'large']);
const CTA_TREATMENTS = new Set(['button', 'line', 'phone', 'arrow', 'none']);
const NEGATIVE_SPACES = new Set(['tight', 'balanced', 'generous']);
const FORMATS = new Set(['single', 'carousel']);
const PROGRESSIONS = new Set(['broad_to_specific', 'specific_to_broad', 'flat', 'alternating']);
const CTA_TYPES = new Set(['dm', 'call', 'link', 'visit', 'none']);
const RELATIONS = new Set(['continues', 'contrasts', 'zooms_in', 'proves', 'repeats']);

const HEX = /^#[0-9a-fA-F]{6}$/;

const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && (hi === undefined || v <= hi);
const isStr = (v) => typeof v === 'string';
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isBool = (v) => typeof v === 'boolean';
const brandingOk = (v) => v === 0 || v === 1 || v === 2 || v === 3;

const enumErr = (errs, path, v, set) => {
  if (!set.has(v)) { errs.push(`${path}: invalid enum value ${JSON.stringify(v)}`); return false; }
  return true;
};

/** Validate one SlideRead object. Returns a list of problems ([] = valid). */
export function slideReadProblems(read, path) {
  const errs = [];
  if (!read || typeof read !== 'object' || Array.isArray(read)) return [`${path}: not an object`];
  enumErr(errs, `${path}.slide_role`, read.slide_role, SLIDE_ROLES);
  enumErr(errs, `${path}.layout`, read.layout, LAYOUTS);
  enumErr(errs, `${path}.text_position`, read.text_position, TEXT_POSITIONS);
  if (!isNum(read.text_share, 0, 1)) errs.push(`${path}.text_share: must be 0..1 (got ${JSON.stringify(read.text_share)})`);
  enumErr(errs, `${path}.density`, read.density, DENSITIES);
  if (!isStrArr(read.hierarchy)) errs.push(`${path}.hierarchy: must be string[]`);

  const t = read.typography;
  if (!t || typeof t !== 'object') errs.push(`${path}.typography: missing`);
  else {
    enumErr(errs, `${path}.typography.arabic_style`, t.arabic_style, ARABIC_STYLES);
    if (!isInt(t.size_levels, 1)) errs.push(`${path}.typography.size_levels: must be int ≥ 1`);
    enumErr(errs, `${path}.typography.weight_contrast`, t.weight_contrast, WEIGHT_CONTRASTS);
    if (!isBool(t.latin_present)) errs.push(`${path}.typography.latin_present: must be boolean`);
    enumErr(errs, `${path}.typography.numerals`, t.numerals, NUMERALS);
  }

  if (!Array.isArray(read.palette) || read.palette.length < 1 || read.palette.length > 6) {
    errs.push(`${path}.palette: must be 1..6 entries`);
  } else {
    read.palette.forEach((p, i) => {
      const pp = `${path}.palette[${i}]`;
      if (!p || typeof p !== 'object') { errs.push(`${pp}: not an object`); return; }
      if (!isStr(p.hex) || !HEX.test(p.hex)) errs.push(`${pp}.hex: must be #RRGGBB (got ${JSON.stringify(p.hex)})`);
      enumErr(errs, `${pp}.role`, p.role, PALETTE_ROLES);
      if (!isNum(p.share, 0, 1)) errs.push(`${pp}.share: must be 0..1`);
    });
  }
  enumErr(errs, `${path}.palette_family`, read.palette_family, PALETTE_FAMILIES);

  const im = read.image;
  if (!im || typeof im !== 'object') errs.push(`${path}.image: missing`);
  else {
    if (!isBool(im.present)) errs.push(`${path}.image.present: must be boolean`);
    enumErr(errs, `${path}.image.kind`, im.kind, IMAGE_KINDS);
    enumErr(errs, `${path}.image.subject`, im.subject, IMAGE_SUBJECTS);
    if (!isStrArr(im.treatment)) errs.push(`${path}.image.treatment: must be string[]`);
  }

  const lg = read.logo;
  if (!lg || typeof lg !== 'object') errs.push(`${path}.logo: missing`);
  else {
    if (!isBool(lg.present)) errs.push(`${path}.logo.present: must be boolean`);
    if (!(lg.position === null || isStr(lg.position))) errs.push(`${path}.logo.position: string|null`);
    if (!(lg.variant === null || isStr(lg.variant))) errs.push(`${path}.logo.variant: string|null`);
    if (!(lg.size === null || LOGO_SIZES.has(lg.size))) errs.push(`${path}.logo.size: small|medium|large|null`);
  }

  const cta = read.cta;
  if (!cta || typeof cta !== 'object') errs.push(`${path}.cta: missing`);
  else {
    if (!isBool(cta.present)) errs.push(`${path}.cta.present: must be boolean`);
    enumErr(errs, `${path}.cta.treatment`, cta.treatment, CTA_TREATMENTS);
  }

  if (!isStrArr(read.decoration)) errs.push(`${path}.decoration: must be string[]`);
  if (!brandingOk(read.branding_intensity)) errs.push(`${path}.branding_intensity: must be 0|1|2|3`);
  if (!isStrArr(read.mood)) errs.push(`${path}.mood: must be string[]`);
  enumErr(errs, `${path}.negative_space`, read.negative_space, NEGATIVE_SPACES);

  const rb = read.readability;
  if (!rb || typeof rb !== 'object') errs.push(`${path}.readability: missing`);
  else {
    if (!isBool(rb.contrast_ok)) errs.push(`${path}.readability.contrast_ok: must be boolean`);
    if (!isStr(rb.notes)) errs.push(`${path}.readability.notes: must be string`);
  }
  if (!isStrArr(read.style_tags)) errs.push(`${path}.style_tags: must be string[]`);
  if (!isStr(read.notes)) errs.push(`${path}.notes: must be string`);
  return errs;
}

/** Validate one PostRead object against its manifest slide list. */
export function postReadProblems(read, path, slideCount) {
  const errs = [];
  if (!read || typeof read !== 'object' || Array.isArray(read)) return [`${path}: not an object`];
  enumErr(errs, `${path}.format`, read.format, FORMATS);
  if (!isInt(read.slide_count, 1)) errs.push(`${path}.slide_count: must be int ≥ 1`);
  else if (read.slide_count !== slideCount) errs.push(`${path}.slide_count ${read.slide_count} ≠ manifest slides ${slideCount}`);
  if (read.format === 'single' && slideCount !== 1) errs.push(`${path}: format 'single' but manifest has ${slideCount} slides`);
  if (!Array.isArray(read.role_sequence) || read.role_sequence.length !== slideCount) {
    errs.push(`${path}.role_sequence: must be an array of length ${slideCount}`);
  } else {
    read.role_sequence.forEach((r, i) => enumErr(errs, `${path}.role_sequence[${i}]`, r, SLIDE_ROLES));
  }
  if (!isStr(read.narrative_arc)) errs.push(`${path}.narrative_arc: must be string`);
  enumErr(errs, `${path}.information_progression`, read.information_progression, PROGRESSIONS);

  const c2c = read.cover_to_cta;
  if (!c2c || typeof c2c !== 'object') errs.push(`${path}.cover_to_cta: missing`);
  else {
    if (!isBool(c2c.promise_kept)) errs.push(`${path}.cover_to_cta.promise_kept: must be boolean`);
    if (!(c2c.cta_slide_index === null || isInt(c2c.cta_slide_index, 1, slideCount)))
      errs.push(`${path}.cover_to_cta.cta_slide_index: null or int 1..${slideCount} (got ${JSON.stringify(c2c.cta_slide_index)})`);
    enumErr(errs, `${path}.cover_to_cta.cta_type`, c2c.cta_type, CTA_TYPES);
    if (!isStr(c2c.notes)) errs.push(`${path}.cover_to_cta.notes: must be string`);
  }

  if (!Array.isArray(read.slide_relationships)) errs.push(`${path}.slide_relationships: must be array`);
  else read.slide_relationships.forEach((r, i) => {
    const pp = `${path}.slide_relationships[${i}]`;
    if (!r || typeof r !== 'object') { errs.push(`${pp}: not an object`); return; }
    if (!isInt(r.from, 1, slideCount) || !isInt(r.to, 1, slideCount))
      errs.push(`${pp}: from/to must be int 1..${slideCount}`);
    enumErr(errs, `${pp}.relation`, r.relation, RELATIONS);
  });

  const rl = read.recurring_layout;
  if (!rl || typeof rl !== 'object') errs.push(`${path}.recurring_layout: missing`);
  else {
    if (!isBool(rl.template_used)) errs.push(`${path}.recurring_layout.template_used: must be boolean`);
    if (!isStr(rl.layout_family)) errs.push(`${path}.recurring_layout.layout_family: must be string`);
    if (!isStrArr(rl.varies_on)) errs.push(`${path}.recurring_layout.varies_on: must be string[]`);
    if (!isStrArr(rl.fixed)) errs.push(`${path}.recurring_layout.fixed: must be string[]`);
  }

  const vc = read.visual_continuity;
  if (!vc || typeof vc !== 'object') errs.push(`${path}.visual_continuity: missing`);
  else {
    for (const k of ['palette_consistent', 'typography_consistent', 'logo_consistent', 'image_treatment_consistent'])
      if (!isBool(vc[k])) errs.push(`${path}.visual_continuity.${k}: must be boolean`);
    if (!isNum(vc.score, 0, 1)) errs.push(`${path}.visual_continuity.score: must be 0..1`);
  }

  const ds = read.design_system;
  if (!ds || typeof ds !== 'object') errs.push(`${path}.design_system: missing`);
  else {
    if (!Array.isArray(ds.palette)) errs.push(`${path}.design_system.palette: must be array`);
    else ds.palette.forEach((p, i) => {
      if (!p || typeof p !== 'object' || !isStr(p.hex) || !HEX.test(p.hex) || !isStr(p.role))
        errs.push(`${path}.design_system.palette[${i}]: must be {hex:#RRGGBB, role:string}`);
    });
    if (!(ds.typography && typeof ds.typography === 'object' && !Array.isArray(ds.typography)))
      errs.push(`${path}.design_system.typography: must be object`);
    if (!isStrArr(ds.decoration)) errs.push(`${path}.design_system.decoration: must be string[]`);
    if (!isStr(ds.logo_rules)) errs.push(`${path}.design_system.logo_rules: must be string`);
  }

  if (!Array.isArray(read.content_density_profile) || read.content_density_profile.length !== slideCount) {
    errs.push(`${path}.content_density_profile: must be an array of length ${slideCount}`);
  } else {
    read.content_density_profile.forEach((d, i) => enumErr(errs, `${path}.content_density_profile[${i}]`, d, DENSITIES));
  }
  if (!brandingOk(read.branding_intensity)) errs.push(`${path}.branding_intensity: must be 0|1|2|3`);

  const is2 = read.image_strategy;
  if (!is2 || typeof is2 !== 'object') errs.push(`${path}.image_strategy: missing`);
  else {
    if (!(is2.mix && typeof is2.mix === 'object' && !Array.isArray(is2.mix))) errs.push(`${path}.image_strategy.mix: must be object`);
    else for (const [k, v] of Object.entries(is2.mix)) if (!isNum(v, 0, 1)) errs.push(`${path}.image_strategy.mix.${k}: must be 0..1`);
    if (!isStr(is2.asset_dependency)) errs.push(`${path}.image_strategy.asset_dependency: must be string`);
    if (!isStr(is2.reusability)) errs.push(`${path}.image_strategy.reusability: must be string`);
  }

  if (!isStr(read.copy_design_relationship)) errs.push(`${path}.copy_design_relationship: must be string`);
  if (!isStrArr(read.mood)) errs.push(`${path}.mood: must be string[]`);
  if (!isStrArr(read.style_tags)) errs.push(`${path}.style_tags: must be string[]`);
  if (!isStrArr(read.strengths)) errs.push(`${path}.strengths: must be string[]`);
  if (!isStrArr(read.weaknesses)) errs.push(`${path}.weaknesses: must be string[]`);
  const ln = read.learnable;
  if (!ln || typeof ln !== 'object') errs.push(`${path}.learnable: missing`);
  else for (const k of ['structure', 'hierarchy', 'avoid']) if (!isStr(ln[k])) errs.push(`${path}.learnable.${k}: must be string`);
  if (!isStr(read.summary)) errs.push(`${path}.summary: must be string`);
  return errs;
}

/**
 * Validate the slide skill's result array against the manifest.
 * @param {unknown} rawResults parsed result.json
 * @param {Array<{media_id:string, post_id:string, carousel_index?:number, subject_kind?:string, org?:string|null}>} manifest
 * @returns {{ valid: Array<{mediaId:string, postId:string, slideIndex:number|null, subjectKind:string|null, org:string|null, read:object}>, errors: string[] }}
 */
export function validateSlideReads(rawResults, manifest) {
  const errors = [];
  if (!Array.isArray(rawResults)) return { valid: [], errors: ['result is not a JSON array'] };
  const byId = new Map(manifest.map((m) => [m.media_id, m]));
  const seen = new Set();
  const valid = [];
  for (const item of rawResults) {
    if (!item || typeof item !== 'object') { errors.push('non-object result item'); continue; }
    const src = typeof item.media_id === 'string' ? byId.get(item.media_id) : undefined;
    if (!src) { errors.push(`unknown/missing media_id: ${JSON.stringify(item.media_id)}`); continue; }
    if (seen.has(item.media_id)) { errors.push(`duplicate media_id: ${item.media_id}`); continue; }
    const problems = slideReadProblems(item.read, `media ${item.media_id}`);
    if (problems.length > 0) { errors.push(...problems.slice(0, 6)); continue; }
    seen.add(item.media_id);
    valid.push({
      mediaId: item.media_id,
      postId: src.post_id,
      slideIndex: Number.isInteger(item.slide_index) ? item.slide_index : (src.carousel_index ?? null),
      subjectKind: src.subject_kind ?? null,
      org: src.org ?? null,
      read: item.read,
    });
  }
  for (const m of manifest) if (!seen.has(m.media_id)) errors.push(`media ${m.media_id}: missing from result`);
  return { valid, errors };
}

/**
 * Validate the post skill's result array against the manifest.
 * @param {unknown} rawResults parsed result.json
 * @param {Array<{post_id:string, subject_kind?:string, org?:string|null, slides:Array<unknown>}>} posts
 * @returns {{ valid: Array<{postId:string, subjectKind:string|null, org:string|null, read:object}>, errors: string[] }}
 */
export function validatePostReads(rawResults, posts) {
  const errors = [];
  if (!Array.isArray(rawResults)) return { valid: [], errors: ['result is not a JSON array'] };
  const byId = new Map(posts.map((p) => [p.post_id, p]));
  const seen = new Set();
  const valid = [];
  for (const item of rawResults) {
    if (!item || typeof item !== 'object') { errors.push('non-object result item'); continue; }
    const src = typeof item.post_id === 'string' ? byId.get(item.post_id) : undefined;
    if (!src) { errors.push(`unknown/missing post_id: ${JSON.stringify(item.post_id)}`); continue; }
    if (seen.has(item.post_id)) { errors.push(`duplicate post_id: ${item.post_id}`); continue; }
    const slideCount = Array.isArray(src.slides) ? src.slides.length : 0;
    const problems = postReadProblems(item.read, `post ${item.post_id}`, slideCount);
    if (problems.length > 0) { errors.push(...problems.slice(0, 6)); continue; }
    seen.add(item.post_id);
    valid.push({ postId: item.post_id, subjectKind: src.subject_kind ?? null, org: src.org ?? null, read: item.read });
  }
  for (const p of posts) if (!seen.has(p.post_id)) errors.push(`post ${p.post_id}: missing from result`);
  return { valid, errors };
}
