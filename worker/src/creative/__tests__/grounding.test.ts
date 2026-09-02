import { describe, it, expect } from 'vitest';
import { buildFactsPackage } from '../../marketing/script/facts';
import { normAr } from '../../marketing/script/entities';
import type { BlockEntry } from '../../marketing/script/entities';
import type { FactsPackage } from '../../marketing/script/types';
import type {
  AiRecommendation, AssetPick, BasePackage, BrandKit, Concept, ConceptsOutput, Derivative, DerivativeTarget,
  FactRef, OrganicCopy, PaidCopy, VisualAdaptation, WriterRules,
} from '../contracts';
import {
  buildViolationFeedback, prohibitedPhrases, validateBase, validateConcepts, validateDerivatives,
} from '../grounding';
import type { GroundingCtx } from '../grounding';
import { PLACEMENT_SPECS } from '../placementSpecs';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const RECORD: Record<string, unknown> = {
  project_name: 'مشروع الاختبار',
  project_status: 'available',
  construction_status: 'ready',
  unit_count: 40,
  available_units: 12,
  available_price_range: { min: 1050000, max: 1800000 },
  available_area_range: { min: 120, max: 210 },
  unit_types: ['apartment'],
  location: { district_ar: 'حي الياسمين', city_ar: 'الرياض' },
  status_checked_at: '2026-08-01T00:00:00Z',
};

const PKG: FactsPackage = buildFactsPackage(RECORD, { developerName: 'شركة الاختبار للتطوير' });
const REFS: FactRef[] = PKG.facts.map((f) => ({ id: f.id, key: f.key, rendered_ar: f.rendered_ar, source_field: f.source_field, claimable: f.claimable }));
const PRICE_ID = PKG.facts.find((f) => f.key === 'price_from')!.id;

const IG_FEED: DerivativeTarget = { target_kind: 'organic', platform: 'instagram', placement_type: 'feed', target_ref: {} };
const META_AD: DerivativeTarget = { target_kind: 'paid', platform: 'meta', placement_type: 'ad_feed', target_ref: {} };

const NO_RULES: WriterRules = { shared: [], post: [], decisions_log: [] };

function mkCtx(over: Partial<GroundingCtx> = {}): GroundingCtx {
  return {
    facts: PKG,
    refs: REFS,
    language: 'ar',
    selectedTargets: [IG_FEED],
    specs: PLACEMENT_SPECS,
    brandKit: null,
    rules: NO_RULES,
    blocklist: [],
    allowedTerms: [],
    competitorMediaIds: new Set<string>(),
    assetMeta: new Map(),
    ...over,
  };
}

function mkAsset(over: Partial<AssetPick> = {}): AssetPick {
  return {
    file_id: 'f1', nature: 'real', source: 'developer', rights: 'approved', rights_verified: true,
    production_state: 'raw', placement: 'slide 1 primary', usage: 'direct', treatment: '', why: '',
    is_production: true, needs_rights_confirmation: false,
    ...over,
  };
}

function mkBase(over: { design?: Partial<BasePackage['design_text']>; base?: Partial<BasePackage> } = {}): BasePackage {
  return {
    strategy: {
      objective: 'حجوزات', audience: 'عائلات الرياض', audience_source: 'inferred',
      campaign_context: { campaign_id: null, objective: null, offer: null },
      angle: 'سعر تأسيسي', main_message: 'تملّك في الياسمين', desired_response: 'dm',
      format: 'single', format_rationale: '', intended_use: 'organic',
      master_aspect: '4:5', master_aspect_rationale: '', language: 'ar',
    },
    design_text: {
      project_name_lead: 'مشروع الاختبار', latin_name: null,
      headlines: ['تبدأ من ١٬٠٥٠٬٠٠٠ ر.س في حي الياسمين'],
      cta_on_design: null, fact_refs: [PRICE_ID],
      ...over.design,
    },
    slides: [],
    visual_direction: {
      concept: '', mood: [], composition: '', layout: 'framed', hierarchy: [],
      typography: { display: 'Amiri', size_levels: 2, numerals: 'arabic_indic' },
      image_treatment: '', background: '', decoration: [],
      logo: { variant: 'primary', position: 'bottom', color: 'bronze' },
      cta_placement: '', negative_space: 'balanced', continuity: null, safe_zones_note: '',
    },
    palette: [], palette_rationale: '',
    brand_kit: { version: 1, mode: 'advisory', deviations: [] },
    assets: [], references: [], ai_recommendations: [],
    warnings: [], missing: [], facts_used: [PRICE_ID],
    confidence: { copy: 1, assets: 1, references: 1 }, rationale: '',
    ...over.base,
  };
}

