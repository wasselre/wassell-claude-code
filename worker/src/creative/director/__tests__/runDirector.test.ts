import { describe, expect, it } from 'vitest';
import { buildFactsPackage } from '../../../marketing/script/facts.js';
import { factsCatalog } from '../../facts.js';
import type {
  BasePackage,
  ConceptsOutput,
  Derivative,
  DerivativeTarget,
  DerivativesOutput,
  FactRef,
  OrganicCopy,
  WriterRules,
} from '../../contracts.js';
import type { CreativeFacts } from '../../facts.js';
import { PLACEMENT_SPECS } from '../../placementSpecs.js';
import type { CallRequest } from '../../../ai/index.js';
import type { CreativeCallResult, CreativeRoleKey } from '../../roles.js';
import type { CandidateAssetRow } from '../assets.js';
import type { CreativeReferenceRow } from '../references.js';
import { runConcepts, runDerivatives, runPackage, runRegenerate, type DirectorCallRole, type DirectorDeps } from '../runDirector.js';
import type { DirectorInput } from '../types.js';

// ── Facts fixture (same recipe as the grounding tests) ───────────────────────
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
const PKG = buildFactsPackage(RECORD, { developerName: 'شركة الاختبار للتطوير' });
const FACTS: CreativeFacts = {
  package: PKG,
  catalog: factsCatalog(PKG.facts),
  refs: PKG.facts.map((f): FactRef => ({ id: f.id, key: f.key, rendered_ar: f.rendered_ar, source_field: f.source_field, claimable: f.claimable })),
};
const PRICE_ID = PKG.facts.find((f) => f.key === 'price_from')!.id;

// ── Targets / rows ───────────────────────────────────────────────────────────
const IG_FEED: DerivativeTarget = { target_kind: 'organic', platform: 'instagram', placement_type: 'feed', target_ref: {} };
const IG_STORY: DerivativeTarget = { target_kind: 'organic', platform: 'instagram', placement_type: 'story', target_ref: {} };
const X_POST: DerivativeTarget = { target_kind: 'organic', platform: 'x', placement_type: 'post', target_ref: {} };

const NO_RULES: WriterRules = { shared: [], post: [], decisions_log: [] };

const ASSET_ROWS: CandidateAssetRow[] = [
  {
    file_id: 'f1', original_name: 'facade.jpg', primary_category: 'project_photo', document_type: null, link_role: null,
    asset_nature: 'real', acquisition_source: 'developer', usage_rights: 'approved', rights_provenance: 'human_approved',
    rights_verified: true, production_state: 'raw', aspect_ratio: '4:5', width_px: 1080, height_px: 1350,
    ai_description: 'واجهة المشروع الخارجية', tags: null, subjects: null, dominant_colors: ['#B8734F'],
    has_text: false, headline_space: 'top',
  },
  {
    file_id: 'f2', original_name: 'render.jpg', primary_category: 'project_photo', document_type: null, link_role: null,
    asset_nature: 'cgi_render', acquisition_source: 'internal', usage_rights: 'needs_review', rights_provenance: 'ai_suggested',
    rights_verified: false, production_state: 'raw', aspect_ratio: '1:1', width_px: 1080, height_px: 1080,
    ai_description: 'رندر داخلي', tags: null, subjects: null, dominant_colors: [],
    has_text: false, headline_space: 'none',
  },
  {
    file_id: 'comp1', original_name: 'comp.jpg', primary_category: 'project_photo', document_type: null, link_role: null,
    asset_nature: 'real', acquisition_source: 'competitor', usage_rights: 'approved', rights_provenance: 'human_approved',
    rights_verified: true, production_state: 'raw', aspect_ratio: '4:5', width_px: 1080, height_px: 1350,
    ai_description: null, tags: null, subjects: null, dominant_colors: [], has_text: false, headline_space: null,
  },
];

