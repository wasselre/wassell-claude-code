import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateEnrichmentResults, isSubscriptionLimit, attributionRejection, normalizeText, GENERIC_TOKENS } from './mkt-enrichment-validate.mjs';

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
  // These two ran on the STRONG full_name candidate until 2026-10-03; a strong
  // pick with a bad quote now stands on the matcher's alias (see "matcher
  // alias" below), so the downgrade rule is exercised on a weak copy of it.
  const weakEvidence = [{ ...evidence[0], candidates: [{ ...evidence[0].candidates[0], strength: 'word', confidence: 0.55 }] }];
  it('a pick WITHOUT a quote is downgraded to no project — and says why', () => {
    const { valid, errors } = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, is_general_branding: false, language: 'ar' }], weakEvidence);
    expect(errors).toEqual([]);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].result.attribution_rejected).toMatch(/no evidence_quote/);
  });
  it('a quote that is not in the evidence is refused', () => {
    const { valid } = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, evidence_quote: 'ريفييرا المربع أفضل مشروع في الرياض', is_general_branding: false, language: 'ar' }], weakEvidence);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].result.attribution_rejected).toMatch(/not found verbatim/);
  });
  it('a fabricated quote on a STRONG pick is never stored — the matcher alias replaces it', () => {
    const { valid } = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, evidence_quote: 'ريفييرا المربع أفضل مشروع في الرياض', is_general_branding: false, language: 'ar' }], evidence);
    expect(valid[0].primaryProjectId).toBe(P1);
    expect(valid[0].evidenceQuote).toBe('ريفييرا المربع');
    expect(valid[0].result.evidence_quote).toBe('ريفييرا المربع');
    expect(valid[0].result.evidence_quote_source).toBe('matcher');
    expect(valid[0].result.model_quote_rejected).toMatch(/not found verbatim/);
    expect(valid[0].result.attribution_rejected).toBeUndefined();
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

// Real strings from the 2026-10-03 attribution audit.
const MAKEEN_POST = 'aaaaaaaa-0000-0000-0000-000000000002';
const SAMAWA_POST = 'aaaaaaaa-0000-0000-0000-000000000003';
const makeenCand = { projectId: P1, nameAr: 'مكين 63', confidence: 0.85, matchedAliases: ['مكين 63'], strength: 'number' };
const makeen = {
  post_id: MAKEEN_POST,
  caption: 'مكين 63حي العارض وحدات سكنية قريبة لأهم الوجهات',
  transcript: '',
  ocr_text: 'مكين MAKEEN 63 حي العارض ينتظرك',
  brand_tokens: ['مكين', 'makeen'],
  candidates: [makeenCand],
};
const samawaCand = { projectId: P2, nameAr: 'شقق سماوة', confidence: 0.55, matchedAliases: ['سماوه'], strength: 'word' };
const samawa = {
  post_id: SAMAWA_POST,
  caption: 'تغطية للوحدة المؤثثة في سماوة',
  transcript: '',
  ocr_text: '',
  brand_tokens: [],
  candidates: [samawaCand],
};
const pick = (postId, quote, extra = {}) => ({ post_id: postId, primary_project_index: 0, evidence_quote: quote, is_general_branding: false, language: 'ar', ...extra });

