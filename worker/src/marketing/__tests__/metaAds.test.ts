import { describe, it, expect } from 'vitest';
import { parseMetaAd } from '../metaAdsLifecycle';

// Sanitized real-shape fixture of an apify/facebook-ads-scraper item (Ad Library).
// Reconcile + update with the live pilot output if fields differ (per spec).
const AD_ITEM = {
  adArchiveID: '1234567890123456',
  isActive: true,
  startDate: 1717200000, // epoch seconds
  pageName: 'الماجدية | Almajdiah',
  pageID: '100000000000001',
  snapshot: {
    body: { text: 'تملك في مشروع الماجدية 174 بأفضل الأسعار — سجل اهتمامك' },
    title: 'الماجدية 174',
    linkDescription: 'شقق سكنية فاخرة',
    ctaText: 'Learn More',
    linkUrl: 'https://almajdiah.com/projects/229',
    images: [{ resizedImageUrl: 'https://scontent.fbcdn.net/ad_image_resized.jpg', originalImageUrl: 'https://scontent.fbcdn.net/ad_image.jpg' }],
    videos: [],
  },
};

describe('parseMetaAd (Meta Ad Library fixture)', () => {
  it('maps the actor item to a normalized ad', () => {
    const ad = parseMetaAd(AD_ITEM)!;
    expect(ad.platform).toBe('meta');
    expect(ad.externalAdId).toBe('1234567890123456');
    expect(ad.advertiserName).toContain('الماجدية');
    expect(ad.pageId).toBe('100000000000001');
    expect(ad.creativeType).toBe('image');
    expect(ad.creativeMediaRef).toBe('https://scontent.fbcdn.net/ad_image_resized.jpg');
    expect(ad.headline).toBe('الماجدية 174');
    expect(ad.body).toContain('174');
    expect(ad.description).toBe('شقق سكنية فاخرة');
    expect(ad.cta).toBe('Learn More');
    expect(ad.landingUrl).toBe('https://almajdiah.com/projects/229');
    expect(ad.isActive).toBe(true);
    expect(ad.platformStartedAt).toBe(new Date(1717200000 * 1000).toISOString());
  });

  it('prefers video creative when present', () => {
    const vid = parseMetaAd({ adArchiveID: '9', snapshot: { videos: [{ videoHdUrl: 'https://v.mp4' }] } })!;
    expect(vid.creativeType).toBe('video');
    expect(vid.creativeMediaRef).toBe('https://v.mp4');
  });

  it('returns null without an archive id', () => {
    expect(parseMetaAd({ snapshot: { body: { text: 'x' } } })).toBeNull();
  });

  it('defaults isActive true and never invents reach', () => {
    const ad = parseMetaAd({ adArchiveID: '5', snapshot: {} })!;
    expect(ad.isActive).toBe(true);
    expect(ad.reachInfo).toBeUndefined(); // no fabricated metrics
  });
});
