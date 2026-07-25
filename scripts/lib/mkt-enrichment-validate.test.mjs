import { describe, it, expect } from 'vitest';
import { validateEnrichmentResults, isSubscriptionLimit } from './mkt-enrichment-validate.mjs';

const P1 = '6ff3010b-4252-4566-bc6f-db842bd99a48';
const P2 = '83a6a789-c022-4d6e-bef1-6d484fb1a4e0';
const POST = 'aaaaaaaa-0000-0000-0000-000000000001';
const evidence = [{
  post_id: POST,
  candidates: [{ projectId: P1, nameAr: 'ريفييرا المربع', confidence: 0.9, matchedAliases: ['المربع'] }, { projectId: P2, nameAr: 'ريفييرا 58', confidence: 0.82, matchedAliases: ['58'] }],
  deterministic_partial: false,
}];

describe('validateEnrichmentResults — schema + business rules', () => {
  it('accepts a valid result and resolves the project id from the candidate index', () => {
    const { valid, errors } = validateEnrichmentResults([{ post_id: POST, primary_project_index: 0, is_general_branding: false, language: 'ar', content_type: 'offer', offer: '27 of 78 sold' }], evidence);
    expect(errors).toEqual([]);
    expect(valid).toHaveLength(1);
    expect(valid[0].primaryProjectId).toBe(P1);
    expect(valid[0].result.content_type).toBe('offer');
    // candidate P2 has confidence 0.82 ≥ 0.8 → secondary attribution
    expect(valid[0].secondary.map((s) => s.projectId)).toContain(P2);
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
    const dup = [{ post_id: POST, primary_project_index: 0, is_general_branding: false, language: 'ar' }, { post_id: POST, primary_project_index: 1, is_general_branding: false, language: 'ar' }];
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

describe('isSubscriptionLimit', () => {
  it('detects Claude usage/rate-limit phrasings', () => {
    expect(isSubscriptionLimit('You have reached your usage limit for the 5-hour window')).toBe(true);
    expect(isSubscriptionLimit('rate limit exceeded, please try again later')).toBe(true);
    expect(isSubscriptionLimit('normal completion, wrote result.json')).toBe(false);
  });
});
