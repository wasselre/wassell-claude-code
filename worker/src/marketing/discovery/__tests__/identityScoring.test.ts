import { describe, it, expect } from 'vitest';
import { scoreIdentity, decideIdentityAutoConfirm, type OrgIdentity, type IdentityCandidateInput } from '../identityScoring';
import { platformHandle, hostOf } from '../browserDiscovery';

const ocean: OrgIdentity = {
  nameAr: 'أوشن', nameEn: 'Ocean', website: 'https://ocean.com.sa/', orgType: 'developer', aliases: ['Ocean Real Estate', 'أوشن العقارية'],
};

const base = (over: Partial<IdentityCandidateInput>): IdentityCandidateInput => ({
  platform: 'instagram', handle: 'ocean1.ksa', url: 'https://instagram.com/ocean1.ksa', sources: ['google'], ...over,
});

describe('platformHandle URL parsing', () => {
  it('extracts instagram / tiktok / youtube handles and rejects post URLs', () => {
    expect(platformHandle('https://www.instagram.com/ocean1.ksa/?hl=ar')).toEqual({ platform: 'instagram', handle: 'ocean1.ksa' });
    expect(platformHandle('https://www.tiktok.com/@alajlan_riviera')).toEqual({ platform: 'tiktok', handle: 'alajlan_riviera' });
    expect(platformHandle('https://youtube.com/@mena_development')).toEqual({ platform: 'youtube', handle: 'mena_development' });
    expect(platformHandle('https://www.youtube.com/channel/UCzxPvU71abcDEFghIJKlmn')).toEqual({ platform: 'youtube', handle: 'UCzxPvU71abcDEFghIJKlmn' });
    expect(platformHandle('https://instagram.com/p/Cabc123/')).toBeNull(); // a post, not a profile
    expect(platformHandle('https://instagram.com/explore/tags/x')).toBeNull();
  });
  it('hostOf strips www', () => {
    expect(hostOf('https://www.ocean.com.sa/about')).toBe('ocean.com.sa');
  });
});

describe('identity scoring — link-back anchors decide', () => {
  it('site-link is a decisive anchor and yields high confidence', () => {
    const s = scoreIdentity(base({ siteLinksToThis: true, sources: ['site_crawl', 'google'], pageName: 'Ocean | أوشن' }), ocean);
    expect(s.score).toBeGreaterThanOrEqual(60);
    expect(s.confidence).toBe('high');
    expect(s.accountClass).toBe('organization');
    expect(s.reasons.some((r) => r.code === 'site_links_to_account')).toBe(true);
  });

  it('account bio linking back to the official domain is a decisive anchor', () => {
    const s = scoreIdentity(base({ bioLinks: ['https://ocean.com.sa/projects'], pageName: 'Ocean' }), ocean);
    expect(s.reasons.some((r) => r.code === 'account_links_to_domain')).toBe(true);
    expect(s.confidence).toBe('high');
  });

  it('a name-only match with no anchor is NOT high confidence', () => {
    const s = scoreIdentity(base({ pageName: 'Ocean', sources: ['google'] }), ocean);
    expect(s.confidence).not.toBe('high');
  });

  it('marketplace accounts are penalized and never organization-class', () => {
    const s = scoreIdentity(base({ handle: 'bayut', pageName: 'Bayut KSA', bioLinks: ['https://bayut.sa'], siteLinksToThis: false }), ocean);
    expect(s.isMarketplace).toBe(true);
    expect(s.score).toBeLessThan(0);
    expect(s.accountClass).toBe('marketplace');
  });
});

describe('auto-confirm gating', () => {
  it('auto-confirms an anchored winner that clearly beats rivals', () => {
    const winner = scoreIdentity(base({ handle: 'ocean1.ksa', siteLinksToThis: true, sources: ['site_crawl', 'google'], pageName: 'Ocean أوشن' }), ocean);
    const rival = scoreIdentity(base({ handle: 'ocean_homes', pageName: 'Ocean Homes', sources: ['google'] }), ocean);
    const dec = decideIdentityAutoConfirm([winner, rival], 'instagram');
    expect(dec.confirm).toBe(true);
    expect(dec.reason).toBe('linkback_anchored');
  });

  it('refuses to auto-confirm when the top candidate has no link-back anchor', () => {
    const a = scoreIdentity(base({ handle: 'ocean_a', pageName: 'Ocean', sources: ['google'] }), ocean);
    const b = scoreIdentity(base({ handle: 'ocean_b', pageName: 'Ocean Group', sources: ['google'] }), ocean);
    const dec = decideIdentityAutoConfirm([a, b], 'instagram');
    expect(dec.confirm).toBe(false);
    expect(['low_confidence', 'no_linkback_anchor']).toContain(dec.reason);
  });

  it('refuses when a non-marketplace rival is within the margin (ambiguous)', () => {
    const a = scoreIdentity(base({ handle: 'ocean_a', siteLinksToThis: true, sources: ['site_crawl'], pageName: 'Ocean' }), ocean);
    const b = scoreIdentity(base({ handle: 'ocean_b', siteLinksToThis: true, sources: ['site_crawl'], pageName: 'Ocean' }), ocean);
    const dec = decideIdentityAutoConfirm([a, b], 'instagram');
    expect(dec.confirm).toBe(false);
    expect(dec.reason).toBe('ambiguous_rival');
  });

  it('refuses when the top candidate is a marketplace', () => {
    const mk = scoreIdentity(base({ handle: 'aqar', pageName: 'Aqar عقار', bioLinks: ['https://sa.aqar.fm'] }), ocean);
    const dec = decideIdentityAutoConfirm([mk], 'instagram');
    expect(dec.confirm).toBe(false);
    expect(dec.reason).toBe('top_is_marketplace');
  });
});