const REF_ROWS: CreativeReferenceRow[] = [
  {
    ref_kind: 'competitor_post', ref_id: 'r1', post_id: 'post-r1', slide_index: null, level: 'post',
    preview_url: 'https://example.test/r1.jpg', org_name: 'شركة المنافس الأولى', platform: 'instagram',
    published_at: '2026-08-01T00:00:00Z', post_url: null, score: 0.9, why: { purpose: 'عرض' }, read: null,
  },
  {
    ref_kind: 'competitor_media', ref_id: 'r2', post_id: 'post-r2', slide_index: 1, level: 'slide',
    preview_url: 'https://example.test/r2.jpg', org_name: 'شركة المنافس الثانية', platform: 'instagram',
    published_at: '2026-07-01T00:00:00Z', post_url: null, score: 0.8, why: {}, read: null,
  },
];

function mkInput(over: Partial<DirectorInput> = {}): DirectorInput {
  return {
    brief: { objective: 'حجوزات', audience: 'عائلات الرياض', platforms: ['instagram'], cta: 'للحجز والاستفسار: وصل العقارية' },
    content: { language: 'ar', title: 'بوست تجريبي', content_type_key: 'post_image' },
    facts: FACTS,
    brandKit: null,
    rules: NO_RULES,
    targets: [IG_FEED],
    specs: PLACEMENT_SPECS,
    referenceRows: REF_ROWS,
    assetRows: ASSET_ROWS,
    recipe: 'feature_spec',
    ...over,
  };
}

// ── Model output fixtures ────────────────────────────────────────────────────
function mkConcepts(): ConceptsOutput {
  return {
    concepts: [
      { id: 'c1', title: 'سعر البدء', angle: 'سعر تأسيسي', format: 'single', one_line_design_idea: 'الاسم + سطر سعر', leans_on_reference: null, suggested_targets: ['instagram:feed'], why: 'مباشر' },
      { id: 'c2', title: 'لايف ستايل', angle: 'حياة العائلة', format: 'carousel', one_line_design_idea: 'غلاف + شرائح مزايا', leans_on_reference: null, suggested_targets: ['instagram:carousel'], why: 'وعي' },
    ],
    recommended: 'c1',
    warnings: [],
    missing: [],
  };
}

function mkBase(over: Partial<BasePackage> = {}): BasePackage {
  return {
    strategy: {
      objective: 'حجوزات', audience: 'عائلات الرياض', audience_source: 'campaign',
      campaign_context: { campaign_id: null, objective: 'حجوزات', offer: null },
      angle: 'سعر تأسيسي', main_message: 'تملّك في الياسمين', desired_response: 'dm',
      format: 'single', format_rationale: 'رسالة واحدة', intended_use: 'organic',
      master_aspect: '4:5', master_aspect_rationale: 'الأهداف المختارة كلها تحمله', language: 'ar',
    },
    design_text: {
      project_name_lead: 'مشروع الاختبار', latin_name: null,
      headlines: ['تبدأ من ١٬٠٥٠٬٠٠٠ ر.س في حي الياسمين'],
      cta_on_design: null, fact_refs: [PRICE_ID],
    },
    slides: [],
    visual_direction: {
      concept: 'هادئ وفاخر', mood: ['دافئ'], composition: 'صورة كاملة + نص أسفل', layout: 'full_bleed_photo_text_bottom',
      hierarchy: ['الاسم', 'العنوان'],
      typography: { display: 'Amiri', size_levels: 2, numerals: 'arabic_indic', notes: null },
      image_treatment: 'تصحيح لوني خفيف', background: 'صورة الواجهة', decoration: [],
      logo: { variant: 'primary', position: 'bottom', color: 'bronze' },
      cta_placement: 'في الكابشن', negative_space: 'balanced', continuity: null, safe_zones_note: 'لا نص قرب الحواف',
    },
    palette: [], palette_rationale: '',
    brand_kit: { version: 1, mode: 'advisory', deviations: [] },
    assets: [
      {
        file_id: 'f1', nature: null, source: null, rights: null, rights_verified: false, production_state: null,
        placement: 'slide 1 primary', usage: 'direct', treatment: '', why: 'واجهة معبرة', is_production: true,
        needs_rights_confirmation: false,
      },
    ],
    references: [
      {
        ref_kind: 'competitor_post', ref_id: 'r1', post_id: null, slide_index: null, level: 'post',
        preview_url: null, aspect: 'composition', why: 'بنية ناجحة', study: 'الهرمية', adapt: 'مع هويتنا',
        do_not_copy: 'النص', differ: 'هوية وصل',
      },
    ],
    ai_recommendations: [],
    warnings: [], missing: [], facts_used: [PRICE_ID],
    confidence: { copy: 0.9, assets: 0.8, references: 0.7 },
    rationale: 'الأنسب للجمهور',
    ...over,
  };
}

