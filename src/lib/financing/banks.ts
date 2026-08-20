/**
 * Financing calculator — bank rate table (Bayut-style rebuild, 2026-08-20).
 *
 * The previous V2 prequalification engine (capacity/DBR/product matching/
 * scenarios) was deleted on user decision — too complicated. This is a
 * deliberate duplicate of bayut.sa's listing-page financing calculator:
 * a static per-bank, per-tenure FLAT rate table + client-side math.
 *
 * Rates live in `financing_banks` (Supabase) so they can be updated without a
 * deploy; DEFAULT_BANKS below is the offline/bootstrap fallback and the seed.
 * Source of the numbers: bayut.sa `GET /api/banks`, scraped 2026-08-20.
 */
import { supabase } from '@/lib/supabase';

export interface FinancingBank {
  slug: string;
  name_ar: string;
  name_en: string;
  /** Annual FLAT rate (decimal, e.g. 0.038) per tenure in years, 5..25. */
  rates: Record<number, number>;
  sort_order: number;
}

export const MIN_TERM_YEARS = 5;
export const MAX_TERM_YEARS = 25;
export const DEFAULT_TERM_YEARS = 15;
/** Saudi citizen buying their first home (SAMA 90% LTV concession). */
export const FIRST_HOME_MIN_DOWN_PCT = 10;
/** Everyone else: non-Saudi, or Saudi who already owns a home. */
export const STANDARD_MIN_DOWN_PCT = 30;
export const MAX_DOWN_PCT = 80;
export const DEFAULT_FLAT_RATE = 0.036;

const flat = (rate: number): Record<number, number> => {
  const r: Record<number, number> = {};
  for (let y = MIN_TERM_YEARS; y <= MAX_TERM_YEARS; y++) r[y] = rate;
  return r;
};

const ramp = (pairs: Array<[number, number]>): Record<number, number> => {
  // pairs = [[fromYear, rate], ...] each rate applies from its year until the next pair.
  const r: Record<number, number> = {};
  for (let y = MIN_TERM_YEARS; y <= MAX_TERM_YEARS; y++) {
    let v = DEFAULT_FLAT_RATE;
    for (const [from, rate] of pairs) if (y >= from) v = rate;
    r[y] = v;
  }
  return r;
};

