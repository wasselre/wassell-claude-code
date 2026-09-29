import { describe, it, expect } from 'vitest';
import {
  parseZone, hasDirectionWord, normalizeUnitType, mergeSlots, decideNext, nextMissingSlot,
  type Slots, type Understanding,
} from '../decide.js';
import { agentText } from '../texts.js';
import { isOtherProjectsAsk } from '../../../whatsapp/basic-reply.js';

const U = (over: Partial<Understanding> = {}): Understanding => ({
  intent: 'answer', zone: null, unit_types: [], bedrooms_min: null, budget_max: null,
  skip: [], city: null, gender: null, lang: 'ar', ...over,
});

describe('parseZone / hasDirectionWord', () => {
  it.each([
    ['مهتم بمشاريع سكنية اخرى في شمال الرياض', 'north'],
    ['مهتم بمشاريع سكنية اخرى في شرق الرياض', 'east'],
    ['مهتم بمشاريع سكنية اخرى في وسط الرياض', 'center'],
    ['ابي بالشمال', 'north'],
    ['الغرب أفضل', 'west'],
    ['interested in north Riyadh', 'north'],
  ])('«%s» → %s', (t, z) => expect(parseZone(t)).toBe(z));

  it('does not read a project NAME containing a direction as a zone («المشرقية»)', () => {
    expect(parseZone('مهتم بمشروع المشرقية 2')).toBeNull();
    expect(hasDirectionWord('مهتم بمشروع المشرقية 2')).toBe(false);
  });
  it('two different directions are ambiguous → null (we ask)', () => {
    expect(parseZone('الشمال او الشرق')).toBeNull();
  });
  it('the other-projects detector no longer fires on «المشرقية»', () => {
    expect(isOtherProjectsAsk('عندكم مشاريع مثل المشرقية')).toBe(false);
    expect(isOtherProjectsAsk('مهتم بمشاريع سكنية اخرى في شمال الرياض')).toBe(true);
  });
});

describe('normalizeUnitType', () => {
  it.each([['شقق', 'شقة'], ['فلل', 'فيلا'], ['أدوار', 'دور'], ['تاون', 'تاون هاوس'], ['villa', 'فيلا'], ['apartment', 'شقة']])(
    '%s → %s', (a, b) => expect(normalizeUnitType(a)).toBe(b));
  it('rejects unknown types', () => expect(normalizeUnitType('مكتب')).toBeNull());
});

describe('mergeSlots', () => {
  it('ignores a budget under 100k (a unit slip, e.g. «مليون» read as 1)', () => {
    const { slots } = mergeSlots({}, U({ budget_max: 2 }));
    expect(slots.budget_max).toBeUndefined();
  });
  it('keeps feminine once detected', () => {
    const a = mergeSlots({}, U({ gender: 'f' })).slots;
    const b = mergeSlots(a, U({ gender: 'm' })).slots;
    expect(b.gender).toBe('f');
  });
  it('records «ما يهم» as a skipped slot and reports a change', () => {
    const { slots, changed } = mergeSlots({ zone: 'north' }, U({ skip: ['bedrooms'] }));
    expect(slots.skipped).toContain('bedrooms');
    expect(changed).toBe(true);
  });
});

describe('decideNext — the reps\' script', () => {
  const none = { sentCount: 0, slotsChanged: false };
  it('asks region → type → bedrooms → budget, in order', () => {
    let s: Slots = {};
    expect(decideNext(s, U(), none)).toEqual({ kind: 'ask', slot: 'zone' });
    s = { zone: 'north' };
    expect(decideNext(s, U(), none)).toEqual({ kind: 'ask', slot: 'unit_type' });
    s = { ...s, unit_types: ['فيلا'] };
    expect(decideNext(s, U(), none)).toEqual({ kind: 'ask', slot: 'bedrooms' });
    s = { ...s, bedrooms_min: 4 };
    expect(decideNext(s, U(), none)).toEqual({ kind: 'ask', slot: 'budget' });
    s = { ...s, budget_max: 2_000_000 };
    expect(decideNext(s, U(), none)).toEqual({ kind: 'search' });
  });
  it('one message answering everything jumps straight to the search', () => {
    const { slots } = mergeSlots({ zone: 'north' }, U({ unit_types: ['فلل'], bedrooms_min: 4, budget_max: 2_000_000 }));
    expect(nextMissingSlot(slots)).toBeNull();
    expect(decideNext(slots, U(), none)).toEqual({ kind: 'search' });
  });
  const full: Slots = { zone: 'north', unit_types: ['فيلا'], bedrooms_min: 4, budget_max: 2_000_000 };
  const after = { sentCount: 1, slotsChanged: false };
  it('after a project: "more" searches again, "interested" hands to a rep for a visit', () => {
    expect(decideNext(full, U({ intent: 'more' }), after)).toEqual({ kind: 'search' });
    expect(decideNext(full, U({ intent: 'interested' }), after)).toEqual({ kind: 'handoff', reason: 'interested' });
    expect(decideNext(full, U({ intent: 'question' }), after)).toEqual({ kind: 'handoff', reason: 'question' });
  });
  it('changed preferences after a project trigger a new search', () => {
    expect(decideNext(full, U({ intent: 'answer' }), { sentCount: 1, slotsChanged: true })).toEqual({ kind: 'search' });
  });
  it('stop and human always win, even mid-script', () => {
    expect(decideNext({}, U({ intent: 'stop' }), none)).toEqual({ kind: 'stop' });
    expect(decideNext({}, U({ intent: 'human' }), none)).toEqual({ kind: 'handoff', reason: 'human' });
  });
  it('a question mid-qualifying does not derail the script', () => {
    expect(decideNext({ zone: 'north' }, U({ intent: 'question' }), none)).toEqual({ kind: 'ask', slot: 'unit_type' });
  });
});

describe('texts follow the reps\' voice', () => {
  const all = [
    agentText.askZone('ar', 'm'), agentText.askUnitTypeWithIntro('ar', 'm', 'north'), agentText.askUnitType('ar', 'm'),
    agentText.askBedrooms('ar', 'm'), agentText.askBudget('ar'), agentText.afterProject('ar', 'north', false, true),
    agentText.afterProject('ar', 'north', true, true), agentText.noResults('ar'), agentText.interested('ar'),
    agentText.holding('ar'), agentText.close('ar'),
  ];
  it('no bullets, no colon-labels, short', () => {
    for (const t of all) {
      expect(t).not.toMatch(/[•\n]|^-|الخيار الأول:/);
      expect(t.length).toBeLessThanOrEqual(120);
    }
  });
  it('asks with feminine forms for a woman', () => {
    expect(agentText.askUnitType('ar', 'f')).toContain('تبين');
    expect(agentText.askBedrooms('ar', 'f')).toContain('تبين');
    expect(agentText.askUnitType('ar', 'm')).toContain('تبي ');
  });
  it('the first region question acknowledges the region like a rep would', () => {
    expect(agentText.askUnitTypeWithIntro('ar', 'm', 'north')).toBe('أبشر، عندنا مشاريع بالشمال. تبي شقة ولا دور ولا فيلا ولا تاون هاوس؟');
  });
});
