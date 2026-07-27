import { describe, it, expect } from 'vitest';
import {
  assignAngles, buildQuantityPlan, distributePosts, rankAngles,
  MAX_POSTS_PER_BATCH, MAX_POSTS_PER_PROJECT, MAX_PROJECTS_PER_BATCH, MIN_ANGLE_SCORE,
} from '@/lib/postsContent/planning';
import { POST_ANGLES, matchAngleEvidence, angleById } from '@/lib/postsContent/templates';
import {
  buildFactCatalog, composeSpecBlock, evidenceHaystack, maxGuaranteeYears,
  needsAr, needsEn, parseGuaranteeYears, topGuarantees, unknownFactIds,
  type PostsProjectFacts,
} from '@/lib/postsContent/facts';

/** A data-rich project modelled on ستون الندى (the live richest our_project). */
function richFacts(overrides: Partial<PostsProjectFacts> = {}): PostsProjectFacts {
  return {
    ourProjectId: 'op-1',
    allProjectId: 'ap-1',
    name: 'ستون الندى',
    developer: 'مطور',
    city: { ar: 'الرياض', en: 'Riyadh' },
    district: { ar: 'حي الندى', en: 'Al Nada Dist.' },
    unitTypes: [{ ar: 'شقة', en: 'Apartment' }],
    unitTypeValues: ['apartment'],
    areaRange: { min: 81.58, max: 117.07 },
    priceRange: { min: 1066964, max: 1523844 },
    bedrooms: { min: 2, max: 4 },
    bathrooms: { min: 2, max: 3 },
    availableUnits: 135,
    projectStatus: null,
    constructionStatus: { ar: 'تحت الإنشاء', en: 'Under construction' },
    features: [
      'واجهات حجر طبيعي', 'تكييف مخفي مجهز مسبقاً', 'نادي رجالي ونسائي',
      'أفنية داخلية مشجرة ومساحات خضراء', 'وحدات ذكية', 'نظام كاميرات مراقبة',
      'تراسات وبلكونات',
    ],
    guarantees: [
      { item: 'الهيكل الإنشائي', duration: '10 سنوات', years: 10 },
      { item: 'عدادات الكهرباء', duration: '25 سنة', years: 25 },
      { item: 'ضمان شامل للوحدة السكنية', duration: 'سنة واحدة', years: 1 },
      { item: 'المصاعد', duration: 'سنتان', years: 2 },
    ],
    services: ['البيع على الخارطة (التسليم 30/11/2027)', 'السداد على 7 دفعات'],
    landmarks: ['مسجد الحي - 300 م', 'مدرسة ابتدائية - 1.2 كم'],
    amenities: [{ ar: 'مسجد', en: 'Mosque' }],
    websiteUnitsLink: 'https://wassel.re/project?id=ap-1#units',
    brochureLink: null,
    missing: [],
    ...overrides,
  };
}

/** A project with almost nothing on it. */
function emptyFacts(): PostsProjectFacts {
  return {
    ...richFacts(),
    features: [], guarantees: [], services: [], landmarks: [], amenities: [],
    unitTypes: [], unitTypeValues: [], constructionStatus: null,
    areaRange: null, priceRange: null, bedrooms: null, bathrooms: null, availableUnits: 0,
  };
}

