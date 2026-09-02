import { describe, expect, it } from 'vitest';
import type { BasePackage, DerivativeTarget } from '../../contracts.js';
import { PLACEMENT_SPECS } from '../../placementSpecs.js';
import {
  deterministicSlideMapping,
  finalizeAdaptation,
  planAdaptations,
  specLimits,
  targetKey,
} from '../adaptation.js';

const IG_FEED: DerivativeTarget = { target_kind: 'organic', platform: 'instagram', placement_type: 'feed', target_ref: {} };
const IG_STORY: DerivativeTarget = { target_kind: 'organic', platform: 'instagram', placement_type: 'story', target_ref: {} };

const SINGLE_BASE: Pick<BasePackage, 'strategy' | 'slides'> = {
  strategy: { master_aspect: '4:5', format: 'single' } as BasePackage['strategy'],
  slides: [],
};

const CAROUSEL_BASE: Pick<BasePackage, 'strategy' | 'slides'> = {
  strategy: { master_aspect: '4:5', format: 'carousel' } as BasePackage['strategy'],
  slides: [1, 2, 3].map((i) => ({ index: i }) as BasePackage['slides'][number]),
};

describe('planAdaptations', () => {
  it('4:5 master → 9:16 story requires a separate design with an extend', () => {
    const [p] = planAdaptations(SINGLE_BASE, [IG_STORY], PLACEMENT_SPECS);
    expect(p.skeleton).not.toBeNull();
    expect(p.skeleton!.aspect).toBe('9:16');
    expect(p.skeleton!.px).toEqual([1080, 1920]);
    expect(p.skeleton!.requires_separate_design).toBe(true);
    expect(p.skeleton!.image_change).toBe('extend');
    expect(p.dimensions).toEqual({ aspect: '9:16', px: [1080, 1920] });
  });

  it('same-aspect target is geometry-stable (no change)', () => {
    const [p] = planAdaptations(SINGLE_BASE, [IG_FEED], PLACEMENT_SPECS);
    expect(p.skeleton!.requires_separate_design).toBe(false);
    expect(p.skeleton!.image_change).toBe('none');
    expect(p.limits.caption_max).toBe(2000);
  });

  it('a target without a spec plans as null (never guessed)', () => {
    const weird: DerivativeTarget = { target_kind: 'organic', platform: 'threads', placement_type: 'feed', target_ref: {} };
    const [p] = planAdaptations(SINGLE_BASE, [weird], PLACEMENT_SPECS);
    expect(p.spec).toBeNull();
    expect(p.skeleton).toBeNull();
    expect(p.dimensions).toBeNull();
  });

  it('specLimits carries only the ceilings the spec has', () => {
    const story = PLACEMENT_SPECS.find((s) => s.platform === 'instagram' && s.placement_type === 'story')!;
    expect(specLimits(story)).toEqual({ formats: ['jpg', 'png'] });
  });
});

describe('deterministicSlideMapping', () => {
  it('carousel → single-frame placement keeps the cover, drops the rest', () => {
    const story = PLACEMENT_SPECS.find((s) => s.platform === 'instagram' && s.placement_type === 'story')!;
    const m = deterministicSlideMapping(3, story);
    expect(m).toHaveLength(3);
    expect(m[0]).toMatchObject({ from_index: 1, to_index: 1 });
    expect(m[1]).toMatchObject({ from_index: 2, to_index: null });
    expect(m[2]).toMatchObject({ from_index: 3, to_index: null });
  });

  it('carousel → multi-frame placement maps slide per frame', () => {
    const tiktok = PLACEMENT_SPECS.find((s) => s.platform === 'tiktok' && s.placement_type === 'photo_mode')!;
    const m = deterministicSlideMapping(3, tiktok);
    expect(m.every((e) => e.to_index !== null)).toBe(true);
  });
});

describe('finalizeAdaptation', () => {
  it('fills explicit "no change" wording when nothing changes and the model left prose empty', () => {
    const [p] = planAdaptations(SINGLE_BASE, [IG_FEED], PLACEMENT_SPECS);
    const a = finalizeAdaptation(undefined, p, 0);
    expect(a.image_change).toBe('none');
    expect(a.image_instructions).toContain('لا تغيير');
    expect(a.text_reposition).toContain('لا تغيير');
    expect(a.logo_reposition).toContain('لا تغيير');
    expect(a.layout_changes).toContain('لا تغيير');
    expect(a.element_scaling).toContain('لا تغيير');
  });

  it('skeleton facts beat the model: geometry is never model-authored', () => {
    const [p] = planAdaptations(SINGLE_BASE, [IG_STORY], PLACEMENT_SPECS);
    const a = finalizeAdaptation(
      { aspect: '1:1', px: [1, 1], requires_separate_design: false, image_change: 'none' },
      p,
      0,
    );
    expect(a.aspect).toBe('9:16');
    expect(a.px).toEqual([1080, 1920]);
    expect(a.requires_separate_design).toBe(true);
    expect(a.image_change).toBe('extend');
    // separate-design prose fallback mentions the re-layout, never an empty string
    expect(a.layout_changes.length).toBeGreaterThan(0);
    expect(a.image_instructions.length).toBeGreaterThan(0);
  });

  it('keeps the model slide mapping only when it covers every master slide', () => {
    const [p] = planAdaptations(CAROUSEL_BASE, [IG_FEED], PLACEMENT_SPECS);
    const partial = finalizeAdaptation({ slide_mapping: [{ from_index: 1, to_index: 1, note: 'x' }] }, p, 3);
    expect(partial.slide_mapping).toHaveLength(3); // deterministic replacement
    const full = finalizeAdaptation(
      {
        slide_mapping: [
          { from_index: 1, to_index: 1, note: 'a' },
          { from_index: 2, to_index: 2, note: 'b' },
          { from_index: 3, to_index: 3, note: 'c' },
        ],
      },
      p,
      3,
    );
    expect(full.slide_mapping[1]!.note).toBe('b'); // model's kept
  });

  it('carousel master plans a deterministic mapping for a non-carousel target', () => {
    const [p] = planAdaptations(CAROUSEL_BASE, [IG_STORY], PLACEMENT_SPECS);
    expect(p.skeleton!.slide_mapping).toHaveLength(3);
    expect(p.skeleton!.slide_mapping[2]!.to_index).toBeNull();
  });
});

describe('targetKey', () => {
  it('is the grounding key shape', () => {
    expect(targetKey(IG_FEED)).toBe('organic:instagram:feed');
  });
});
