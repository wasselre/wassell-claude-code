import { describe, it, expect } from 'vitest';
import {
  buildOfficeMessage, describeAsk, formatAmountAr, variantFor, containsLink,
  MAX_MESSAGE_CHARS, MAX_PLACES,
} from '../message';

const facts = {
  unitTypes: ['فيلا'],
  places: ['المعذر', 'الرفيعة'],
  city: 'الرياض',
  budgetMax: 2_500_000,
  bedroomsMin: 4,
  notes: 'يبي فيلا جاهزة، شارع 20 أو أكثر',
};

describe('office outreach message', () => {
  it('describes the ask in one line with type, places, city, budget and rooms', () => {
    expect(describeAsk(facts)).toBe('فيلا في المعذر، الرفيعة (الرياض)، الميزانية حتى 2٫5 مليون، غرف النوم من 4');
  });

  it('formats amounts with the Arabic decimal comma and whole millions plain', () => {
    expect(formatAmountAr(2_500_000)).toBe('2٫5 مليون');
    expect(formatAmountAr(3_000_000)).toBe('3 مليون');
    expect(formatAmountAr(850_000)).toBe('850 ألف');
  });

  it('greets the office by name, asks a question, and offers an opt-out', () => {
    const m = buildOfficeMessage(facts, 'مكتب الدار', 'office-1');
    expect(m).toContain('مكتب الدار');
    expect(m).toMatch(/؟/);
    expect(m).toContain('«إيقاف»');
    expect(m).toContain('يبي فيلا جاهزة');
  });

  it('works without an office name', () => {
    const m = buildOfficeMessage(facts, null, 'x');
    expect(m.split('\n')[0].endsWith('،')).toBe(true);
    expect(m).not.toContain('null');
  });

  it('keeps one office on one wording and spreads offices across wordings', () => {
    expect(buildOfficeMessage(facts, null, 'same')).toBe(buildOfficeMessage(facts, null, 'same'));
    const firstLines = new Set(Array.from({ length: 40 }, (_, i) => buildOfficeMessage(facts, null, `office-${i}`).split('\n')[0]));
    expect(firstLines.size).toBeGreaterThan(1);
    expect(variantFor('abc', 4)).toBeLessThan(4);
  });

  it('caps the place list and the whole message length', () => {
    const many = { ...facts, places: Array.from({ length: 10 }, (_, i) => `حي ${i}`), notes: 'ك'.repeat(900) };
    const m = buildOfficeMessage(many, 'مكتب', 'k');
    expect(describeAsk(many)).toContain('وغيرها');
    expect(describeAsk(many).split('حي').length - 1).toBe(MAX_PLACES);
    expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });

  it('never carries a link, and flags one when a rep pastes it', () => {
    expect(containsLink(buildOfficeMessage(facts, 'مكتب', 'k'))).toBe(false);
    expect(containsLink('شوف https://wassel.re/p/1')).toBe(true);
    expect(containsLink('wassel.re')).toBe(true);
  });

  it('says ready / off-plan only when the client wants exactly one', () => {
    expect(describeAsk({ ...facts, readiness: 'ready' })).toContain('جاهز للسكن');
    expect(describeAsk({ ...facts, readiness: 'off_plan' })).toContain('على الخارطة');
    const either = describeAsk({ ...facts, readiness: null });
    expect(either).not.toContain('جاهز للسكن');
    expect(either).not.toContain('على الخارطة');
  });
});
