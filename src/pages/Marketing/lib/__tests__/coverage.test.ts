import { describe, it, expect } from 'vitest';
import {
  computeDemand, placementCounts, computeCoverage, periodWindow,
  type TargetLite, type CapacityRow,
} from '../coverage';
import type { PerfCalendarData } from '@/lib/marketingOS/client';

/**
 * The correct model:
 *   • Distribution demand = every required platform placement (Σ platforms).
 *   • Production demand    = unique creatives (MAX across platforms — the same
 *                            video is reused on every platform + paid ads).
 *
 * Cadence: Instagram 2 video + 1 static/day, TikTok 3 video/day. Same videos
 * reused. Publishing 7 days/week, production across 6 working days.
 */
const CADENCE: TargetLite[] = [
  { platform: 'instagram', bucket: 'video', per_day: 2, weekday: null, active: true },
  { platform: 'instagram', bucket: 'post', per_day: 1, weekday: null, active: true },
  { platform: 'tiktok', bucket: 'video', per_day: 3, weekday: null, active: true },
];

const CAP_4: CapacityRow[] = [
  { role_key: 'writer', bucket: 'video', per_day: 4 },
  { role_key: 'montage', bucket: 'video', per_day: 4 },
  { role_key: 'writer', bucket: 'post', per_day: 10 },
  { role_key: 'montage', bucket: 'post', per_day: 4 },
];

const line = (rows: ReturnType<typeof computeDemand>, bucket: 'post' | 'video') =>
  rows.find((r) => r.bucket === bucket)!;

describe('placement vs production counting', () => {
  it('counts one reused creative ONCE in production but MANY times in distribution', () => {
    // One video (content A) published to BOTH Instagram and TikTok.
    const pubs = [
      { content_id: 'A', bucket: 'video' as const, status: 'published' },
      { content_id: 'A', bucket: 'video' as const, status: 'published' },
    ];
    const c = placementCounts(pubs, 'video');
    expect(c.placements).toBe(2); // distribution: two placements
    expect(c.unique).toBe(1);     // production: one creative
  });

  it('a genuinely new content_id raises unique production; a reuse does not', () => {
    const reuseOnly = placementCounts([
      { content_id: 'A', bucket: 'video' as const },
      { content_id: 'A', bucket: 'video' as const }, // reused (e.g. a paid placement)
      { content_id: 'A', bucket: 'video' as const }, // reused again
    ], 'video');
    expect(reuseOnly).toEqual({ placements: 3, unique: 1 });

    const withNew = placementCounts([
      { content_id: 'A', bucket: 'video' as const },
      { content_id: 'A', bucket: 'video' as const },
      { content_id: 'B', bucket: 'video' as const }, // a genuinely new creative
    ], 'video');
    expect(withNew).toEqual({ placements: 3, unique: 2 });
  });

  it('respects the status filter and the bucket', () => {
    const pubs = [
      { content_id: 'A', bucket: 'video' as const, status: 'published' },
      { content_id: 'B', bucket: 'video' as const, status: 'scheduled' },
      { content_id: 'C', bucket: 'post' as const, status: 'published' },
    ];
    expect(placementCounts(pubs, 'video', ['published'])).toEqual({ placements: 1, unique: 1 });
    expect(placementCounts(pubs, 'video', ['scheduled'])).toEqual({ placements: 1, unique: 1 });
    expect(placementCounts(pubs, 'post', ['published'])).toEqual({ placements: 1, unique: 1 });
  });
});