function mkCarouselBase(): BasePackage {
  return mkBase({
    strategy: {
      ...mkBase().strategy,
      format: 'carousel', format_rationale: 'مزايا متعددة',
      master_aspect: '4:5',
    },
    design_text: { project_name_lead: 'مشروع الاختبار', latin_name: null, headlines: ['سكن يليق بالعائلة', 'في قلب الياسمين'], cta_on_design: null, fact_refs: [] },
    slides: [
      { index: 1, role: 'cover', purpose: 'الخطّاف', headline: 'سكن يليق بالعائلة', support: null, asset_ref: 'f1', fact_refs: [], continuity: 'افتتاحية' },
      { index: 2, role: 'feature', purpose: 'المزايا', headline: 'مساحات واسعة', support: null, asset_ref: 'f2', fact_refs: [], continuity: 'تفصيل' },
      { index: 3, role: 'cta', purpose: 'الدعوة', headline: 'تواصل معنا — وصل العقارية', support: null, asset_ref: null, fact_refs: [], continuity: 'ختام' },
    ],
  });
}

function mkOrganicCopy(): OrganicCopy {
  return { caption: 'تبدأ من 1,050,000 ر.س في حي الياسمين — للحجز والاستفسار: وصل العقارية', hashtags: ['#وصل_العقارية'], char_count: 60, fact_refs: [PRICE_ID] };
}

function mkDerivative(target: DerivativeTarget): Derivative {
  return {
    target,
    dimensions: { aspect: '4:5', px: [1080, 1350] },
    adaptation: {
      aspect: '4:5', px: [1080, 1350], safe_zones: {}, requires_separate_design: false,
      image_change: 'none', image_instructions: '', text_reposition: '', logo_reposition: '',
      layout_changes: '', element_scaling: '', slide_mapping: [], asset_substitutions: [],
    },
    copy: mkOrganicCopy(),
    limits: {}, warnings: [],
  };
}

// ── Fake role caller ─────────────────────────────────────────────────────────
interface FakeCall { key: CreativeRoleKey; req: CallRequest }

