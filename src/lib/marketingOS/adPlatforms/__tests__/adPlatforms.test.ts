/**
 * The ad-platform schema library — the rules the real Ads Managers enforce,
 * encoded as data. These tests pin the two dependency behaviors (goal
 * filtering by objective, TikTok's goal → billing table) and the summary /
 * progress helpers the UI leans on.
 */
import { describe, expect, it } from 'vitest';
import {
  autoFillAfterChange, defaultPlatformSettings, fieldOptions, fieldVisible,
  getPlatformSchema, metaSchema, objectiveKeyOf, settingsProgress,
  settingsSummary, tiktokSchema,
} from '..';

describe('schema registry', () => {
  it('serves structured platforms and declines the rest', () => {
    expect(getPlatformSchema('meta')?.platform).toBe('meta');
    expect(getPlatformSchema('instagram')?.platform).toBe('meta'); // IG = Meta placements
    expect(getPlatformSchema('snapchat')?.platform).toBe('snapchat');
    expect(getPlatformSchema('tiktok')?.platform).toBe('tiktok');
    expect(getPlatformSchema('google')).toBeNull();
    expect(getPlatformSchema('x')).toBeNull();
    expect(getPlatformSchema('youtube')).toBeNull();
  });

  it('objective key follows each platform dialect', () => {
    expect(objectiveKeyOf(metaSchema)).toBe('objective');
    expect(objectiveKeyOf(tiktokSchema)).toBe('objective_type');
    const snap = getPlatformSchema('snapchat');
    expect(snap && objectiveKeyOf(snap)).toBe('objective_v2_type');
  });

  it('instagram defaults pin placements to Instagram', () => {
    const d = defaultPlatformSettings('instagram');
    expect(d.placement_mode).toBe('MANUAL');
    expect(d.publisher_platforms).toEqual(['instagram']);
  });
});

describe('Meta objective → goal matrix', () => {
  const goalField = metaSchema.sections
    .flatMap((s) => s.fields)
    .find((f) => f.key === 'optimization_goal');
  if (!goalField) throw new Error('meta schema lost its optimization_goal field');

  it('leads objective offers lead goals, not video views', () => {
    const opts = fieldOptions(metaSchema, goalField, { objective: 'OUTCOME_LEADS' })
      .map((o) => o.value);
    expect(opts).toContain('LEAD_GENERATION');
    expect(opts).toContain('OFFSITE_CONVERSIONS');
    expect(opts).not.toContain('THRUPLAY');
    expect(opts).not.toContain('APP_INSTALLS');
  });

  it('no objective yet → the full list (nothing hidden by surprise)', () => {
    const opts = fieldOptions(metaSchema, goalField, {});
    expect(opts.length).toBe(goalField.options?.length);
  });

  it('changing the objective clears a goal the matrix no longer allows', () => {
    const patch = autoFillAfterChange(metaSchema, 'objective', {
      objective: 'OUTCOME_AWARENESS',
      optimization_goal: 'LEAD_GENERATION',
    });
    expect(patch.optimization_goal).toBeNull();
  });
});

describe('TikTok goal → billing table', () => {
  it.each([
    ['CLICK', 'CPC'],
    ['REACH', 'CPM'],
    ['ENGAGED_VIEW', 'CPV'],
    ['LEAD_GENERATION', 'OCPM'],
    ['CONVERT', 'OCPM'],
  ])('%s bills as %s', (goal, billing) => {
    const patch = autoFillAfterChange(tiktokSchema, 'optimization_goal', {
      optimization_goal: goal,
    });
    expect(patch.billing_event).toBe(billing);
  });
});

describe('conditional visibility', () => {
  const bidPrice = tiktokSchema.sections
    .flatMap((s) => s.fields)
    .find((f) => f.key === 'bid_price');
  if (!bidPrice) throw new Error('tiktok schema lost bid_price');

  it('bid price shows only under a custom bid', () => {
    expect(fieldVisible(bidPrice, { bid_type: 'BID_TYPE_CUSTOM' })).toBe(true);
    expect(fieldVisible(bidPrice, { bid_type: 'BID_TYPE_NO_BID' })).toBe(false);
    expect(fieldVisible(bidPrice, {})).toBe(false);
  });
});

describe('summary + progress', () => {
  it('summarizes objective, goal, budget and geo bilingually', () => {
    const parts = settingsSummary('tiktok', {
      objective_type: 'LEAD_GENERATION',
      optimization_goal: 'LEAD_GENERATION',
      budget_mode: 'BUDGET_MODE_DAY',
      budget: 500,
      location_ids: ['الرياض'],
    }, false);
    expect(parts[0]).toBe('Lead generation');
    expect(parts).toContain('Lead forms');
    expect(parts.some((p) => p.includes('500') && p.includes('/day'))).toBe(true);
    expect(parts).toContain('الرياض');
  });

  it('empty settings summarize to nothing, and unstructured platforms too', () => {
    expect(settingsSummary('tiktok', {}, true)).toEqual([]);
    expect(settingsSummary('google', { anything: 'x' }, true)).toEqual([]);
  });

  it('progress counts only visible fields', () => {
    const p1 = settingsProgress(tiktokSchema, {});
    const p2 = settingsProgress(tiktokSchema, { bid_type: 'BID_TYPE_CUSTOM' });
    // Turning on a custom bid reveals bid_price + conversion_bid_price.
    expect(p2.total).toBe(p1.total + 2);
    expect(p2.set).toBe(p1.set + 1);
  });
});
