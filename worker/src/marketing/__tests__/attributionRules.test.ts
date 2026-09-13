import { describe, it, expect } from 'vitest';
import { attributeCaption, computeCommonTokens, projectNameVariants, type ProjectAlias } from '../pipeline';
import { narrowProjects } from '../content/enrich';

// The measured failure modes of 2026-09-13, each pinned as a test so the
// candidate builder can never regress into them silently.

const CATALOG: ProjectAlias[] = [
  { projectId: 'azoum-narjis', nameAr: 'عزوم النرجس', nameEn: null, tokens: [] },
  { projectId: 'dyara-masharef', nameAr: 'ديارا مشارف', nameEn: 'Dyara Masharef', tokens: [] },
  { projectId: 'rabwa-ramz', nameAr: 'ربوة الرمز', nameEn: null, tokens: [] },
  { projectId: 'tal-rabwa', nameAr: 'تل الربوة', nameEn: null, tokens: [] },
  { projectId: 'sadeem-town', nameAr: 'سديم تاون - شقق', nameEn: null, tokens: [] },
  { projectId: 'sadeem-villas', nameAr: 'سديم فلل', nameEn: null, tokens: [] },
  { projectId: 'burj-ramz', nameAr: 'برج الرمز', nameEn: null, tokens: [] },
  { projectId: 'jawhara-ramz', nameAr: 'جوهرة الرمز', nameEn: null, tokens: [] },
  { projectId: 'burj-other', nameAr: 'برج المملكة', nameEn: null, tokens: [] }, // makes "برج" common
  { projectId: 'jawhara-other', nameAr: 'جوهرة العليا', nameEn: null, tokens: [] }, // makes "جوهره" common
  { projectId: 'stone-nada', nameAr: 'ستون الندى', nameEn: null, tokens: [] },
  { projectId: 'stone-malqa', nameAr: 'ستون الملقا', nameEn: null, tokens: [] },
  { projectId: 'majdiah-village', nameAr: 'الماجدية فيلج (Al Majdiah Village)', nameEn: null, tokens: [] },
  { projectId: 'majdiah-174', nameAr: 'الماجدية 174', nameEn: null, tokens: [] },
  { projectId: 'makana', nameAr: 'مكانة', nameEn: null, tokens: [] },
];
const COMMON = computeCommonTokens(CATALOG);
// brand words of the tracked organizations + district names
const EXCLUDED = new Set(['عزوم', 'الاعمار', 'ديارا', 'العقاريه', 'الرمز', 'النرجس', 'الملقا', 'الربوه', 'العليا']);
const BRANDS = ['عزوم الأعمار', 'ديارا العقارية', 'الرمز'];
const byOrg = (ids: string[]) => CATALOG.filter((p) => ids.includes(p.projectId));
const opts = (ids: string[]) => ({ publisherProjectIds: ids, commonTokens: COMMON, excludedTokens: EXCLUDED, brandPhrases: BRANDS });

describe('brand word is never project evidence (عزوم → عزوم النرجس ×156)', () => {
  it('a furniture post by a single-project developer yields NO candidate', () => {
    const r = attributeCaption('تصميم . إشراف . تنفيذ . تأثيث — في عزوم نوفرلك كل شيء في مكان واحد', byOrg(['azoum-narjis']), opts(['azoum-narjis']));
    expect(r).toEqual([]);
  });
  it('the same developer naming the project in full still matches — strongly', () => {
    const r = attributeCaption('تملك الآن في عزوم النرجس بحي النرجس', byOrg(['azoum-narjis']), opts(['azoum-narjis']));
    expect(r.map((x) => x.projectId)).toEqual(['azoum-narjis']);
    expect(r[0]!.strength).toBe('full_name');
    expect(r[0]!.autoAccept).toBe(true);
  });
  it('a marketer mentioning the developer brand is not pinned to that developer\'s one project (ريفا → ديارا مشارف ×32)', () => {
    const r = attributeCaption('ديارا العقارية تملك بيت أحلامك 🏡 امتلك بيتك في مشروع ديارا الروضة D1', byOrg(['dyara-masharef']), opts(['dyara-masharef']));
    expect(r).toEqual([]);
  });
});