function mkDeps(respond: (key: CreativeRoleKey, req: CallRequest, callNo: number) => unknown): { deps: DirectorDeps; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const callRole: DirectorCallRole = async <T,>(key: CreativeRoleKey, req: CallRequest): Promise<CreativeCallResult<T>> => {
    calls.push({ key, req });
    const callNo = calls.filter((c) => c.key === key).length;
    const output = respond(key, req, callNo) as T;
    return { output, usage: { in: 10, out: 20 }, cost_usd: 0.001, provider: 'anthropic', model: 'fake-model', version: null, latency_ms: 1 };
  };
  return { deps: { callRole }, calls };
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('runConcepts', () => {
  it('happy path — grounded concepts, one call, ledger recorded', async () => {
    const { deps, calls } = mkDeps(() => mkConcepts());
    const r = await runConcepts(mkInput(), deps);
    expect(r.validation.ok).toBe(true);
    expect(r.needs_attention).toBe(false);
    expect(r.retried).toBe(false);
    expect(r.output.concepts).toHaveLength(2);
    expect(r.cost_usd).toBe(0.001);
    expect(r.rolesJson.calls).toBe(1);
    // The prompt carries the facts catalog + the language rule.
    expect(calls[0]!.req.user).toContain('مشروع الاختبار');
    expect(calls[0]!.req.user).toContain('قاعدة اللغة');
    expect(calls[0]!.req.system).toContain('بدون سعي');
  });
});

describe('runPackage', () => {
  it('single-post happy path', async () => {
    const { deps } = mkDeps(() => mkBase());
    const r = await runPackage(mkInput({ conceptChoice: { concept: mkConcepts().concepts[0] } }), deps);
    expect(r.validation.ok).toBe(true);
    expect(r.needs_attention).toBe(false);
    expect(r.output.design_text.project_name_lead).toBe('مشروع الاختبار');
    // Rights copied from the ROW, not the model (the model sent nulls).
    expect(r.output.assets[0]).toMatchObject({ file_id: 'f1', rights: 'approved', rights_verified: true, source: 'developer', nature: 'real' });
    // References resolved from the rows (preview_url + level filled deterministically).
    expect(r.output.references[0]).toMatchObject({ ref_id: 'r1', preview_url: 'https://example.test/r1.jpg', level: 'post' });
  });

  it('carousel happy path', async () => {
    const { deps } = mkDeps(() => mkCarouselBase());
    const r = await runPackage(mkInput({ targets: [IG_FEED] }), deps);
    expect(r.validation.ok).toBe(true);
    expect(r.needs_attention).toBe(false);
    expect(r.output.slides).toHaveLength(3);
  });

  it('number without fact_ref → one retry with violation feedback → fixed', async () => {
    const bad = mkBase();
    bad.design_text = { ...bad.design_text, fact_refs: [] }; // price in the headline, no citation
    const { deps, calls } = mkDeps((_key, _req, n) => (n === 1 ? bad : mkBase()));
    const r = await runPackage(mkInput(), deps);
    expect(r.retried).toBe(true);
    expect(r.needs_attention).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.req.user).toContain('fact_ref_missing');
  });

  it('unrepaired violations never throw — needs_attention with the error list', async () => {
    const bad = mkBase();
    bad.design_text = { ...bad.design_text, fact_refs: [] };
    const { deps } = mkDeps(() => bad); // never fixes it
    const r = await runPackage(mkInput(), deps);
    expect(r.retried).toBe(true);
    expect(r.needs_attention).toBe(true);
    expect(r.validation.errors.some((e) => e.rule === 'fact_ref_missing')).toBe(true);
  });

  it('policy-blocked AI recommendation is dismissed with a warning, never an error', async () => {
    const withRec = mkBase({
      ai_recommendations: [
        {
          index: 0, mode: 'extend_background', source_file_ids: ['f1'],
          prompt: 'Add a swimming pool in front of the building', must_keep: [], must_change: ['sky'],
          aspect: '4:5', constraints: [], policy_check: 'none', status: 'recommended',
        },
      ],
    });
    const { deps } = mkDeps(() => withRec);
    const r = await runPackage(mkInput(), deps);
    expect(r.output.ai_recommendations[0]!.status).toBe('dismissed');
    expect(r.output.warnings.some((w) => w.startsWith('policy_blocked:'))).toBe(true);
    expect(r.needs_attention).toBe(false);
  });

  it('hallucinated asset id is dropped (still a clean validation)', async () => {
    const withGhost = mkBase({
      assets: [
        { file_id: 'ghost-999', nature: null, source: null, rights: null, rights_verified: false, production_state: null, placement: 'bg', usage: 'direct', treatment: '', why: '', is_production: true, needs_rights_confirmation: false },
      ],
    });
    const { deps } = mkDeps(() => withGhost);
    const r = await runPackage(mkInput(), deps);
    expect(r.output.assets).toHaveLength(0);
    expect(r.output.warnings.some((w) => w.includes('ghost-999'))).toBe(true);
    expect(r.validation.ok).toBe(true);
  });

  it('competitor asset id is rejected', async () => {
    const withComp = mkBase({
      assets: [
        { file_id: 'comp1', nature: null, source: null, rights: null, rights_verified: false, production_state: null, placement: 'bg', usage: 'direct', treatment: '', why: '', is_production: true, needs_rights_confirmation: false },
      ],
    });
    const { deps } = mkDeps(() => withComp);
    const r = await runPackage(mkInput(), deps);
    expect(r.output.assets).toHaveLength(0);
    expect(r.output.warnings.some((w) => w.includes('competitor'))).toBe(true);
    expect(r.validation.ok).toBe(true);
  });

  it('language is preserved — a wrong strategy.language is corrected, never accepted', async () => {
    const wrong = mkBase();
    wrong.strategy = { ...wrong.strategy, language: 'en' };
    const { deps } = mkDeps(() => wrong);
    const r = await runPackage(mkInput(), deps);
    expect(r.output.strategy.language).toBe('ar');
    expect(r.output.warnings.some((w) => w.includes('language'))).toBe(true);
    expect(r.validation.ok).toBe(true);
  });
});

