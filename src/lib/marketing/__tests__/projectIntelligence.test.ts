import { describe, it, expect } from 'vitest';
import { projectIntelligenceSummary, factsPresent, isTruncated } from '../projectIntelligence';
import type { ProjectIntelligence } from '../client';

const base = (o: Partial<ProjectIntelligence> = {}): ProjectIntelligence => ({
  generated_at: '2026-07-26T00:00:00Z',
  window: { from: null, to: null },
  project: { id: 'p1', name: 'ريفييرا المربع', city: 'الرياض', status: 'available',
             type: 'general', page_url: null, developer: { record_id: 'd1', name: 'العجلان' } },
  organizations: [],
  social_accounts: [],
  content: { total: 0, shown: 10, recent: [] },
  paid_ads: { total: 0, shown: 10, recent: [] },
  facts: {},
  trends: { activity: [], price: [], platforms: [] },
  share_of_voice: [],
  timeline: { campaigns: [], org_first_seen: [] },
  state: null,
  insights: [],
  attribution_quality: { confirmed_posts: 0, speculative_posts: 0, note: 'n' },
  ...o,
});

describe('projectIntelligenceSummary', () => {
  it('names the developer and the marketers separately by ROLE, not org type', () => {
    // An org is a developer on some projects and a marketer on others — the role
    // lives on the link, so the summary must read it from there.
    const s = projectIntelligenceSummary(base({
      organizations: [
        { organization_id: 'o1', name: 'العجلان', role: 'developer', confidence: 1,
          human_confirmed: true, first_observed_at: null, last_observed_at: null, is_active: true },
        { organization_id: 'o2', name: 'Riva', role: 'authorized_marketer', confidence: 1,
          human_confirmed: true, first_observed_at: null, last_observed_at: null, is_active: true },
        { organization_id: 'o3', name: 'Riva', role: 'observed_marketer', confidence: 0.9,
          human_confirmed: false, first_observed_at: null, last_observed_at: null, is_active: true },
      ],
    }));
    expect(s.developers).toEqual(['العجلان']);
    expect(s.marketers).toEqual(['Riva']);      // deduped across the two marketer roles
  });

  it('reports confirmed activity and does NOT fold in speculative attributions', () => {
    const s = projectIntelligenceSummary(base({
      content: { total: 7, shown: 10, recent: [] },
      attribution_quality: { confirmed_posts: 7, speculative_posts: 105, note: 'n' },
    }));
    expect(s.confirmedPosts).toBe(7);
    expect(s.speculativePosts).toBe(105);
    expect(s.hasSpeculativeBacklog).toBe(true);   // the UI must surface this
  });

  it('does not flag a speculative backlog when there is none', () => {
    expect(projectIntelligenceSummary(base()).hasSpeculativeBacklog).toBe(false);
  });

  it('derives the advertised price range from the price facts', () => {
    const s = projectIntelligenceSummary(base({
      trends: { activity: [], platforms: [],
        price: [
          { bucket: '2025-05-01', observations: 3, min: 298500, max: 298500, avg: 298500 },
          { bucket: '2026-01-01', observations: 4, min: 999000, max: 999000, avg: 999000 },
        ] },
    }));
    expect(s.priceRange).toEqual({ min: 298500, max: 999000 });
    expect(s.priceDirection).toBe('rising');
  });

  it('returns a null price range rather than 0 when no prices are known', () => {
    // 0 would read as "free"; absent must stay absent.
    expect(projectIntelligenceSummary(base()).priceRange).toBeNull();
    expect(projectIntelligenceSummary(base()).priceDirection).toBe('unknown');
  });

  it('calls a falling price series falling, and a flat one flat', () => {
    const mk = (a: number, b: number) => projectIntelligenceSummary(base({
      trends: { activity: [], platforms: [], price: [
        { bucket: '2025-01-01', observations: 1, min: a, max: a, avg: a },
        { bucket: '2026-01-01', observations: 1, min: b, max: b, avg: b }] },
    })).priceDirection;
    expect(mk(999000, 500000)).toBe('falling');
    expect(mk(700000, 700000)).toBe('flat');
  });

  it('picks the dominant platform', () => {
    const s = projectIntelligenceSummary(base({
      trends: { activity: [], price: [], platforms: [
        { platform: 'instagram', posts: 28, share_pct: 93.33, engagement: 341 },
        { platform: 'tiktok', posts: 1, share_pct: 3.33, engagement: 1100741 }] },
    }));
    expect(s.dominantPlatform).toEqual({ platform: 'instagram', share_pct: 93.33 });
  });
});

describe('factsPresent', () => {
  it('lists only fact families that actually have values', () => {
    const d = base({ facts: {
      price: [{ value: '999,000', key: '999,000', observations: 2, posts: 2,
                first_seen: null, last_seen: null, share_pct: 28.57 }],
      offer: [],
      cta: [{ value: 'تملك وحدتك الآن', key: 'تملك وحدتك الآن', observations: 3, posts: 2,
              first_seen: null, last_seen: null, share_pct: 13.04 }],
    } });
    expect(factsPresent(d)).toEqual(['price', 'cta']);
  });

  it('is empty when nothing was extracted', () => {
    expect(factsPresent(base())).toEqual([]);
  });
});