function mkAdaptation(over: Partial<VisualAdaptation> = {}): VisualAdaptation {
  return {
    aspect: '4:5', px: [1080, 1350], safe_zones: {}, requires_separate_design: false,
    image_change: 'none', image_instructions: '', text_reposition: '', logo_reposition: '',
    layout_changes: '', element_scaling: '', slide_mapping: [], asset_substitutions: [],
    ...over,
  };
}

function mkOrganicDerivative(over: { copy?: Partial<OrganicCopy>; target?: DerivativeTarget; dims?: Partial<Derivative['dimensions']> } = {}): Derivative {
  return {
    target: over.target ?? IG_FEED,
    dimensions: { aspect: '4:5', px: [1080, 1350], ...over.dims },
    adaptation: mkAdaptation(),
    copy: { caption: 'تبدأ من 1,050,000 ر.س في حي الياسمين', hashtags: ['#وصل_العقارية'], char_count: 30, fact_refs: [PRICE_ID], ...over.copy },
    limits: {}, warnings: [],
  };
}

const BRAND_KIT: BrandKit = {
  version: 1, status: 'reviewed', mode: 'constraint', reviewed_by: null, reviewed_at: null, sources: [],
  palette: [{ name: 'Copper Bronze', hex: '#B8734F', roles: ['primary'] }],
  usage_ratio: {}, combinations_allowed: [], combinations_avoid: [],
  typography: { display: 'Amiri', body: 'Amiri', numerals: 'arabic_indic', max_sizes_per_slide: 3, latin_policy: '' },
  logo: { variants: ['primary'], on_dark: '', on_light: '', clear_space: '', min_size: '', default_position: 'bottom' },
  character: { statement: '', motifs: [], negative_space: '' },
  image_treatment: { allowed: [], avoid: [] }, prohibited: [], approved_example_ids: [],
};

const has = (list: Array<{ rule: string }>, rule: string): boolean => list.some((v) => v.rule === rule);

