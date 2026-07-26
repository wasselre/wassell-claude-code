import { describe, it, expect } from 'vitest';
import { validateCampaignSummaries } from './mkt-campaign-summary-validate.mjs';

const EV = [
  {
    campaign_id: 'c1',
    member_count: 3, members_included: 3, members_omitted: 0, siblings_omitted: 0,
    members: [{ post_id: 'p1', ad_id: null }, { post_id: 'p2', ad_id: null }, { post_id: null, ad_id: 'a1' }],
  },
  {
    campaign_id: 'c2',
    member_count: 1, members_included: 1, members_omitted: 0, siblings_omitted: 0,
    members: [{ post_id: 'p9', ad_id: null }],
  },
];

const ok = (id, o = {}) => ({
  campaign_id: id, summary_ar: 'ملخص عربي', summary_en: 'English summary',
  confidence: 0.7, evidence_refs: [], messaging_themes: [], differentiators: [], caveats: [],
  ...o,
});

describe('validateCampaignSummaries — schema', () => {
  it('accepts a well-formed pair', () => {
    const { valid, errors } = validateCampaignSummaries([ok('c1'), ok('c2')], EV);
    expect(errors).toEqual([]);
    expect(valid.map((v) => v.campaignId)).toEqual(['c1', 'c2']);
  });

  it('rejects a non-array result', () => {
    expect(validateCampaignSummaries({ campaign_id: 'c1' }, EV).errors[0]).toMatch(/not a JSON array/);
  });

  it('rejects an unknown campaign_id', () => {
    const { errors } = validateCampaignSummaries([ok('c1'), ok('c2'), ok('nope')], EV);
    expect(errors.some((e) => /unknown\/missing campaign_id/.test(e))).toBe(true);
  });

  it('rejects a duplicate campaign_id', () => {
    const { errors } = validateCampaignSummaries([ok('c1'), ok('c1'), ok('c2')], EV);
    expect(errors.some((e) => /duplicate campaign_id: c1/.test(e))).toBe(true);
  });

  it('reports a campaign that was never answered', () => {
    const { errors } = validateCampaignSummaries([ok('c1')], EV);
    expect(errors).toContain('missing result for campaign c2');
  });

  it('requires both languages', () => {
    expect(validateCampaignSummaries([ok('c1', { summary_ar: '  ' }), ok('c2')], EV)
      .errors.some((e) => /summary_ar is empty/.test(e))).toBe(true);
    expect(validateCampaignSummaries([ok('c1', { summary_en: '' }), ok('c2')], EV)
      .errors.some((e) => /summary_en is empty/.test(e))).toBe(true);
  });

  it('rejects confidence that is not a number in [0,1]', () => {
    for (const bad of [1.4, -0.1, '0.5', null, NaN]) {
      const { errors } = validateCampaignSummaries([ok('c1', { confidence: bad }), ok('c2')], EV);
      expect(errors.some((e) => /confidence must be a number/.test(e))).toBe(true);
    }
  });
});

describe('validateCampaignSummaries — citations keep summaries falsifiable', () => {
  it('accepts refs that name real members (posts and ads)', () => {
    const { valid, errors } = validateCampaignSummaries(
      [ok('c1', { evidence_refs: ['p1', 'a1'] }), ok('c2')], EV);
    expect(errors).toEqual([]);
    expect(valid[0].evidenceRefs).toEqual(['p1', 'a1']);
  });

  it('rejects a ref that belongs to a DIFFERENT campaign in the same batch', () => {
    // the cross-contamination case: c1 citing c2's post
    const { errors } = validateCampaignSummaries([ok('c1', { evidence_refs: ['p9'] }), ok('c2')], EV);
    expect(errors.some((e) => /evidence_refs not in this campaign/.test(e))).toBe(true);
  });

  it('rejects an invented id', () => {
    const { errors } = validateCampaignSummaries([ok('c1', { evidence_refs: ['made-up'] }), ok('c2')], EV);
    expect(errors.some((e) => /evidence_refs not in this campaign/.test(e))).toBe(true);
  });
});

describe('validateCampaignSummaries — known limits are never silent', () => {
  it('forces an omitted-members caveat even when the Skill omitted it', () => {
    const ev = [{ ...EV[0], member_count: 50, members_included: 40, members_omitted: 10 }];
    const { valid } = validateCampaignSummaries([ok('c1', { caveats: [] })], ev);
    expect(valid[0].result.caveats.join(' ')).toMatch(/10 omitted/);
  });

  it('forces a partial-sibling caveat', () => {
    const ev = [{ ...EV[0], siblings_omitted: 12 }];
    const { valid } = validateCampaignSummaries([ok('c1')], ev);
    expect(valid[0].result.caveats.join(' ')).toMatch(/12 other campaigns omitted/);
  });

  it('does not duplicate a caveat the Skill already supplied', () => {
    const ev = [{ ...EV[0], siblings_omitted: 3 }];
    const { valid } = validateCampaignSummaries(
      [ok('c1', { caveats: ['compared against a partial sibling set (3 other campaigns omitted)'] })], ev);
    const hits = valid[0].result.caveats.filter((c) => /partial sibling set/.test(c));
    expect(hits).toHaveLength(1);
  });

  it('marks a one-member campaign as a single item even if the Skill says otherwise', () => {
    const { valid } = validateCampaignSummaries(
      [ok('c1'), ok('c2', { is_single_item: false })], EV);
    expect(valid.find((v) => v.campaignId === 'c2').result.is_single_item).toBe(true);
  });
});

describe('validateCampaignSummaries — coercion', () => {
  it('drops non-string array entries instead of storing them', () => {
    const { valid } = validateCampaignSummaries(
      [ok('c1', { messaging_themes: ['location', 42, null, 'luxury'] }), ok('c2')], EV);
    expect(valid[0].result.messaging_themes).toEqual(['location', 'luxury']);
  });

  it('ignores a comma-joined string where an array is required', () => {
    const { valid } = validateCampaignSummaries(
      [ok('c1', { differentiators: 'a,b,c' }), ok('c2')], EV);
    expect(valid[0].result.differentiators).toBeUndefined();
  });

  it('omits optional string fields that are absent rather than storing empties', () => {
    const { valid } = validateCampaignSummaries([ok('c1'), ok('c2')], EV);
    expect(valid[0].result.positioning).toBeUndefined();
    expect(valid[0].result.offer_summary).toBeUndefined();
  });
});
