import { describe, it, expect } from 'vitest';
import {
  attributeCaption, matchSnippet, shouldSnapshot, browserbaseFallbackEligible, normalizeAr, computeCommonTokens,
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

  it('GLOBAL common-token set excludes the developer name even when the match index is scoped to 1 project', () => {
    // Full catalog: "الماجديه" appears in 2+ projects → common. Scoped index (what the
    // developer publishes) has only 1 project containing it — without the global set it
    // would look distinctive and wrongly match every brand post.
    const catalog: ProjectAlias[] = [
      { projectId: 'p174', nameAr: 'الماجدية 174', nameEn: null, tokens: [] },
      { projectId: 'p163', nameAr: 'الماجدية 163', nameEn: null, tokens: [] },
      { projectId: 'pmakana', nameAr: 'مكانة', nameEn: null, tokens: [] },
    ];
    const common = computeCommonTokens(catalog);
    expect(common.has('الماجديه')).toBe(true);
    const scoped: ProjectAlias[] = [
      { projectId: 'p174', nameAr: 'الماجدية 174', nameEn: null, tokens: [] }, // only 1 with الماجديه
      { projectId: 'pmakana', nameAr: 'مكانة', nameEn: null, tokens: [] },
    ];
    // brand post → no distinctive token → unattributed
    expect(attributeCaption('مشاريعنا أقرب لكم من الماجدية', scoped, { commonTokens: common })).toEqual([]);
    // a real project mention still matches by its distinctive word
    expect(attributeCaption('برج مكانة تجربة سكنية', scoped, { commonTokens: common }).map((h) => h.projectId)).toEqual(['pmakana']);
    // and by number
    expect(attributeCaption('الماجدية 174 عرض', scoped, { commonTokens: common }).map((h) => h.projectId)).toEqual(['p174']);
  });

  it('a SHORT (1–2 digit) project number never matches alone — only as a series phrase', () => {
    const catalog: ProjectAlias[] = [
      { projectId: 'pm2', nameAr: 'المشرقية 2', nameEn: null, tokens: [] },
      { projectId: 'pm1', nameAr: 'المشرقية 1', nameEn: null, tokens: [] }, // makes "مشرقيه" common
      { projectId: 'p174', nameAr: 'الماجدية 174', nameEn: null, tokens: [] },
    ];
    const common = computeCommonTokens(catalog);
    const scoped = catalog.filter((p) => p.projectId === 'pm2');
    // a caption with a stray "2" (different project) must NOT match المشرقية 2
    expect(attributeCaption('الماجدية 150 حي عرقة', scoped, { commonTokens: common })).toEqual([]);
    // but the project's own caption (series word + number, adjacent) DOES match
    expect(attributeCaption('المشرقية 2 | حي القدس', scoped, { commonTokens: common }).map((h) => h.projectId)).toEqual(['pm2']);
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

describe('late project references — evidence must never be judged from a preview', () => {
  // A caption whose hook, emoji block and ad copy occupy the opening — the
  // project is named well past the first 45 characters. Reviewing only the head
  // of such a caption once produced a WRONG verdict (a correct attribution was
  // called a false positive), which is why both the match and the quoted
  // evidence must come from the full text.
  const LEAD = 'ابدأ حكايتك اليوم واغتنم الفرصة قبل نفاد الوحدات المتاحة لدينا الآن — عرض محدود';
  const LATE_CAPTION = `${LEAD} في مشروع الماجدية 174 بحي القدس`;

  it('the project reference sits beyond the first 45 characters (test premise)', () => {
    expect(LATE_CAPTION.indexOf('174')).toBeGreaterThan(45);
    // and would be invisible to a head-preview reviewer
    expect(LATE_CAPTION.slice(0, 45)).not.toContain('174');
  });

  it('still attributes the project when the reference appears late', () => {
    const r = attributeCaption(LATE_CAPTION, INDEX);
    expect(r).toHaveLength(1);
    expect(r[0]!.projectId).toBe('p174');
    expect(r[0]!.autoAccept).toBe(true);
  });

  it('the stored snippet CONTAINS the matched evidence, not just the caption head', () => {
    const r = attributeCaption(LATE_CAPTION, INDEX);
    expect(r[0]!.evidence.snippet).toContain('174');
  });

  it('finds a reference placed far into a long caption', () => {
    const filler = 'نبني لكم مساكن تليق بتطلعاتكم وتفاصيل مدروسة بعناية. '.repeat(12);
    const r = attributeCaption(`${filler} تفضلوا بزيارة ديارا مشارف`, INDEX);
    expect(r.map((x) => x.projectId)).toEqual(['pdiara']);
    expect(r[0]!.evidence.snippet).toContain('ديارا');
  });
});

describe('matchSnippet', () => {
  it('centres the window on the match and marks both elisions', () => {
    const text = `${'ا'.repeat(300)} الماجدية 174 ${'ب'.repeat(300)}`;
    const s = matchSnippet(text, ['174']);
    expect(s).toContain('174');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThan(text.length);
  });

  it('anchors a phrase match on its first word', () => {
    const text = `${'x'.repeat(200)} شقق سدن 52 هنا`;
    expect(matchSnippet(text, ['شقق سدن 52'])).toContain('شقق سدن');
  });

  it('falls back to the head when the match cannot be located', () => {
    expect(matchSnippet('نص قصير بدون تطابق', ['zzz'])).toContain('نص قصير');
  });

  it('returns empty for empty input rather than throwing', () => {
    expect(matchSnippet('', ['174'])).toBe('');
  });
});
