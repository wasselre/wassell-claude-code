/**
 * Tests for the code half of the officer interest rules (officerInterestGate.ts):
 * the model proposes a signal + quotes, CODE decides.
 */
import { describe, it, expect } from 'vitest';
import { decideGate, cleanReason } from '../officerInterestGate.js';

const chat = 'السلام عليكم\nابمر اشوفها\nكم المساحة؟\nفيه غرفة سائق؟\nنعم';

describe('decideGate', () => {
  it('passes a visit signal whose quote is in the client text', () => {
    const v = decideGate({ signal: 'visit', quotes: ['ابمر اشوفها'] }, chat);
    expect(v).toEqual({ pass: true, signal: 'visit', quotes: ['ابمر اشوفها'], reason: null, summary: 'أبدى رغبته في زيارة المشروع' });
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

describe('cleanReason — the model reason line for the officer', () => {
  it('keeps a short formal phrase that starts with a reporting verb', () => {
    expect(cleanReason('استفسر عن خطة الدفع وقيمة الدفعة الأولى.')).toBe('استفسر عن خطة الدفع وقيمة الدفعة الأولى');
    expect(cleanReason('أبدى رغبته في زيارة المشروع مساء اليوم')).toBe('أبدى رغبته في زيارة المشروع مساء اليوم');
  });
  it('drops anything that is not that', () => {
    expect(cleanReason(null)).toBeNull();
    expect(cleanReason('العميل مهتم جداً')).toBeNull();
    expect(cleanReason('استفسر عن «السعر»')).toBeNull();
    expect(cleanReason('استفسر about price')).toBeNull();
    expect(cleanReason('استفسر عن ' + 'تفاصيل '.repeat(30))).toBeNull();
    expect(cleanReason('استفسر\nعن السعر')).toBeNull();
  });
  it('a pass uses the model wording, else the signal fallback', () => {
    const chat = 'كم الدفعة الاولى؟';
    expect(decideGate({ signal: 'deal', quotes: ['كم الدفعة الاولى؟'], reason_ar: 'استفسر عن قيمة الدفعة الأولى' }, chat).summary).toBe('استفسر عن قيمة الدفعة الأولى');
    expect(decideGate({ signal: 'deal', quotes: ['كم الدفعة الاولى؟'], reason_ar: 'interested' }, chat).summary).toBe('استفسر عن تفاصيل الشراء');
  });
});
