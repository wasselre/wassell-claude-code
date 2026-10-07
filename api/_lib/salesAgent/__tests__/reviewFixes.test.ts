import { describe, it, expect } from 'vitest';
import { genderFromName } from '../nameGender';
import { foldPlace, matchDistrictNames } from '../districtNames';
import { retimeGreeting } from '../followupSend';
import { readinessIsExclusive } from '../prefReading';
import { checkReply } from '../guard';
import { isSoldOut } from '../followupDraft';
import { fitOf } from '../catalog';

// The fixes from the week-one review (2026-10-07), one block per finding.

describe('gender from the name on the record', () => {
  it('reads common female names, kunyas and ة names', () => {
    for (const n of ['نوره', 'نورة العتيبي', 'سارة', 'هيا محمد', 'أسماء', 'تغريد', 'منى', 'ام فيصل', 'أم عبدالعزيز', 'Sabeena', 'غالية', 'ميرفت', 'ثريا', 'نجاة'])
      expect(genderFromName(n), n).toBe('f');
  });
  it('male ة names and kunyas are not female', () => {
    for (const n of ['حمزة', 'أسامة الحربي', 'طلحة', 'عبدالله', 'أبو يوسف', 'عبد الرحمن']) expect(genderFromName(n), n).toBe('m');
  });
  it('does not guess names it does not know', () => {
    for (const n of ['فهد', 'محمد', 'Ahmad', '', 'شركه مسكن نفوذ للعقارات']) expect(genderFromName(n), n).not.toBe('f');
  });
});

describe('plain district names', () => {
  const names = [
    { key: foldPlace('حي المصيف'), ids: ['m'], label: 'المصيف' },
    { key: foldPlace('حي الملقا'), ids: ['q'], label: 'الملقا' },
    { key: foldPlace('حي الصفا'), ids: ['s'], label: 'الصفا' },
    { key: foldPlace('حي الفاروق'), ids: ['f'], label: 'الفاروق' },
    { key: foldPlace('حي السلام'), ids: ['x'], label: 'السلام' },
    { key: 'ام الحمام', ids: ['e', 'w'], label: 'ام الحمام' },
  ];
  it('finds the names customers wrote (review: not understood before)', () => {
    expect(matchDistrictNames('ابي بالمصيف', names).map((d) => d.id)).toEqual(['m']);
    expect(matchDistrictNames('الصفا و الفاروق ،،، لا', names).map((d) => d.id).sort()).toEqual(['f', 's']);
    expect(matchDistrictNames('في الملقاء', names).map((d) => d.id)).toEqual(['q']);
    expect(matchDistrictNames('قريب من أم الحمام', names).map((d) => d.id).sort()).toEqual(['e', 'w']);
  });
  it('a greeting is not a district', () => {
    expect(matchDistrictNames('السلام عليكم ابي شقة', names)).toEqual([]);
  });
  it('a project brand is not the district', () => {
    expect(matchDistrictNames('مهتم بصفا 82', names)).toEqual([]);
  });
});

describe('follow-up greeting set at send time', () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 9, 7, hour - 3, 0, 0)); // Riyadh = UTC+3
  it('«صباح الخير» delivered at 5 pm becomes an evening greeting', () => {
    expect(retimeGreeting('صباح الخير، لازلت مهتم بيمام 17؟', at(17))).toBe('مساء الخير، لازلت مهتم بيمام 17؟');
  });
  it('an evening greeting delivered at 10 am becomes «صباح الخير»', () => {
    expect(retimeGreeting('مساك الله بالخير، ناسبك المشروع؟', at(10))).toBe('صباح الخير، ناسبك المشروع؟');
  });
  it('a correct greeting is left alone', () => {
    expect(retimeGreeting('مسيتي بالخير، شفتي القائمة؟', at(19))).toBe('مسيتي بالخير، شفتي القائمة؟');
    expect(retimeGreeting('Good morning, still looking?', at(15))).toBe('Good afternoon, still looking?');
  });
});