/** Verbatim from bayut.sa /api/banks (2026-08-20). Flat annual rates. */
export const DEFAULT_BANKS: FinancingBank[] = [
  {
    slug: 'emirates-nbd', name_ar: 'بنك الإمارات دبي الوطني', name_en: 'Emirates NBD', sort_order: 1,
    rates: ramp([[5, 0.0345], [6, 0.0365], [11, 0.038], [16, 0.0395], [21, 0.041]]),
  },
  {
    slug: 'al-jazira', name_ar: 'بنك الجزيرة', name_en: 'Bank AlJazira', sort_order: 2,
    rates: {
      5: 0.0346, 6: 0.0346, 7: 0.0346, 8: 0.0346, 9: 0.0346, 10: 0.0355, 11: 0.036, 12: 0.0365,
      13: 0.037, 14: 0.0375, 15: 0.038, 16: 0.0385, 17: 0.039, 18: 0.04, 19: 0.0405, 20: 0.0407,
      21: 0.0413, 22: 0.0416, 23: 0.042, 24: 0.0424, 25: 0.0426,
    },
  },
  {
    slug: 'fab', name_ar: 'بنك أبوظبي الأول', name_en: 'FAB', sort_order: 3,
    // 16y = 4.00% is in Bayut's source data (their entry error, kept verbatim).
    rates: { ...ramp([[5, 0.0385], [6, 0.0408], [11, 0.042], [17, 0.0441], [21, 0.0458]]), 16: 0.04 },
  },
  {
    slug: 'al-rajhi', name_ar: 'مصرف الراجحي', name_en: 'Al Rajhi', sort_order: 4,
    rates: {
      5: 0.0389, 6: 0.0409, 7: 0.0409, 8: 0.0409, 9: 0.0409, 10: 0.0394, 11: 0.0399, 12: 0.0404,
      13: 0.0409, 14: 0.0414, 15: 0.0419, 16: 0.0424, 17: 0.0429, 18: 0.0434, 19: 0.0439, 20: 0.0444,
      21: 0.0454, 22: 0.0459, 23: 0.0463, 24: 0.0469, 25: 0.0474,
    },
  },
  {
    slug: 'snb', name_ar: 'البنك الأهلي السعودي', name_en: 'SNB', sort_order: 5,
    rates: {
      5: 0.0383, 6: 0.0385, 7: 0.0389, 8: 0.0392, 9: 0.0395, 10: 0.0399, 11: 0.0404, 12: 0.0409,
      13: 0.0415, 14: 0.042, 15: 0.0426, 16: 0.0432, 17: 0.0438, 18: 0.0444, 19: 0.045, 20: 0.0456,
      21: 0.0463, 22: 0.0469, 23: 0.0475, 24: 0.0482, 25: 0.0487,
    },
  },
  {
    // Bayut ships interest_details = null for Riyad Bank and falls back to its
    // 3.60% default; we seed that fallback explicitly.
    slug: 'riyad-bank', name_ar: 'بنك الرياض', name_en: 'Riyad Bank', sort_order: 6,
    rates: flat(0.036),
  },
  {
    slug: 'shl', name_ar: 'الشركة السعودية لتمويل المساكن', name_en: 'SHL', sort_order: 7,
    rates: {
      5: 0.055, 6: 0.0556, 7: 0.0564, 8: 0.0571, 9: 0.0578, 10: 0.0586, 11: 0.0593, 12: 0.0601,
      13: 0.0608, 14: 0.0616, 15: 0.0623, 16: 0.063, 17: 0.0637, 18: 0.0644, 19: 0.0651, 20: 0.0658,
      21: 0.0665, 22: 0.0671, 23: 0.0678, 24: 0.0684, 25: 0.0696,
    },
  },
  {
    slug: 'sab', name_ar: 'البنك السعودي الأول', name_en: 'SAB', sort_order: 8,
    rates: {
      5: 0.0315, 6: 0.0315, 7: 0.0315, 8: 0.0315, 9: 0.0315, 10: 0.0345, 11: 0.0345, 12: 0.0355,
      13: 0.0355, 14: 0.036, 15: 0.036, 16: 0.0365, 17: 0.0365, 18: 0.0375, 19: 0.0375, 20: 0.0379,
      21: 0.0395, 22: 0.0398, 23: 0.0401, 24: 0.0404, 25: 0.0406,
    },
  },
  {
    slug: 'dar-al-tamleek', name_ar: 'دار التمليك', name_en: 'Dar Al Tamleek', sort_order: 9,
    rates: ramp([[5, 0.052], [8, 0.0539], [9, 0.0546], [10, 0.0553], [15, 0.0586], [20, 0.0619]]),
  },
  {
    slug: 'bsf', name_ar: 'البنك السعودي الفرنسي', name_en: 'BSF', sort_order: 10,
    rates: {
      5: 0.036, 6: 0.036, 7: 0.036, 8: 0.036, 9: 0.036, 10: 0.0365, 11: 0.0365, 12: 0.037,
      13: 0.0375, 14: 0.038, 15: 0.0385, 16: 0.039, 17: 0.0395, 18: 0.04, 19: 0.0405, 20: 0.041,
      21: 0.0415, 22: 0.042, 23: 0.0425, 24: 0.043, 25: 0.0435,
    },
  },
];

interface BankRow {
  slug: string;
  name_ar: string;
  name_en: string;
  rates: Record<string, number> | null;
  sort_order: number;
}

/**
 * Live rates from `financing_banks`, falling back to DEFAULT_BANKS when
 * Supabase is unconfigured, the query fails, or the table is empty. The
 * fallback is reported via console.error (never silently) per the
 * silent-failures rule; an empty table is a legitimate state, not an error.
 */
export async function loadBanks(): Promise<FinancingBank[]> {
  if (!supabase) return DEFAULT_BANKS;
  const { data, error } = await supabase
    .from('financing_banks')
    .select('slug,name_ar,name_en,rates,sort_order')
    .eq('is_active', true)
    .order('sort_order');
  if (error) {
    console.error('[financing] financing_banks read failed; using built-in defaults', error);
    return DEFAULT_BANKS;
  }
  if (!data || data.length === 0) return DEFAULT_BANKS;
  return (data as BankRow[]).map((r) => ({
    slug: r.slug,
    name_ar: r.name_ar,
    name_en: r.name_en,
    sort_order: r.sort_order,
    rates: Object.fromEntries(Object.entries(r.rates ?? {}).map(([y, v]) => [Number(y), Number(v)])),
  }));
}

export function rateFor(bank: FinancingBank | null, years: number): number {
  return bank?.rates?.[years] ?? DEFAULT_FLAT_RATE;
}
