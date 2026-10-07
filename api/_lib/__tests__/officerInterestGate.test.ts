/**
 * Tests for the code half of the officer interest rules (officerInterestGate.ts):
 * the model proposes a signal + quotes, CODE decides.
 */
import { describe, it, expect } from 'vitest';
import { decideGate } from '../officerInterestGate.js';

const chat = 'السلام عليكم\nابمر اشوفها\nكم المساحة؟\nفيه غرفة سائق؟\nنعم';

describe('decideGate', () => {
  it('passes a visit signal whose quote is in the client text', () => {
    const v = decideGate({ signal: 'visit', quotes: ['ابمر اشوفها'] }, chat);
    expect(v).toEqual({ pass: true, signal: 'visit', quotes: ['ابمر اشوفها'], reason: null });
  });

  it('refuses a quote the client never wrote (an invented or our-side quote)', () => {
    const v = decideGate({ signal: 'buy', quotes: ['أبي أحجز'] }, chat);
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/no quote/);
  });

  it('refuses no signal (rule B — a bare «نعم»)', () => {
    const v = decideGate({ signal: null, quotes: ['نعم'], explanation: 'one-word yes' }, chat);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('no strong signal: one-word yes');
  });

  it('refuses an unknown signal value', () => {
    expect(decideGate({ signal: 'excited', quotes: ['ابمر اشوفها'] }, chat).pass).toBe(false);
  });

  it('«details» needs two DIFFERENT found questions', () => {
    expect(decideGate({ signal: 'details', quotes: ['كم المساحة؟'] }, chat).pass).toBe(false);
    expect(decideGate({ signal: 'details', quotes: ['كم المساحة؟', 'كم المساحة؟'] }, chat).pass).toBe(false);
    expect(decideGate({ signal: 'details', quotes: ['كم المساحة؟', 'فيه غرفة سائق؟'] }, chat).pass).toBe(true);
  });

  it('ignores non-string and too-short quotes, and keeps at most two', () => {
    const v = decideGate({ signal: 'visit', quotes: [42, 'ا', 'ابمر اشوفها', 'كم المساحة؟', 'فيه غرفة سائق؟'] }, chat);
    expect(v.pass).toBe(true);
    expect(v.quotes).toEqual(['ابمر اشوفها', 'كم المساحة؟']);
  });

  it('a non-array quotes value is no quotes', () => {
    expect(decideGate({ signal: 'visit', quotes: 'ابمر اشوفها' }, chat).pass).toBe(false);
  });
});