describe('district / place words are never project evidence (ربوة ×47)', () => {
  const ramz = ['rabwa-ramz', 'tal-rabwa', 'sadeem-town', 'sadeem-villas', 'burj-ramz', 'jawhara-ramz', 'stone-nada', 'stone-malqa'];
  it('"جنوب الربوة" in a سديم تاون post does NOT match ربوة الرمز — it matches سديم تاون', () => {
    const r = attributeCaption('نعلن عن أبرز إنجازاتنا في مشروع سديم تاون باكتمال المرحلة الأولى من الفلل السكنية في جنوب الربوة', byOrg(ramz), opts(ramz));
    expect(r.map((x) => x.projectId)).toEqual(['sadeem-town']);
    expect(r[0]!.strength).toBe('full_name');
  });
  it('a تل الربوة post matches تل الربوة, not ربوة الرمز', () => {
    const r = attributeCaption('تملَّك في مشروع شقق تل الربوة ضمن الفرص المتاحة لتملك غير السعوديين', byOrg(ramz), opts(ramz));
    expect(r.map((x) => x.projectId)).toEqual(['tal-rabwa']);
  });
  it('the hashtag form #ربوة_الرمز is a full-name match', () => {
    const r = attributeCaption('في #ربوة_الرمز خيارات عديدة وتجارب فريدة', byOrg(ramz), opts(ramz));
    expect(r.map((x) => x.projectId)).toEqual(['rabwa-ramz']);
    expect(r[0]!.strength).toBe('full_name');
  });
  it('an attached prefix letter still matches the phrase (بربوة الرمز)', () => {
    const r = attributeCaption('استعرضنا مزايا السكن بربوة الرمز أمام الوسطاء', byOrg(ramz), opts(ramz));
    expect(r.map((x) => x.projectId)).toEqual(['rabwa-ramz']);
  });
});

describe('full names win even when every word is "common" (برج الرمز / جوهرة الرمز never candidates)', () => {
  const ramz = ['rabwa-ramz', 'burj-ramz', 'jawhara-ramz', 'stone-nada'];
  it('برج الرمز is found although برج and الرمز are both non-distinctive', () => {
    expect(COMMON.has('برج')).toBe(true);
    const r = attributeCaption('تتواصل الأعمال التطويرية في برج الرمز، بالتزامن مع مراحل تنفيذية متقدمة', byOrg(ramz), opts(ramz));
    expect(r.map((x) => x.projectId)).toEqual(['burj-ramz']);
    expect(r[0]!.autoAccept).toBe(true);
  });
  it('جوهرة الرمز likewise (ta-marbuta folded)', () => {
    const r = attributeCaption('تحديثات مشروع جوهرة الرمز مع التقدم المستمر في مراحل التنفيذ', byOrg(ramz), opts(ramz));
    expect(r.map((x) => x.projectId)).toEqual(['jawhara-ramz']);
  });
});

describe('sibling confusion (ستون الملقا filed under ستون الندى ×5)', () => {
  it('with both siblings in scope, the named one wins and the other is absent', () => {
    const ids = ['stone-nada', 'stone-malqa'];
    const r = attributeCaption('يأتي ستون الملقا في موقع واعد شمال الرياض', byOrg(ids), opts(ids));
    expect(r.map((x) => x.projectId)).toEqual(['stone-malqa']);
  });
  it('the shared series word alone (ستون) is not a match for either', () => {
    const ids = ['stone-nada', 'stone-malqa'];
    const r = attributeCaption('ستون تقدم لكم تجربة سكنية', byOrg(ids), opts(ids));
    expect(r).toEqual([]);
  });
});

describe('lone distinctive words are WEAK, never auto-accepted', () => {
  it('a single project-unique word gives a word-strength, non-auto candidate', () => {
    const idx: ProjectAlias[] = [{ projectId: 'p-x', nameAr: 'أوتوجراف 21', nameEn: null, tokens: [] }];
    const r = attributeCaption('أوتوجراف يفتح أبوابه قريبًا', idx, { publisherProjectIds: ['p-x'], commonTokens: new Set(), excludedTokens: EXCLUDED });
    expect(r).toHaveLength(1);
    expect(r[0]!.strength).toBe('word');
    expect(r[0]!.autoAccept).toBe(false);
    expect(r[0]!.confidence).toBeLessThan(0.85);
  });
  it('the series word + number form is strong', () => {
    const idx: ProjectAlias[] = [{ projectId: 'p-x', nameAr: 'أوتوجراف 21', nameEn: null, tokens: [] }];
    const r = attributeCaption('اكتشف أوتوجراف 21 اليوم', idx, { publisherProjectIds: ['p-x'], commonTokens: new Set(), excludedTokens: EXCLUDED });
    expect(r[0]!.strength).toBe('full_name');
    expect(r[0]!.autoAccept).toBe(true);
  });
});

