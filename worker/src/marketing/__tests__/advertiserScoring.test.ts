import { describe, it, expect } from 'vitest';
import {
  scoreCandidate, scoreCandidates, decideAutoConfirm, normalizeName, nameTokens, registrableDomain,
  type OrgIdentity, type AdvertiserCandidate,
} from '../advertiserScoring';

const almajdiah: OrgIdentity = {
  nameAr: 'الماجدية', nameEn: 'Almajdiah', website: 'https://almajdiah.com/', orgType: 'developer',
  facebookUrls: [], aliases: ['Almajdiah Real Estate', 'الماجدية العقارية'],
};

describe('normalization', () => {
  it('strips RE suffixes + diacritics and normalizes hamza/taa-marbuta', () => {
    expect(nameTokens('الماجدية العقارية')).toEqual(['الماجديه']);
    expect(nameTokens('Almajdiah Real Estate Co.')).toEqual(['almajdiah']);
    expect(normalizeName('  Bayut  KSA ')).toBe('bayut ksa');
  });
  it('registrableDomain strips scheme/www/path', () => {
    expect(registrableDomain('https://www.almajdiah.com/projects')).toBe('almajdiah.com');
    expect(registrableDomain('bayut.sa')).toBe('bayut.sa');
    expect(registrableDomain('not a url')).toBeNull();
  });
});

describe('marketplace detection + penalty (the Bayut case)', () => {
  const bayut: AdvertiserCandidate = {
    pageId: '218564802076664', pageName: 'Bayut KSA',
    pageUrl: 'https://www.facebook.com/218564802076664', landingDomains: ['bayut.sa'], adCount: 10,
  };
  it('flags Bayut as a marketplace and penalizes it hard for a developer', () => {
    const s = scoreCandidate(bayut, almajdiah);
    expect(s.isMarketplace).toBe(true);
    expect(s.reasons.some((r) => r.code === 'marketplace_detected')).toBe(true);
    expect(s.score).toBeLessThan(0);
    expect(s.confidence).toBe('low');
  });
  it('NEVER auto-confirms a marketplace top candidate', () => {
    const d = decideAutoConfirm(scoreCandidates([bayut], almajdiah));
    expect(d.confirm).toBe(false);
    expect(d.reason).toBe('top_is_marketplace');
  });
});

describe('identity anchors reward correctly', () => {
  it('official domain match', () => {
    const c: AdvertiserCandidate = { pageId: '1', pageName: 'Almajdiah', landingDomains: ['almajdiah.com'] };
    const s = scoreCandidate(c, almajdiah);
    expect(s.reasons.some((r) => r.code === 'official_domain_match')).toBe(true);
    expect(s.reasons.some((r) => r.code === 'exact_en_name')).toBe(true);
    expect(s.confidence).toBe('high');
  });
  it('existing Facebook URL match (numeric page id inside stored url)', () => {
    const org2 = { ...almajdiah, facebookUrls: ['https://www.facebook.com/999888777'] };
    const c: AdvertiserCandidate = { pageId: '999888777', pageName: 'الماجدية', pageUrl: 'https://www.facebook.com/999888777' };
    const s = scoreCandidate(c, org2);
    expect(s.reasons.some((r) => r.code === 'existing_social_url_match')).toBe(true);
    expect(s.confidence).toBe('high');
  });
  it('exact Arabic-name match', () => {
    const c: AdvertiserCandidate = { pageId: '2', pageName: 'الماجدية' };
    const s = scoreCandidate(c, almajdiah);
    expect(s.reasons.some((r) => r.code === 'exact_ar_name')).toBe(true);
  });
  it('exact alias match', () => {
    const c: AdvertiserCandidate = { pageId: '3', pageName: 'Almajdiah Real Estate' };
    const s = scoreCandidate(c, almajdiah);
    // "Almajdiah Real Estate" normalizes to alias "almajdiah" → exact_en_name or alias
    expect(s.reasons.some((r) => r.code === 'exact_alias_match' || r.code === 'exact_en_name')).toBe(true);
  });
});

