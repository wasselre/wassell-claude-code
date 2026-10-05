import { describe, it, expect } from 'vitest';
import {
  buildOfficeMessage, describeAsk, formatAmountAr, roomsText, variantFor, containsLink,
  MAX_MESSAGE_CHARS, MAX_PLACES,
} from '../message';

const facts = {
  unitTypes: ['فيلا'],
  places: ['المعذر', 'الرفيعة'],
  city: 'الرياض',
  budgetMax: 2_500_000,
  bedroomsMin: 4,
  notes: 'ملاحظة داخلية للمندوب',
};

// Ramroma, 2026-10-05: a floor «بنفس مساحة التاون هاوس» (291–297) in central Riyadh.
const ramroma = { unitTypes: ['دور'], places: ['وسط الرياض'], city: 'الرياض', areaMin: 291, areaMax: 297 };

describe('office outreach message', () => {
  it('describes the ask in one line for the app screens', () => {
    expect(describeAsk(facts)).toBe('فيلا في المعذر والرفيعة بالرياض، الميزانية حتى 2٫5 مليون، 4 غرف وأكثر');
  });

  it('formats amounts with the Arabic decimal comma and whole millions plain', () => {
    expect(formatAmountAr(2_500_000)).toBe('2٫5 مليون');
    expect(formatAmountAr(3_000_000)).toBe('3 مليون');
    expect(formatAmountAr(850_000)).toBe('850 ألف');
  });

  it('counts rooms the Arabic way', () => {
    expect(roomsText(1, 1)).toBe('غرفة');
    expect(roomsText(2, 2)).toBe('غرفتين');
    expect(roomsText(3, 4)).toBe('3 إلى 4 غرف');
    expect(roomsText(4, null)).toBe('4 غرف وأكثر');
    expect(roomsText(null, 3)).toBe('حتى 3 غرف');
  });

  it('leads with the office’s own district and gives the size as a real range', () => {
    const m = buildOfficeMessage(ramroma, { district: 'حي الملز' }, 'office-1');
    expect(m).toContain('دور في الملز أو اللي حوله بالرياض');
    expect(m).toContain('مساحة 291 إلى 297 متر');
    expect(m).not.toContain('حتى 297');
    expect(m).toMatch(/يشتري|مشتري/);
    expect(m).toContain('التفاصيل والسعر');
  });

  it('never names the office, never greets by time of day, never carries the rep note', () => {
    for (let i = 0; i < 40; i++) {
      const m = buildOfficeMessage(facts, { district: null }, `office-${i}`);
      expect(m).not.toMatch(/مساء|صباح|مساك/);
      expect(m).not.toContain('ملاحظة داخلية');
      expect(m).toContain('«إيقاف»');
      expect(m).toMatch(/؟|التفاصيل والسعر/);
    }
  });

  it('uses the client’s places when the office was not matched on a district', () => {
    const m = buildOfficeMessage(facts, { district: null }, 'x');
    expect(m).toContain('فيلا في المعذر والرفيعة بالرياض');
    expect(m).toContain('4 غرف وأكثر');
    expect(m).toContain('الميزانية حتى 2٫5 مليون');
  });

  it('says ready / off-plan only when the client wants exactly one', () => {
    expect(buildOfficeMessage({ ...facts, readiness: 'ready' }, {}, 'k')).toContain('جاهز للسكن');
    expect(buildOfficeMessage({ ...facts, readiness: 'off_plan' }, {}, 'k')).toContain('على الخارطة');
    const either = buildOfficeMessage({ ...facts, readiness: null }, {}, 'k');
    expect(either).not.toContain('جاهز للسكن');
    expect(either).not.toContain('على الخارطة');
  });

  it('keeps one office on one wording and spreads offices across wordings', () => {
    expect(buildOfficeMessage(facts, {}, 'same')).toBe(buildOfficeMessage(facts, {}, 'same'));
    const firstLines = new Set(Array.from({ length: 40 }, (_, i) => buildOfficeMessage(facts, {}, `office-${i}`).split('\n')[0]));
    expect(firstLines.size).toBeGreaterThan(1);
    expect(variantFor('abc', 4)).toBeLessThan(4);
  });

  it('caps the place list and the whole message length', () => {
    const many = { ...facts, places: Array.from({ length: 10 }, (_, i) => `حي ${i}`) };
    const m = buildOfficeMessage(many, {}, 'k');
    expect(m).toContain('وغيرها');
    expect(describeAsk(many).split('، ').filter((p) => /^\d$/.test(p) || p.startsWith('فيلا')).length).toBeGreaterThan(0);
    expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(MAX_PLACES).toBe(4);
  });

  it('never carries a link, and flags one when present', () => {
    expect(containsLink(buildOfficeMessage(facts, {}, 'k'))).toBe(false);
    expect(containsLink('شوف https://wassel.re/p/1')).toBe(true);
    expect(containsLink('wassel.re')).toBe(true);
  });
});
