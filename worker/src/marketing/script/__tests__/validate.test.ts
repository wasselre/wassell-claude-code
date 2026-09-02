import { describe, expect, it } from 'vitest';
import { buildBlocklist, tokenizeAr } from '../entities.js';
import { normalizeGeneration, toArabicIndic } from '../generate.js';
import { DEFAULT_RULES, type Brief, type DraftScene, type Exemplar, type FactsPackage, type RecipeRow } from '../types.js';
import { longestSharedRun, structuralChecks, validateScript } from '../validate.js';

const RECIPE: RecipeRow = { key: 'walkthrough', label_ar: 'جولة', label_en: 'Walkthrough', structure: ['hook', 'location', 'feature', 'cta'], guidance: 'g', default_duration_sec: 45, scene_count_hint: 5, retrieval_content_types: ['walkthrough'], requires_facts: [], version: 1, is_active: true };
const BRIEF: Brief = {
  content_id: 'c', project_id: 'p', project_ids: ['p'], multi_project_warning: false, purpose: 'organic', platforms: ['instagram'], objective: null, audience: null,
  language: 'ar', cta: 'للحجز والاستفسار: وصل العقارية', recipe: 'walkthrough', duration_sec: 45, scene_count_hint: 5, funnel: 'mid', existing_scenes: [], assets_summary: { count: 0, kinds: {} }, warnings: [],
};
function facts(readiness: FactsPackage['readiness']): FactsPackage {
  return {
    project_name: 'أكنان ٢٥', readiness, sold_out: false, viable: true, missing: [], warnings: [], developer_name: 'أكنان',
    facts: [
      { id: 'F1', key: 'project_name', class: 'name', value: 'أكنان ٢٥', rendered_ar: 'أكنان ٢٥', source_field: 'project_name', verified_at: null, claimable: true },
      { id: 'F2', key: 'price_from', class: 'price', value: 674497, rendered_ar: 'تبدأ من 674,497 ر.س', source_field: 'available_price_range.min', verified_at: null, claimable: true },
      { id: 'F3', key: 'handover_date', class: 'date', value: '2026-09-01', rendered_ar: 'التسليم 2026-09', source_field: 'handover_date', verified_at: null, claimable: true },
    ],
  };
}
function scene(order: number, voiceover: string, on_screen_text = '', extra: Partial<DraftScene> = {}): DraftScene {
  return {
    order, purpose: order === 1 ? 'hook' : 'feature', duration_sec: 9, start_sec: (order - 1) * 9, end_sec: order * 9, voiceover, on_screen_text, visual: 'لقطة',
    visual_intent: { shot_size: 'wide', subject: 'building', setting: 'exterior_facade', interior_exterior: 'exterior', motion: 'drone', graphic_kind: 'none', mood: '' },
    angle: '', fact_refs: [], learned_from: [], asset_requirement: 'footage', production_note: '', warnings: [], ...extra,
  };
}
const CTA = 'للحجز والاستفسار: وصل العقارية';
const EXEMPLAR: Exemplar = { id: 'E1', content_post_id: 'x', organization_id: 'o', org_name: 'ريفا العقارية', platform: 'instagram', content_type: 'walkthrough', language: 'ar', views: 1, similarity: 0.9,
  transcript: 'حياكم الله اليوم في شمال الرياض حي النرجس تحديداً عندنا مشروع فلل جاهزة للسكن مساحات كبيرة وتشطيب فاخر ما شاء الله تبارك الله تواصلوا معنا', ocr: '', campaign_message: null, selling_points: [] };
const BL = buildBlocklist({ brief: { cta: CTA }, exemplars: [EXEMPLAR], projectRecord: {}, developerName: 'أكنان', rules: DEFAULT_RULES });

const base = (f: FactsPackage) => ({ brief: BRIEF, facts: f, recipe: RECIPE, rules: DEFAULT_RULES, exemplars: [EXEMPLAR], output: { patterns_learned: [], scene_plan: [], scenes: [], hooks: [] } });
const check = (checks: ReturnType<typeof structuralChecks>, key: string) => checks.find((c) => c.key === key)!;

