import { describe, it, expect } from 'vitest';
import { extractMedia } from '../mediaExtract';
import { detectLanguage } from '../falTranscribe';

describe('media extraction from raw payloads', () => {
  it('instagram reel → video + thumbnail with duration', () => {
    const m = extractMedia('instagram', { videoUrl: 'https://cdn/v.mp4', displayUrl: 'https://cdn/cover.jpg', videoDuration: 30, originalWidth: 1080, originalHeight: 1920 });
    expect(m.find((x) => x.kind === 'video')).toMatchObject({ url: 'https://cdn/v.mp4', durationMs: 30000, carouselIndex: 0 });
    expect(m.find((x) => x.kind === 'thumbnail')?.url).toBe('https://cdn/cover.jpg');
  });
  it('instagram image → single image, no thumbnail', () => {
    const m = extractMedia('instagram', { displayUrl: 'https://cdn/i.jpg', type: 'Image' });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'image', carouselIndex: 0 });
  });
  it('instagram carousel → ordered children preserving index + type', () => {
    const m = extractMedia('instagram', {
      displayUrl: 'https://cdn/cover.jpg',
      childPosts: [
        { displayUrl: 'https://cdn/c0.jpg' },
        { videoUrl: 'https://cdn/c1.mp4', displayUrl: 'https://cdn/c1.jpg', videoDuration: 12 },
        { displayUrl: 'https://cdn/c2.jpg' },
      ],
    });
    const items = m.filter((x) => x.kind !== 'thumbnail');
    expect(items.map((x) => x.carouselIndex)).toEqual([0, 1, 2]);
    expect(items[1]).toMatchObject({ kind: 'video', url: 'https://cdn/c1.mp4', durationMs: 12000 });
    expect(items[0]!.kind).toBe('image');
  });
  it('tiktok → video from mediaUrls + cover thumbnail, rejects the profile url', () => {
    const m = extractMedia('tiktok', { mediaUrls: ['https://tt/dl.mp4'], webVideoUrl: 'https://www.tiktok.com/@x/video/1', videoMeta: { coverUrl: 'https://tt/cover.jpg', duration: 15, width: 720, height: 1280 } });
    expect(m.find((x) => x.kind === 'video')).toMatchObject({ url: 'https://tt/dl.mp4', durationMs: 15000 });
    expect(m.find((x) => x.kind === 'thumbnail')?.url).toBe('https://tt/cover.jpg');
  });
  it('youtube → thumbnail only (no direct video url)', () => {
    const m = extractMedia('youtube', { snippet: { thumbnails: { high: { url: 'https://yt/hq.jpg' } } } });
    expect(m).toEqual([{ carouselIndex: 0, kind: 'thumbnail', url: 'https://yt/hq.jpg' }]);
  });
  it('empty / unknown payloads yield no media (never throws)', () => {
    expect(extractMedia('instagram', {})).toEqual([]);
    expect(extractMedia('snapchat', { videoUrl: 'x' })).toEqual([]);
  });
});

describe('transcript language detection (ar / en / mixed)', () => {
  it('detects Arabic', () => expect(detectLanguage('وصل ريفييرا عرض خاص')).toBe('ar'));
  it('detects English', () => expect(detectLanguage('Welcome to Riviera book now')).toBe('en'));
  it('detects mixed code-switching', () => expect(detectLanguage('مشروع Riviera الآن available today احجز')).toBe('mixed'));
  it('honors multiple inferred languages as mixed', () => expect(detectLanguage('...', ['ar', 'en'])).toBe('mixed'));
  it('empty text with no inference is null', () => expect(detectLanguage('')).toBeNull());
});
