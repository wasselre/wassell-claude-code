import { describe, it, expect } from 'vitest';
import {
  attributeCaption, shouldSnapshot, browserbaseFallbackEligible, normalizeAr,
  type ProjectAlias,
} from '../pipeline';

const INDEX: ProjectAlias[] = [
  { projectId: 'p174', nameAr: 'الماجدية 174', nameEn: 'Almajdiah 174', tokens: [] },
  { projectId: 'p163', nameAr: 'الماجدية 163', nameEn: 'Almajdiah 163', tokens: [] },
  { projectId: 'pdiara', nameAr: 'ديارا مشارف', nameEn: 'Diara Masharef', tokens: [] },
  { projectId: 'p52', nameAr: 'شقق سدن - حي الصفا - 52', nameEn: 'Sudan 52', tokens: ['شقق سدن'] },
];

describe('attribution (spec §9)', () => {
  it('matches a distinctive project number and auto-accepts a single hit', () => {
    const r = attributeCaption('عرض خاص في الماجدية 174 بحي القدس', INDEX);
    expect(r).toHaveLength(1);
    expect(r[0]!.projectId).toBe('p174');
    expect(r[0]!.autoAccept).toBe(true);
    expect(r[0]!.evidence.matched).toContain('174');
  });

  it('does NOT assign a bare developer post (no project reference) to any project', () => {
    // organization-level brand post → stays unattributed
    expect(attributeCaption('في الماجدية تتحقق الأحلام #حياة_ملهمة', INDEX)).toEqual([]);
  });

  it('a number does not spuriously match a different-numbered project', () => {
    const r = attributeCaption('مشروع 163 الجديد', INDEX);
    expect(r.map((x) => x.projectId)).toEqual(['p163']); // not p174
  });

  it('ambiguous caption (two projects) never auto-accepts — goes to review', () => {
    const r = attributeCaption('جولة في الماجدية 174 و الماجدية 163', INDEX);
    expect(r.length).toBe(2);
    expect(r.every((x) => x.autoAccept === false)).toBe(true);
  });

  it('account ownership raises confidence but does not create a match', () => {
    const withOwnership = attributeCaption('ديارا مشارف حي النرجس', INDEX, { publisherProjectIds: ['pdiara'] });
    const without = attributeCaption('ديارا مشارف حي النرجس', INDEX);
    expect(withOwnership[0]!.confidence).toBeGreaterThan(without[0]!.confidence);
    // ...but ownership alone (no caption ref) still yields nothing:
    expect(attributeCaption('برجنا الجديد', INDEX, { publisherProjectIds: ['pdiara', 'p174'] })).toEqual([]);
  });

  it('matches an alias phrase (شقق سدن)', () => {
    const r = attributeCaption('تملك الان في شقق سدن باسعار مميزة', INDEX);
    expect(r.map((x) => x.projectId)).toContain('p52');
  });

  it('normalizeAr folds hamza/taa-marbuta/tatweel', () => {
    expect(normalizeAr('أدوار الــماجدية')).toBe('ادوار الماجديه');
  });
});

describe('metric snapshot suppression (spec §10)', () => {
  const now = Date.parse('2026-07-23T12:00:00Z');
  it('first snapshot always taken', () => {
    expect(shouldSnapshot(null, { views: 10 }, null, 20, now).reason).toBe('first');
  });
  it('snapshots when a tracked metric changed', () => {
    expect(shouldSnapshot({ views: 10 }, { views: 12 }, '2026-07-23T11:00:00Z', 20, now))
      .toEqual({ snapshot: true, reason: 'changed' });
  });
  it('suppresses an unchanged snapshot within the interval', () => {
    expect(shouldSnapshot({ views: 10 }, { views: 10 }, '2026-07-23T11:00:00Z', 20, now))
      .toEqual({ snapshot: false, reason: 'suppressed' });
  });
  it('snapshots when the interval elapsed even if unchanged', () => {
    expect(shouldSnapshot({ views: 10 }, { views: 10 }, '2026-07-22T00:00:00Z', 20, now).reason).toBe('interval');
  });
  it('treats unavailable (undefined) as NOT a change (never fabricates)', () => {
    expect(shouldSnapshot({ views: 10 }, { views: undefined, likes: undefined }, '2026-07-23T11:00:00Z', 20, now).snapshot)
      .toBe(false);
  });
});

describe('browserbase fallback eligibility (spec §8)', () => {
  it('eligible on genuine outage AFTER retries exhausted', () => {
    expect(browserbaseFallbackEligible({ primaryHealth: 'unavailable', attemptsExhausted: true }).eligible).toBe(true);
  });
  it('NOT eligible on outage before retries exhausted', () => {
    expect(browserbaseFallbackEligible({ primaryHealth: 'unavailable', attemptsExhausted: false }).eligible).toBe(false);
  });
  it('NEVER auto-falls-back on auth/rate-limit/not-configured/invalid-config', () => {
    for (const h of ['auth_failed', 'rate_limited', 'not_configured', 'config_invalid'] as const) {
      expect(browserbaseFallbackEligible({ primaryHealth: h, attemptsExhausted: true }).eligible).toBe(false);
    }
  });
  it('eligible on explicit manual request or unsupported source', () => {
    expect(browserbaseFallbackEligible({ primaryHealth: 'auth_failed', attemptsExhausted: false, manualRequest: true }).eligible).toBe(true);
    expect(browserbaseFallbackEligible({ primaryHealth: 'connected', attemptsExhausted: false, unsupportedSource: true }).eligible).toBe(true);
  });
});