// ── validateBase ─────────────────────────────────────────────────────────────
describe('validateBase — happy path', () => {
  it('accepts a grounded single-post base (Arabic-Indic price cited via fact_refs)', () => {
    const r = validateBase(mkBase(), mkCtx());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
  it('accepts Western digits too', () => {
    const r = validateBase(mkBase({ design: { headlines: ['تبدأ من 1,050,000 ر.س'] } }), mkCtx());
    expect(r.errors).toEqual([]);
  });
});

describe('validateBase — robustness', () => {
  it('NEVER throws when the model hands back non-array headlines / slides', () => {
    const base = mkBase();
    (base.design_text as unknown as { headlines: unknown }).headlines = 'ليست مصفوفة';
    (base as unknown as { slides: unknown }).slides = null;
    base.strategy.format = 'carousel';
    let r!: ReturnType<typeof validateBase>;
    expect(() => { r = validateBase(base, mkCtx()); }).not.toThrow();
    expect(has(r.errors, 'headline_count')).toBe(true);
    expect(has(r.errors, 'slides_missing')).toBe(true);
  });
});

describe('validateBase — claims', () => {
  it('errors when a matching claim is not cited in fact_refs', () => {
    const r = validateBase(mkBase({ design: { fact_refs: [] } }), mkCtx());
    expect(has(r.errors, 'fact_ref_missing')).toBe(true);
  });
  it('errors on a number no claimable fact carries', () => {
    const r = validateBase(mkBase({ design: { headlines: ['تبدأ من ٢٬٠٠٠٬٠٠٠ ر.س'], fact_refs: [] } }), mkCtx());
    expect(has(r.errors, 'claim_unverified')).toBe(true);
  });
  it('errors on an unknown fact_refs id', () => {
    const r = validateBase(mkBase({ design: { fact_refs: [PRICE_ID, 'F99'] } }), mkCtx());
    expect(has(r.errors, 'fact_ref_unknown')).toBe(true);
  });
});

describe('validateBase — identity, language, readiness', () => {
  it('requires project_name_lead to equal the project name', () => {
    const r = validateBase(mkBase({ design: { project_name_lead: 'اسم مختلف تمامًا' } }), mkCtx());
    expect(has(r.errors, 'project_name_lead')).toBe(true);
  });
  it('accepts the Latin name when the identity is bilingual', () => {
    const r = validateBase(mkBase({ design: { project_name_lead: 'Test Project', latin_name: 'Test Project' } }), mkCtx());
    expect(has(r.errors, 'project_name_lead')).toBe(false);
  });
  it('rejects a strategy language other than the record language', () => {
    const base = mkBase();
    base.strategy.language = 'en';
    const r = validateBase(base, mkCtx({ language: 'ar' }));
    expect(has(r.errors, 'language_mismatch')).toBe(true);
  });
  it('rejects off-plan wording on a READY project', () => {
    const r = validateBase(mkBase({ design: { headlines: ['بيع على الخارطة في الياسمين'] } }), mkCtx());
    expect(has(r.errors, 'readiness_mismatch')).toBe(true);
  });
});

describe('validateBase — headlines / slides', () => {
  it('bounds single-post headlines to 1–4', () => {
    const r = validateBase(mkBase({ design: { headlines: ['أ', 'ب', 'ج', 'د', 'هـ'] } }), mkCtx());
    expect(has(r.errors, 'headline_count')).toBe(true);
  });
  it('bounds a carousel cover to 1–3 and requires a headline per slide', () => {
    const base = mkBase();
    base.strategy.format = 'carousel';
    base.design_text.headlines = ['أ', 'ب', 'ج', 'د'];
    base.slides = [
      { index: 1, role: 'cover', purpose: '', headline: 'غلاف', support: null, asset_ref: null, fact_refs: [], continuity: '' },
      { index: 2, role: 'feature', purpose: '', headline: '', support: null, asset_ref: null, fact_refs: [], continuity: '' },
    ];
    const r = validateBase(base, mkCtx());
    expect(has(r.errors, 'headline_count')).toBe(true);
    expect(has(r.errors, 'slide_headline')).toBe(true);
  });
});

describe('validateBase — entities + prohibited phrases', () => {
  it('flags a phone number anywhere in the design text', () => {
    const r = validateBase(mkBase({ design: { headlines: ['اتصل الآن 0501234567'] } }), mkCtx());
    expect(has(r.errors, 'entity_phone')).toBe(true);
  });
  it('flags a blocklisted competitor name but honours allowedTerms (developer)', () => {
    const blocklist: BlockEntry[] = [{ term: normAr('شركة الاختبار للتطوير'), kind: 'org', source: 'test', display: 'شركة الاختبار للتطوير' }];
    const blocked = validateBase(mkBase({ design: { headlines: ['من تطوير شركة الاختبار للتطوير'] } }), mkCtx({ blocklist }));
    expect(has(blocked.errors, 'entity_org')).toBe(true);
    const allowed = validateBase(
      mkBase({ design: { headlines: ['من تطوير شركة الاختبار للتطوير'] } }),
      mkCtx({ blocklist, allowedTerms: ['شركة الاختبار للتطوير'] }),
    );
    expect(has(allowed.errors, 'entity_org')).toBe(false);
  });
  it('extracts «بدون سعي» from a prohibitive rule and flags it verbatim', () => {
    const rules: WriterRules = { shared: ['ممنوع استخدام «بدون سعي» في أي نص تسويقي'], post: [], decisions_log: [] };
    expect(prohibitedPhrases(rules)).toEqual(['بدون سعي']);
    const r = validateBase(mkBase({ design: { headlines: ['امتلك وحدتك بدون سعي الآن'] } }), mkCtx({ rules }));
    expect(has(r.errors, 'prohibited_phrase')).toBe(true);
  });
  it('ignores quoted phrases in non-prohibitive rules', () => {
    const rules: WriterRules = { shared: ['استخدم صيغة «تبدأ من» عند ذكر السعر'], post: [], decisions_log: [] };
    expect(prohibitedPhrases(rules)).toEqual([]);
  });
  it('does NOT ban a PRESCRIBED phrase paired with «never» in the same line (real writer_rules)', () => {
    // Live regression (أكنان 25): this exact seeded rule has «تبدأ من» in its
    // first clause and "never" in a LATER clause. The naive whole-line scan
    // banned «تبدأ من» — the very phrase the rule prescribes.
    const rules: WriterRules = {
      shared: ['Use the AVAILABLE price range as the «تبدأ من» — never the all-unit range (a sold-out tier must never set the headline price).'],
      post: [], decisions_log: [],
    };
    expect(prohibitedPhrases(rules)).toEqual([]);
  });
  it('still bans «بدون سعي» from the real NEVER-say rule, and readiness phrases stay unbanned', () => {
    const rules: WriterRules = {
      shared: [
        'NEVER say «بدون سعي» anywhere — headline, caption, or script — even when it sits in the project record; drop it silently.',
        'Off-plan flag works BOTH ways: «بيع على الخارطة» + delivery date when off-plan; «جاهزة للسكن / استلام فوري» when ready — never imply the wrong one.',
      ],
      post: [], decisions_log: [],
    };
    const banned = prohibitedPhrases(rules);
    expect(banned).toContain('بدون سعي');
    expect(banned).not.toContain('بيع على الخارطة');
    expect(banned).not.toContain('جاهزة للسكن / استلام فوري');
  });
});

describe('validateBase — assets + rights', () => {
  it('blocks restricted / do_not_use assets', () => {
    const r = validateBase(
      mkBase({ base: { assets: [mkAsset()] } }),
      mkCtx({ assetMeta: new Map([['f1', { rights: 'restricted', rights_verified: true, nature: 'real' }]]) }),
    );
    expect(has(r.errors, 'rights_blocked')).toBe(true);
  });
  it('requires needs_rights_confirmation on unverified production assets', () => {
    const meta = new Map([['f1', { rights: 'approved', rights_verified: false, nature: 'real' }]]);
    const flagged = validateBase(mkBase({ base: { assets: [mkAsset({ rights_verified: false })] } }), mkCtx({ assetMeta: meta }));
    expect(has(flagged.errors, 'rights_confirmation')).toBe(true);
    const confirmed = validateBase(
      mkBase({ base: { assets: [mkAsset({ rights_verified: false, needs_rights_confirmation: true })] } }),
      mkCtx({ assetMeta: meta }),
    );
    expect(has(confirmed.errors, 'rights_confirmation')).toBe(false);
  });
  it('never allows competitor media as an asset', () => {
    const r = validateBase(mkBase({ base: { assets: [mkAsset()] } }), mkCtx({ competitorMediaIds: new Set(['f1']) }));
    expect(has(r.errors, 'asset_competitor')).toBe(true);
  });
});

describe('validateBase — palette vs brand kit', () => {
  const offBrand = { hex: '#FF0000', name: 'red', role: 'accent', source: 'asset' as const };
  it('constraint mode → error; advisory mode → warning; listed deviation → clean', () => {
    const constraint = validateBase(mkBase({ base: { palette: [offBrand] } }), mkCtx({ brandKit: BRAND_KIT }));
    expect(has(constraint.errors, 'palette_off_brand')).toBe(true);

    const advisory = validateBase(
      mkBase({ base: { palette: [offBrand] } }),
      mkCtx({ brandKit: { ...BRAND_KIT, mode: 'advisory' } }),
    );
    expect(has(advisory.errors, 'palette_off_brand')).toBe(false);
    expect(has(advisory.warnings, 'palette_off_brand')).toBe(true);

    const deviated = validateBase(
      mkBase({ base: { palette: [offBrand], brand_kit: { version: 1, mode: 'constraint', deviations: ['#ff0000 red as a one-off accent'] } } }),
      mkCtx({ brandKit: BRAND_KIT }),
    );
    expect(has(deviated.errors, 'palette_off_brand')).toBe(false);
  });
  it('accepts kit colours', () => {
    const r = validateBase(
      mkBase({ base: { palette: [{ hex: '#b8734f', name: 'bronze', role: 'primary', source: 'brand_kit' }] } }),
      mkCtx({ brandKit: BRAND_KIT }),
    );
    expect(has(r.errors, 'palette_off_brand')).toBe(false);
  });
});

describe('validateBase — AI recommendations', () => {
  const rec: AiRecommendation = {
    index: 0, mode: 'cleanup', source_file_ids: ['f1'], prompt: 'نظّف الصورة', must_keep: ['architecture'],
    must_change: [], aspect: '4:5', constraints: [], policy_check: 'cleanup only', status: 'recommended',
  };
  it('rejects unknown modes, unknown sources, and policy failures', () => {
    const meta = new Map([['f1', { rights: 'approved', rights_verified: true, nature: 'real' }]]);
    const badMode = validateBase(mkBase({ base: { ai_recommendations: [{ ...rec, mode: 'fabricate_view' as never }] } }), mkCtx({ assetMeta: meta }));
    expect(has(badMode.errors, 'ai_mode')).toBe(true);

    const badSource = validateBase(mkBase({ base: { ai_recommendations: [{ ...rec, source_file_ids: ['ghost'] }] } }), mkCtx({ assetMeta: meta }));
    expect(has(badSource.errors, 'ai_source_unknown')).toBe(true);

    const blocked = validateBase(
      mkBase({ base: { ai_recommendations: [rec] } }),
      mkCtx({ assetMeta: meta, policyCheck: () => ({ ok: false, reason: 'creates a building view absent from the facts' }) }),
    );
    expect(has(blocked.errors, 'policy_blocked')).toBe(true);
  });
  it('passes an allowed recommendation with a known source and a clean policy check', () => {
    const meta = new Map([['f1', { rights: 'approved', rights_verified: true, nature: 'real' }]]);
    const r = validateBase(
      mkBase({ base: { ai_recommendations: [rec] } }),
      mkCtx({ assetMeta: meta, policyCheck: () => ({ ok: true, reason: '' }) }),
    );
    expect(r.errors).toEqual([]);
  });
});

// ── validateDerivatives ──────────────────────────────────────────────────────
describe('validateDerivatives', () => {
  it('accepts a grounded organic derivative for a selected target', () => {
    const r = validateDerivatives({ derivatives: [mkOrganicDerivative()] }, mkCtx());
    expect(r.errors).toEqual([]);
  });
  it('rejects a derivative for an unselected target', () => {
    const tiktok: DerivativeTarget = { target_kind: 'organic', platform: 'tiktok', placement_type: 'photo_mode', target_ref: {} };
    const r = validateDerivatives({ derivatives: [mkOrganicDerivative({ target: tiktok })] }, mkCtx());
    expect(has(r.errors, 'target_not_selected')).toBe(true);
  });
  it('enforces caption_max and hashtags_max from the spec', () => {
    const longCaption = validateDerivatives({ derivatives: [mkOrganicDerivative({ copy: { caption: 'س'.repeat(2001), fact_refs: [] } })] }, mkCtx());
    expect(has(longCaption.errors, 'caption_max')).toBe(true);
    const manyTags = validateDerivatives(
      { derivatives: [mkOrganicDerivative({ copy: { hashtags: Array.from({ length: 31 }, (_, i) => `#وسم${i}`) } })] },
      mkCtx(),
    );
    expect(has(manyTags.errors, 'hashtags_max')).toBe(true);
  });
  it('blocks competitor hashtags from the blocklist', () => {
    const blocklist: BlockEntry[] = [{ term: normAr('#منافس_عقاري'), kind: 'hashtag', source: 'org:x', display: '#منافس_عقاري' }];
    const r = validateDerivatives(
      { derivatives: [mkOrganicDerivative({ copy: { hashtags: ['#منافس_عقاري'] } })] },
      mkCtx({ blocklist }),
    );
    expect(has(r.errors, 'hashtag_blocked')).toBe(true);
  });
  it('flags a phone number in a caption', () => {
    const r = validateDerivatives(
      { derivatives: [mkOrganicDerivative({ copy: { caption: 'للتواصل 0501234567', fact_refs: [] } })] },
      mkCtx(),
    );
    expect(has(r.errors, 'entity_phone')).toBe(true);
  });
  it('rejects dimensions the spec does not allow', () => {
    const r = validateDerivatives({ derivatives: [mkOrganicDerivative({ dims: { aspect: '16:9', px: [1600, 900] } })] }, mkCtx());
    expect(has(r.errors, 'aspect_not_allowed')).toBe(true);
    const wrongPx = validateDerivatives({ derivatives: [mkOrganicDerivative({ dims: { px: [1000, 1000] } })] }, mkCtx());
    expect(has(wrongPx.errors, 'px_mismatch')).toBe(true);
  });
  it('rejects paid-shaped copy on an organic target and vice versa', () => {
    const paidCopy: PaidCopy = { primary_text: 'نص', headline: 'عنوان', description: 'وصف', cta: 'احجز', destination_url: null, fact_refs: [] };
    const organicWithPaid = validateDerivatives(
      { derivatives: [{ ...mkOrganicDerivative(), copy: paidCopy as unknown as OrganicCopy }] },
      mkCtx(),
    );
    expect(has(organicWithPaid.errors, 'copy_kind')).toBe(true);

    const paidTarget: Derivative = {
      target: META_AD,
      dimensions: { aspect: '1:1', px: [1080, 1080] },
      adaptation: mkAdaptation({ aspect: '1:1', px: [1080, 1080] }),
      copy: { caption: 'كابشن', hashtags: [], char_count: 6, fact_refs: [] },
      limits: {}, warnings: [],
    };
    const paidWithOrganic = validateDerivatives({ derivatives: [paidTarget] }, mkCtx({ selectedTargets: [META_AD] }));
    expect(has(paidWithOrganic.errors, 'copy_kind')).toBe(true);
  });
});

// ── validateConcepts ─────────────────────────────────────────────────────────
describe('validateConcepts', () => {
  const mkConcept = (id: string, title: string): Concept => ({
    id, title, angle: 'زاوية', format: 'single', one_line_design_idea: 'فكرة',
    leans_on_reference: null, suggested_targets: ['instagram:feed'], why: 'لأن',
  });
  it('accepts 2–3 clean concepts', () => {
    const out: ConceptsOutput = { concepts: [mkConcept('c1', 'سعر تأسيسي'), mkConcept('c2', 'موقع الحي')], recommended: 'c1', warnings: [], missing: [] };
    const r = validateConcepts(out, mkCtx());
    expect(r.errors).toEqual([]);
  });
  it('rejects a single concept and flags contact channels in concept text', () => {
    const out: ConceptsOutput = { concepts: [mkConcept('c1', 'اتصل 0501234567')], recommended: 'c1', warnings: [], missing: [] };
    const r = validateConcepts(out, mkCtx());
    expect(has(r.errors, 'concept_count')).toBe(true);
    expect(has(r.errors, 'entity_phone')).toBe(true);
  });
  it('NEVER throws on a malformed (non-array) concepts payload — degrades to concept_count', () => {
    // Live regression (أكنان 25 re-run): the model returned `concepts` as a
    // non-array. `?? []` does not catch a truthy non-array, so `.map`/`for..of`
    // threw and crashed the whole job instead of flagging needs_attention.
    const bad = { concepts: { c1: {} }, recommended: 'c1', warnings: [], missing: [] } as unknown as ConceptsOutput;
    let r!: ReturnType<typeof validateConcepts>;
    expect(() => { r = validateConcepts(bad, mkCtx()); }).not.toThrow();
    expect(has(r.errors, 'concept_count')).toBe(true);
    expect(r.ok).toBe(false);
  });
  it('does NOT read fact-reference codes (F5, F8-F11) in the rationale as unverified claims', () => {
    // Live regression (أكنان 25): the model cites fact codes in `why`/`angle`
    // ("نوع الوحدات (F8-F11) وسعر البدء (F5)"). Those are internal citations,
    // never customer numbers — the extractor pulled 8/11/5 and flagged them.
    const c: Concept = {
      id: 'c1', title: 'تنوّع الوحدات', angle: 'يبرز التنوع الفعلي (F8-F11)', format: 'single',
      one_line_design_idea: 'اسم المشروع + تشكيلة وحدات جاهزة للسكن',
      leans_on_reference: null, suggested_targets: ['instagram:feed'],
      why: 'يبرز نوع الوحدات (F8-F11) وسعر البدء الحقيقي (F5) كخطّاف',
    };
    const out: ConceptsOutput = { concepts: [c, mkConcept('c2', 'موقع الحي')], recommended: 'c1', warnings: [], missing: [] };
    const r = validateConcepts(out, mkCtx());
    expect(has(r.errors, 'claim_unverified')).toBe(false);
    expect(r.errors).toEqual([]);
  });
});

// ── buildViolationFeedback ───────────────────────────────────────────────────
describe('buildViolationFeedback', () => {
  it('renders bilingual bullets with path + rule + detail', () => {
    const text = buildViolationFeedback([{ path: 'design_text.headlines', rule: 'claim_unverified', detail: '«٢ مليون» لا يطابق أي حقيقة' }]);
    expect(text).toContain('مخالفة');
    expect(text).toContain('violation');
    expect(text).toContain('- [claim_unverified] design_text.headlines: «٢ مليون» لا يطابق أي حقيقة');
  });
});
