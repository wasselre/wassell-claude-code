import { describe, it, expect } from 'vitest';
import {
  normalizeLandingUrl, normalizeHeadlineKey, campaignSignature,
  sha256Hex, dHashFromGrayscale, hammingDistanceHex, insightKey,
} from '../adIntel';

describe('landing-page normalization (§6)', () => {
  it('strips tracking params (utm_/fbclid/_nc_) + www + trailing slash + hash', () => {
    const r = normalizeLandingUrl('https://WWW.Almajdiah.com/projects/229/?utm_source=fb&fbclid=abc&id=7#top');
    expect(r.canonical).toBe('https://almajdiah.com/projects/229?id=7'); // keeps meaningful id, drops tracking
    expect(r.domain).toBe('almajdiah.com');
  });
  it('two URLs differing only by tracking params normalize equal', () => {
    const a = normalizeLandingUrl('https://x.com/p?utm_campaign=a&gclid=1');
    const b = normalizeLandingUrl('https://x.com/p?gclid=2&utm_campaign=b');
    expect(a.canonical).toBe(b.canonical);
  });
  it('handles a non-URL gracefully', () => {
    expect(normalizeLandingUrl('fb.me/xyz').domain).toBeNull();
    expect(normalizeLandingUrl(null)).toEqual({ canonical: '', domain: null });
  });
});

describe('headline key + campaign signature (§4)', () => {
  it('drops dynamic placeholders + punctuation, keeps 8-token core', () => {
    expect(normalizeHeadlineKey('تملك في {{product.name}}! — عرض خاص')).toBe('تملك في عرض خاص');
  });
  it('same advertiser+landing+cta+headline → same signature (grouping)', () => {
    const base = { organizationId: 'o1', advertiserName: 'Almajdiah', landingCanonical: 'https://a.com/174', cta: 'Learn More', headline: 'مشروع الماجدية 174' };
    expect(campaignSignature(base)).toBe(campaignSignature({ ...base, headline: 'مشروع الماجدية 174 ✨' }));
  });
  it('different landing → different campaign', () => {
    const a = campaignSignature({ organizationId: 'o1', landingCanonical: 'https://a.com/174', cta: 'x', headline: 'h' });
    const b = campaignSignature({ organizationId: 'o1', landingCanonical: 'https://a.com/163', cta: 'x', headline: 'h' });
    expect(a).not.toBe(b);
  });
});

describe('creative fingerprinting (§3)', () => {
  it('sha256 is deterministic + identical bytes collide (exact / reused creative)', () => {
    const bytes = Buffer.from('same-image-bytes');
    expect(sha256Hex(bytes)).toBe(sha256Hex(Buffer.from('same-image-bytes')));
    expect(sha256Hex(bytes)).not.toBe(sha256Hex(Buffer.from('other')));
    expect(sha256Hex(bytes)).toHaveLength(64);
  });
  it('dHash: identical images → distance 0; a small edit → small distance', () => {
    const flat = new Array(72).fill(100);
    const h1 = dHashFromGrayscale(flat);
    expect(h1).toHaveLength(16);
    expect(hammingDistanceHex(h1, dHashFromGrayscale([...flat]))).toBe(0);
    const edited = [...flat]; edited[0] = 250; // one gradient flips
    expect(hammingDistanceHex(h1, dHashFromGrayscale(edited))).toBeGreaterThan(0);
    expect(hammingDistanceHex(h1, dHashFromGrayscale(edited))).toBeLessThan(6); // near-dup, not unrelated
  });
  it('dHash rejects a wrong-size matrix', () => {
    expect(() => dHashFromGrayscale([1, 2, 3])).toThrow(/9x8/);
  });
});

describe('insight dedup keys (§7/§8)', () => {
  it('stable + parts-joined', () => {
    expect(insightKey('new_campaign', 'org1', 'camp1')).toBe('new_campaign:org1:camp1');
    expect(insightKey('new_campaign', 'org1', 'camp1')).toBe(insightKey('new_campaign', 'org1', 'camp1'));
  });
});
