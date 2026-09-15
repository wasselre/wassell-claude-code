import { describe, it, expect } from 'vitest';
import {
  resolveProjectPaymentPlans,
  resolveUnitPaymentPlans,
  composePaymentPlansMessage,
  entryDownPayment,
  hasAedPricing,
  formatPlanPriceRange,
  planRowTitle,
} from '../paymentPlans';
import type { AppRecord } from '@/types';

/**
 * Fixtures mirror the LIVE shapes measured on 2026-09-15:
 *  • Saudi (صفا 80): named plan «خطة صفا (البوابة)», a long free-text schedule,
 *    NO per-card price — the price is the unit's own `total_price`, SAR only.
 *  • Dubai (Binghatti): numeric plan "01", per-card `price` (AED) + `price_sar`,
 *    plus the 100%-down cash card several towers carry.
 */
function unit(id: string, data: Record<string, unknown>): AppRecord {
  return { id, model_id: 'm_units', data, created_at: '', updated_at: '' } as AppRecord;
}

const SAFA_SCHEDULE = 'الدفعة الأولى: 20% عند إنجاز 0% | الدفعة الثانية: 10% عند إنجاز 20%';

const safaUnits = [
  unit('u1', {
    total_price: 1_595_590,
    payment_plans: [
      { plan: 'خطة صفا (البوابة)', down: 20, before_handover: 75, on_handover: 5, after_handover: 0, schedule: SAFA_SCHEDULE },
    ],
  }),
  unit('u2', {
    total_price: 1_435_270,
    payment_plans: [
      { plan: 'خطة صفا (البوابة)', down: 20, before_handover: 75, on_handover: 5, after_handover: 0, schedule: SAFA_SCHEDULE },
      { plan: 'خطة صفا (البوابة)', down: 20, before_handover: 80, on_handover: 0, after_handover: 0 },
    ],
  }),
  unit('u3', { total_price: 1_200_000 }), // no plans at all — contributes nothing
];

const binghattiUnits = [
  unit('b1', {
    payment_plans: [
      { plan: '01', down: 20, before_handover: 50, on_handover: 30, after_handover: 0, price: 2_608_515, price_sar: 2_663_562 },
      { plan: '02', down: 100, before_handover: 0, on_handover: 0, after_handover: 0, price: 2_400_000, price_sar: 2_450_647 },
    ],
  }),
  unit('b2', {
    payment_plans: [
      { plan: '01', down: 20, before_handover: 50, on_handover: 30, after_handover: 0, price: 3_100_000, price_sar: 3_165_420 },
    ],
  }),
];

describe('resolveProjectPaymentPlans', () => {
  it('groups by %-split across units and counts the UNITS offering each', () => {
    const rows = resolveProjectPaymentPlans(safaUnits, true);
    expect(rows.map((r) => r.key)).toEqual(['20/75/5/0', '20/80/0/0']);
    expect(rows[0]!.count).toBe(2); // u1 + u2
    expect(rows[0]!.countKind).toBe('units');
    expect(rows[1]!.count).toBe(1); // u2 only
  });

  it('falls back to the unit total price (SAR) for a card with no price of its own', () => {
    const rows = resolveProjectPaymentPlans(safaUnits, true);
    expect(rows[0]!.minSar).toBe(1_435_270);
    expect(rows[0]!.maxSar).toBe(1_595_590);
    expect(rows[0]!.maxAed).toBe(0); // Saudi project — no AED anywhere
    expect(hasAedPricing(rows)).toBe(false);
  });

  it('keeps the developer plan NAME and its milestone schedule', () => {
    const rows = resolveProjectPaymentPlans(safaUnits, true);
    expect(rows[0]!.name).toBe('خطة صفا (البوابة)');
    expect(rows[0]!.schedule).toBe(SAFA_SCHEDULE);
    expect(rows[0]!.label).toBe('20% مقدم / 75% أثناء الإنشاء / 5% عند التسليم');
  });

  it('treats a bare sequence number as NOT a name (Binghatti cards are numbered)', () => {
    const rows = resolveProjectPaymentPlans(binghattiUnits, false);
    expect(rows.every((r) => r.name === '')).toBe(true);
    expect(planRowTitle(rows[0]!, false)).toBe('20% down / 50% during construction / 30% on handover');
  });

  it('rolls AED + SAR ranges up across units and flags the cash plan', () => {
    const rows = resolveProjectPaymentPlans(binghattiUnits, false);
    const instalment = rows.find((r) => r.key === '20/50/30/0')!;
    expect(instalment.minAed).toBe(2_608_515);
    expect(instalment.maxAed).toBe(3_100_000);
    expect(instalment.minSar).toBe(2_663_562);
    expect(hasAedPricing(rows)).toBe(true);

    const cash = rows.find((r) => r.key === '100/0/0/0')!;
    expect(cash.isCash).toBe(true);
    expect(planRowTitle(cash, true)).toBe('دفعة كاملة (كاش)');
  });

  it('sorts entry-plan-first (lowest down payment)', () => {
    const rows = resolveProjectPaymentPlans(binghattiUnits, false);
    expect(rows.map((r) => r.down)).toEqual([20, 100]);
    expect(entryDownPayment(rows)).toBe(20);
  });

  it('is empty — not broken — for a project whose units carry no plans', () => {
    expect(resolveProjectPaymentPlans([unit('x', { total_price: 1 })], true)).toEqual([]);
    expect(entryDownPayment([])).toBe(0);
  });

  it('renders the %-split in the requested language, not the app language', () => {
    expect(resolveProjectPaymentPlans(safaUnits, false)[0]!.label)
      .toBe('20% down / 75% during construction / 5% on handover');
  });
});

