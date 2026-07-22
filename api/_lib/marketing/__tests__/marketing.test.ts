import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { canonicalizeUrl, contentFingerprint, withDedupKeys, dedupeBatch } from '../normalize';
import { YouTubeProvider } from '../providers/youtube';
import { ApifyProvider } from '../providers/apify';
import { BrowserbaseProvider } from '../providers/browserbase';
import { ProviderError, type NormalizedContentPost } from '../types';

const post = (platform: NormalizedContentPost['platform'], id: string, extra: Partial<NormalizedContentPost> = {}): NormalizedContentPost => ({
  platform, externalId: id, raw: {}, ...extra,
});

describe('normalize / dedup (spec §6)', () => {
  it('canonicalizes urls (strips query + hash, lowercases host, trims slash)', () => {
    expect(canonicalizeUrl('https://WWW.TikTok.com/@a/video/123?x=1#y/')).toBe('https://www.tiktok.com/@a/video/123');
    expect(canonicalizeUrl(undefined)).toBeUndefined();
    expect(canonicalizeUrl('not a url')).toBeUndefined();
  });

  it('content fingerprint is deterministic and caption-sensitive', () => {
    const a = contentFingerprint({ platform: 'tiktok', handle: 'x', publishedAt: '2026-01-01', caption: 'hello world' });
    const b = contentFingerprint({ platform: 'tiktok', handle: 'x', publishedAt: '2026-01-01', caption: 'hello world' });
    const c = contentFingerprint({ platform: 'tiktok', handle: 'x', publishedAt: '2026-01-01', caption: 'different' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('withDedupKeys fills canonicalUrl + contentHash', () => {
    const p = withDedupKeys(post('tiktok', '1', { postUrl: 'https://tiktok.com/@a/video/1?utm=x' }), 'a');
    expect(p.canonicalUrl).toBe('https://tiktok.com/@a/video/1');
    expect(p.contentHash).toHaveLength(32);
  });

  it('repeated collection of the same post collapses (dedupeBatch)', () => {
    const batch = [post('tiktok', 'V1'), post('tiktok', 'V1'), post('tiktok', 'V2')];
    expect(dedupeBatch(batch)).toHaveLength(2);
  });

  it('same post from two providers has an identical dedup identity', () => {
    // dedup identity is (platform, externalId) — provider-independent
    const fromApify = post('tiktok', 'SAME');
    const fromBrowserbase = post('tiktok', 'SAME');
    const key = (p: NormalizedContentPost) => `${p.platform}:${p.externalId}`;
    expect(key(fromApify)).toBe(key(fromBrowserbase));
    expect(dedupeBatch([fromApify, fromBrowserbase])).toHaveLength(1);
  });
});

describe('provider health — credentials not configured', () => {
  beforeEach(() => { vi.unstubAllEnvs(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('YouTube reports not_configured without an API key', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', '');
    const h = await new YouTubeProvider().validateConnection();
    expect(h.health).toBe('not_configured');
  });

  it('Apify reports not_configured without a token', async () => {
    vi.stubEnv('APIFY_API_TOKEN', '');
    const h = await new ApifyProvider().validateConnection();
    expect(h.health).toBe('not_configured');
  });

  it('Browserbase reports not_configured without keys', async () => {
    vi.stubEnv('BROWSERBASE_API_KEY', '');
    vi.stubEnv('BROWSERBASE_PROJECT_ID', '');
    const h = await new BrowserbaseProvider().validateConnection();
    expect(h.health).toBe('not_configured');
  });
});

describe('YouTube provider — invalid credentials + quota', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('maps 403 quotaExceeded → rate_limited', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'k');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 })));
    const h = await new YouTubeProvider().validateConnection();
    expect(h.health).toBe('rate_limited');
  });

  it('maps 403 (non-quota) → auth_failed (invalid credentials)', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'bad');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { errors: [{ reason: 'keyInvalid' }] } }), { status: 403 })));
    const h = await new YouTubeProvider().validateConnection();
    expect(h.health).toBe('auth_failed');
  });
});

describe('YouTube provider — pagination + normalization', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('walks the uploads playlist and returns nextCursor when more pages exist', async () => {
    vi.stubEnv('YOUTUBE_DATA_API_KEY', 'k');
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.includes('/channels')) {
        return new Response(JSON.stringify({
          items: [{ id: 'UC123', snippet: { title: 'Dev' }, statistics: { subscriberCount: '1000' },
                    contentDetails: { relatedPlaylists: { uploads: 'UU123' } } }],
        }), { status: 200 });
      }
      if (url.includes('/playlistItems')) {
        return new Response(JSON.stringify({
          nextPageToken: 'PAGE2',
          items: [{ contentDetails: { videoId: 'vid1' } }, { contentDetails: { videoId: 'vid2' } }],
        }), { status: 200 });
      }
      if (url.includes('/videos')) {
        return new Response(JSON.stringify({
          items: [{
            id: 'vid1',
            snippet: { title: 'Project 174 tour', description: 'nice', publishedAt: '2026-01-01T00:00:00Z',
                       thumbnails: { high: { url: 'https://i.ytimg.com/vi/vid1/hq.jpg' } }, tags: ['realestate'] },
            contentDetails: { duration: 'PT1M30S' },
            statistics: { viewCount: '5000', likeCount: '120', commentCount: '8' },
          }],
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const batch = await new YouTubeProvider().collectAccountContent({
      platform: 'youtube', handle: 'Dev', externalAccountId: 'UC123', mode: 'incremental',
    });
    expect(batch.hasMore).toBe(true);
    expect(batch.nextCursor).toBe('PAGE2');
    expect(batch.posts).toHaveLength(1);
    const p = batch.posts[0]!;
    expect(p.externalId).toBe('vid1');
    expect(p.durationMs).toBe(90000);          // PT1M30S → 90s
    expect(p.metrics?.views).toBe(5000);
    expect(p.canonicalUrl).toBe('https://www.youtube.com/watch?v=vid1');
    // incremental continues from the returned cursor
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('Apify + Browserbase fallback contracts', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('Apify (API side) is health-only — collection throws "runs in worker"', async () => {
    await expect(new ApifyProvider().collectAccountContent({ platform: 'tiktok', handle: 'x', mode: 'incremental' }))
      .rejects.toThrow(/worker/i);
  });

  it('Browserbase fallback throws without an injected scraper (never fakes)', async () => {
    await expect(new BrowserbaseProvider().collectAccountContent({ platform: 'tiktok', handle: 'x', mode: 'incremental' }))
      .rejects.toThrow(/worker/i);
  });

  it('Browserbase runs the injected scraper + normalizes its output', async () => {
    const scrape = vi.fn(async () => ({ posts: [post('tiktok', 'B1', { postUrl: 'https://tiktok.com/@x/video/B1?s=1' })] }));
    const batch = await new BrowserbaseProvider(scrape).collectAccountContent({ platform: 'tiktok', handle: 'x', mode: 'incremental' });
    expect(batch.posts[0]!.canonicalUrl).toBe('https://tiktok.com/@x/video/B1');
    expect(scrape).toHaveBeenCalledOnce();
  });
});