describe('domain mismatch + weak matches penalized', () => {
  it('unrelated landing domain flags advertiser_domain_mismatch', () => {
    const c: AdvertiserCandidate = { pageId: '4', pageName: 'Some Agency', landingDomains: ['randomportal.com'] };
    const s = scoreCandidate(c, almajdiah);
    expect(s.reasons.some((r) => r.code === 'advertiser_domain_mismatch')).toBe(true);
  });
  it('no signal at all → weak_keyword_only + low', () => {
    const c: AdvertiserCandidate = { pageId: '5', pageName: 'micro.lashes.samar' };
    const s = scoreCandidate(c, almajdiah);
    expect(s.reasons.some((r) => r.code === 'weak_keyword_only')).toBe(true);
    expect(s.confidence).toBe('low');
  });
});

describe('decideAutoConfirm — safe/unsafe', () => {
  it('confirms a clean high-confidence anchored winner with clear margin', () => {
    const winner: AdvertiserCandidate = { pageId: '10', pageName: 'Almajdiah', landingDomains: ['almajdiah.com'] };
    const noise: AdvertiserCandidate = { pageId: '11', pageName: 'micro.lashes.samar' };
    const d = decideAutoConfirm(scoreCandidates([winner, noise], almajdiah));
    expect(d.confirm).toBe(true);
    expect(d.winner?.pageId).toBe('10');
  });
  it('refuses when two high-confidence non-marketplace candidates are similarly likely (ambiguous)', () => {
    const a: AdvertiserCandidate = { pageId: '20', pageName: 'Almajdiah', landingDomains: ['almajdiah.com'] };
    const b: AdvertiserCandidate = { pageId: '21', pageName: 'الماجدية', landingDomains: ['almajdiah.com'] };
    const d = decideAutoConfirm(scoreCandidates([a, b], almajdiah));
    expect(d.confirm).toBe(false);
    expect(d.reason).toBe('ambiguous_rival');
  });
  it('exact-name-only (no domain/FB anchor) is NOT high-confidence → never auto-confirms', () => {
    const a: AdvertiserCandidate = { pageId: '30', pageName: 'الماجدية' };
    const d = decideAutoConfirm(scoreCandidates([a], almajdiah));
    expect(d.confirm).toBe(false);
    expect(d.reason).toBe('low_confidence');
  });
  it('refuses on empty candidate set', () => {
    expect(decideAutoConfirm([]).confirm).toBe(false);
  });
  it('name-only match (even AR+EN exact) is NOT a hard anchor → never auto-confirms', () => {
    // a latin brand where nameAr==nameEn would sum two exact-name rewards, but
    // without a domain/URL/alias anchor it must stay ≤ medium.
    const org2: OrgIdentity = { nameAr: 'Nova', nameEn: 'Nova', website: 'https://nova.example/', orgType: 'developer' };
    const c: AdvertiserCandidate = { pageId: '40', pageName: 'Nova' }; // no landing domains
    const s = scoreCandidates([c], org2);
    expect(s[0]!.confidence).not.toBe('high');
    expect(decideAutoConfirm(s).confirm).toBe(false);
  });
  it('the real Alajlan Riviera self-advertiser (ads link to alajlaninvest.com) DOES auto-confirm', () => {
    const alajlan: OrgIdentity = { nameAr: 'العجلان ريفييرا', nameEn: 'Alajlan Riviera', website: 'https://alajlaninvest.com/', orgType: 'developer' };
    const cand: AdvertiserCandidate = {
      pageId: '112070131901692', pageName: 'العجلان ريڤييرا  Alajlan Riviera',
      pageUrl: 'https://www.facebook.com/112070131901692', adCount: 4, landingDomains: ['alajlaninvest.com', 'fb.me'],
    };
    const scored = scoreCandidates([cand], alajlan);
    expect(scored[0]!.confidence).toBe('high');
    expect(scored[0]!.reasons.some((r) => r.code === 'official_domain_match')).toBe(true);
    const d = decideAutoConfirm(scored);
    expect(d.confirm).toBe(true);
    expect(d.winner?.pageId).toBe('112070131901692');
  });
  it('the real Almajdiah candidate set (Bayut + unrelated) does NOT auto-confirm', () => {
    const real: AdvertiserCandidate[] = [
      { pageId: '218564802076664', pageName: 'Bayut KSA', landingDomains: ['bayut.sa'] },
      { pageId: '1005965822591772', pageName: 'alyami2610' },
      { pageId: '722275960968589', pageName: 'مُقام لتنظيم المعارض و المؤتمرات' },
      { pageId: '100962359235596', pageName: 'micro.lashes.samar' },
    ];
    const d = decideAutoConfirm(scoreCandidates(real, almajdiah));
    expect(d.confirm).toBe(false);
  });
});
