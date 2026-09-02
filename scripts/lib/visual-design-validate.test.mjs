import { describe, it, expect } from 'vitest';
import { validateSlideReads, validatePostReads, slideReadProblems, postReadProblems } from './visual-design-validate.mjs';

const M1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const M2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const P1 = 'bbbbbbbb-0000-0000-0000-000000000001';

const goodSlideRead = () => ({
  slide_role: 'cover',
  layout: 'full_bleed_photo_text_bottom',
  text_position: 'band_bottom',
  text_share: 0.3,
  density: 'medium',
  hierarchy: ['headline', 'price', 'logo'],
  typography: { arabic_style: 'modern_sans', size_levels: 3, weight_contrast: 'high', latin_present: false, numerals: 'western' },
  palette: [
    { hex: '#4A2C2A', role: 'band', share: 0.2 },
    { hex: '#F5EDE0', role: 'text', share: 0.1 },
    { hex: '#B8734F', role: 'accent', share: 0.05 },
  ],
  palette_family: 'warm',
  image: { present: true, kind: 'render', subject: 'exterior', treatment: ['darkened_for_text'] },
  logo: { present: true, position: 'top_right', variant: 'light', size: 'small' },
  cta: { present: true, treatment: 'phone' },
  decoration: ['gold_rule'],
  branding_intensity: 2,
  mood: ['luxurious'],
  negative_space: 'balanced',
  readability: { contrast_ok: true, notes: '' },
  style_tags: ['minimal_luxury'],
  notes: '',
});

const goodPostRead = (n) => ({
  format: n === 1 ? 'single' : 'carousel',
  slide_count: n,
  role_sequence: Array.from({ length: n }, (_, i) => (i === 0 ? 'cover' : i === n - 1 ? 'cta' : 'feature')),
  narrative_arc: 'hook → features → CTA',
  information_progression: 'broad_to_specific',
  cover_to_cta: { promise_kept: true, cta_slide_index: n, cta_type: 'call', notes: '' },
  slide_relationships: n > 1 ? [{ from: 1, to: 2, relation: 'continues' }] : [],
  recurring_layout: { template_used: true, layout_family: 'full_bleed_photo_text_bottom', varies_on: ['photo', 'headline'], fixed: ['band', 'logo'] },
  visual_continuity: { palette_consistent: true, typography_consistent: true, logo_consistent: true, image_treatment_consistent: true, score: 0.9 },
  design_system: { palette: [{ hex: '#4A2C2A', role: 'band' }], typography: { display: 'modern_sans' }, decoration: ['gold_rule'], logo_rules: 'always top right' },
  content_density_profile: Array.from({ length: n }, () => 'medium'),
  branding_intensity: 2,
  image_strategy: { mix: { render: 1 }, asset_dependency: 'needs one render per slide', reusability: 'template reusable' },
  copy_design_relationship: 'copy leads; design frames it',
  mood: ['luxurious'],
  style_tags: ['minimal_luxury'],
  strengths: ['clear hierarchy'],
  weaknesses: ['small cta'],
  learnable: { structure: 'cover + features + cta', hierarchy: 'headline first', avoid: 'cluttered specs' },
  summary: 'A clean luxury carousel.',
});

const slideManifest = [
  { media_id: M1, post_id: P1, carousel_index: 0, subject_kind: 'competitor_media', org: 'org-1' },
  { media_id: M2, post_id: P1, carousel_index: 1, subject_kind: 'competitor_media', org: 'org-1' },
];