describe('runDerivatives', () => {
  const base = mkBase();

  it('only selected targets survive; 4:5→9:16 is a separate design; adaptation strings complete', async () => {
    const out: DerivativesOutput = {
      derivatives: [mkDerivative(IG_FEED), mkDerivative(IG_STORY), mkDerivative(X_POST)],
    };
    const { deps } = mkDeps(() => out);
    const r = await runDerivatives(mkInput({ targets: [IG_FEED, IG_STORY], basePackage: base }) as DirectorInput & { basePackage: BasePackage }, deps);
    expect(r.validation.ok).toBe(true);
    expect(r.output.derivatives).toHaveLength(2);
    const keys = r.output.derivatives.map((d) => `${d.target.target_kind}:${d.target.platform}:${d.target.placement_type}`);
    expect(keys).toEqual(['organic:instagram:feed', 'organic:instagram:story']);
    expect(r.validation.warnings.some((w) => w.rule === 'target_not_selected' && w.detail.includes('x:post'))).toBe(true);

    const feed = r.output.derivatives[0]!;
    expect(feed.dimensions).toEqual({ aspect: '4:5', px: [1080, 1350] });
    expect(feed.adaptation.requires_separate_design).toBe(false);
    expect(feed.adaptation.image_instructions).toContain('لا تغيير');
    expect(feed.limits.caption_max).toBe(2000);

    const story = r.output.derivatives[1]!;
    expect(story.dimensions).toEqual({ aspect: '9:16', px: [1080, 1920] });
    expect(story.adaptation.requires_separate_design).toBe(true);
    expect(story.adaptation.image_change).toBe('extend');
    expect(story.adaptation.text_reposition.length).toBeGreaterThan(0);
    expect(story.adaptation.logo_reposition.length).toBeGreaterThan(0);
    expect(story.adaptation.layout_changes.length).toBeGreaterThan(0);
    expect(story.adaptation.element_scaling.length).toBeGreaterThan(0);
  });

  it('a missing selected target triggers the retry (target_missing)', async () => {
    const { deps, calls } = mkDeps((_k, _r, n) =>
      n === 1
        ? { derivatives: [mkDerivative(IG_FEED)] } // story missing
        : { derivatives: [mkDerivative(IG_FEED), mkDerivative(IG_STORY)] },
    );
    const r = await runDerivatives(mkInput({ targets: [IG_FEED, IG_STORY], basePackage: base }) as DirectorInput & { basePackage: BasePackage }, deps);
    expect(r.retried).toBe(true);
    expect(calls[1]!.req.user).toContain('target_missing');
    expect(r.needs_attention).toBe(false);
    expect(r.output.derivatives).toHaveLength(2);
  });
});

describe('runRegenerate', () => {
  it('renders the previous package + the reviewer note into the prompt', async () => {
    const { deps, calls } = mkDeps(() => mkBase());
    const prev = mkBase();
    const r = await runRegenerate(mkInput({ previousPackage: prev, revisionNote: 'قصّر العناوين' }), deps);
    expect(r.validation.ok).toBe(true);
    expect(calls[0]!.req.user).toContain('قصّر العناوين');
    expect(calls[0]!.req.user).toContain('الحزمة السابقة');
  });

  it('throws facts_insufficient when there is no previous package', async () => {
    const { deps } = mkDeps(() => mkBase());
    await expect(runRegenerate(mkInput(), deps)).rejects.toThrow(/^facts_insufficient:/);
  });
});

describe('facts gate', () => {
  it('throws facts_insufficient when the package is not viable', async () => {
    const dead: CreativeFacts = { ...FACTS, package: { ...PKG, viable: false, missing: ['price'] } };
    const { deps } = mkDeps(() => mkConcepts());
    await expect(runConcepts(mkInput({ facts: dead }), deps)).rejects.toThrow(/^facts_insufficient:/);
  });

  it('throws facts_insufficient when a price-led recipe has no claimable price fact', async () => {
    const noPrice: CreativeFacts = {
      ...FACTS,
      package: { ...PKG, facts: PKG.facts.filter((f) => f.class !== 'price') },
    };
    const { deps } = mkDeps(() => mkBase());
    await expect(runPackage(mkInput({ recipe: 'offer', facts: noPrice }), deps)).rejects.toThrow(/^facts_insufficient:/);
  });
});
