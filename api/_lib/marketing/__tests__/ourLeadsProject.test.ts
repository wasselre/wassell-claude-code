import { describe, it, expect } from 'vitest';
import { bucketProjectLeads, type InferredLead, type OurLead } from '../ourLeads.js';

/**
 * Leads per project, including leads WhatsApp sent without an ad ID
 * (2026-09-28). Such a lead counts for its campaign's project and is reported
 * again in `inferredLeads` — it never reaches an ad.
 */
const RIYA_CAMPAIGN = 'camp-riya';
const RIYA_PROJECT = 'proj-riya';
const RIYA_EXEC = 'exec-riya';

const lookups = {
  execOfAd: new Map([['ad-471-story', RIYA_EXEC], ['ad-472-feed', RIYA_EXEC]]),
  campaignOfExec: new Map<string, string | null>([[RIYA_EXEC, RIYA_CAMPAIGN], ['exec-orphan', 'camp-orphan']]),
  projectOfCampaign: new Map<string, string | null>([[RIYA_CAMPAIGN, RIYA_PROJECT], ['camp-orphan', null]]),
};

const tagged = (adRowId: string, conversationKey: string, day = '2026-09-28'): OurLead => ({
  adRowId, conversationKey, day, at: `${day}T13:19:15.000Z`, platformAdId: null,
});
const inferred = (conversationKey: string, over: Partial<InferredLead> = {}): InferredLead => ({
  conversationKey, day: '2026-09-28', at: '2026-09-28T16:08:18.000Z',
  campaignId: RIYA_CAMPAIGN, executionId: RIYA_EXEC, ...over,
});

describe('leads per project with leads that came without an ad ID', () => {
  it('counts the 16:08 lead for ريا النخيل beside the tagged ones, and says it was inferred', () => {
    const totals = bucketProjectLeads(
      [tagged('ad-471-story', '966554446109@c.us'), tagged('ad-472-feed', '966555288053@c.us')],
      [inferred('966500700283@c.us')],
      lookups,
    );
    expect(totals).toEqual([{
      projectId: RIYA_PROJECT, campaignId: RIYA_CAMPAIGN, leads: 3, inferredLeads: 1,
      adRowIds: ['ad-471-story', 'ad-472-feed'],
    }]);
  });

  it('counts a conversation with a tagged AND an inferred message once, as tagged', () => {
    const totals = bucketProjectLeads(
      [tagged('ad-471-story', '201558374740@c.us')],
      [inferred('201558374740@c.us')],
      lookups,
    );
    expect(totals[0]).toMatchObject({ leads: 1, inferredLeads: 0 });
  });

  it('never names an ad for an inferred lead', () => {
    const totals = bucketProjectLeads([], [inferred('966500700283@c.us')], lookups);
    expect(totals).toEqual([{ projectId: RIYA_PROJECT, campaignId: RIYA_CAMPAIGN, leads: 1, inferredLeads: 1, adRowIds: [] }]);
  });

  it('reaches the campaign through the execution when only the execution is known', () => {
    const totals = bucketProjectLeads([], [inferred('c1', { campaignId: null })], lookups);
    expect(totals[0]).toMatchObject({ projectId: RIYA_PROJECT, campaignId: RIYA_CAMPAIGN, leads: 1 });
  });

  it('keeps a campaign with no project in the fail-loud bucket, never drops it', () => {
    const totals = bucketProjectLeads([], [inferred('c1', { campaignId: 'camp-orphan', executionId: 'exec-orphan' })], lookups);
    expect(totals).toEqual([{ projectId: null, campaignId: 'camp-orphan', leads: 1, inferredLeads: 1, adRowIds: [] }]);
  });

  it('applies the Riyadh-day window to inferred leads too', () => {
    const totals = bucketProjectLeads(
      [],
      [inferred('in-window'), inferred('too-early', { day: '2026-08-31' })],
      lookups,
      { since: '2026-09-01', until: '2026-09-30' },
    );
    expect(totals[0]).toMatchObject({ leads: 1, inferredLeads: 1 });
  });
});
