import { describe, it, expect } from 'vitest';
import { parseTiktokVideo, parseInstagramPost, normYouTubeVideo } from '../providers';

// Sanitized real-shape fixtures of the seeded Apify actors' dataset items.
// If a live run shows the actor output differs, update these fixtures + the parser
// together (regression guard, per spec §5).

const TIKTOK_ITEM = {
  id: '7420108274738990354',
  text: 'استمتع بالمساحات الواسعة في مشروع مينا 52 #الرياض',
  webVideoUrl: 'https://www.tiktok.com/@menaco_sa/video/7420108274738990354',
  createTimeISO: '2026-05-01T09:00:00.000Z',
  playCount: 12345, diggCount: 456, commentCount: 12, shareCount: 7, collectCount: 3,
  videoMeta: { coverUrl: 'https://p16.tiktokcdn.com/cover.jpg', duration: 32 },
};

const INSTAGRAM_ITEM = {
  id: '3400000000000000001',
  shortCode: 'C_QLwe8oCto',
  type: 'Video', productType: 'clips',
  caption: 'ديارا مشارف حي النرجس ✨',
  url: 'https://www.instagram.com/reel/C_QLwe8oCto/',
  timestamp: '2026-06-10T12:00:00.000Z',
  displayUrl: 'https://scontent.cdninstagram.com/thumb.jpg',
  videoUrl: 'https://scontent.cdninstagram.com/video.mp4',
  likesCount: 890, commentsCount: 21, videoViewCount: 15000,
  hashtags: ['النرجس'],
};

const YOUTUBE_VIDEO = {
  id: 'D30NtLy8Fdo',
  snippet: { title: 'أديم الفرسان', description: 'حياة تواكب تطلعاتك', publishedAt: '2026-04-01T00:00:00Z',
    thumbnails: { high: { url: 'https://i.ytimg.com/vi/D30NtLy8Fdo/hq.jpg' } }, tags: ['عقار'], defaultAudioLanguage: 'ar' },
  contentDetails: { duration: 'PT2M5S' },
  statistics: { viewCount: '48000', likeCount: '1200', commentCount: '30' },
};

describe('Apify TikTok fixture normalization (spec §5)', () => {
  it('maps the actor item to a normalized post with metrics + dedup keys', () => {
    const p = parseTiktokVideo(TIKTOK_ITEM, 'menaco_sa')!;
    expect(p.platform).toBe('tiktok');
    expect(p.externalId).toBe('7420108274738990354');
    expect(p.postType).toBe('video');
    expect(p.caption).toContain('مينا 52');
    expect(p.publishedAt).toBe('2026-05-01T09:00:00.000Z');
    expect(p.durationMs).toBe(32000);
    expect(p.metrics).toEqual({ views: 12345, likes: 456, comments: 12, shares: 7, saves: 3 });
    expect(p.canonicalUrl).toBe('https://www.tiktok.com/@menaco_sa/video/7420108274738990354');
    expect(p.contentHash).toHaveLength(32);
  });
  it('returns null when the item has no id', () => {
    expect(parseTiktokVideo({ text: 'x' }, 'h')).toBeNull();
  });
});

describe('Apify Instagram fixture normalization', () => {
  it('maps a reel with likes/views and classifies productType=clips as reel', () => {
    const p = parseInstagramPost(INSTAGRAM_ITEM, 'riva_aqar')!;
    expect(p.platform).toBe('instagram');
    expect(p.externalId).toBe('3400000000000000001');
    expect(p.postType).toBe('reel');
    expect(p.caption).toContain('ديارا');
    expect(p.metrics).toMatchObject({ likes: 890, comments: 21, views: 15000 });
    expect(p.postUrl).toBe('https://www.instagram.com/reel/C_QLwe8oCto/');
  });
});

describe('YouTube fixture normalization', () => {
  it('parses duration + stats + youtube canonical identity', () => {
    const p = normYouTubeVideo(YOUTUBE_VIDEO);
    expect(p.externalId).toBe('D30NtLy8Fdo');
    expect(p.durationMs).toBe(125000); // PT2M5S
    expect(p.metrics).toMatchObject({ views: 48000, likes: 1200, comments: 30 });
    expect(p.canonicalUrl).toBe('https://www.youtube.com/watch?v=D30NtLy8Fdo');
    expect(p.lang).toBe('ar');
  });
});