describe('A — a number glued to the next word', () => {
  it('accepts «مكين 63حي العارض» (the number is bounded by non-digits)', () => {
    const { valid, errors } = validateEnrichmentResults([pick(MAKEEN_POST, 'مكين 63حي العارض')], [makeen]);
    expect(errors).toEqual([]);
    expect(valid[0].primaryProjectId).toBe(P1);
    expect(valid[0].evidenceQuote).toBe('مكين 63حي العارض');
    expect(valid[0].result.attribution_rejected).toBeUndefined();
    expect(valid[0].result.evidence_quote_source).toBeUndefined();
  });
  it('does NOT read 63 inside a longer number', () => {
    const ev = { ...makeen, caption: 'مكين منذ 1963 في الرياض', ocr_text: '' };
    expect(attributionRejection('مكين منذ 1963 في', makeenCand, ev)).toMatch(/0\/1 name tokens/);
  });
  it('accepts a number glued to the word BEFORE it («مكين63»)', () => {
    // the left edge needs only a non-digit too — the worker's rule 3
    // («<series>\s*<number>») already accepts this form
    const ev = { ...makeen, caption: 'مشروع مكين63 حي العارض', ocr_text: '' };
    expect(attributionRejection('مشروع مكين63 حي', makeenCand, ev)).toBeNull();
  });
  it('word anchors keep their letter boundaries', () => {
    // «سماوه» glued inside a longer word («السماوة») is not the project
    const ev = { ...samawa, caption: 'فلل للبيع في السماوة الشرقية' };
    expect(attributionRejection('في السماوة الشرقية', samawaCand, ev)).toMatch(/0\/1 name tokens/);
  });
  it('a mixed letter-and-digit WORD keeps letter boundaries («b12x» is not «b12»)', () => {
    const cand = { nameEn: 'Sedra B12', matchedAliases: ['sedra b12'], strength: 'word' };
    const ev = { caption: 'new b12x units and b12 towers', transcript: '', ocr_text: '', brand_tokens: ['sedra'] };
    expect(attributionRejection('new b12x units', cand, ev)).toMatch(/0\/1 name tokens/);
    expect(attributionRejection('and b12 towers', cand, ev)).toBeNull();
  });
});

describe('B — Arabic-Indic and Persian digits', () => {
  it('normalizeText folds ٠-٩ and ۰-۹ to ASCII', () => {
    expect(normalizeText('مكين ٦٣ / ۶۳ / ٠١٢٣٤٥٦٧٨٩')).toBe('مكين 63 / 63 / 0123456789');
  });
  it('accepts an Arabic-Indic quote against ASCII evidence', () => {
    const { valid } = validateEnrichmentResults([pick(MAKEEN_POST, 'مكين ٦٣حي العارض')], [makeen]);
    expect(valid[0].primaryProjectId).toBe(P1);
    expect(valid[0].result.attribution_rejected).toBeUndefined();
    // the MODEL's quote is what passed — without the digit fold the pick would
    // still stand, but on the matcher alias, and this test would prove nothing
    expect(valid[0].evidenceQuote).toBe('مكين ٦٣حي العارض');
    expect(valid[0].result.evidence_quote_source).toBeUndefined();
  });
  it('accepts an ASCII quote against Arabic-Indic evidence', () => {
    const ev = { ...makeen, caption: 'مكين ٦٣ حي العارض', ocr_text: '' };
    expect(attributionRejection('مكين 63 حي العارض', makeenCand, ev)).toBeNull();
  });
});

describe('C — generic real-estate words are not name tokens', () => {
  it('accepts «تغطية للوحدة المؤثثة في سماوة» for «شقق سماوة»', () => {
    const { valid, errors } = validateEnrichmentResults([pick(SAMAWA_POST, 'تغطية للوحدة المؤثثة في سماوة')], [samawa]);
    expect(errors).toEqual([]);
    expect(valid[0].primaryProjectId).toBe(P2);
    expect(valid[0].result.attribution_rejected).toBeUndefined();
  });
  it('the generic word alone still does not name the project', () => {
    const ev = { ...samawa, caption: 'شقق مفروشة للايجار الشهري' };
    expect(attributionRejection('شقق مفروشة للايجار', samawaCand, ev)).toMatch(/0\/1 name tokens/);
  });
  it('GENERIC_TOKENS carries every entry of the worker matcher list (keep-in-sync guard)', () => {
    const src = readFileSync(fileURLToPath(new URL('../../worker/src/marketing/pipeline.ts', import.meta.url)), 'utf-8');
    const m = src.match(/export const GENERIC_TOKENS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(m, 'GENERIC_TOKENS literal not found in worker/src/marketing/pipeline.ts').not.toBeNull();
    const workerTokens = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]);
    // a broken extraction must fail, not pass on an empty list
    expect(workerTokens.length).toBeGreaterThan(50);
    expect(workerTokens.filter((t) => !GENERIC_TOKENS.has(t))).toEqual([]);
  });
});