describe('structuralChecks — readiness consistency', () => {
  it('off-plan project must not promise immediate handover', () => {
    const s = [scene(1, 'تبي فيلا؟'), scene(2, 'فلل جاهزة تستلمها اليوم'), scene(3, CTA)];
    expect(check(structuralChecks(base(facts('off_plan')), s, [], []), 'readiness_consistency').level).toBe('fail');
  });
  it('ready project must not imply off-plan delivery', () => {
    const s = [scene(1, 'تبي فيلا؟'), scene(2, 'على الخارطة، موعد التسليم ٢٠٢٦'), scene(3, CTA)];
    expect(check(structuralChecks(base(facts('ready')), s, [], []), 'readiness_consistency').level).toBe('fail');
  });
  it('ready wording on a ready project passes (استلام فوري is not off-plan)', () => {
    const s = [scene(1, 'تبي فيلا؟'), scene(2, 'جاهزة للسكن واستلام فوري'), scene(3, CTA)];
    expect(check(structuralChecks(base(facts('ready')), s, [], []), 'readiness_consistency').level).toBe('pass');
  });
  it('off-plan project that never says so gets a warning', () => {
    const s = [scene(1, 'تبي فيلا؟'), scene(2, 'مساحات كبيرة'), scene(3, CTA)];
    expect(check(structuralChecks(base(facts('off_plan')), s, [], []), 'readiness_consistency').level).toBe('warn');
  });
});

describe('structuralChecks — CTA / contact / leakage / hook', () => {
  it('missing Wassel CTA in the last scene fails', () => {
    const s = [scene(1, 'تبي فيلا؟'), scene(2, 'مساحات كبيرة'), scene(3, 'احجز الآن')];
    expect(check(structuralChecks(base(facts('ready')), s, [], []), 'cta_present').level).toBe('fail');
  });
  it('Wassel CTA present passes', () => {
    const s = [scene(1, 'تبي فيلا؟'), scene(2, 'مساحات كبيرة'), scene(3, CTA)];
    expect(check(structuralChecks(base(facts('ready')), s, [], []), 'cta_present').level).toBe('pass');
  });
  it('another contact channel fails', () => {
    const s = [scene(1, 'تبي فيلا؟'), scene(2, 'اتصل 0501234567'), scene(3, CTA)];
    const r = structuralChecks(base(facts('ready')), s, [], [{ scene: 2, mention: '0501234567', kind: 'phone' }]);
    expect(check(r, 'contact_channel').level).toBe('fail');
  });
  it('verbatim exemplar copying (≥12 words) fails', () => {
    const copied = 'اليوم في شمال الرياض حي النرجس تحديداً عندنا مشروع فلل جاهزة للسكن مساحات كبيرة وتشطيب فاخر';
    expect(longestSharedRun(copied, [tokenizeAr(EXEMPLAR.transcript)])).toBeGreaterThanOrEqual(12);
    const s = [scene(1, 'تبي فيلا؟'), scene(2, copied), scene(3, CTA)];
    expect(check(structuralChecks(base(facts('ready')), s, [], []), 'exemplar_leakage').level).toBe('fail');
  });
  it('a greeting hook warns', () => {
    const s = [scene(1, 'بسم الله الله يبارك في وقتكم يا متابعين'), scene(2, 'مساحات'), scene(3, CTA)];
    expect(check(structuralChecks(base(facts('ready')), s, [], []), 'hook_greeting').level).toBe('warn');
  });
  it('unknown fact refs warn', () => {
    const s = [scene(1, 'تبي فيلا؟', '', { fact_refs: ['F9'] }), scene(2, 'مساحات'), scene(3, CTA)];
    expect(check(structuralChecks(base(facts('ready')), s, [], []), 'fact_refs').level).toBe('warn');
  });
});