describe('"off-plan is fine" is not "off-plan only"', () => {
  it('accepting one kind does not refuse the other', () => {
    for (const q of ['Off plan is ok', 'ماعندي مانع على الخارطه', 'على الخارطة عادي', 'ما يفرق']) expect(readinessIsExclusive(q), q).toBe(false);
  });
  it('an exclusive wish stays exclusive', () => {
    for (const q of ['ابي جاهز', 'جاهزه', 'ما ابي على الخارطة', 'off plan only']) expect(readinessIsExclusive(q), q).toBe(true);
  });
});

describe('guard: what reached customers in week one', () => {
  const base = { grounded: new Set<number>() };
  it('blocks a note to itself in an English chat', () => {
    const v = checkReply('Sadeem Town units are apartments. Sent card says Type: Apartment. Answer directly.\n\nSadeem Town is apartments.', { ...base, lang: 'en' });
    expect(v.problems.some((p) => p.includes('note to yourself'))).toBe(true);
  });
  it('blocks Latin letters glued to Arabic («Lسه»)', () => {
    expect(checkReply('Lسه أتأكد لك وأرد عليك', { ...base, lang: 'ar' }).ok).toBe(false);
  });
  it('blocks «صباح الخير» in the evening and allows it in the morning', () => {
    expect(checkReply('صباح الخير، ناسبك المشروع؟', { ...base, lang: 'ar', riyadhHour: 17 }).ok).toBe(false);
    expect(checkReply('صباح الخير، ناسبك المشروع؟', { ...base, lang: 'ar', riyadhHour: 9 }).ok).toBe(true);
  });
  it('blocks a second greeting within the same hours, unless the customer greeted', () => {
    expect(checkReply('مساك الله بالخير، ناسبك؟', { ...base, lang: 'ar', riyadhHour: 18, hoursSinceOurs: 1, customerText: 'كم السعر' }).ok).toBe(false);
    expect(checkReply('مساك الله بالخير، ناسبك؟', { ...base, lang: 'ar', riyadhHour: 18, hoursSinceOurs: 1, customerText: 'مساء الخير' }).ok).toBe(true);
  });
  it('a plain good reply still passes', () => {
    expect(checkReply('أبشر، ناسبك المشروع؟', { ...base, lang: 'ar', riyadhHour: 18, hoursSinceOurs: 0.2, customerText: 'تمام' }).ok).toBe(true);
  });
});

describe('sold-out projects are never pitched', () => {
  it('zero available, or no available price', () => {
    expect(isSoldOut({ available_units: 0, available_price_range: { min: 533000, max: 900000 } })).toBe(true);
    expect(isSoldOut({ available_price_range: null })).toBe(true);
    expect(isSoldOut({ available_units: 12, available_price_range: { min: 1539000, max: 1899000 } })).toBe(false);
  });
});

describe('price per unit type', () => {
  it('villas and townhouses each get their own starting price (أديم الفرسان)', () => {
    const f = fitOf([
      { type: 'تاون هاوس', bedrooms: 4, price: 1005535, area: 250 },
      { type: 'فيلا', bedrooms: 4, price: 1259840, area: 300 },
      { type: 'فيلا', bedrooms: 4, price: 1400000, area: 320 },
    ], { types: [], strictType: false, checkType: false, bedroomsMin: null, budgetMax: null });
    expect(f.from_by_type['فيلا']).toBe(1259840);
    expect(f.from_by_type['تاون هاوس']).toBe(1005535);
  });
  it('an upper size limit drops bigger units', () => {
    const f = fitOf([{ type: 'فيلا', bedrooms: 5, price: 3950000, area: 376 }, { type: 'فيلا', bedrooms: 4, price: 2830000, area: 280 }],
      { types: [], strictType: false, checkType: false, bedroomsMin: null, budgetMax: null, areaMin: 250, areaMax: 300 });
    expect(f.units).toBe(1);
    expect(f.area_to).toBe(280);
  });
});
