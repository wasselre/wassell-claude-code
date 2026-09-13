import { describe, it, expect } from 'vitest';
import {
  PLACEMENTS_BY_VARIANT, buildAdSetPayload, buildAdSetTargeting, buildCampaignPayload, resolveObjective,
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

  it('targeting = the saved audience verbatim + Instagram-only placements per variant + unknown age excluded', () => {
    const feed = buildAdSetTargeting(SAVED, 'feed');
    // the saved audience's own geo / age / gender / Advantage+ flags survive
    expect(feed.geo_locations).toEqual(SAVED.geo_locations);
    expect(feed.age_min).toBe(18);
    expect(feed.genders).toEqual([0]);
    expect(feed.targeting_automation).toEqual({ advantage_audience: 1, individual_setting: { geo: 1 } });
    // house placements — Instagram only, never Facebook / Messenger / WhatsApp status
    expect(feed.publisher_platforms).toEqual(['instagram']);
    expect(feed.instagram_positions).toEqual(['stream', 'profile_feed']);
    expect(feed.whatsapp_positions).toBeUndefined();
    expect(feed.facebook_positions).toBeUndefined();
    expect(feed.device_platforms).toEqual(['mobile']);
    expect(feed.user_age_unknown).toBe(false);
    const story = buildAdSetTargeting(SAVED, 'story');
    expect(story.instagram_positions).toEqual(['story', 'reels']);
    expect(story.publisher_platforms).toEqual(['instagram']);
  });

  it('a saved audience that carries its own placements is overridden by the variant placements', () => {
    const t = buildAdSetTargeting({
      ...SAVED,
      publisher_platforms: ['facebook', 'instagram', 'audience_network'],
      facebook_positions: ['feed'],
      instagram_positions: ['stream'],
      device_platforms: ['mobile', 'desktop'],
    }, 'story');
    expect(t.publisher_platforms).toEqual(PLACEMENTS_BY_VARIANT.story.publisher_platforms);
    expect(t.facebook_positions).toBeUndefined();
    expect(t.instagram_positions).toEqual(PLACEMENTS_BY_VARIANT.story.instagram_positions);
    expect(t.device_platforms).toEqual(['mobile']);
  });

  it('refuses an empty audience spec — no broad-KSA fallback exists any more', () => {
    expect(() => buildAdSetTargeting({}, 'feed')).toThrow(/saved audience targeting is empty/);
  });

  it('ad set pair: PAUSED, Click-to-WhatsApp for leads, half the budget each, variant suffix + placements', () => {
    const feed = buildAdSetPayload(campaign, execution, { id: 's1', name: 'مجموعة 1' }, 'CAMP', 'PAGE', SAVED, 'feed');
    expect(feed.status).toBe('PAUSED');
    expect(feed.campaign_id).toBe('CAMP');
    expect(feed.optimization_goal).toBe('CONVERSATIONS');
    expect(feed.destination_type).toBe('WHATSAPP');
    expect(feed.promoted_object).toEqual({ page_id: 'PAGE' });
    expect(feed.daily_budget).toBe(5000); // 100 SAR planned → 50 SAR per half
    expect(feed.name).toBe('C-042 · ميتا · مجموعة 1 — فيد');
    const ft = feed.targeting as Record<string, unknown>;
    expect(ft.instagram_positions).toEqual(['stream', 'profile_feed']);
    expect((ft.geo_locations as { cities: unknown[] }).cities).toHaveLength(1);
    expect(ft.countries).toBeUndefined();
    const story = buildAdSetPayload(campaign, execution, { id: 's1', name: 'مجموعة 1' }, 'CAMP', 'PAGE', SAVED, 'story');
    expect(story.name).toBe('C-042 · ميتا · مجموعة 1 — ستوري');
    expect(story.daily_budget).toBe(5000);
    // a small plan never produces a half Meta refuses
    const tiny = buildAdSetPayload(campaign, { ...execution, budget: 10 }, { id: 's1', name: 'x' }, 'CAMP', 'PAGE', SAVED, 'feed');
    expect(tiny.daily_budget).toBe(2000);
    expect((story.targeting as Record<string, unknown>).instagram_positions).toEqual(['story', 'reels']);
    // a very long planned name is trimmed but the variant suffix survives (Meta 1487046)
    const long = buildAdSetPayload(campaign, execution, { id: 's1', name: 'x'.repeat(300) }, 'CAMP', 'PAGE', SAVED, 'story');
    expect(String(long.name).length).toBeLessThanOrEqual(200);
    expect(String(long.name).endsWith(' — ستوري')).toBe(true);
  });
});
