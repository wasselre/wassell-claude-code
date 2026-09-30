import { describe, it, expect } from 'vitest';
import { foldTimeline } from '../timeline';
import type { InterestTimelineEvent } from '@/types';

let running = 0;
const ev = (kind: string, points: number, o: Partial<InterestTimelineEvent> = {}): InterestTimelineEvent => {
  running += points;
  return {
    at: '2026-09-29T15:00:00Z', link_id: 'l1', focus: 'project', sent_via: 'agent', session_id: 's1',
    kind, section: 'photos', item: null, value: null, points, running, unit_label: null, ...o,
  };
};

describe('foldTimeline', () => {
  it('folds a stay into readable steps and keeps the points total', () => {
    running = 0;
    const events = [
      ev('sent', 0, { session_id: null, section: null }),
      ev('view', 10),
      ev('time', 0, { value: 15 }),
      ev('photo_open', 2, { item: 'p1' }),
      ev('time', 1, { value: 15 }),
      ev('photo_open', 2, { item: 'p2' }),
      ev('view', 0, { section: 'brochure' }),
      ev('time', 2, { section: 'brochure', value: 12 }),
      ev('brochure_page', 1, { section: 'brochure', item: '1' }),
      ev('brochure_page', 1, { section: 'brochure', item: '3' }),
      ev('map_open', 10, { section: 'location' }),
    ];
    const steps = foldTimeline(events);
    expect(steps.map((s) => s.kind)).toEqual(['sent', 'view', 'photo_open', 'view', 'brochure_page', 'map_open']);
    const photosStay = steps[1]!;
    expect(photosStay.value).toBe(30);   // seconds on the tab, folded into the open
    expect(photosStay.points).toBe(11);  // 10 for the open + 1 for the time
    expect(steps[2]!.count).toBe(2);
    expect(steps[2]!.points).toBe(4);
    expect(steps[3]!.value).toBe(12);    // brochure stay
    expect(steps[4]!.value).toBe(3);     // highest page reached
    // The steps add up to exactly what SQL scored.
    expect(steps.reduce((a, s) => a + s.points, 0)).toBe(running);
    expect(steps[steps.length - 1]!.running).toBe(running);
    // Running total never goes down in display order.
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.running).toBeGreaterThanOrEqual(steps[i - 1]!.running);
  });

  it('a second visit to the same tab starts new steps', () => {
    running = 0;
    const steps = foldTimeline([
      ev('view', 10), ev('time', 0, { value: 10 }),
      ev('view', 0), ev('time', 1, { value: 20 }),
    ]);
    expect(steps.map((s) => [s.kind, s.value])).toEqual([['view', 10], ['view', 20]]);
  });

  it('different visits never fold together', () => {
    running = 0;
    const steps = foldTimeline([ev('time', 0, { value: 10 }), ev('time', 0, { value: 10, session_id: 's2' })]);
    expect(steps).toHaveLength(2);
  });
});
