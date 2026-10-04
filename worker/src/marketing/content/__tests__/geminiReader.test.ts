import { describe, expect, it } from 'vitest';
import { validateEnrichmentResults as validateTs, attributionRejection as rejectTs, normalizeText as normTs, GENERIC_TOKENS as GEN_TS, type EnrichEvidence } from '../enrichmentValidate.js';
// @ts-expect-error — plain .mjs from the scripts package, no type declarations
import { validateEnrichmentResults as validateMjs, attributionRejection as rejectMjs, normalizeText as normMjs, GENERIC_TOKENS as GEN_MJS } from '../../../../../scripts/lib/mkt-enrichment-validate.mjs';
import { buildDecidePrompt, buildReadPrompt, ENRICH_RULES } from '../geminiRead.js';
import { candidateFingerprint, isGeminiRead } from '../geminiEnrich.js';

const cand = (projectId: string, nameAr: string, strength: string, extra: Record<string, unknown> = {}) => ({ projectId, nameAr, nameEn: '', strength, confidence: 0.9, matchedAliases: [] as string[], ...extra });

const evidence: EnrichEvidence[] = [
  { post_id: 'p1', caption: 'امتلك مسكنك بمشروع عراقة 2 حي قرطبة', transcript: '', ocr_text: 'رصف RASF', brand_tokens: ['رصف', 'rasf'], candidates: [cand('a', 'عراقة قرطبة 2', 'full_name'), cand('b', 'عراقة الملقا', 'word')] },
  { post_id: 'p2', caption: 'ديار أصيلة - حي الصفا', transcript: '', ocr_text: '', brand_tokens: ['ريفيرا'], candidates: [cand('c', 'شقق حي الصفا - ريفيرا 48', 'word')] },
  { post_id: 'p3', caption: 'عزوم نوفرلك كل شيء', transcript: '', ocr_text: '', brand_tokens: ['عزوم'], candidates: [cand('d', 'عزوم الرمال', 'word')] },
  { post_id: 'p4', caption: '', transcript: '', ocr_text: '', brand_tokens: [], candidates: [cand('e', 'مكين 63', 'number')] },
  { post_id: 'p5', caption: 'مكين ٦٣ حي العارض', transcript: '', ocr_text: '', brand_tokens: [], candidates: [cand('f', 'مكين 63', 'number', { matchedAliases: ['مكين 63'] })] },
  { post_id: 'p6', caption: 'عن مشروع ريفييرا المربع', transcript: '', ocr_text: '', brand_tokens: [], candidates: [cand('g', 'ريفييرا 58', 'number'), cand('h', 'ريفييرا المربع', 'full_name')] },
];
const answers = [
  { post_id: 'p1', primary_project_index: 0, evidence_quote: 'مشروع عراقة 2 حي قرطبة', content_type: 'teaser', language: 'ar', mentioned_projects: [], offer: '' },
  { post_id: 'p2', primary_project_index: 0, evidence_quote: 'ديار أصيلة - حي الصفا', content_type: 'offer', language: 'ar' },
  { post_id: 'p3', primary_project_index: 0, evidence_quote: 'عزوم نوفرلك كل شيء', content_type: 'brand', language: 'ar' },
  { post_id: 'p4', primary_project_index: 0, evidence_quote: 'مكين 63 حي', content_type: 'brand', language: 'ar' },
  { post_id: 'p5', primary_project_index: 0, evidence_quote: '', content_type: 'project_launch', language: 'ar', selling_points: ['قريب'] },
  { post_id: 'p6', primary_project_index: 0, evidence_quote: 'عن مشروع ريفييرا المربع', content_type: 'project_launch', language: 'ar' },
];

describe('ported proof checker == scripts/lib original', () => {
  it('gives identical results on the same answers and evidence', () => {
    expect(JSON.parse(JSON.stringify(validateTs(answers, evidence)))).toEqual(JSON.parse(JSON.stringify(validateMjs(answers, evidence))));
  });
  it('single rejections agree', () => {
    for (const e of evidence) for (const c of e.candidates ?? []) for (const q of [e.caption ?? '', 'xx', '']) {
      expect(rejectTs(q, c, e)).toBe(rejectMjs(q, c, e));
    }
  });
  it('normalisation and the generic-word list agree', () => {
    for (const t of ['مكين ٦٣', 'أدوار - يمام 9', 'ـمشروعًـ', 'RIVA_Real']) expect(normTs(t)).toBe(normMjs(t));
    expect([...GEN_TS].sort()).toEqual([...(GEN_MJS as Set<string>)].sort());
  });
  it('accepts the Araqa pick and refuses the Riviera 48 pick that quotes another project', () => {
    const { valid } = validateTs(answers, evidence);
    expect(valid.find((v) => v.postId === 'p1')?.primaryProjectId).toBe('a');
    expect(valid.find((v) => v.postId === 'p2')?.primaryProjectId).toBeNull();
    expect(valid.find((v) => v.postId === 'p3')?.primaryProjectId).toBeNull();
    expect(valid.find((v) => v.postId === 'p4')?.result.no_evidence).toBe(true);
  });
});

describe('Gemini reader prompts', () => {
  const ctx = { post_id: 'p', organization_name: 'رصف', account: '@rasf (instagram)', brand_tokens: ['رصف'], sibling_projects: ['عراقة الملقا'], caption: 'cap', transcript: '', candidates: [cand('a', 'عراقة قرطبة 2', 'full_name')] };
  it('the read prompt numbers the media and carries the rules and the short list', () => {
    const p = buildReadPrompt(ctx, ['video', 'image']);
    expect(p).toContain('[1] video, [2] image');
    expect(p).toContain('[0] عراقة قرطبة 2');
    expect(p).toContain(ENRICH_RULES.slice(0, 40));
    expect(p).toContain('copied EXACTLY in its original language');
  });
  it('the decide prompt includes the stored screen text', () => {
    expect(buildDecidePrompt({ ...ctx, ocr_text: 'مشروع عراقة 2' })).toContain('ON-SCREEN TEXT (read from its images/video):\nمشروع عراقة 2');
  });
});

describe('reader helpers', () => {
  it('a short list compares by project and strength, not order', () => {
    expect(candidateFingerprint([{ projectId: 'b', strength: 'word' }, { projectId: 'a', strength: 'full_name' }]))
      .toBe(candidateFingerprint([{ projectId: 'a', strength: 'full_name' }, { projectId: 'b', strength: 'word' }]));
    expect(candidateFingerprint([{ projectId: 'a', strength: 'word' }])).not.toBe(candidateFingerprint([{ projectId: 'a', strength: 'full_name' }]));
  });
  it('only a done Gemini decision counts as already read', () => {
    expect(isGeminiRead({ model: 'gemini-3.8-flash', status: 'done' })).toBe(true);
    expect(isGeminiRead({ model: 'claude-runner:content-enrichment', status: 'done' })).toBe(false);
    expect(isGeminiRead({ model: 'gemini-3.8-flash', status: 'pending' })).toBe(false);
    expect(isGeminiRead(null)).toBe(false);
  });
});
