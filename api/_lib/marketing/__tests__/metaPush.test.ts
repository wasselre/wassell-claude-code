import { describe, it, expect } from 'vitest';
import {
  WASSEL_PLACEMENTS, buildAdSetPayload, buildAdSetTargeting, buildCampaignPayload, resolveObjective,
  type PushCampaign, type PushExecution,
} from '../metaPush';

const campaign: PushCampaign = { id: 'c1', ref: 'C-042', name: 'ربوة الرمز', objective: 'leads' };
const execution: PushExecution = {
  id: 'e1', label: 'ميتا', platform: 'meta', budget: 100, starts_on: null, ends_on: null,
  targeting: null, platform_settings: null,
};

/** The live Saved Audience «عام - ألرياض - 18+» exactly as Graph returned it
 *  on 2026-09-13 (id 120253259850460020). */
const SAVED = {
  age_max: 65, age_min: 18, age_range: [18, 65], genders: [0],
  geo_locations: {
    cities: [{ country: 'SA', distance_unit: 'mile', key: '2117479', name: 'Riyadh', radius: 35, region: 'Riyadh Region', region_id: '3205' }],
    location_types: ['home', 'recent'],
  },
  targeting_automation: { advantage_audience: 1, individual_setting: { geo: 1 } },
};

describe('metaPush — skeleton house rules (2026-09-13)', () => {
  it('objective: platform_settings wins, else the campaign objective, else leads', () => {
    expect(resolveObjective(campaign, null)).toBe('OUTCOME_LEADS');
    expect(resolveObjective({ ...campaign, objective: 'traffic' }, null)).toBe('OUTCOME_TRAFFIC');
    expect(resolveObjective(campaign, { objective: 'OUTCOME_SALES' })).toBe('OUTCOME_SALES');
    expect(resolveObjective({ ...campaign, objective: 'nonsense' }, null)).toBe('OUTCOME_LEADS');
  });

  it('campaign is PAUSED, auction, ad-set budgets by default (v21 flag)', () => {
    const p = buildCampaignPayload(campaign, execution);
    expect(p.status).toBe('PAUSED');
    expect(p.objective).toBe('OUTCOME_LEADS');
    expect(p.is_adset_budget_sharing_enabled).toBe(false);
    expect(p.name).toBe('C-042 · ميتا · ربوة الرمز');
  });

  it('targeting = the saved audience verbatim + Instagram/WhatsApp-only placements + unknown age excluded', () => {
    const t = buildAdSetTargeting(SAVED);
    // the saved audience's own geo / age / gender / Advantage+ flags survive
    expect(t.geo_locations).toEqual(SAVED.geo_locations);
    expect(t.age_min).toBe(18);
    expect(t.genders).toEqual([0]);
    expect(t.targeting_automation).toEqual({ advantage_audience: 1, individual_setting: { geo: 1 } });
    // house placements — never Facebook / Messenger / Audience Network / Threads
    expect(t.publisher_platforms).toEqual(['instagram', 'whatsapp']);
    expect(t.instagram_positions).toEqual(['stream', 'story', 'reels', 'profile_feed']);
    expect(t.whatsapp_positions).toEqual(['status']);
    expect(t.device_platforms).toEqual(['mobile']);
    expect(t.facebook_positions).toBeUndefined();
    expect(t.user_age_unknown).toBe(false);
  });

  it('a saved audience that carries its own placements is overridden by the house placements', () => {
    const t = buildAdSetTargeting({
      ...SAVED,
      publisher_platforms: ['facebook', 'instagram', 'audience_network'],
      facebook_positions: ['feed'],
      instagram_positions: ['stream'],
      device_platforms: ['mobile', 'desktop'],
    });
    expect(t.publisher_platforms).toEqual(WASSEL_PLACEMENTS.publisher_platforms);
    expect(t.facebook_positions).toBeUndefined();
    expect(t.instagram_positions).toEqual(WASSEL_PLACEMENTS.instagram_positions);
    expect(t.device_platforms).toEqual(['mobile']);
  });

  it('refuses an empty audience spec — no broad-KSA fallback exists any more', () => {
    expect(() => buildAdSetTargeting({})).toThrow(/saved audience targeting is empty/);
  });

  it('ad set: PAUSED, Click-to-WhatsApp for leads, budget in halalas, targeting from the saved audience', () => {
    const p = buildAdSetPayload(campaign, execution, { id: 's1', name: 'مجموعة 1' }, 'CAMP', 'PAGE', SAVED);
    expect(p.status).toBe('PAUSED');
    expect(p.campaign_id).toBe('CAMP');
    expect(p.optimization_goal).toBe('CONVERSATIONS');
    expect(p.destination_type).toBe('WHATSAPP');
    expect(p.promoted_object).toEqual({ page_id: 'PAGE' });
    expect(p.daily_budget).toBe(10000);
    const t = p.targeting as Record<string, unknown>;
    expect(t.publisher_platforms).toEqual(['instagram', 'whatsapp']);
    expect((t.geo_locations as { cities: unknown[] }).cities).toHaveLength(1);
    expect(t.countries).toBeUndefined();
  });
});
