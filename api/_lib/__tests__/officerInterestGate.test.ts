/**
 * Tests for the code half of the officer interest rules (officerInterestGate.ts):
 * the model proposes a signal + quotes, CODE decides.
 */
import { describe, it, expect } from 'vitest';
import { decideGate, budgetStop } from '../officerInterestGate.js';

const chat = 'السلام عليكم\nابمر اشوفها\nكم المساحة؟\nفيه غرفة سائق؟\nنعم';

describe('decideGate', () => {
  it('passes a visit signal whose quote is in the client text', () => {
    const v = decideGate({ signal: 'visit', quotes: ['ابمر اشوفها'], mismatch: null }, chat, null);
    expect(v).toEqual({ pass: true, signal: 'visit', quotes: ['ابمر اشوفها'], reason: null });
  });

  it('refuses a quote the client never wrote (an invented or our-side quote)', () => {
    const v = decideGate({ signal: 'buy', quotes: ['أبي أحجز'], mismatch: null }, chat, null);
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/no quote/);
  });

  it('refuses no signal (rule B — a bare «نعم»)', () => {
    const v = decideGate({ signal: null, quotes: ['نعم'], mismatch: null, explanation: 'one-word yes' }, chat, null);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('no strong signal: one-word yes');
  });

  it('refuses an unknown signal value', () => {
    expect(decideGate({ signal: 'excited', quotes: ['ابمر اشوفها'], mismatch: null }, chat, null).pass).toBe(false);
  });

  it('«details» needs two DIFFERENT found questions', () => {
    expect(decideGate({ signal: 'details', quotes: ['كم المساحة؟'], mismatch: null }, chat, null).pass).toBe(false);
    expect(decideGate({ signal: 'details', quotes: ['كم المساحة؟', 'كم المساحة؟'], mismatch: null }, chat, null).pass).toBe(false);
    expect(decideGate({ signal: 'details', quotes: ['كم المساحة؟', 'فيه غرفة سائق؟'], mismatch: null }, chat, null).pass).toBe(true);
  });

  it('a mismatch stops even a strong signal', () => {
    const v = decideGate({ signal: 'visit', quotes: ['ابمر اشوفها'], mismatch: 'wants 400 m², villas are 250 m²' }, chat, null);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('the project does not fit: wants 400 m², villas are 250 m²');
  });

  it('the budget stop wins over everything', () => {
    const v = decideGate({ signal: 'buy', quotes: ['ابمر اشوفها'], mismatch: null }, chat, 'budget below');
    expect(v).toMatchObject({ pass: false, reason: 'budget below' });
  });

  it('ignores non-string and too-short quotes, and keeps at most two', () => {
    const v = decideGate({ signal: 'visit', quotes: [42, 'ا', 'ابمر اشوفها', 'كم المساحة؟', 'فيه غرفة سائق؟'], mismatch: null }, chat, null);
    expect(v.pass).toBe(true);
    expect(v.quotes).toEqual(['ابمر اشوفها', 'كم المساحة؟']);
  });

  it('a non-array quotes value is no quotes', () => {
    expect(decideGate({ signal: 'visit', quotes: 'ابمر اشوفها', mismatch: null }, chat, null).pass).toBe(false);
  });
});

describe('budgetStop', () => {
  it('stops when the budget max is below the starting price', () => {
    expect(budgetStop({ min: 1_000_000, max: 1_700_000 }, { min: 1_890_000, max: 2_500_000 }))
      .toBe("their budget (1,700,000) is below the project's starting price (1,890,000)");
  });
  it('does not stop at or above the starting price', () => {
    expect(budgetStop({ max: 1_890_000 }, { min: 1_890_000 })).toBeNull();
  });
  it('unknown on either side is not a stop', () => {
    expect(budgetStop(null, { min: 1 })).toBeNull();
    expect(budgetStop({ max: 2 }, null)).toBeNull();
    expect(budgetStop({ max: '0' }, { min: 5 })).toBeNull();
  });
  it('reads numeric strings', () => {
    expect(budgetStop({ max: '900000' }, { min: '1000000' })).not.toBeNull();
  });
});