describe('partial names (two consecutive words incl. a distinctive one) are strong', () => {
  const idx: ProjectAlias[] = [
    { projectId: 'jadeel', nameAr: 'أدوار جديل الرمال', nameEn: null, tokens: [] },
    { projectId: 'other-adwar', nameAr: 'أدوار النخيل', nameEn: null, tokens: [] }, // makes أدوار common
  ];
  const o = { publisherProjectIds: ['jadeel'], commonTokens: computeCommonTokens(idx), excludedTokens: new Set(['الرمال', 'النخيل']) };
  it('«أدوار جديل» links to أدوار جديل الرمال as a full-name match', () => {
    const r = attributeCaption('تشهد أدوار جديل اكتمالاً في التفاصيل وإنجازًا في أعمالها النهائية', [idx[0]!], o);
    expect(r.map((x) => x.projectId)).toEqual(['jadeel']);
    expect(r[0]!.strength).toBe('full_name');
    expect(r[0]!.autoAccept).toBe(true);
  });
  it('«جديل» alone stays a weak lone word', () => {
    const r = attributeCaption('مشروع جديل يقترب من الاكتمال', [idx[0]!], o);
    expect(r[0]!.strength).toBe('word');
  });
  it('two non-distinctive words together («أدوار الرمال») are not a match', () => {
    const r = attributeCaption('أدوار الرمال تجربة مختلفة', [idx[0]!], o);
    expect(r).toEqual([]);
  });
});

describe('name variants', () => {
  it('parenthesised alternates and dash segments become variants', () => {
    const v = projectNameVariants(CATALOG.find((p) => p.projectId === 'majdiah-village')!);
    expect(v).toContain('al majdiah village');
    expect(v).toContain('الماجديه فيلج');
    const v2 = projectNameVariants(CATALOG.find((p) => p.projectId === 'sadeem-town')!);
    expect(v2).toContain('سديم تاون');
    expect(v2).toContain('سديم تاون شقق');
  });
  it('an English alternate matches an English caption', () => {
    const r = attributeCaption('Welcome to Al Majdiah Village — a new way of living', byOrg(['majdiah-village', 'majdiah-174']), opts(['majdiah-village', 'majdiah-174']));
    expect(r.map((x) => x.projectId)).toEqual(['majdiah-village']);
  });
  it('a bare single-word name that is a place word (النرجس) does not fire on the district', () => {
    const idx: ProjectAlias[] = [{ projectId: 'p-narjis', nameAr: 'النرجس', nameEn: null, tokens: [] }];
    const r = attributeCaption('شقق فاخرة في حي النرجس', idx, { publisherProjectIds: ['p-narjis'], commonTokens: new Set(), excludedTokens: EXCLUDED });
    expect(r).toEqual([]);
  });
});

describe('narrowProjects labels ambiguity for the reader', () => {
  it('a lone-word candidate is ambiguous; a full-name single candidate is not', () => {
    const idx: ProjectAlias[] = [{ projectId: 'p-x', nameAr: 'أوتوجراف 21', nameEn: null, tokens: [] }];
    const weak = narrowProjects('أوتوجراف يفتح أبوابه', idx, { publisherProjectIds: ['p-x'], commonTokens: new Set(), excludedTokens: EXCLUDED });
    expect(weak[0]).toMatchObject({ strength: 'word', ambiguous: true });
    const strong = narrowProjects('اكتشف أوتوجراف 21', idx, { publisherProjectIds: ['p-x'], commonTokens: new Set(), excludedTokens: EXCLUDED });
    expect(strong[0]).toMatchObject({ strength: 'full_name', ambiguous: false });
  });
  it('two strong candidates are both ambiguous', () => {
    const ids = ['majdiah-village', 'majdiah-174'];
    const r = narrowProjects('جولة في الماجدية 174 والماجدية فيلج', byOrg(ids), opts(ids));
    expect(r).toHaveLength(2);
    expect(r.every((c) => c.ambiguous)).toBe(true);
  });
});
