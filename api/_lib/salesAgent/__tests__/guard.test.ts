import { describe, it, expect } from 'vitest';
import { checkReply, groundedNumbers, numbersInText, spokenAmounts } from '../guard.js';

// Facts shaped like catalog.ts returns them (صفا 78, live 2026-09-29).
const TOOLS = [{
  total: 14, projects: [{ name: 'صفا 78', price_from: 932000, price_to: 1629252, down_payment_percent: 20, bedrooms: { min: 2, max: 3 } }],
  facets: { readiness: { ready: 6, off_plan: 8 } },
}];
const G = groundedNumbers([...TOOLS, 'ابي 3 غرف']);

describe('numbersInText reads numbers the way a reader does', () => {
  it('thousand separators vs decimals', () => {
    expect(numbersInText('1,050,000')).toEqual([1050000]);
    expect(numbersInText('1.290.000')).toEqual([1290000]);
    expect(numbersInText('١٬٠٥٠٬٠٠٠')).toEqual([1050000]);
    expect(numbersInText('2.8 مليون')).toEqual([2.8]);
    expect(numbersInText('٣ غرف و٢٠٪')).toEqual([3, 20]);
  });
});

describe('checkReply', () => {
  const ok = (t: string) => checkReply(t, { lang: 'ar', grounded: G });

  it('passes a short grounded Najdi line', () => {
    expect(ok('عندنا 14 مشروع بالشمال فيها شقق 3 غرف، تبي جاهز ولا على الخارطة؟').ok).toBe(true);
  });
  it('grounds the ways reps say a price', () => {
    expect(ok('صفا 78 بالنرجس تبدأ من 932 ألف، ناسبك؟').ok).toBe(true);
    expect(ok('توصل لمليون و629 ألف، والدفعة الأولى 20٪').ok).toBe(true);
    expect(ok('من 1.6 مليون').ok).toBe(true);
  });
  it('rejects a price the tools never returned', () => {
    const v = ok('صفا 78 تبدأ من 850 ألف، ناسبك؟');
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain('850');
  });
  it('rejects lists, links, bold, formal Arabic, and too many questions', () => {
    expect(ok('عندنا:\n- صفا 78\n- صفا 83').ok).toBe(false);
    expect(ok('شف الرابط https://wassel.re/project?id=x').ok).toBe(false);
    expect(ok('**صفا 78** ممتاز').ok).toBe(false);
    expect(ok('يسعدنا خدمتك، تبي شقة؟').ok).toBe(false);
    expect(ok('تبي شقة؟ ولا فيلا؟ وكم غرفة؟').ok).toBe(false);
  });
  it('rejects a planning note leaking above the message', () => {
    expect(ok('Area known (east), unit type missing → ask.\n\nأبشر، تبي شقة ولا فيلا؟').ok).toBe(false);
    expect(ok('Plan: ask the unit type next\nأبشر، تبي شقة ولا فيلا؟').ok).toBe(false);
  });
  it('rejects a brochure-length message', () => {
    expect(ok('كلام '.repeat(120)).ok).toBe(false);
  });
  it('holds the customer\'s language', () => {
    expect(checkReply('Sure, how many bedrooms?', { lang: 'ar', grounded: G }).ok).toBe(false);
    expect(checkReply('Sure, how many bedrooms?', { lang: 'en', grounded: G }).ok).toBe(true);
  });
});

describe('spoken amounts are checked whole (2026-10-04)', () => {
  // أكنان 25 villas: 250 m², 2,830,000.
  const V = groundedNumbers([{ projects: [{ name: 'أكنان 25', price_from: 2830000, area: 250 }] }, 'كم سعرها']);

  it('«مليون و830 ألف» is 1,830,000 — not the 2,830,000 the facts give', () => {
    expect(spokenAmountsValues('بمليون و830 ألف')).toEqual([1830000]);
    const r = checkReply('فلل أكنان 25 بمليون و830 ألف، تبيها؟', { lang: 'ar', grounded: V });
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toContain('1,830,000');
  });

  it('the right spoken price passes', () => {
    expect(checkReply('فلل أكنان 25 بمليونين و830 ألف، تبيها؟', { lang: 'ar', grounded: V }).ok).toBe(true);
    expect(checkReply('فلل أكنان 25 بـ2 مليون و830 ألف، تبيها؟', { lang: 'ar', grounded: V }).ok).toBe(true);
  });

  it('a budget the customer said in words may be repeated', () => {
    const C = groundedNumbers(['ميزانيتي مليون و900']);
    expect(checkReply('تمام، حدود مليون و900، تبيها جاهزة؟', { lang: 'ar', grounded: C }).ok).toBe(true);
  });
});

function spokenAmountsValues(t: string): number[] {
  return spokenAmounts(t).map((a) => a.value);
}
