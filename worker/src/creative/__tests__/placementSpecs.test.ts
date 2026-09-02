import { describe, it, expect } from 'vitest';
import {
  adaptationSkeleton, aspectFamily, masterAspectFor, placementSpec, PLACEMENT_SPECS,
} from '../placementSpecs';

describe('PLACEMENT_SPECS data', () => {
  it('covers every contracted target', () => {
    const keys = PLACEMENT_SPECS.map((s) => `${s.target_kind}:${s.platform}:${s.placement_type}`);
    for (const k of [
      'organic:instagram:feed', 'organic:instagram:carousel', 'organic:instagram:story',
      'organic:tiktok:photo_mode', 'organic:snapchat:story', 'organic:x:post', 'organic:website:post',
      'paid:meta:ad_feed', 'paid:meta:ad_story', 'paid:meta:ad_carousel', 'paid:meta:ad_reels',
      'paid:google:ad_display',
    ]) expect(keys).toContain(k);
  });
  it('carries the publish-preflight ceilings', () => {
    expect(placementSpec('instagram', 'feed')).toMatchObject({ caption_max: 2000, hashtags_max: 30 });
    expect(placementSpec('snapchat', 'story')).toMatchObject({ caption_max: 160, max_slides: 1 });
    expect(placementSpec('tiktok', 'photo_mode')).toMatchObject({ caption_max: 2200, max_slides: 10, formats: ['jpg', 'webp'] });
  });
  it('marks manual-publish platforms', () => {
    expect(placementSpec('x', 'post')?.manual_publish).toBe(true);
    expect(placementSpec('website', 'post')?.manual_publish).toBe(true);
    expect(placementSpec('google', 'ad_display')?.manual_publish).toBe(true);
    expect(placementSpec('instagram', 'feed')?.manual_publish).toBeUndefined();
  });
  it('story placements carry the 250px top/bottom safe zones', () => {
    expect(placementSpec('instagram', 'story')?.safe_zones).toEqual({ top: 250, bottom: 250 });
    expect(placementSpec('meta', 'ad_story')?.safe_zones).toEqual({ top: 250, bottom: 250 });
  });
});

describe('aspectFamily', () => {
  it('groups the aspects', () => {
    expect(aspectFamily('1:1')).toBe('square');
    expect(aspectFamily('4:5')).toBe('portrait');
    expect(aspectFamily('9:16')).toBe('vertical');
    expect(aspectFamily('16:9')).toBe('landscape');
    expect(aspectFamily('1.91:1')).toBe('wide');
    expect(aspectFamily('7:11')).toBe('other');
  });
});

describe('masterAspectFor', () => {
  it('defaults to 4:5 with no targets', () => {
    expect(masterAspectFor([])).toBe('4:5');
  });
  it('picks the native aspect shared by the selected targets', () => {
    expect(masterAspectFor([
      { platform: 'instagram', placement_type: 'feed' },
      { platform: 'instagram', placement_type: 'carousel' },
    ])).toBe('4:5');
    expect(masterAspectFor([
      { platform: 'instagram', placement_type: 'story' },
      { platform: 'snapchat', placement_type: 'story' },
    ])).toBe('9:16');
  });
  it('serves mixed feed+story with the fewest re-layouts (tie → preference order)', () => {
    const master = masterAspectFor([
      { platform: 'instagram', placement_type: 'feed' },
      { platform: 'instagram', placement_type: 'story' },
    ]);
    expect(['4:5', '9:16']).toContain(master);
  });
});

describe('adaptationSkeleton', () => {
  it('same aspect → no geometry change', () => {
    const sk = adaptationSkeleton('4:5', placementSpec('instagram', 'feed')!);
    expect(sk).toMatchObject({ aspect: '4:5', px: [1080, 1350], requires_separate_design: false, image_change: 'none' });
  });
  it('4:5 → 9:16 = separate design + extend, with the story safe zones', () => {
    const sk = adaptationSkeleton('4:5', placementSpec('instagram', 'story')!);
    expect(sk).toMatchObject({
      aspect: '9:16', px: [1080, 1920],
      safe_zones: { top: 250, bottom: 250 },
      requires_separate_design: true, image_change: 'extend',
    });
  });
  it('4:5 → 1:1 = crop, no separate design', () => {
    const sk = adaptationSkeleton('4:5', placementSpec('meta', 'ad_feed')!);
    expect(sk).toMatchObject({ aspect: '1:1', px: [1080, 1080], requires_separate_design: false, image_change: 'crop' });
  });
  it('1:1 → 4:5 = extend, no separate design', () => {
    const sk = adaptationSkeleton('1:1', placementSpec('instagram', 'feed')!);
    expect(sk).toMatchObject({ aspect: '4:5', requires_separate_design: false, image_change: 'extend' });
  });
  it('carousel → story = separate design + slide_mapping placeholder', () => {
    const sk = adaptationSkeleton('4:5', placementSpec('instagram', 'story')!, 'carousel');
    expect(sk.requires_separate_design).toBe(true);
    expect(sk.slide_mapping).toHaveLength(1);
    expect(sk.slide_mapping[0]!.note).toContain('PLACEHOLDER');
  });
  it('carousel → feed keeps slides without a mapping placeholder', () => {
    const sk = adaptationSkeleton('4:5', placementSpec('instagram', 'feed')!, 'carousel');
    expect(sk.slide_mapping).toEqual([]);
  });
});
