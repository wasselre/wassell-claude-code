import { describe, it, expect } from 'vitest';
import { dayPhrase, timePhrase, dueAfter, officerQuestionMessage, officerReminderMessage, taskSummary } from '../officerQuestions';

// Officer questions as tracked tasks (2026-10-08). The wording is fixed — built
// from fields, no model writes it — so it is tested exactly.

describe('day and time wording', () => {
  it('today / tomorrow / a later day', () => {
    expect(dayPhrase('2026-10-08', '2026-10-08')).toBe('اليوم');
    expect(dayPhrase('2026-10-09', '2026-10-08')).toBe('بكرة الجمعة');
    expect(dayPhrase('2026-10-11', '2026-10-08')).toBe('يوم الأحد 11 أكتوبر');
  });
  it('an exact time beats the rough one; none is empty', () => {
    expect(timePhrase('afternoon', null)).toBe('العصر');
    expect(timePhrase('afternoon', '16:30')).toBe('الساعة 4:30 مساءً');
    expect(timePhrase(null, '10:00')).toBe('الساعة 10:00 صباحاً');
    expect(timePhrase(null, null)).toBe('');
    expect(timePhrase(null, '25:99')).toBe('');
  });
});

describe('the message to the officer', () => {
  const base = { officerName: 'عبدالعزيز ال مطلب', projectName: 'ربوة الرمز', clientName: 'Ibrahim', clientPhone: '0558992913', today: '2026-10-08' };
  it('a visit check names the day, asks who receives him, and never invents a time', () => {
    const m = officerQuestionMessage({ ...base, question: null, visit: { day: '2026-10-09', slot: 'afternoon', time: null } });
    expect(m).toBe([
      'السلام عليكم أخوي عبدالعزيز،',
      'عندنا عميل يبي يزور مشروع «ربوة الرمز» بكرة الجمعة العصر، والوقت مرن.',
      'فيه أحد بالموقع يستقبله ويوريه المشروع؟ ولين متى الدوام؟',
      'العميل: Ibrahim — رقمه: 0558992913',
      'ننتظر ردّك، ويعطيك العافية.',
    ].join('\n'));
    expect(m).not.toContain('4:30');
  });
  it('a visit check with an extra question carries it', () => {
    const m = officerQuestionMessage({ ...base, question: 'هل فيه مواقف للزوار؟', visit: { day: '2026-10-09', slot: null, time: '17:00' } });
    expect(m).toContain('بكرة الجمعة الساعة 5:00 مساءً.');
    expect(m).toContain('وسؤاله كمان: هل فيه مواقف للزوار؟');
  });
  it('a plain question', () => {
    const m = officerQuestionMessage({ ...base, question: 'هل يقبلون الدفع كاش بخصم؟', visit: null });
    expect(m).toContain('عندنا عميل مهتم بمشروع «ربوة الرمز» وعنده سؤال:\nهل يقبلون الدفع كاش بخصم؟');
  });
  it('a female officer is «أختي»', () => {
    expect(officerQuestionMessage({ ...base, officerName: 'نورة العتيبي', question: 'سؤال', visit: null })).toMatch(/^السلام عليكم أختي نورة،/);
  });
  it('the reminder repeats what we asked', () => {
    const r = officerReminderMessage({ ...base, question: null, visit: { day: '2026-10-09', slot: 'afternoon', time: null } });
    expect(r).toContain('نذكّرك بخصوص العميل Ibrahim (0558992913): يبي يزور مشروع «ربوة الرمز» بكرة الجمعة العصر — فيه أحد يستقبله؟');
  });
  it('the rep task summary', () => {
    expect(taskSummary({ projectName: 'ربوة الرمز', question: null, visit: { day: '2026-10-09', slot: 'afternoon', time: null }, today: '2026-10-08' }))
      .toBe('تأكيد زيارة «ربوة الرمز» بكرة الجمعة العصر');
  });
});

describe('answer deadline (2 working hours, 09:00–21:00 Riyadh)', () => {
  // Riyadh = UTC+3.
  it('inside the day: +2 hours', () => {
    expect(dueAfter('2026-10-08T10:13:00.000Z')).toBe('2026-10-08T12:13:00.000Z'); // 13:13 → 15:13 Riyadh
  });
  it('a deadline past 21:00 moves to 11:00 the next morning', () => {
    expect(dueAfter('2026-10-08T17:00:00.000Z')).toBe('2026-10-09T08:00:00.000Z'); // 20:00 → next day 11:00 Riyadh
  });
  it('sent at 09:00 (the first slot of the day) is due 11:00', () => {
    expect(dueAfter('2026-10-09T06:00:00.000Z')).toBe('2026-10-09T08:00:00.000Z');
  });
});