// Names from the worker's own projectNameVariants / rule-3 comments. Once the
// generic words left the anchors, these names had no anchor left (or only one
// from the English alternate, which an Arabic quote cannot hit), and the old
// fallback demanded the raw nameAr verbatim — parenthesis and « - شقق» included.
// Every case below passed before C and was rejected right after it.
describe('C — a name made of brand + generic words is still provable', () => {
  const village = { projectId: P1, nameAr: 'الماجدية فيلج (Al Majdiah Village)', confidence: 0.9, matchedAliases: ['al majdiah village'], strength: 'full_name' };
  const yamam = { projectId: P1, nameAr: 'أدوار - يمام 9', confidence: 0.85, matchedAliases: ['يمام 9'], strength: 'number' };
  it('accepts the parenthesised English name «Al Majdiah Village»', () => {
    const ev = { caption: 'Welcome to Al Majdiah Village — a new way of living', transcript: '', ocr_text: '', brand_tokens: ['الماجدية', 'majdiah', 'almajdiah'] };
    expect(attributionRejection('Welcome to Al Majdiah Village', village, ev)).toBeNull();
  });
  it('accepts «الماجدية فيلج» in Arabic when the only anchor left is the English «majdiah»', () => {
    const ev = { caption: 'تحديثات مشروع الماجدية فيلج لهذا الشهر', transcript: '', ocr_text: '', brand_tokens: ['الماجدية', 'almajdiah'] };
    expect(attributionRejection('تحديثات مشروع الماجدية فيلج', village, ev)).toBeNull();
  });
  it('accepts «سديم تاون» for «سديم تاون - شقق»', () => {
    const cand = { projectId: P1, nameAr: 'سديم تاون - شقق', confidence: 0.9, matchedAliases: ['سديم تاون'], strength: 'full_name' };
    const ev = { caption: 'تحديثات مشروع سديم تاون', transcript: '', ocr_text: '', brand_tokens: ['سديم', 'العقارية', 'sadeem'] };
    expect(attributionRejection('تحديثات مشروع سديم تاون', cand, ev)).toBeNull();
  });
  it('accepts «يمام 9» for «أدوار - يمام 9», and the matcher alias rescues an empty quote', () => {
    const ev = { post_id: POST, caption: 'أدوار يمام 9 جاهزة للسكن', transcript: '', ocr_text: '', brand_tokens: ['يمام'], candidates: [yamam] };
    expect(attributionRejection('أدوار يمام 9 جاهزة', yamam, ev)).toBeNull();
    const { valid } = validateEnrichmentResults([pick(POST, '')], [ev]);
    expect(valid[0].primaryProjectId).toBe(P1);
    expect(valid[0].evidenceQuote).toBe('يمام 9');
    expect(valid[0].result.evidence_quote_source).toBe('matcher');
  });
  it('the brand alone still does not name the project', () => {
    const ev = { caption: 'Welcome to Al Majdiah — a new way of living', transcript: '', ocr_text: '', brand_tokens: ['الماجدية', 'majdiah', 'almajdiah'] };
    expect(attributionRejection('Welcome to Al Majdiah', village, ev)).toBe('quote carries only the brand word');
  });
  it('a whole-name phrase made only of brand words is not proof', () => {
    // a project whose English name was entered as the developer's brand
    const cand = { projectId: P1, nameAr: 'ريفييرا المربع', nameEn: 'Alajlan Riviera', confidence: 0.9, matchedAliases: ['ريفييرا المربع'], strength: 'full_name' };
    const ev = { caption: 'Alajlan Riviera — quality you can trust', transcript: '', ocr_text: '', brand_tokens: ['العجلان', 'ريفييرا', 'alajlan', 'riviera'] };
    expect(attributionRejection('Alajlan Riviera — quality', cand, ev)).toMatch(/does not name the project \(0\/1/);
  });
  it('a whole-name phrase must end where the name ends («يمام 99» is not «يمام 9»)', () => {
    const ev = { caption: 'أدوار يمام 99 جاهزة للسكن', transcript: '', ocr_text: '', brand_tokens: ['يمام'] };
    expect(attributionRejection('أدوار يمام 99 جاهزة', yamam, ev)).toBe('quote carries only the brand word');
  });
});

describe('D — a strong matcher hit survives a bad model quote', () => {
  it('an EMPTY quote on a number candidate is accepted via the matcher alias', () => {
    const { valid } = validateEnrichmentResults([pick(MAKEEN_POST, '')], [makeen]);
    expect(valid[0].primaryProjectId).toBe(P1);
    expect(valid[0].evidenceQuote).toBe('مكين 63');
    expect(valid[0].result.evidence_quote).toBe('مكين 63');
    expect(valid[0].result.evidence_quote_source).toBe('matcher');
    expect(valid[0].result.model_quote_rejected).toBe('no evidence_quote');
    expect(valid[0].result.attribution_rejected).toBeUndefined();
  });
  it('the same on a WORD candidate is still rejected', () => {
    const { valid } = validateEnrichmentResults([pick(SAMAWA_POST, '')], [samawa]);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].evidenceQuote).toBe('');
    expect(valid[0].result.attribution_rejected).toBe('no evidence_quote');
    expect(valid[0].result.evidence_quote_source).toBeUndefined();
  });
  it('a pick the model did NOT make (index -1) is never upgraded', () => {
    const { valid } = validateEnrichmentResults([pick(MAKEEN_POST, 'مكين 63حي العارض', { primary_project_index: -1 })], [makeen]);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].evidenceQuote).toBe('');
    expect(valid[0].result.evidence_quote_source).toBeUndefined();
    expect(valid[0].result.attribution_rejected).toBeUndefined();
  });
  it('a brand-only quote is still rejected when the alias is not in the evidence', () => {
    expect(attributionRejection('مكين MAKEEN', makeenCand, makeen)).toMatch(/does not name the project \(0\/1/);
    // a stale candidate: the evidence now carries only the brand
    const ev = { ...makeen, caption: 'مكين MAKEEN ينتظرك', ocr_text: '' };
    const { valid } = validateEnrichmentResults([pick(MAKEEN_POST, 'مكين MAKEEN ينتظرك')], [ev]);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].result.attribution_rejected).toMatch(/does not name the project/);
    expect(valid[0].result.evidence_quote_source).toBeUndefined();
  });
  it('an alias shorter than 6 characters is still a proof («174»)', () => {
    // the ≥6 minimum is for quotes the MODEL writes; a matcher alias is exact
    const ev = { post_id: POST, caption: 'تملك في 174 الآن', transcript: '', ocr_text: '', brand_tokens: ['ريفييرا'],
      candidates: [{ projectId: P1, nameAr: 'ريفييرا 174', confidence: 0.85, matchedAliases: ['174'], strength: 'number' }] };
    const { valid } = validateEnrichmentResults([pick(POST, '')], [ev]);
    expect(valid[0].primaryProjectId).toBe(P1);
    expect(valid[0].evidenceQuote).toBe('174');
    expect(valid[0].result.evidence_quote_source).toBe('matcher');
    expect(valid[0].result.attribution_rejected).toBeUndefined();
  });
  it('never upgrades a pick whose own quote names a DIFFERENT candidate (mis-indexed)', () => {
    // the model quoted P1 («ريفييرا المربع») under P2's index; both are in the post
    const { valid } = validateEnrichmentResults([pick(POST, 'عن مشروع ريفييرا المربع', { primary_project_index: 1 })], evidence);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].evidenceQuote).toBe('');
    expect(valid[0].result.evidence_quote_source).toBeUndefined();
    expect(valid[0].result.attribution_rejected).toMatch(/does not name the project.*the quote names candidate\[0\] instead/);
    // neither is auto-accepted; both stay as review candidates
    expect(valid[0].secondary.map((s) => s.projectId).sort()).toEqual([P1, P2].sort());
  });
  it('an alias found only inside a longer number is not proof', () => {
    const ev = { post_id: POST, caption: 'ريفييرا 1745 تملّك الآن', transcript: '', ocr_text: '', brand_tokens: ['ريفييرا'],
      candidates: [{ projectId: P1, nameAr: 'ريفييرا 174', confidence: 0.85, matchedAliases: ['174'], strength: 'number' }] };
    const { valid } = validateEnrichmentResults([pick(POST, '')], [ev]);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].result.attribution_rejected).toBe('no evidence_quote');
  });
  it('an alias that is only the brand word does not pass the anchor rule', () => {
    const ev = { post_id: POST, caption: 'في عزوم نوفرلك كل شيء في مكان واحد', transcript: '', ocr_text: '', brand_tokens: ['عزوم'],
      candidates: [{ projectId: P1, nameAr: 'عزوم النرجس', confidence: 0.9, matchedAliases: ['عزوم'], strength: 'full_name' }] };
    const { valid } = validateEnrichmentResults([pick(POST, '')], [ev]);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].result.evidence_quote_source).toBeUndefined();
  });
});