describe('resolveUnitPaymentPlans', () => {
  it('groups one unit\'s cards by structure and counts OFFERS', () => {
    const u = unit('b1', {
      payment_plans: [
        { plan: '01', down: 20, before_handover: 50, on_handover: 30, price: 2_600_000, price_sar: 2_655_000 },
        { plan: '01', down: 20, before_handover: 50, on_handover: 30, price: 2_500_000, price_sar: 2_552_000 },
      ],
    });
    const rows = resolveUnitPaymentPlans(u, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
    expect(rows[0]!.countKind).toBe('offers');
    expect(rows[0]!.minAed).toBe(2_500_000);
    expect(rows[0]!.maxAed).toBe(2_600_000);
  });

  it('handles a missing record', () => {
    expect(resolveUnitPaymentPlans(undefined, true)).toEqual([]);
  });
});

describe('formatPlanPriceRange', () => {
  it('collapses an equal min/max to one figure and em-dashes an empty one', () => {
    expect(formatPlanPriceRange(1_500_000, 1_500_000, 'ر.س')).toBe('1,500,000 ر.س');
    expect(formatPlanPriceRange(1_400_000, 1_600_000, 'SAR')).toBe('1,400,000 SAR — 1,600,000 SAR');
    expect(formatPlanPriceRange(0, 0, 'SAR')).toBe('—');
  });
});

describe('composePaymentPlansMessage', () => {
  const rows = resolveProjectPaymentPlans(safaUnits, true);

  it('leads with the project, lists every plan with its split, schedule and price', () => {
    const msg = composePaymentPlansMessage({ projectName: 'صفا 80', rows, isAr: true });
    expect(msg.split('\n')[0]).toBe('خطط السداد — صفا 80');
    expect(msg).toContain('1) خطة صفا (البوابة)');
    expect(msg).toContain('20% مقدم / 75% أثناء الإنشاء / 5% عند التسليم');
    expect(msg).toContain(SAFA_SCHEDULE);
    expect(msg).toContain('السعر بالريال: 1,435,270 ر.س — 1,595,590 ر.س');
    // Both structures are listed — nothing is capped or truncated.
    expect(msg).toContain('2) خطة صفا (البوابة)');
  });

  it('states off-plan status and the handover month when the project is off-plan', () => {
    const msg = composePaymentPlansMessage({
      projectName: 'صفا 80',
      rows,
      isAr: true,
      deliveryPhrase: 'على الخارطة — التسليم المتوقع أغسطس 2028',
    });
    expect(msg).toContain('الحالة: على الخارطة — التسليم المتوقع أغسطس 2028');
  });

  it('writes NO status line when the status is unknown', () => {
    const msg = composePaymentPlansMessage({ projectName: 'صفا 80', rows, isAr: true, deliveryPhrase: null });
    expect(msg).not.toContain('الحالة:');
  });

  it('omits the AED line for a Saudi project and includes it for a Dubai one', () => {
    expect(composePaymentPlansMessage({ projectName: 'صفا 80', rows, isAr: true })).not.toContain('د.إ');
    const dubai = composePaymentPlansMessage({
      projectName: 'Binghatti Twilight',
      rows: resolveProjectPaymentPlans(binghattiUnits, false),
      isAr: false,
    });
    expect(dubai).toContain('Price: 2,608,515 AED — 3,100,000 AED');
    expect(dubai).toContain('Price in SAR:');
  });

  it('appends the public link only when one is supplied', () => {
    const withLink = composePaymentPlansMessage({
      projectName: 'صفا 80', rows, isAr: true, link: 'https://wassel.re/project?id=a#units',
    });
    expect(withLink).toContain('الرابط: https://wassel.re/project?id=a#units');
    expect(composePaymentPlansMessage({ projectName: 'صفا 80', rows, isAr: true })).not.toContain('الرابط');
  });

  it('says the price varies by unit (the range is across units, not one price)', () => {
    expect(composePaymentPlansMessage({ projectName: 'صفا 80', rows, isAr: true }))
      .toContain('السعر يختلف حسب الوحدة');
  });
});
