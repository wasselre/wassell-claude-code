import { describe, it, expect } from 'vitest';
import { attributeCaption, computeCommonTokens, matchSnippet, projectNameVariants, type ProjectAlias } from '../pipeline';
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

describe('word order does not matter for a full name (فلل سديم → سديم فلل)', () => {
  const idx: ProjectAlias[] = [
    { projectId: 'sadeem-villas', nameAr: 'سديم فلل', nameEn: null, tokens: [] },
    { projectId: 'sadeem-town', nameAr: 'سديم تاون - شقق', nameEn: null, tokens: [] },
  ];
  const o = { publisherProjectIds: ['sadeem-villas', 'sadeem-town'], commonTokens: computeCommonTokens(idx), excludedTokens: new Set<string>() };
  it('reversed order matches as a full name', () => {
    const r = attributeCaption('تحديثات مشروع فلل سديم بفضل الله نعلن عن أبرز إنجازاتنا', idx, o);
    expect(r.map((x) => x.projectId)).toEqual(['sadeem-villas']);
    expect(r[0]!.strength).toBe('full_name');
  });
  it('the words far apart do not match', () => {
    const r = attributeCaption('فلل فاخرة في شمال الرياض بجوار سديم', idx, o);
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

describe("a marketer can post about ANY catalog project (أكنان 23 outside ريفا's scope)", () => {
  const catalog: ProjectAlias[] = [
    { projectId: 'aknan-23', nameAr: 'أكنان 23', nameEn: null, tokens: [] },
    { projectId: 'aknan-25', nameAr: 'أكنان 25', nameEn: null, tokens: [] },
    { projectId: 'majdiah-174', nameAr: 'الماجدية 174', nameEn: null, tokens: [] },
    { projectId: 'abaq', nameAr: 'عبق العارض', nameEn: null, tokens: [] },
  ];
  const scope = catalog.filter((p) => p.projectId === 'abaq'); // ريفا's seeded scope
  const o = { publisherProjectIds: ['abaq'], commonTokens: computeCommonTokens(catalog), excludedTokens: new Set<string>(), catalog };
  it('a full name outside the scope becomes a candidate', () => {
    const r = narrowProjects('أكنان 23 بحي الرمال — تاون هاوس وشقق بتصاميم ومرافق تعيش معك', scope, o);
    expect(r.map((c) => c.projectId)).toEqual(['aknan-23']);
    expect(r[0]!.strength).toBe('full_name');
  });
  it('a bare number outside the scope does NOT (174 units is not الماجدية 174)', () => {
    const r = narrowProjects('بقي 174 وحدة فقط في عبق العارض', scope, o);
    expect(r.map((c) => c.projectId)).toEqual(['abaq']);
  });
  it('a lone word outside the scope does NOT', () => {
    const r = narrowProjects('أكنان تفتح أبوابها', scope, o);
    expect(r).toEqual([]);
  });
});

// Three more production failures, each from a real post. Out-of-scope projects
// reach the candidate list through narrowProjects' catalog pass, which calls the
// matcher with an EMPTY publisher scope — so that is the path tested here.

describe('a generic word + a short number is not a series reference (Ocean «ادوار 9» → Yamam «أدوار - يمام 9»)', () => {
  const catalog: ProjectAlias[] = [
    { projectId: 'yamam-adwar-9', nameAr: 'أدوار - يمام 9', nameEn: null, tokens: [] },
    { projectId: 'yamam-12', nameAr: 'يمام 12', nameEn: null, tokens: [] }, // makes يمام a series word
  ];
  const common = computeCommonTokens(catalog);
  const excluded = new Set(['اوشن']); // the publisher's brand word
  // Ocean's own scope holds none of Yamam's projects.
  const o = { publisherProjectIds: [], commonTokens: common, excludedTokens: excluded, catalog };
  it('a villa post by another company with «ادوار 9» yields no Yamam candidate', () => {
    const text = 'فيلا فاخرة للبيع من أوشن: 3 ادوار 9 غرف نوم ومسبح خاص';
    expect(narrowProjects(text, [], o)).toEqual([]);
    expect(attributeCaption(text, catalog, { publisherProjectIds: [], commonTokens: common, excludedTokens: excluded })).toEqual([]);
  });
  it('«يمام 9» still names the project as a number match', () => {
    const r = narrowProjects('احجز وحدتك في يمام 9 قبل نفاد الكمية', [], o);
    expect(r.map((c) => c.projectId)).toEqual(['yamam-adwar-9']);
    expect(r[0]!.strength).toBe('number');
    expect(r[0]!.matchedAliases).toEqual(['يمام 9']);
  });
});

describe('… nor is it a whole name for another company (a project named just «أدوار 9»)', () => {
  const catalog: ProjectAlias[] = [{ projectId: 'adwar-9', nameAr: 'أدوار 9', nameEn: null, tokens: [] }];
  const common = computeCommonTokens(catalog);
  const excluded = new Set(['اوشن']);
  const TEXT = 'فيلا فاخرة للبيع من أوشن: 3 ادوار 9 غرف نوم ومسبح خاص';
  it("Ocean's villa post yields no candidate (rule 1 now agrees with rule 3)", () => {
    expect(narrowProjects(TEXT, [], { publisherProjectIds: [], commonTokens: common, excludedTokens: excluded, catalog })).toEqual([]);
  });
  it("the project's own publisher still names it", () => {
    const r = attributeCaption(TEXT, catalog, { publisherProjectIds: ['adwar-9'], commonTokens: common, excludedTokens: excluded });
    expect(r.map((c) => [c.projectId, c.strength])).toEqual([['adwar-9', 'full_name']]);
  });
});

describe('a one-word everyday name needs a project marker (Almajdiah «على بعد خطوات» → «بعد»)', () => {
  const catalog: ProjectAlias[] = [
    { projectId: 'baad', nameAr: 'بعد', nameEn: null, tokens: [] },
    { projectId: 'binaa', nameAr: 'بناء', nameEn: null, tokens: [] },
    { projectId: 'dam', nameAr: 'دام', nameEn: null, tokens: [] },
    { projectId: 'madar', nameAr: 'مدار', nameEn: null, tokens: [] },
    { projectId: 'majdiah-174', nameAr: 'الماجدية 174', nameEn: null, tokens: [] },
  ];
  const common = computeCommonTokens(catalog);
  const excluded = new Set(['الماجديه']);
  const one = (id: string) => catalog.filter((p) => p.projectId === id);
  const inScopeOf = (id: string) => ({ publisherProjectIds: [id], commonTokens: common, excludedTokens: excluded });
  const outOfScope = { publisherProjectIds: [], commonTokens: common, excludedTokens: excluded };
  // Almajdiah's scope = its own project; everything else arrives via the catalog pass.
  const almajdiah = { publisherProjectIds: ['majdiah-174'], commonTokens: common, excludedTokens: excluded, catalog };
  const POST = 'سكن فاخر على بعد خطوات من الكورنيش';

  it('the Almajdiah post yields no candidate for «بعد» out of scope', () => {
    expect(narrowProjects(POST, one('majdiah-174'), almajdiah)).toEqual([]);
  });
  it('… nor in scope — not even a weak lone word', () => {
    expect(attributeCaption(POST, one('baad'), inScopeOf('baad'))).toEqual([]);
  });
  it('«مشروع بعد» names the project, in scope and out of scope', () => {
    const text = 'تملك الآن في مشروع بعد بأسعار مميزة';
    const own = attributeCaption(text, one('baad'), inScopeOf('baad'));
    expect(own.map((c) => c.projectId)).toEqual(['baad']);
    expect(own[0]!).toMatchObject({ strength: 'full_name', method: 'name_ar', matchedAliases: ['مشروع بعد'] });
    expect(own[0]!.evidence.snippet).toContain('مشروع بعد');
    const other = narrowProjects(text, one('majdiah-174'), almajdiah);
    expect(other.map((c) => c.projectId)).toEqual(['baad']);
    expect(other[0]!.strength).toBe('full_name');
  });
  it('the marker may carry an attached prefix letter; the name may not («مشروع لبناء» is not بناء)', () => {
    expect(attributeCaption('استثمر بمشروع بناء شمال الرياض', one('binaa'), outOfScope).map((c) => c.projectId)).toEqual(['binaa']);
    expect(attributeCaption('أطلقنا مشروع لبناء 300 وحدة سكنية', one('binaa'), outOfScope)).toEqual([]);
  });
  it('an in-scope one-word name that is not an everyday word still matches as full_name without a marker', () => {
    const r = attributeCaption('تملّك فيلتك في مدار بأفضل الأسعار', one('madar'), inScopeOf('madar'));
    expect(r.map((c) => c.projectId)).toEqual(['madar']);
    expect(r[0]!.strength).toBe('full_name');
  });
  it('out of scope that name without a marker is only a weak word, which narrowProjects drops', () => {
    const text = 'تملّك فيلتك في مدار بأفضل الأسعار';
    expect(attributeCaption(text, one('madar'), outOfScope).map((c) => c.strength)).toEqual(['word']);
    expect(narrowProjects(text, one('majdiah-174'), almajdiah)).toEqual([]);
  });
  it('«للمشروع بعد …» is "for THE project, after …": «لل» is the article, not a prefix letter', () => {
    const text = 'سجل اهتمامك للمشروع بعد الإطلاق مباشرة';
    expect(attributeCaption(text, one('baad'), inScopeOf('baad'))).toEqual([]);
    expect(narrowProjects(text, one('majdiah-174'), almajdiah)).toEqual([]);
  });
  it('a quoted name after its marker is still marked, and the alias quotes it verbatim', () => {
    const r = narrowProjects('اكتشف مشروع «مدار» الآن', one('majdiah-174'), almajdiah);
    expect(r.map((c) => c.projectId)).toEqual(['madar']);
    expect(r[0]!).toMatchObject({ strength: 'full_name', matchedAliases: ['مشروع «مدار»'] });
    const own = attributeCaption('سجل في مشروع "بعد" اليوم', one('baad'), inScopeOf('baad'));
    expect(own.map((c) => [c.projectId, c.strength])).toEqual([['baad', 'full_name']]);
  });
  it('English puts the marker after the name («Madar Tower»)', () => {
    const madar: ProjectAlias = { projectId: 'madar-en', nameAr: 'مدار', nameEn: 'Madar', tokens: [] };
    const r = attributeCaption('Discover Madar Tower, now selling', [madar], outOfScope);
    expect(r[0]!).toMatchObject({ projectId: 'madar-en', strength: 'full_name', method: 'name_en', matchedAliases: ['madar tower'] });
    expect(attributeCaption('Discover Madar, now selling', [madar], outOfScope).map((c) => c.strength)).toEqual(['word']);
  });
  it('the stored snippet centres on the matched phrase, not on the first «مشروع» of the caption', () => {
    const filler = 'تصاميم عصرية ومساحات واسعة ومواقع مميزة قريبة من الخدمات. '.repeat(3);
    const text = `مشروع جديد من الماجدية. ${filler}وتملك الآن في مشروع بعد بأسعار مميزة`;
    expect(matchSnippet(text, ['مشروع بعد'])).toContain('مشروع بعد');
    expect(attributeCaption(text, one('baad'), inScopeOf('baad'))[0]!.evidence.snippet).toContain('مشروع بعد');
  });
});

describe('a name of generic + place words only is evidence only from its own publisher («مشروع النرجس كوميونيتيز» → «مشروع النرجس»)', () => {
  const catalog: ProjectAlias[] = [{ projectId: 'nahda-narjis', nameAr: 'مشروع النرجس', nameEn: null, tokens: [] }];
  const common = computeCommonTokens(catalog);
  const excluded = new Set(['النرجس', 'دار', 'واعمار', 'النهضه']); // district + organization brand words
  const brandPhrases = ['دار وإعمار', 'النهضة']; // passed with excludedTokens in production
  const POST = 'دار وإعمار تطلق مشروع النرجس كوميونيتيز شمال الرياض';

  it("a Dar Wa Emaar post yields no candidate for Nahda's «مشروع النرجس»", () => {
    expect(narrowProjects(POST, [], { publisherProjectIds: [], commonTokens: common, excludedTokens: excluded, brandPhrases, catalog })).toEqual([]);
  });
  it('the any-order rule (1c) holds the same line', () => {
    expect(attributeCaption('النرجس مشروع جديد شمال الرياض', catalog, { publisherProjectIds: [], commonTokens: common, excludedTokens: excluded, brandPhrases })).toEqual([]);
  });
  it("Nahda's own post still names it as a full name", () => {
    const r = attributeCaption(POST, catalog, { publisherProjectIds: ['nahda-narjis'], commonTokens: common, excludedTokens: excluded, brandPhrases });
    expect(r.map((c) => c.projectId)).toEqual(['nahda-narjis']);
    expect(r[0]!.strength).toBe('full_name');
  });
});

describe("an organization's name inside a whole name is the project's own (ريفا names another developer's project in full)", () => {
  const catalog: ProjectAlias[] = [
    { projectId: 'azoum-narjis', nameAr: 'عزوم النرجس', nameEn: null, tokens: [] },
    { projectId: 'burj-ramz', nameAr: 'برج الرمز', nameEn: null, tokens: [] },
    { projectId: 'majdiah-village', nameAr: 'الماجدية فيلج', nameEn: null, tokens: [] },
    { projectId: 'maskan-narjis', nameAr: 'مسكن النرجس', nameEn: null, tokens: [] },
    { projectId: 'abaq', nameAr: 'عبق العارض', nameEn: null, tokens: [] },
  ];
  const scope = catalog.filter((p) => p.projectId === 'abaq'); // ريفا's seeded scope
  // what loadAttributionContext builds: every organization's name words + district names
  const excluded = new Set(['عزوم', 'الرمز', 'الماجديه', 'مسكن', 'ريفا', 'النرجس', 'العارض']);
  const o = { publisherProjectIds: ['abaq'], commonTokens: computeCommonTokens(catalog), excludedTokens: excluded, brandPhrases: ['عزوم', 'الرمز', 'الماجدية', 'مسكن', 'ريفا'], catalog };
  it.each([
    ['ريفا تقدم لكم عزوم النرجس — فلل بتصاميم عصرية', 'azoum-narjis'],
    ['ريفا: وحدات متاحة في برج الرمز بأسعار مميزة', 'burj-ramz'],
    ['ريفا تسوق الماجدية فيلج — فلل جاهزة للسكن', 'majdiah-village'],
  ])('%s → %s, a full name', (text, id) => {
    const r = narrowProjects(text, scope, o);
    expect(r.map((c) => [c.projectId, c.strength])).toEqual([[id, 'full_name']]);
  });
  it('out of its own order it is not («عزوم النرجس مسكن يليق بك» holds «النرجس مسكن», which is no «مسكن النرجس»)', () => {
    const r = narrowProjects('مشروع عزوم النرجس مسكن يليق بك', scope, o);
    expect(r.map((c) => c.projectId)).toEqual(['azoum-narjis']);
  });
});

describe('Arabic-Indic digits match catalog numbers («مينا ٣٩» → مينا 39)', () => {
  const mena: ProjectAlias[] = [{ projectId: 'mena-39', nameAr: 'مينا 39', nameEn: null, tokens: [] }];
  it('a caption written with Arabic-Indic digits finds the project', () => {
    const hits = attributeCaption('تملك وحدتك السكنية بحي النرجس - مينا ٣٩ بمساحات مختلفة', mena, { publisherProjectIds: ['mena-39'] });
    expect(hits.map((h) => h.projectId)).toEqual(['mena-39']);
    expect(hits[0]!.strength).not.toBe('word');
  });
  it('Persian digits fold too, and a different number still does not match', () => {
    expect(attributeCaption('مينا ۳۹', mena, { publisherProjectIds: ['mena-39'] }).map((h) => h.projectId)).toEqual(['mena-39']);
    expect(attributeCaption('مينا ٣٨', mena, { publisherProjectIds: ['mena-39'] }).filter((h) => h.strength !== 'word')).toEqual([]);
  });
});

describe('any-order names keep their number («أدوار - يمام 9» is not «يمام 16»)', () => {
  const yamam: ProjectAlias[] = [
    { projectId: 'yamam-9', nameAr: 'أدوار - يمام 9', nameEn: null, tokens: [] },
    { projectId: 'yamam-16', nameAr: 'يمام 16', nameEn: null, tokens: [] },
  ];
  it('a post about يمام 16 that also says «أدوار يمام» is not a full-name match for يمام 9', () => {
    const hits = attributeCaption('يمام 16 | حي التعاون - أدوار يمام مستقلة بتصاميم عصرية', yamam, { publisherProjectIds: ['yamam-9', 'yamam-16'] });
    expect(hits.find((h) => h.projectId === 'yamam-9' && h.strength === 'full_name')).toBeUndefined();
    expect(hits.find((h) => h.projectId === 'yamam-16')).toBeDefined();
  });
  it('the words in another order WITH the number still match («يمام 9 أدوار»)', () => {
    const hits = attributeCaption('تملك في يمام 9 أدوار مستقلة', yamam, { publisherProjectIds: ['yamam-9'] });
    expect(hits.find((h) => h.projectId === 'yamam-9')?.strength).not.toBe('word');
  });
});