describe('isTruncated', () => {
  it('detects a capped list so the UI can say "showing N of M"', () => {
    expect(isTruncated({ total: 30, shown: 10 })).toBe(true);
    expect(isTruncated({ total: 7, shown: 10 })).toBe(false);
    expect(isTruncated({ total: 10, shown: 10 })).toBe(false);
  });
});

// ── Organization Intelligence ───────────────────────────────────────────────
import { organizationIntelligenceSummary } from '../projectIntelligence';
import type { OrganizationIntelligence } from '../client';

const org = (o: Partial<OrganizationIntelligence> = {}): OrganizationIntelligence => ({
  generated_at: '2026-07-26T00:00:00Z',
  window: { from: null, to: null },
  organization: { id: 'o1', name: 'Alajlan Riviera', name_ar: 'العجلان', name_en: 'Alajlan Riviera',
    website: null, hq_city: null, status: 'active', followers_cached: null,
    meta_page_url: null, meta_confirmed: true, developer_record_id: null },
  roles: {},
  projects: { total: 0, shown: 10, items: [] },
  social_accounts: [],
  audience: { current_followers: null, history_points: 0, growth_measurable: false,
    net_change: null, first_observed_at: null, last_observed_at: null, series: [] },
  posting_frequency: { total_posts: 0, months_active: 0, avg_posts_per_active_month: null,
    last_3_months: 0, prior_3_months: 0, change_pct: null },
  ads: { total: 0, active: 0, shown: 10, recent: [] },
  facts: {},
  trends: { activity: [], price: [], platforms: [] },
  share_of_voice: [],
  campaigns: { total: 0, active: 0, shown: 10, items: [] },
  insights: [],
  coverage: { has_content: false, has_facts: false, has_ads: false,
    content_processed_posts: 0, content_unprocessed_posts: 0, note: 'n' },
  ...o,
});

describe('organizationIntelligenceSummary', () => {
  it('reports EVERY role an org holds, not one type', () => {
    // Alajlan is a developer on 19 projects and an authorized marketer on 10.
    // A single per-org "type" cannot express that; the roles map can.
    const s = organizationIntelligenceSummary(org({
      roles: { developer: 19, authorized_marketer: 10 },
      projects: { total: 29, shown: 10, items: [] },
    }));
    expect(s.roles.sort()).toEqual(['authorized_marketer', 'developer']);
    expect(s.projectCount).toBe(29);
  });

  it('omits roles with a zero count', () => {
    expect(organizationIntelligenceSummary(org({ roles: { developer: 3, observed_marketer: 0 } })).roles)
      .toEqual(['developer']);
  });

  it('classifies posting trend from the change percentage', () => {
    const mk = (p: number | null) => organizationIntelligenceSummary(org({
      posting_frequency: { total_posts: 112, months_active: 24, avg_posts_per_active_month: 4.7,
        last_3_months: 21, prior_3_months: 25, change_pct: p },
    })).postingTrend;
    expect(mk(-16)).toBe('down');
    expect(mk(40)).toBe('up');
    expect(mk(0)).toBe('flat');
    expect(mk(null)).toBe('unknown');   // no prior baseline
  });

  it('never reports a follower change when growth is not measurable', () => {
    // The critical honesty case: 0 would read as "flat" when the truth is
    // "we have fewer than two observations".
    const s = organizationIntelligenceSummary(org({
      audience: { current_followers: 5000, history_points: 1, growth_measurable: false,
        net_change: null, first_observed_at: null, last_observed_at: null, series: [] },
    }));
    expect(s.followerChange).toBeNull();
    expect(s.growthMeasurable).toBe(false);
  });

  it('reports follower change once there are two observations', () => {
    const s = organizationIntelligenceSummary(org({
      audience: { current_followers: 1050, history_points: 2, growth_measurable: true,
        net_change: 150, first_observed_at: '2026-07-19', last_observed_at: '2026-07-26',
        series: [{ day: '2026-07-19', followers: 900 }, { day: '2026-07-26', followers: 1050 }] },
    }));
    expect(s.followerChange).toBe(150);
    expect(s.growthMeasurable).toBe(true);
  });

  it('suppresses a stale net_change if the server says growth is unmeasurable', () => {
    // Defensive: trust the flag, not a leftover number.
    const s = organizationIntelligenceSummary(org({
      audience: { current_followers: 1, history_points: 1, growth_measurable: false,
        net_change: 999, first_observed_at: null, last_observed_at: null, series: [] },
    }));
    expect(s.followerChange).toBeNull();
  });

  it('flags unprocessed content so an empty facts section is not read as silence', () => {
    expect(organizationIntelligenceSummary(org({
      coverage: { has_content: true, has_facts: false, has_ads: false,
        content_processed_posts: 0, content_unprocessed_posts: 66, note: 'n' },
    })).hasUnprocessedContent).toBe(true);
  });

  it('picks the dominant platform by share', () => {
    const s = organizationIntelligenceSummary(org({
      trends: { activity: [], price: [], platforms: [
        { platform: 'tiktok', posts: 51, share_pct: 45.54, engagement: 21997367 },
        { platform: 'instagram', posts: 31, share_pct: 27.68, engagement: 128053 }] },
    }));
    expect(s.dominantPlatform).toEqual({ platform: 'tiktok', share_pct: 45.54 });
  });
});
