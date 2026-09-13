import { describe, it, expect } from 'vitest';
import { validateEnrichmentResults, isSubscriptionLimit, attributionRejection, normalizeText } from './mkt-enrichment-validate.mjs';

const P1 = '6ff3010b-4252-4566-bc6f-db842bd99a48';
const P2 = '83a6a789-c022-4d6e-bef1-6d484fb1a4e0';
const POST = 'aaaaaaaa-0000-0000-0000-000000000001';
const evidence = [{
  post_id: POST,
  caption: 'عن مشروع ريفييرا المربع، في حي المربع مشروع استثنائي وفرصة استثمارية #العجلان_ريفييرا — 27 of 78 sold',
  transcript: '',
  ocr_text: 'ريفييرا 58 تملّك الآن',
  brand_tokens: ['العجلان', 'ريفييرا', 'alajlan', 'riviera'],
  candidates: [
    { projectId: P1, nameAr: 'ريفييرا المربع', confidence: 0.9, matchedAliases: ['ريفييرا المربع'], strength: 'full_name' },
    { projectId: P2, nameAr: 'ريفييرا 58', confidence: 0.85, matchedAliases: ['ريفييرا 58'], strength: 'number' },
  ],
  deterministic_partial: false,
}];

describe('validateEnrichmentResults — schema + business rules', () => {
  it('accepts a valid result WITH a verbatim quote and resolves the project id from the candidate index', () => {
    const { valid, errors } = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, evidence_quote: 'مشروع ريفييرا المربع', is_general_branding: false, language: 'ar', content_type: 'offer', offer: '27 of 78 sold' }], evidence);
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
    expect(valid[0].primaryProjectId).toBe(P1);
    expect(valid[0].evidenceQuote).toBe('مشروع ريفييرا المربع');
    expect(valid[0].result.content_type).toBe('offer');
    expect(valid[0].result.attribution_rejected).toBeUndefined();
    // candidate P2 has confidence 0.85 ≥ 0.8 and is strong → secondary attribution
    expect(valid[0].secondary.map((s) => s.projectId)).toContain(P2);
  });
  it('a pick WITHOUT a quote is downgraded to no project — and says why', () => {
    const { valid, errors } = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, is_general_branding: false, language: 'ar' }], evidence);
    expect(errors).toEqual([]);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].result.attribution_rejected).toMatch(/no evidence_quote/);
  });
  it('a quote that is not in the evidence is refused', () => {
    const { valid } = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, evidence_quote: 'ريفييرا المربع أفضل مشروع في الرياض', is_general_branding: false, language: 'ar' }], evidence);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].result.attribution_rejected).toMatch(/not found verbatim/);
  });
  it('a quote that carries only the brand word is refused (the عزوم / ديارا trap)', () => {
    const ev = [{
      post_id: POST, caption: 'في عزوم نوفرلك كل شيء في مكان واحد', transcript: '', ocr_text: 'AZOUM COMPANY',
      brand_tokens: ['عزوم', 'الاعمار', 'azoum'],
      candidates: [{ projectId: P1, nameAr: 'عزوم النرجس', confidence: 0.6, matchedAliases: ['عزوم'], strength: 'word' }],
    }];
    const { valid } = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, evidence_quote: 'في عزوم نوفرلك', is_general_branding: false, language: 'ar' }], ev);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].result.attribution_rejected).toMatch(/does not name the project/);
  });
  it('a weak (lone-word) candidate needs the actual project name in the quote', () => {
    const ev = [{
      post_id: POST, caption: 'تعرّف على أوتوجراف — التفاصيل قريبًا. أوتوجراف 21 يفتح أبوابه', transcript: '', ocr_text: '',
      brand_tokens: ['ديار', 'اصيله'],
      candidates: [{ projectId: P1, nameAr: 'أوتوجراف 21', confidence: 0.6, matchedAliases: ['اوتوجراف'], strength: 'word' }],
    }];
    const weak = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, evidence_quote: 'تعرّف على أوتوجراف', is_general_branding: false, language: 'ar' }], ev);
    expect(weak.valid[0].primaryProjectId).toBeNull();
    const strong = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, evidence_quote: 'أوتوجراف 21 يفتح أبوابه', is_general_branding: false, language: 'ar' }], ev);
    expect(strong.valid[0].primaryProjectId).toBe(P1);
  });
  it('quotes survive hamza / ta-marbuta / line-break differences', () => {
    const ev = [{ ...evidence[0], caption: 'تحديثات مشروع جوهرة\nالرمز مع التقدم', candidates: [{ projectId: P1, nameAr: 'جوهرة الرمز', confidence: 0.9, matchedAliases: ['جوهره الرمز'], strength: 'full_name' }], brand_tokens: ['الرمز'] }];
    const { valid } = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, evidence_quote: 'مشروع جوهره الرمز', is_general_branding: false, language: 'ar' }], ev);
    expect(valid[0].primaryProjectId).toBe(P1);
  });
  it('mentioned_projects are carried through (catalog gap signal)', () => {
    const { valid } = validateEnrichmentResults([{ post_id: POST, primary_project_index: -1, mentioned_projects: ['ديارا الروضة D1', ''], is_general_branding: false, language: 'ar' }], evidence);
    expect(valid[0].result.mentioned_projects).toEqual(['ديارا الروضة D1']);
  });
  it('a human-locked post is flagged so the runner skips attribution writes', () => {
    const ev = [{ ...evidence[0], attribution_locked: true }];
    const { valid } = validateEnrichmentResults([{ post_id: POST, primary_project_index: -1, is_general_branding: true, language: 'ar' }], ev);
    expect(valid[0].locked).toBe(true);
  });
  it('index -1 → general branding, no project', () => {
    const { valid } = validateEnrichmentResults([{ post_id: POST, primary_project_index: -1, is_general_branding: true, language: 'ar' }], evidence);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].result.is_general_branding).toBe(true);
  });
  it('REJECTS an out-of-range index (unknown project — cannot fabricate)', () => {
    const { valid, errors } = validateEnrichmentResults([{ post_id: POST, primary_project_index: 5, is_general_branding: false, language: 'ar' }], evidence);
    expect(valid).toHaveLength(0);
    expect(errors.join(' ')).toMatch(/out of range/);
  });
  it('REJECTS a non-array (malformed Claude output)', () => {
    expect(validateEnrichmentResults({ post_id: POST }, evidence).errors).toContain('result is not a JSON array');
  });
  it('REJECTS an unknown post_id', () => {
    const { errors } = validateEnrichmentResults([{ post_id: 'zzzz', primary_project_index: -1, is_general_branding: true, language: 'ar' }], evidence);
    expect(errors.join(' ')).toMatch(/unknown\/missing post_id/);
  });
  it('flags a post missing from the result (partial failure)', () => {
    const { errors } = validateEnrichmentResults([], evidence);
    expect(errors.join(' ')).toMatch(new RegExp(`${POST}: missing from result`));
  });
  it('rejects a duplicate post_id but keeps the first', () => {
    const dup = [{ post_id: POST, primary_project_index: 0, evidence_quote: 'ريفييرا المربع', is_general_branding: false, language: 'ar' }, { post_id: POST, primary_project_index: 1, is_general_branding: false, language: 'ar' }];
    const { valid, errors } = validateEnrichmentResults(dup, evidence);
    expect(valid).toHaveLength(1);
    expect(errors.join(' ')).toMatch(/duplicate post_id/);
  });
  it('coerces an invalid language enum to none and never emits null', () => {
    const { valid } = validateEnrichmentResults([{ post_id: POST, primary_project_index: -1, is_general_branding: false, language: 'martian', offer: null, unit_types: null }], evidence);
    expect(valid[0].result.language).toBe('none');
    expect(valid[0].result.offer).toBe('');
    expect(valid[0].result.unit_types).toEqual([]);
  });
});

describe('attributionRejection / normalizeText', () => {
  it('folds the same way the worker matcher does', () => {
    expect(normalizeText('أدوار الــماجدية  \n جديدة')).toBe('ادوار الماجديه جديده');
  });
  it('accepts a quote whose only anchor is the project number', () => {
    const cand = { nameAr: 'ريفييرا 58', matchedAliases: ['ريفييرا 58'], strength: 'number' };
    expect(attributionRejection('ريفييرا 58 تملّك الآن', cand, evidence[0])).toBeNull();
  });
});

describe('isSubscriptionLimit', () => {
  it('detects Claude usage/rate-limit phrasings', () => {
    expect(isSubscriptionLimit('You have reached your usage limit for the 5-hour window')).toBe(true);
    expect(isSubscriptionLimit('rate limit exceeded, please try again later')).toBe(true);
    expect(isSubscriptionLimit('normal completion, wrote result.json')).toBe(false);
  });
});