describe('E — a post with no evidence gets no label', () => {
  const STR = ['content_type', 'objective', 'offer', 'financing', 'payment_plan', 'price', 'location', 'district', 'campaign_message'];
  const ARR = ['unit_types', 'amenities', 'selling_points', 'ctas'];
  const EMPTY_POST = 'aaaaaaaa-0000-0000-0000-000000000004';
  const empty = { post_id: EMPTY_POST, caption: '', transcript: '', ocr_text: ' \n ', brand_tokens: ['مكين'], candidates: [] };
  const guess = {
    post_id: EMPTY_POST, primary_project_index: -1, is_general_branding: true, language: 'ar',
    content_type: 'brand', objective: 'awareness', campaign_message: 'مكين', unit_types: ['شقق'], ctas: ['تواصل'], mentioned_projects: ['مكين 63'],
  };
  it('the image post stored as confident «brand» is neutralised', () => {
    const { valid, errors } = validateEnrichmentResults([guess], [empty]);
    expect(errors).toEqual([]);
    const r = valid[0].result;
    expect(valid[0].primaryProjectId).toBeNull();
    expect(r.no_evidence).toBe(true);
    expect(r.content_type).toBe('');
    expect(r.is_general_branding).toBe(false);
    expect(r.language).toBe('none');
    expect(r.evidence_quote).toBe('');
    expect(r.mentioned_projects).toEqual([]);
    for (const f of STR) expect(r[f]).toBe('');
    for (const f of ARR) expect(r[f]).toEqual([]);
  });
  it('a pick on a stale candidate is refused and no secondary is written', () => {
    const ev = { ...empty, candidates: [makeenCand, { ...makeenCand, projectId: P2 }] };
    const { valid } = validateEnrichmentResults([{ ...guess, primary_project_index: 0, evidence_quote: 'مكين 63حي العارض' }], [ev]);
    expect(valid[0].primaryProjectId).toBeNull();
    expect(valid[0].result.attribution_rejected).toMatch(/no evidence/);
    expect(valid[0].secondary).toEqual([]);
    expect(valid[0].result.no_evidence).toBe(true);
  });
  it('a post WITH evidence is never flagged', () => {
    const { valid } = validateEnrichmentResults([pick(MAKEEN_POST, 'مكين 63حي العارض', { content_type: 'offer' })], [makeen]);
    expect(valid[0].result.no_evidence).toBeUndefined();
    expect(valid[0].result.content_type).toBe('offer');
  });
});

describe('isSubscriptionLimit', () => {
  it('detects Claude usage/rate-limit phrasings', () => {
    expect(isSubscriptionLimit('You have reached your usage limit for the 5-hour window')).toBe(true);
    expect(isSubscriptionLimit('rate limit exceeded, please try again later')).toBe(true);
    expect(isSubscriptionLimit('normal completion, wrote result.json')).toBe(false);
  });
});
