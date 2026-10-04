import { describe, it, expect } from 'vitest';
import { distancesIn, foldDistanceText, normalizeDistanceText } from '../distanceText.js';
import { foldWord } from '../anchorPrep.js';

/**
 * The closed distance grammar (design 2026-10-04 §2.2 / §6.1): a radius is used
 * only when the customer's own words state that number. Every row of §6.1.
 */

describe('distancesIn — the closed grammar (§6.1)', () => {
  const rows: Array<[string, number[]]> = [
    ['3 كيلو', [3000]],
    ['٣ كيلو', [3000]],
    ['3كيلو', [3000]],
    ['2 كم', [2000]],
    ['2.5 كيلو', [2500]],
    ['٢٫٥ كم', [2500]],
    ['كيلوين', [2000]],
    ['نص كيلو', [500]],
    ['ربع كيلو', [250]],
    ['كيلو ونص', [1500]],
    ['2 كيلو ونص', [2500]],
    ['500 متر', [500]],
    ['500م', [500]],
    ['ثلاث كيلو', [3000]],
    ['خلال كيلو من الرياض بارك', [1000]],
    ['2,000 متر', [2000]],
    // A time is never a distance.
    ['10 دقايق', []],
    ['ربع ساعة بالسيارة', []],
    ['5 دقايق مشي', []],
    ['ساعتين', []],
    // A bare «كيلو» with no trigger word.
    ['ابي كيلو', []],
    // Out of bounds are dropped.
    ['30 متر', []],
    ['80 كيلو', []],
  ];
  for (const [text, want] of rows) {
    it(`«${text}» → ${JSON.stringify(want)}`, () => {
      expect(distancesIn([text])).toEqual(want);
    });
  }
});

describe('distancesIn — the rest of the closed grammar', () => {
  it('reads every unit spelling of D2 / D3, glued or spaced', () => {
    expect(distancesIn(['4 كيلومترات'])).toEqual([4000]);
    expect(distancesIn(['4 كيلومتر'])).toEqual([4000]);
    expect(distancesIn(['4 كيلوات'])).toEqual([4000]);
    expect(distancesIn(['4 km'])).toEqual([4000]);
    expect(distancesIn(['4KM'])).toEqual([4000]);
    expect(distancesIn(['1.5 kilometres'])).toEqual([1500]);
    expect(distancesIn(['800 m'])).toEqual([800]);
    expect(distancesIn(['800 meters'])).toEqual([800]);
    expect(distancesIn(['300 أمتار'])).toEqual([300]);
    expect(distancesIn(['200 متراً'])).toEqual([200]);
  });

  it('D1 accepts «نصف» and a spaced «و»', () => {
    expect(distancesIn(['3 كم و نصف'])).toEqual([3500]);
    expect(distancesIn(['3كم ونصف'])).toEqual([3500]);
  });

  it('D8 number words (folded spellings)', () => {
    expect(distancesIn(['ثلاثة كيلو'])).toEqual([3000]);
    expect(distancesIn(['خمسه كم'])).toEqual([5000]);
    expect(distancesIn(['عشرين كيلو'])).toEqual([20_000]);
    expect(distancesIn(['عشر كيلو'])).toEqual([10_000]);
  });

  it('D9 triggers: one or two words before a bare «كيلو», never further', () => {
    expect(distancesIn(['في حدود كيلو'])).toEqual([1000]);
    expect(distancesIn(['اقل من كيلو'])).toEqual([1000]);
    expect(distancesIn(['حوالى كيلو'])).toEqual([1000]); // ى folds to ي
    expect(distancesIn(['خلال تقريباً كيلو'])).toEqual([1000]);
    expect(distancesIn(['خلال الحي الشمالي كيلو'])).toEqual([]);
  });

  it('a unit glued to another word is not a unit («10 مليون», «3 مدارس»)', () => {
    expect(distancesIn(['10 مليون'])).toEqual([]);
    expect(distancesIn(['3 مدارس'])).toEqual([]);
    expect(distancesIn(['5 mins'])).toEqual([]);
  });

  it('a comma that is not a thousands separator never yields a number read across it («1,5 كيلو»)', () => {
    expect(distancesIn(['1,5 كيلو'])).toEqual([]);
  });

  it('collects every distance across texts, in order, without duplicates', () => {
    expect(distancesIn(['خلال 3 كيلو من الرياض بارك', 'او 500 متر من المسجد', 'قلت 3 كيلو'])).toEqual([3000, 500]);
  });
});

describe('normalisation', () => {
  it('Arabic-Indic and Persian digits, the Arabic decimal and thousands separators', () => {
    expect(normalizeDistanceText('٢٬٠٠٠ م')).toBe('2000 م');
    expect(normalizeDistanceText('۲۰۰۰')).toBe('2000');
    expect(normalizeDistanceText('٢٫٥')).toBe('2.5');
    expect(normalizeDistanceText('12,500,000')).toBe('12500000');
    expect(normalizeDistanceText('12,34')).toBe('12,34');
  });

  it('the fold is anchorPrep.foldWord exactly (a copy, to avoid an import cycle)', () => {
    for (const s of ['أقلّ من كيلو', 'مسافةً', 'حوالى', 'ٱلشمال', 'تقريـــباً', 'KM']) {
      expect(foldDistanceText(s)).toBe(foldWord(s));
    }
  });
});
