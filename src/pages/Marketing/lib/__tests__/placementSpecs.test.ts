import { describe, it, expect } from 'vitest';
import {
  adaptationSkeleton, aspectFamily, masterAspectFor, placementSpec, PLACEMENT_SPECS,
} from '@/lib/marketingOS/platformRules';

/**
 * The SPA-side twin of worker/src/creative/__tests__/placementSpecs.test.ts —
 * platformRules.ts is the canonical home of PLACEMENT_SPECS; the worker copy
 * must stay identical (both are covered by the same expectations).
 */
describe('PLACEMENT_SPECS (platformRules)', () => {
  it('covers the contracted organic + paid targets', () => {
    const keys = PLACEMENT_SPECS.map((s) => `${s.target_kind}:${s.platform}:${s.placement_type}`);
    for (const k of [
      'organic:instagram:feed', 'organic:instagram:carousel', 'organic:instagram:story',
      'organic:tiktok:photo_mode', 'organic:snapchat:story', 'organic:x:post', 'organic:website:post',
      'paid:meta:ad_feed', 'paid:meta:ad_story', 'paid:meta:ad_carousel', 'paid:meta:ad_reels',
      'paid:google:ad_display',
    ]) expect(keys).toContain(k);
  });
  it('reuses the publish-preflight ceilings', () => {
    expect(placementSpec('instagram', 'feed')).toMatchObject({ caption_max: 2000, hashtags_max: 30 });
    expect(placementSpec('snapchat', 'story')).toMatchObject({ caption_max: 160, max_slides: 1 });
    expect(placementSpec('instagram', 'story')?.safe_zones).toEqual({ top: 250, bottom: 250 });
  });
});

describe('aspect helpers', () => {
  it('aspectFamily groups square / portrait / vertical / landscape / wide', () => {
    expect(aspectFamily('1:1')).toBe('square');
    expect(aspectFamily('4:5')).toBe('portrait');
    expect(aspectFamily('9:16')).toBe('vertical');
    expect(aspectFamily('16:9')).toBe('landscape');
    expect(aspectFamily('1.91:1')).toBe('wide');
  });
  it('masterAspectFor picks the aspect with the fewest re-layouts', () => {
    expect(masterAspectFor([])).toBe('4:5');
    expect(masterAspectFor([
      { platform: 'instagram', placement_type: 'feed' },
      { platform: 'instagram', placement_type: 'carousel' },
    ])).toBe('4:5');
    expect(masterAspectFor([
      { platform: 'instagram', placement_type: 'story' },
      { platform: 'snapchat', placement_type: 'story' },
    ])).toBe('9:16');
  });
  it('adaptationSkeleton: 4:5→9:16 = separate design + extend; 4:5→1:1 = crop; 1:1→4:5 = extend', () => {
    expect(adaptationSkeleton('4:5', placementSpec('instagram', 'story')!)).toMatchObject({
      aspect: '9:16', px: [1080, 1920], safe_zones: { top: 250, bottom: 250 },
      requires_separate_design: true, image_change: 'extend',
    });
    expect(adaptationSkeleton('4:5', placementSpec('meta', 'ad_feed')!)).toMatchObject({
      aspect: '1:1', requires_separate_design: false, image_change: 'crop',
    });
    expect(adaptationSkeleton('1:1', placementSpec('instagram', 'feed')!)).toMatchObject({
      aspect: '4:5', requires_separate_design: false, image_change: 'extend',
    });
  });
  it('adaptationSkeleton: carousel→story adds the slide_mapping placeholder', () => {
    const sk = adaptationSkeleton('4:5', placementSpec('instagram', 'story')!, 'carousel');
    expect(sk.requires_separate_design).toBe(true);
    expect(sk.slide_mapping).toHaveLength(1);
  });
});
