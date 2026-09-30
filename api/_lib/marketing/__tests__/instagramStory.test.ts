/**
 * An Instagram STORY is its own surface — the destination decides it, not the file.
 *
 * Until 2026-09-30 `buildPlatformData` knew only POST and REEL. The material
 * rule (2026-09-15) resolved a 'story' release to the vertical design and an
 * empty caption, and the payload builder then sent exactly that as a feed POST:
 * seven caption-less vertical feed posts went out on the company account
 * (29–30 Sep), each beside its feed twin. bundle.social reported every one as
 * POSTED — the status is the same for both surfaces, so only the link told
 * (instagram.com/p/… instead of instagram.com/stories/…).
 *
 * These tests pin the three places the destination has to reach: the payload,
 * the rulebook, and the post time.
 */
import { describe, expect, it } from 'vitest';
import { buildPlatformData, resolvePostDate } from '../bundleSocial.js';
import { preflightPublishSet } from '../../../../src/lib/marketingOS/platformRules.js';

const image = { id: 'up-1', kind: 'design' as const };
const video = { id: 'up-v', kind: 'video' as const };

describe('the payload follows the destination', () => {
  it('a story release is sent as STORY — one file, no caption, no feed auto-fit', () => {
    const built = buildPlatformData('instagram', { text: '', uploads: [image], placement: 'story' });
    expect(built).toEqual({
      socialAccountType: 'INSTAGRAM',
      data: { INSTAGRAM: { type: 'STORY', uploadIds: ['up-1'] } },
    });
  });

  it('a feed release is still a POST with its caption and auto-fit', () => {
    const built = buildPlatformData('instagram', { text: 'نص', uploads: [image], placement: 'feed' });
    expect(built?.data).toEqual({
      INSTAGRAM: { type: 'POST', text: 'نص', uploadIds: ['up-1'], autoFitImage: true },
    });
  });

  it('no destination at all (a legacy release) keeps the old shape', () => {
    const built = buildPlatformData('instagram', { text: 'نص', uploads: [image] });
    expect((built?.data as { INSTAGRAM: { type: string } }).INSTAGRAM.type).toBe('POST');
    const reel = buildPlatformData('instagram', { text: 'نص', uploads: [video] });
    expect((reel?.data as { INSTAGRAM: { type: string } }).INSTAGRAM.type).toBe('REEL');
  });

  it('a story video stays a story — it is not turned into a Reel', () => {
    const built = buildPlatformData('instagram', { text: '', uploads: [video], placement: 'story' });
    expect((built?.data as { INSTAGRAM: { type: string } }).INSTAGRAM.type).toBe('STORY');
  });

  it('a story with more than one file is refused, never downgraded to a feed carousel', () => {
    const built = buildPlatformData('instagram', {
      text: '', uploads: [image, { id: 'up-2', kind: 'design' }], placement: 'story',
    });
    expect(built).toBeNull();
  });

  it('the destination does not change the other platforms', () => {
    const snap = buildPlatformData('snapchat', { text: 'نص', uploads: [image], placement: 'feed' });
    expect((snap?.data as { SNAPCHAT: { type: string } }).SNAPCHAT.type).toBe('STORY');
    const tiktok = buildPlatformData('tiktok', { text: 'نص', uploads: [video], placement: 'story' });
    expect((tiktok?.data as { TIKTOK: { type: string } }).TIKTOK.type).toBe('VIDEO');
  });
});

describe('the rulebook knows a story', () => {
  const photo = { kind: 'design', mime_type: 'image/png', size_bytes: 900_000, rendered: true };

  it('one image and no caption is a valid story', () => {
    const r = preflightPublishSet('instagram', [photo], '', { captionRequired: false, placement: 'story' });
    expect(r.ok).toBe(true);
    expect(r.issues.filter((i) => i.level === 'block')).toEqual([]);
  });

  it('two files block a story before anything is uploaded', () => {
    const r = preflightPublishSet('instagram', [photo, photo], '', { placement: 'story' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.level === 'block' && /Story takes exactly one file/.test(i.en))).toBe(true);
  });

  it('the same two files are a normal carousel on the feed', () => {
    const r = preflightPublishSet('instagram', [photo, photo], 'نص', { placement: 'feed' });
    expect(r.ok).toBe(true);
  });

  it('a story video over 60 seconds is blocked; a feed video of that length is not', () => {
    const clip = { kind: 'video', mime_type: 'video/mp4', size_bytes: 20_000_000, duration_seconds: 75 };
    const story = preflightPublishSet('instagram', [clip], '', { placement: 'story' });
    expect(story.ok).toBe(false);
    expect(story.issues.some((i) => /Stories max out at 60s/.test(i.en))).toBe(true);
    const reel = preflightPublishSet('instagram', [clip], 'نص');
    expect(reel.ok).toBe(true);
  });

  it('a short story video passes', () => {
    const clip = { kind: 'video', mime_type: 'video/mp4', size_bytes: 8_000_000, duration_seconds: 20 };
    expect(preflightPublishSet('instagram', [clip], '', { placement: 'story' }).ok).toBe(true);
  });
});

describe('the post time is the release\'s own slot', () => {
  const now = Date.parse('2026-10-01T14:45:00Z');

  it('a slot safely ahead is kept — a plan release handed over early posts on time', () => {
    expect(resolvePostDate('2026-10-01T15:00:00Z', now)).toBe('2026-10-01T15:00:00.000Z');
  });

  it('a slot that has passed posts a minute from now', () => {
    expect(resolvePostDate('2026-09-29T15:00:00Z', now)).toBe('2026-10-01T14:46:00.000Z');
  });

  it('a slot less than a minute away is treated as now', () => {
    expect(resolvePostDate('2026-10-01T14:45:30Z', now)).toBe('2026-10-01T14:46:00.000Z');
  });

  it('no slot, or an unreadable one, posts a minute from now', () => {
    expect(resolvePostDate(null, now)).toBe('2026-10-01T14:46:00.000Z');
    expect(resolvePostDate('not a date', now)).toBe('2026-10-01T14:46:00.000Z');
  });
});
