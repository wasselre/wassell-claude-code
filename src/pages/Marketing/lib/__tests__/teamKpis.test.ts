import { describe, it, expect } from 'vitest';
import {
  dayLevel, dayTitle, fullDays, hoursLabel, onTimeRate, personName, rateTone, sortPeople,
} from '../teamKpis';
import type { TeamKpiDay, TeamKpiPerson } from '@/lib/marketingOS/client';

/**
 * «مهامي» › «الفريق» (2026-09-27). The server counts; these helpers only turn
 * the counts into what the page shows. The numbers below are September's real
 * figures on the day the tab was built.
 */

const day = (over: Partial<TeamKpiDay> = {}): TeamKpiDay => ({
  day: '2026-09-28', off: false, leave: false, loads: [], ...over,
});

const person = (over: Partial<TeamKpiPerson>): TeamKpiPerson => ({
  user_id: 'u-0000000000', name_ar: null, name_en: null, roles: [],
  open_now: 0, late_now: 0, blocked_now: 0, due_today: 0,
  done: 0, done_late: 0, done_no_deadline: 0, median_hours: null,
  strikes: 0, booked_items: 0, booked_units: 0, days: [],
  ...over,
});

describe('on-time rate', () => {
  it('is on-time ÷ finished-with-a-deadline — September: 22 finished, 10 late → 55%', () => {
    expect(onTimeRate({ done: 22, done_late: 10, done_no_deadline: 0 })).toBeCloseTo(54.55, 1);
  });

  it('leaves tasks without a deadline out of both sides', () => {
    // 10 finished, 2 had no deadline, 2 late → 6 of 8 = 75%
    expect(onTimeRate({ done: 10, done_late: 2, done_no_deadline: 2 })).toBe(75);
  });

  it('is null — never 0% or 100% — when nothing with a deadline was finished', () => {
    expect(onTimeRate({ done: 0, done_late: 0, done_no_deadline: 0 })).toBeNull();
    expect(onTimeRate({ done: 3, done_late: 0, done_no_deadline: 3 })).toBeNull();
  });

  it('bands: 75+ good, 50+ fair, below poor', () => {
    expect(rateTone(80)).toBe('good');
    expect(rateTone(75)).toBe('good');
    expect(rateTone(54.5)).toBe('fair');
    expect(rateTone(49.9)).toBe('poor');
  });
});

describe('how full a day is', () => {
  it('reads an unbooked day as off, leave or empty', () => {
    expect(dayLevel(day({ off: true, loads: [{ bucket: 'post', units: 0, capacity: 7 }] }))).toBe('off');
    expect(dayLevel(day({ leave: true }))).toBe('leave');
    expect(dayLevel(day({ loads: [{ bucket: 'post', units: 0, capacity: 7 }] }))).toBe('empty');
  });

  it('grades a working day against the daily limit — سارة at 7 of 7 is full', () => {
    expect(dayLevel(day({ loads: [{ bucket: 'post', units: 7, capacity: 7 }] }))).toBe('full');
    expect(dayLevel(day({ loads: [{ bucket: 'post', units: 5, capacity: 7 }] }))).toBe('busy');
    expect(dayLevel(day({ loads: [{ bucket: 'post', units: 2, capacity: 7 }] }))).toBe('light');
    expect(dayLevel(day({ loads: [{ bucket: 'post', units: 8, capacity: 7 }] }))).toBe('over');
  });

  it('lets the fuller of two buckets decide — a writer who also checks designs', () => {
    const d = day({
      loads: [
        { bucket: 'approvals', units: 3, capacity: 20 },
        { bucket: 'post', units: 10, capacity: 10 },
      ],
    });
    expect(dayLevel(d)).toBe('full');
  });

  it('calls anything booked on a day off, on leave, or with no limit at all "over"', () => {
    expect(dayLevel(day({ off: true, loads: [{ bucket: 'post', units: 1, capacity: 7 }] }))).toBe('over');
    expect(dayLevel(day({ leave: true, loads: [{ bucket: 'post', units: 1, capacity: 7 }] }))).toBe('over');
    expect(dayLevel(day({ loads: [{ bucket: 'video', units: 1, capacity: 0 }] }))).toBe('over');
  });

  it('counts the full and over days of a strip', () => {
    const strip = [
      day({ loads: [{ bucket: 'post', units: 7, capacity: 7 }] }),
      day({ loads: [{ bucket: 'post', units: 9, capacity: 7 }] }),
      day({ off: true }),
      day({ loads: [{ bucket: 'post', units: 7, capacity: 7 }] }),
    ];
    expect(fullDays(strip)).toEqual({ full: 2, over: 1 });
  });

  it('says what is booked, in words, on hover', () => {
    const d = day({ loads: [{ bucket: 'post', units: 7, capacity: 7 }, { bucket: 'approvals', units: 0, capacity: 20 }] });
    expect(dayTitle(d, false)).toBe('Mon Sep 28 — Production 7 of 7');
    expect(dayTitle(day({ off: true }), false)).toBe('Mon Sep 28 — Day off');
    expect(dayTitle(day(), false)).toBe('Mon Sep 28 — Nothing booked');
    expect(dayTitle(d, true)).toBe('الاثنين ٢٨ سبتمبر — إنتاج ٧ من ٧');
  });
});

describe('who is listed first', () => {
  it('puts late work first, then open work, then the most booked, then the most finished', () => {
    const maryam = person({ user_id: 'u-maryam', name_ar: 'مريم', open_now: 2, booked_units: 249, done: 106 });
    const sara = person({ user_id: 'u-sara', name_ar: 'سارة', open_now: 12, late_now: 1, booked_units: 134, done: 22 });
    const hussam = person({ user_id: 'u-hussam', name_ar: 'حسام', booked_units: 258, done: 26 });
    const rayan = person({ user_id: 'u-rayan', name_ar: 'ريان', done: 13 });
    expect(sortPeople([rayan, hussam, maryam, sara], true).map((p) => p.user_id))
      .toEqual(['u-sara', 'u-maryam', 'u-hussam', 'u-rayan']);
  });

  it('never loses a person without a name', () => {
    expect(personName(person({ user_id: 'abcdef123456' }), true)).toBe('abcdef12');
    expect(personName(person({ name_ar: 'سارة', name_en: null }), false)).toBe('سارة');
  });
});

describe('time to finish', () => {
  it('prints hours with the Arabic decimal comma, and a dash when there is nothing to measure', () => {
    expect(hoursLabel(8.44, true)).toBe('٨٫٤ س');
    expect(hoursLabel(8.44, false)).toBe('8.4 h');
    expect(hoursLabel(null, true)).toBe('—');
  });
});