describe('distributePosts', () => {
  it('splits evenly when it divides', () => {
    expect(distributePosts(9, 3)).toEqual([3, 3, 3]);
  });

  it('gives the remainder to the earliest projects, deterministically', () => {
    expect(distributePosts(10, 3)).toEqual([4, 3, 3]);
    expect(distributePosts(11, 3)).toEqual([4, 4, 3]);
  });

  it('never loses or invents a post', () => {
    for (const total of [1, 5, 7, 13, 60]) {
      for (const n of [1, 2, 3, 4, 7]) {
        const split = distributePosts(total, n);
        expect(split).toHaveLength(n);
        expect(split.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('returns nothing for degenerate input', () => {
    expect(distributePosts(0, 3)).toEqual([]);
    expect(distributePosts(5, 0)).toEqual([]);
  });
});

describe('buildQuantityPlan', () => {
  const base = { mode: 'total' as const, totalCount: 10, perProjectCounts: {}, isAr: false };

  it('distributes a total across the selected projects', () => {
    const plan = buildQuantityPlan({ ...base, projectIds: ['a', 'b', 'c'] });
    expect(plan.errors).toEqual([]);
    expect(plan.total).toBe(10);
    expect(plan.perProject).toEqual([
      { ourProjectId: 'a', requested: 4 },
      { ourProjectId: 'b', requested: 3 },
      { ourProjectId: 'c', requested: 3 },
    ]);
  });

  it('honours explicit per-project counts', () => {
    const plan = buildQuantityPlan({
      ...base,
      mode: 'per_project',
      projectIds: ['a', 'b', 'c'],
      perProjectCounts: { a: 8, b: 4, c: 6 },
    });
    expect(plan.errors).toEqual([]);
    expect(plan.total).toBe(18);
    expect(plan.perProject.map((p) => p.requested)).toEqual([8, 4, 6]);
  });

  it('drops projects asked for zero posts in per-project mode', () => {
    const plan = buildQuantityPlan({
      ...base, mode: 'per_project', projectIds: ['a', 'b'], perProjectCounts: { a: 3, b: 0 },
    });
    expect(plan.perProject).toEqual([{ ourProjectId: 'a', requested: 3 }]);
    expect(plan.total).toBe(3);
  });

  it('errors — never silently truncates — when over the batch limit', () => {
    const plan = buildQuantityPlan({ ...base, projectIds: ['a'], totalCount: MAX_POSTS_PER_BATCH + 1 });
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(plan.errors.join(' ')).toContain(String(MAX_POSTS_PER_BATCH));
    // The requested number is preserved in the plan, not quietly reduced.
    expect(plan.total).toBe(MAX_POSTS_PER_BATCH + 1);
  });

  it('errors over the per-project limit', () => {
    const plan = buildQuantityPlan({
      ...base, mode: 'per_project', projectIds: ['a'],
      perProjectCounts: { a: MAX_POSTS_PER_PROJECT + 1 },
    });
    expect(plan.errors.join(' ')).toContain(String(MAX_POSTS_PER_PROJECT));
  });

  it('errors over the project-count limit', () => {
    const ids = Array.from({ length: MAX_PROJECTS_PER_BATCH + 1 }, (_, i) => `p${i}`);
    const plan = buildQuantityPlan({ ...base, projectIds: ids, totalCount: 20 });
    expect(plan.errors.join(' ')).toContain(String(MAX_PROJECTS_PER_BATCH));
  });

  it('warns when the total cannot reach every project', () => {
    const plan = buildQuantityPlan({ ...base, projectIds: ['a', 'b', 'c'], totalCount: 2 });
    expect(plan.errors.join(' ')).toMatch(/smaller than the number of projects/i);
  });

  it('requires a project and a sane count', () => {
    expect(buildQuantityPlan({ ...base, projectIds: [] }).errors.length).toBe(1);
    expect(buildQuantityPlan({ ...base, projectIds: ['a'], totalCount: 0 }).errors.length).toBe(1);
    expect(buildQuantityPlan({ ...base, projectIds: ['a'], totalCount: 2.5 }).errors.length).toBe(1);
  });
});

describe('rankAngles', () => {
  it('excludes angles the project data cannot back', () => {
    const facts = richFacts();
    const ranked = rankAngles(evidenceHaystack(facts), facts.unitTypeValues);
    const ids = ranked.map((r) => r.angleId);
    // Every returned angle must carry at least one piece of real evidence.
    expect(ranked.every((r) => r.evidence.length > 0)).toBe(true);
    expect(ids.length).toBeLessThan(POST_ANGLES.length);
  });

  it('surfaces angles the data genuinely supports', () => {
    const facts = richFacts();
    const ids = rankAngles(evidenceHaystack(facts), facts.unitTypeValues).map((r) => r.angleId);
    // «وحدات ذكية» → smart_home; «كاميرات مراقبة»/«نادي» → compound_security;
    // «البيع على الخارطة» → off_plan; guarantees → quality_warranty.
    expect(ids).toContain('smart_home');
    expect(ids).toContain('compound_security');
    expect(ids).toContain('off_plan');
    expect(ids).toContain('quality_warranty');
  });

  it('returns nothing for a project with no usable data', () => {
    const facts = emptyFacts();
    expect(rankAngles(evidenceHaystack(facts), facts.unitTypeValues)).toEqual([]);
  });

  it('is deterministic and sorted strongest-first', () => {
    const facts = richFacts();
    const a = rankAngles(evidenceHaystack(facts), facts.unitTypeValues);
    const b = rankAngles(evidenceHaystack(facts), facts.unitTypeValues);
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) expect(a[i - 1].score).toBeGreaterThanOrEqual(a[i].score);
  });

  it('gives a unit-type match a bonus that can carry a single-evidence angle', () => {
    const haystack = ['مدخل خاص'];
    const withType = rankAngles(haystack, ['townhouse']);
    const withoutType = rankAngles(haystack, ['apartment']);
    // One keyword + a fitting unit type = 2 → eligible.
    expect(withType.find((x) => x.angleId === 'independence')?.score).toBe(2);
    // One keyword alone = 1 → below MIN_ANGLE_SCORE, excluded as junk.
    expect(withoutType.find((x) => x.angleId === 'independence')).toBeUndefined();
  });

  it('excludes one-incidental-keyword angles (the MIN_ANGLE_SCORE floor)', () => {
    // «سطح» alone made "independence" eligible for an apartment tower before the
    // floor was introduced; «حديقة» alone did the same for "prestige".
    const ranked = rankAngles(['سطح', 'حديقة'], ['apartment']);
    expect(ranked.map((r) => r.angleId)).not.toContain('independence');
    expect(ranked.map((r) => r.angleId)).not.toContain('prestige');
    expect(ranked.every((r) => r.score >= MIN_ANGLE_SCORE)).toBe(true);
  });
});

describe('assignAngles', () => {
  const ranked = [
    { angleId: 'a', evidence: ['x'], score: 3 },
    { angleId: 'b', evidence: ['y'], score: 2 },
  ];

  it('uses the strongest angles first, one each, when supply is enough', () => {
    const out = assignAngles(ranked, 2);
    expect(out.map((o) => o.angleId)).toEqual(['a', 'b']);
    expect(out.every((o) => o.variationIndex === 0)).toBe(true);
    expect(out.map((o) => o.postNumber)).toEqual([1, 2]);
  });

  it('only reuses an angle after every supported angle is used, and marks the take', () => {
    const out = assignAngles(ranked, 5);
    expect(out.map((o) => o.angleId)).toEqual(['a', 'b', 'a', 'b', 'a']);
    expect(out.map((o) => o.variationIndex)).toEqual([0, 0, 1, 1, 2]);
  });

  it('produces nothing when no angle is supported — never pads with filler', () => {
    expect(assignAngles([], 5)).toEqual([]);
  });

  it('produces exactly the requested count when angles exist', () => {
    for (const n of [1, 3, 7, 12]) expect(assignAngles(ranked, n)).toHaveLength(n);
  });
});

describe('fact catalog + validation', () => {
  it('emits a citable id for every real fact', () => {
    const catalog = buildFactCatalog(richFacts());
    const ids = catalog.map((f) => f.id);
    expect(ids).toContain('project:name');
    expect(ids).toContain('location:district');
    expect(ids).toContain('unit_type:0');
    expect(ids).toContain('feature:0');
    expect(ids).toContain('guarantee:0');
    expect(ids).toContain('service:0');
    expect(ids).toContain('landmark:0');
    expect(ids).toContain('range:price');
    expect(ids).toContain('status:construction');
  });

  it('omits ids for facts the project does not have', () => {
    const ids = buildFactCatalog(emptyFacts()).map((f) => f.id);
    expect(ids).not.toContain('feature:0');
    expect(ids).not.toContain('range:price');
    expect(ids).not.toContain('guarantee:0');
  });

  it('flags cited facts that do not exist — the number-free fabrication gate', () => {
    const catalog = buildFactCatalog(richFacts());
    expect(unknownFactIds(['feature:0', 'guarantee:1'], catalog)).toEqual([]);
    // «feature:99» = a pool/garden the project never had.
    expect(unknownFactIds(['feature:0', 'feature:99'], catalog)).toEqual(['feature:99']);
  });
});

describe('guarantee parsing', () => {
  it('reads digits and Arabic number words', () => {
    expect(parseGuaranteeYears('10 سنوات')).toBe(10);
    expect(parseGuaranteeYears('25 سنة')).toBe(25);
    expect(parseGuaranteeYears('سنة واحدة')).toBe(1);
    expect(parseGuaranteeYears('سنتان')).toBe(2);
  });

  it('returns null rather than guessing', () => {
    expect(parseGuaranteeYears('')).toBeNull();
    expect(parseGuaranteeYears('حسب العقد')).toBeNull();
  });

  it('ranks the longest warranties first', () => {
    const top = topGuarantees(richFacts(), 2).map((g) => g.years);
    expect(top).toEqual([25, 10]);
    expect(maxGuaranteeYears(richFacts())).toBe(25);
  });
});

describe('composeSpecBlock — available-only pricing', () => {
  it('renders the type, area, warranties and price', () => {
    const spec = composeSpecBlock(richFacts(), 'short', 'ar');
    expect(spec).toContain('نوع العقار: شقة');
    expect(spec).toContain('المساحة: 82 - 117 م²');
    expect(spec).toContain('الضمانات:');
    expect(spec).toContain('1,066,964 ر.س');
  });

  it('NEVER appends a project link — these are social captions, not WhatsApp', () => {
    for (const tone of ['short', 'long'] as const) {
      for (const lang of ['ar', 'en'] as const) {
        const spec = composeSpecBlock(richFacts(), tone, lang);
        expect(spec).not.toContain('wassel.re');
        expect(spec).not.toContain('http');
        expect(spec).not.toContain('الرابط');
        expect(spec).not.toContain('Link:');
      }
    }
  });

  it('ends on the price line', () => {
    const lines = composeSpecBlock(richFacts(), 'short', 'ar').split('\n');
    expect(lines.at(-1)).toContain('القيمة');
  });

  it('adds location and highlights only in the long tone', () => {
    const short = composeSpecBlock(richFacts(), 'short', 'ar');
    const long = composeSpecBlock(richFacts(), 'long', 'ar');
    expect(short).not.toContain('المزايا');
    expect(short).not.toContain('الموقع');
    expect(long).toContain('المزايا');
    expect(long).toContain('الموقع: حي الندى');
    expect(long).toContain('القيمة الاستثمارية');
  });

  it('OMITS price and area for a sold-out project rather than quoting a stale one', () => {
    // available_* rollups come back null when nothing is available (QA-003).
    const soldOut = richFacts({ priceRange: null, areaRange: null, availableUnits: 0 });
    const spec = composeSpecBlock(soldOut, 'short', 'ar');
    expect(spec).not.toContain('ر.س');
    expect(spec).not.toContain('المساحة');
    expect(spec).not.toContain('القيمة');
    // …but the rest of the post still renders.
    expect(spec).toContain('نوع العقار');
  });

  it('renders English names in the English block, never the Arabic ones', () => {
    const spec = composeSpecBlock(richFacts(), 'long', 'en');
    expect(spec).toContain('Property type: Apartment');
    expect(spec).toContain('Location: Al Nada Dist.');
    expect(spec).toContain('SAR 1,066,964');
    expect(spec).not.toContain('حي الندى');
    expect(spec).not.toContain('ر.س');
  });
});

describe('language selection', () => {
  it('maps each option to the bodies it needs', () => {
    expect([needsAr('ar'), needsEn('ar')]).toEqual([true, false]);
    expect([needsAr('en'), needsEn('en')]).toEqual([false, true]);
    expect([needsAr('both'), needsEn('both')]).toEqual([true, true]);
  });
});

describe('angle registry', () => {
  it('has 15 angles with unique ids and both tone references', () => {
    expect(POST_ANGLES).toHaveLength(15);
    expect(new Set(POST_ANGLES.map((a) => a.id)).size).toBe(15);
    for (const a of POST_ANGLES) {
      expect(a.reference.short.headline).toBeTruthy();
      expect(a.reference.long.body).toBeTruthy();
      expect(a.evidence_keywords.length).toBeGreaterThan(0);
      expect(angleById(a.id)).toBe(a);
    }
  });

  it('matches evidence through Arabic orthographic variants', () => {
    const smart = angleById('smart_home')!;
    // «أنظمة ذكيّة» — different alef + diacritic + ta-marbuta vs the keyword.
    expect(matchAngleEvidence(smart, ['أنظمة ذكيّة للتحكّم'])).toContain('ذكي');
  });
});