describe('validateScript (no model)', () => {
  it('auto-fixes on-screen numerals, gates claims and entities, flags FAIL', async () => {
    const output = normalizeGeneration({
      scenes: [
        { order: 1, purpose: 'hook', duration_sec: 8, voiceover: 'تبي فيلا؟ تبدأ من ٦٧٤٬٤٩٧ ر.س', on_screen_text: 'تبدأ من 674,497 ر.س', visual: 'v' },
        { order: 2, purpose: 'feature', duration_sec: 8, voiceover: 'ريفا العقارية تقدم لكم ضمان ١٠ سنوات', on_screen_text: '', visual: 'v' },
        { order: 3, purpose: 'cta', duration_sec: 8, voiceover: CTA, on_screen_text: CTA, visual: 'v' },
      ],
      hooks: ['h1'],
    }, BRIEF);
    const r = await validateScript({ brief: BRIEF, facts: facts('ready'), recipe: RECIPE, rules: DEFAULT_RULES, output, exemplars: [EXEMPLAR], blocklist: BL, callRole: null });
    expect(r.scenes[0]!.on_screen_text).toBe('تبدأ من ٦٧٤٬٤٩٧ ر.س');
    expect(check(r.validator.checks, 'numerals_on_screen').level).toBe('pass'); // normalizeGeneration already converted
    expect(r.validator.claims.find((c) => c.mention.includes('٦٧٤'))?.verdict).toBe('pass');
    expect(r.validator.claims.find((c) => c.class === 'guarantee')?.verdict).toBe('fail');
    expect(r.validator.entities.some((e) => e.mention === 'ريفا العقارية')).toBe(true);
    expect(check(r.validator.checks, 'entity_leak').level).toBe('fail');
    expect(r.hasFail).toBe(true);
    expect(r.scenes[1]!.warnings.length).toBeGreaterThan(0);
  });
  it('a clean script has no FAIL', async () => {
    const output = normalizeGeneration({
      scenes: [
        { order: 1, purpose: 'hook', duration_sec: 8, voiceover: 'تبي فيلا؟ في أكنان ٢٥ تبدأ من ٦٧٤ ألف ريال', on_screen_text: '٦٧٤٬٤٩٧ ر.س', visual: 'v', fact_refs: ['F1', 'F2'] },
        { order: 2, purpose: 'feature', duration_sec: 8, voiceover: 'ثلاث مزايا تخليك تختارها: الموقع، التشطيب، والجاهزية', on_screen_text: '', visual: 'v' },
        { order: 3, purpose: 'cta', duration_sec: 8, voiceover: CTA, on_screen_text: CTA, visual: 'v' },
      ],
      hooks: ['h1', 'h2', 'h3'],
    }, BRIEF);
    const r = await validateScript({ brief: BRIEF, facts: facts('ready'), recipe: RECIPE, rules: DEFAULT_RULES, output, exemplars: [EXEMPLAR], blocklist: BL, callRole: null });
    expect(r.validator.checks.filter((c) => c.level === 'fail')).toEqual([]);
    expect(r.hasFail).toBe(false);
  });
});

describe('normalizeGeneration', () => {
  it('orders scenes, computes cumulative timing scaled to duration, converts digits', () => {
    const out = normalizeGeneration({ scenes: [
      { order: 2, voiceover: 'ب', on_screen_text: '120 م²', visual: 'v', duration_sec: 10 },
      { order: 3, voiceover: 'ج', on_screen_text: '', visual: 'v', duration_sec: 10 },
      { order: 1, voiceover: 'أ', on_screen_text: '', visual: 'v', duration_sec: 10 },
    ], hooks: ['x'] }, { duration_sec: 45 });
    expect(out.scenes.map((s) => s.voiceover)).toEqual(['أ', 'ب', 'ج']);
    expect(out.scenes[0]!.start_sec).toBe(0);
    expect(out.scenes[1]!.start_sec).toBe(out.scenes[0]!.end_sec);
    expect(out.scenes[2]!.end_sec).toBe(45);
    const total = out.scenes.reduce((a, s) => a + s.duration_sec, 0);
    expect(Math.abs(total - 45) / 45).toBeLessThanOrEqual(0.2);
    expect(out.scenes[1]!.on_screen_text).toBe('١٢٠ م²');
  });
  it('throws a provider: error when no scenes come back', () => {
    expect(() => normalizeGeneration({ scenes: [] }, { duration_sec: 40 })).toThrow(/^provider:/);
  });
  it('toArabicIndic keeps thousands separators', () => {
    expect(toArabicIndic('674,497 ر.س')).toBe('٦٧٤٬٤٩٧ ر.س');
  });
});