describe('distribution demand vs production demand', () => {
  const d = computeDemand(CADENCE, CAP_4, 6);

  it('distribution SUMS placements across platforms', () => {
    expect(line(d, 'video').distributionPerDay).toBe(5);   // 2 IG + 3 TikTok
    expect(line(d, 'video').distributionPerWeek).toBe(35);  // 5 × 7 publishing days
    expect(line(d, 'post').distributionPerDay).toBe(1);
    expect(line(d, 'post').distributionPerWeek).toBe(7);
  });

  it('production takes the MAX (reuse) — unique creatives only', () => {
    expect(line(d, 'video').productionPerDay).toBe(3);      // max(2, 3)
    expect(line(d, 'video').productionPerWeek).toBe(21);    // 3 × 7
    expect(line(d, 'post').productionPerDay).toBe(1);
    expect(line(d, 'post').productionPerWeek).toBe(7);
  });

  it('working-day average spreads weekly production over 6 working days', () => {
    expect(line(d, 'video').productionWorkingDayAvg).toBeCloseTo(3.5, 5); // 21 / 6
    expect(line(d, 'post').productionWorkingDayAvg).toBeCloseTo(7 / 6, 5); // 1.17
  });

  it('adding more reuse platforms raises distribution but NOT production', () => {
    const more: TargetLite[] = [
      ...CADENCE,
      { platform: 'snapchat', bucket: 'video', per_day: 3, weekday: null, active: true },
      { platform: 'x', bucket: 'video', per_day: 3, weekday: null, active: true },
    ];
    const dm = computeDemand(more, CAP_4, 6);
    expect(line(dm, 'video').distributionPerDay).toBe(11); // 2+3+3+3
    expect(line(dm, 'video').productionPerDay).toBe(3);    // still max = 3 (reused)
    expect(line(dm, 'video').productionPerWeek).toBe(21);
  });
});

describe('production capacity is compared to production, not distribution', () => {
  it('4/working-day for both roles → 24/week ≥ 21 required → NO gap', () => {
    const d = line(computeDemand(CADENCE, CAP_4, 6), 'video');
    expect(d.capacityPerWorkingDay).toBe(4);  // bottleneck = min(writer 4, montage 4)
    expect(d.capacityPerWeek).toBe(24);        // 4 × 6
    expect(d.productionPerWeek).toBe(21);
    expect(d.short).toBe(false);
    expect(d.productionGapPerWeek).toBe(0);
  });

  it('the OLD capacity (2/working-day bottleneck) WOULD be short', () => {
    const cap2: CapacityRow[] = [
      { role_key: 'writer', bucket: 'video', per_day: 3 },
      { role_key: 'montage', bucket: 'video', per_day: 2 },
    ];
    const d = line(computeDemand(CADENCE, cap2, 6), 'video');
    expect(d.capacityPerWorkingDay).toBe(2);   // slowest stage
    expect(d.capacityPerWeek).toBe(12);         // 2 × 6
    expect(d.short).toBe(true);
    expect(d.productionGapPerWeek).toBe(9);     // 21 − 12
  });

  it('the bottleneck is the SLOWEST stage, never the sum of stages', () => {
    const d = line(computeDemand(CADENCE, CAP_4, 6), 'video');
    // writer 4 + montage 4 would be 8 (wrong); the model uses min = 4.
    expect(d.capacityPerWorkingDay).toBe(4);
    expect(d.bottleneckRole === 'writer' || d.bottleneckRole === 'montage').toBe(true);
  });
});

describe('computeCoverage integration — actual once-produced / many-placed', () => {
  it('reports 1 unique produced but N placements published', () => {
    const data: PerfCalendarData = {
      month: '2026-08', from: '2026-08-23', to: '2026-08-29',
      targets: CADENCE as PerfCalendarData['targets'],
      publications: [
        { id: 'p1', content_id: 'A', platform: 'instagram', status: 'published', scheduled_at: null, published_at: '2026-08-24T09:00:00Z', bucket: 'video' },
        { id: 'p2', content_id: 'A', platform: 'tiktok', status: 'published', scheduled_at: null, published_at: '2026-08-24T09:00:00Z', bucket: 'video' },
      ],
      intents: [],
      capacity: CAP_4,
      production_days_per_week: 6,
    };
    const cov = computeCoverage(data, periodWindow('week', new Date('2026-08-26T12:00:00')), new Date('2026-08-29T12:00:00'));
    const vid = cov.actual.find((a) => a.bucket === 'video')!;
    expect(vid.distributionPublished).toBe(2); // two placements
    expect(vid.productionPublished).toBe(1);   // one creative
    // and the demand summary is present + correct
    expect(cov.demand.find((d) => d.bucket === 'video')!.productionPerWeek).toBe(21);
  });
});
