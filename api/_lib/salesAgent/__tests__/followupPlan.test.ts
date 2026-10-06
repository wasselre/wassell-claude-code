import { describe, it, expect } from 'vitest';
import { choosePlan, criteriaFromClient, gapLabels, gapQuestion, primaryGap } from '../followupPlan.js';
import { clientLang, startsWithGreeting } from '../followupDraft.js';

const none = new Set<string>();

describe('choosePlan — what a follow-up is about', () => {
  it('1: asks about a project above 15', () => {
    expect(choosePlan({ candidates: [{ projectId: 'a', score: 40 }], deadIds: none, lastFocus: null, gaps: [] }))
      .toEqual({ mode: 'project', projectId: 'a', score: 40 });
  });
  it('2: the highest score wins', () => {
    const c = choosePlan({ candidates: [{ projectId: 'a', score: 20 }, { projectId: 'b', score: 65 }, { projectId: 'c', score: 30 }], deadIds: none, lastFocus: null, gaps: [] });
    expect(c).toMatchObject({ mode: 'project', projectId: 'b' });
  });
  it('exactly 15 is not enough', () => {
    expect(choosePlan({ candidates: [{ projectId: 'a', score: 15 }], deadIds: none, lastFocus: null, gaps: [] }).mode).toBe('search');
  });
  it('never a project the client turned down', () => {
    const c = choosePlan({ candidates: [{ projectId: 'a', score: 90 }, { projectId: 'b', score: 20 }], deadIds: new Set(['a']), lastFocus: null, gaps: [] });
    expect(c).toMatchObject({ mode: 'project', projectId: 'b' });
  });
  it('3: nothing above 15 and complete needs → search for a new project', () => {
    expect(choosePlan({ candidates: [{ projectId: 'a', score: 10 }], deadIds: none, lastFocus: null, gaps: [] })).toEqual({ mode: 'search' });
  });
  it('3: nothing above 15 and missing needs → ask for them', () => {
    expect(choosePlan({ candidates: [], deadIds: none, lastFocus: null, gaps: ['districts', 'specs'] }))
      .toEqual({ mode: 'preferences', gaps: ['districts', 'specs'] });
  });
  it('4: the last follow-up asked about a project → this one goes to 3 even with a hot project', () => {
    const c = choosePlan({ candidates: [{ projectId: 'a', score: 90 }], deadIds: none, lastFocus: { mode: 'project', project_id: 'a' }, gaps: [] });
    expect(c).toEqual({ mode: 'search' });
  });
  it('4: after a new-project or preferences follow-up, a hot project is asked about again', () => {
    expect(choosePlan({ candidates: [{ projectId: 'a', score: 90 }], deadIds: none, lastFocus: { mode: 'preferences' }, gaps: [] }).mode).toBe('project');
  });
});

describe('criteriaFromClient', () => {
  it('maps the saved preferences', () => {
    expect(criteriaFromClient({
      preferred_unit_type: ['شقة'], preferred_bedrooms: { min: 3 }, budget: { max: 1500000 },
      preferred_area: { min: 150, max: 200 }, preferred_readiness: ['ready'],
    })).toEqual({ unit_types: ['شقة'], bedrooms_min: 3, budget_max: 1500000, area_min: 150, readiness: 'ready' });
  });
  it('two readiness values = no readiness filter; empty fields stay empty', () => {
    expect(criteriaFromClient({ preferred_readiness: ['ready', 'off_plan'] }))
      .toEqual({ unit_types: [], bedrooms_min: null, budget_max: null, area_min: null, readiness: null });
  });
});

describe('gapLabels', () => {
  it('names each missing preference', () => {
    expect(gapLabels(['unit_type', 'districts', 'specs'])).toHaveLength(3);
  });
});

describe('clientLang — the follow-up language', () => {
  it('Arabic text → Arabic; English text → English', () => {
    expect(clientLang('السلام عليكم')).toBe('ar');
    expect(clientLang('Hi, is it still available?')).toBe('en');
  });
  it('no text at all (only voice notes / images) → Arabic, not English', () => {
    expect(clientLang('')).toBe('ar');
    expect(clientLang('   ')).toBe('ar');
  });
  it('mixed → Arabic', () => {
    expect(clientLang('ok تمام')).toBe('ar');
  });
});

describe('startsWithGreeting — every follow-up opens with a greeting', () => {
  it('accepts the greetings reps use', () => {
    for (const m of ['صباح الخير، لازلت مهتم؟', 'مساك الله بالخير أبو خالد', 'مسيتي بالخير', 'Good morning, still looking?']) expect(startsWithGreeting(m)).toBe(true);
  });
  it('rejects a message that opens with the question', () => {
    for (const m of ['وإذا ما ناسبتك المشاريع…', 'إذا ما ناسبك تل الربوة…', 'لازلت مهتم؟']) expect(startsWithGreeting(m)).toBe(false);
  });
});

describe('primaryGap — ask for ONE missing preference', () => {
  it('district first, then unit type, then budget', () => {
    expect(primaryGap(['unit_type', 'districts', 'specs'])).toBe('districts');
    expect(primaryGap(['specs', 'unit_type'])).toBe('unit_type');
    expect(primaryGap(['specs'])).toBe('specs');
    expect(primaryGap([])).toBeNull();
  });
  it('the budget gap is asked as the budget alone', () => {
    expect(gapQuestion('specs')).toContain('ميزانيتك');
  });
});