describe('validateSlideReads', () => {
  it('accepts a fully valid result set', () => {
    const { valid, errors } = validateSlideReads(
      [ { media_id: M1, post_id: P1, slide_index: 0, read: goodSlideRead() },
        { media_id: M2, post_id: P1, slide_index: 1, read: goodSlideRead() } ],
      slideManifest);
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(2);
    expect(valid[0].subjectKind).toBe('competitor_media');
    expect(valid[1].slideIndex).toBe(1);
  });

  it('REJECTS a hallucinated media_id', () => {
    const { valid, errors } = validateSlideReads(
      [ { media_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', post_id: P1, slide_index: 0, read: goodSlideRead() },
        { media_id: M1, post_id: P1, slide_index: 0, read: goodSlideRead() },
        { media_id: M2, post_id: P1, slide_index: 1, read: goodSlideRead() } ],
      slideManifest);
    expect(valid).toHaveLength(2);
    expect(errors.join(' ')).toMatch(/unknown\/missing media_id/);
  });

  it('REJECTS a bad enum value (no coercion)', () => {
    const bad = goodSlideRead();
    bad.density = 'very_high';
    const { valid, errors } = validateSlideReads(
      [ { media_id: M1, post_id: P1, slide_index: 0, read: bad },
        { media_id: M2, post_id: P1, slide_index: 1, read: goodSlideRead() } ],
      slideManifest);
    expect(valid).toHaveLength(1);
    expect(errors.join(' ')).toMatch(/density: invalid enum value/);
  });

  it('REJECTS an out-of-range text_share and a malformed hex', () => {
    const bad = goodSlideRead();
    bad.text_share = 1.4;
    bad.palette[0].hex = 'red';
    const problems = slideReadProblems(bad, 'm');
    expect(problems.join(' ')).toMatch(/text_share/);
    expect(problems.join(' ')).toMatch(/hex/);
  });

  it('flags a manifest item missing from the result', () => {
    const { errors } = validateSlideReads(
      [{ media_id: M1, post_id: P1, slide_index: 0, read: goodSlideRead() }],
      slideManifest);
    expect(errors.join(' ')).toMatch(new RegExp(`${M2}: missing from result`));
  });

  it('rejects duplicates but keeps the first', () => {
    const { valid, errors } = validateSlideReads(
      [ { media_id: M1, post_id: P1, slide_index: 0, read: goodSlideRead() },
        { media_id: M1, post_id: P1, slide_index: 0, read: goodSlideRead() },
        { media_id: M2, post_id: P1, slide_index: 1, read: goodSlideRead() } ],
      slideManifest);
    expect(valid).toHaveLength(2);
    expect(errors.join(' ')).toMatch(/duplicate media_id/);
  });
});

describe('validatePostReads', () => {
  const postManifest = [
    { post_id: P1, subject_kind: 'competitor_post', org: 'org-1', slides: [{ media_id: M1 }, { media_id: M2 }] },
  ];

  it('accepts a valid 2-slide carousel read', () => {
    const { valid, errors } = validatePostReads([{ post_id: P1, read: goodPostRead(2) }], postManifest);
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
  });

  it('REJECTS a slide_count that disagrees with the manifest', () => {
    const bad = goodPostRead(2);
    bad.slide_count = 3;
    const { valid, errors } = validatePostReads([{ post_id: P1, read: bad }], postManifest);
    expect(valid).toHaveLength(0);
    expect(errors.join(' ')).toMatch(/slide_count 3 ≠ manifest slides 2/);
  });

  it('REJECTS a role_sequence of the wrong length', () => {
    const bad = goodPostRead(2);
    bad.role_sequence = ['cover'];
    const problems = postReadProblems(bad, 'p', 2);
    expect(problems.join(' ')).toMatch(/role_sequence: must be an array of length 2/);
  });

  it('REJECTS a cta_slide_index out of range and a bad relation enum', () => {
    const bad = goodPostRead(2);
    bad.cover_to_cta.cta_slide_index = 5;
    bad.slide_relationships = [{ from: 1, to: 2, relation: 'supports' }];
    const problems = postReadProblems(bad, 'p', 2);
    expect(problems.join(' ')).toMatch(/cta_slide_index/);
    expect(problems.join(' ')).toMatch(/relation.*invalid enum/);
  });

  it('REJECTS format single with multiple slides', () => {
    const bad = goodPostRead(2);
    bad.format = 'single';
    const problems = postReadProblems(bad, 'p', 2);
    expect(problems.join(' ')).toMatch(/format 'single' but manifest has 2 slides/);
  });

  it('accepts a single-image post read', () => {
    const manifest = [{ post_id: P1, subject_kind: 'competitor_post', org: null, slides: [{ media_id: M1 }] }];
    const { valid, errors } = validatePostReads([{ post_id: P1, read: goodPostRead(1) }], manifest);
    expect(errors).toEqual([]);
    expect(valid[0].read.format).toBe('single');
  });

  it('REJECTS a hallucinated post_id', () => {
    const { valid, errors } = validatePostReads([{ post_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', read: goodPostRead(2) }], postManifest);
    expect(valid).toHaveLength(0);
    expect(errors.join(' ')).toMatch(/unknown\/missing post_id/);
  });
});
