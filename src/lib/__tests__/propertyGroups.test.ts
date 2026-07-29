import { describe, it, expect } from 'vitest';
import { groupRecordsByProperty } from '../marketListings/propertyGroups';
import type { AppRecord } from '@/types';

/**
 * Fixtures are REAL rows copied out of wassell-prod market_listings after the
 * 2026-08-30 property-identity backfill — same shapes the summary view projects
 * into the store (price/property_tier arrive as JSON numbers, not strings).
 */
const rec = (id: string, data: Record<string, unknown>): AppRecord =>
  ({ id, model_id: 'm', data, created_at: '', updated_at: '' }) as unknown as AppRecord;

/** Deed 717823000238 — a 750 m² plot in الخير, four brokers, 975,000–1,100,002. */
const KHAIR = [
  rec('60cecc64', { price: 975000, property_key: 'D:717823000238:750:25.1346:46.4177', property_tier: 2, advertiser_name: 'مكتب عصر الخير للخدمات العقارية' }),
  rec('34df34a1', { price: 1100002.5, property_key: 'D:717823000238:750:25.1346:46.4177', property_tier: 2, advertiser_name: 'مكتب ابداع الصحافة للخدمات العقارية' }),
  rec('73a6c2ce', { price: 1099500, property_key: 'D:717823000238:750:25.1346:46.4177', property_tier: 2, advertiser_name: 'شركة دار الروافد لتقنية المعلومات شركة شخص واحد' }),
  rec('7ffa2a77', { price: 999750, property_key: 'D:717823000238:750:25.1346:46.4177', property_tier: 2, advertiser_name: 'مؤسسة نتائج العقارية' }),
];

/** A tier-3 (coordinates + area, no deed) trio — 600 m² at 24.4136/46.8421. */
const TIER3 = [
  rec('d89c4a40', { price: 300000, property_key: 'G:24.4136:46.8421:600', property_tier: 3, advertiser_name: 'سعد بن حمد بن محمد القحطاني' }),
  rec('d06b024c', { price: 270000, property_key: 'G:24.4136:46.8421:600', property_tier: 3, advertiser_name: 'حمد القحطاني' }),
  rec('12ed0680', { price: 400000, property_key: 'G:24.4136:46.8421:600', property_tier: 3, advertiser_name: 'مكتب عبدالله ابراهيم المنيع للعقارات' }),
];

describe('groupRecordsByProperty', () => {
  it('collapses a deed-keyed property to one row carrying every broker', () => {
    const { rows, groups, collapsed } = groupRecordsByProperty(KHAIR);

    expect(rows).toHaveLength(1);
    expect(collapsed).toBe(3);

    const g = groups.get('60cecc64');
    expect(g).toBeDefined();
    expect(g!.tier).toBe(2);
    expect(g!.members).toHaveLength(4);
    expect(g!.agentCount).toBe(4);
    // The spread is the point of grouping — the real anchor is the lowest ask.
    expect(g!.priceMin).toBe(975000);
    expect(g!.priceMax).toBe(1100002.5);
  });

  it('keeps the first row in the incoming order as the representative', () => {
    // Grouping runs AFTER the sort, so whichever member sorts first must be the
    // row that survives — otherwise the user's sort silently stops applying.
    const reversed = [...KHAIR].reverse();
    const { rows, groups } = groupRecordsByProperty(reversed);
    expect(rows[0]!.id).toBe('7ffa2a77');
    expect(groups.has('7ffa2a77')).toBe(true);
    expect(groups.has('60cecc64')).toBe(false);
  });

  it('tags a coordinates-only match as tier 3 so the UI can call it probable', () => {
    const { groups } = groupRecordsByProperty(TIER3);
    expect(groups.get('d89c4a40')!.tier).toBe(3);
  });

  it('leaves a user-split listing out of its group', () => {
    const split = KHAIR.map((r, i) =>
      i === 1 ? rec(r.id, { ...r.data, property_split: true }) : r,
    );
    const { rows, groups, collapsed } = groupRecordsByProperty(split);

    expect(rows).toHaveLength(2); // the group's representative + the split-out row
    expect(collapsed).toBe(2);
    expect(groups.get('60cecc64')!.members.map((m) => m.id)).not.toContain('34df34a1');
  });

  it('never groups unkeyed listings together', () => {
    // 2,668 live rows have no deed AND no usable coordinates. They must each
    // stand alone, not collapse into one giant "null key" property.
    const unkeyed = [
      rec('a', { price: 1, property_key: null }),
      rec('b', { price: 2 }),
      rec('c', { price: 3, property_key: '' }),
    ];
    const { rows, groups, collapsed } = groupRecordsByProperty(unkeyed);
    expect(rows).toHaveLength(3);
    expect(groups.size).toBe(0);
    expect(collapsed).toBe(0);
  });

  it('passes non-market models through untouched', () => {
    const plain = [rec('x', { name: 'a' }), rec('y', { name: 'b' })];
    const { rows, groups, collapsed } = groupRecordsByProperty(plain);
    expect(rows).toEqual(plain);
    expect(groups.size).toBe(0);
    expect(collapsed).toBe(0);
  });

  it('does not treat a lone keyed listing as a group', () => {
    const { rows, groups } = groupRecordsByProperty([KHAIR[0]!]);
    expect(rows).toHaveLength(1);
    expect(groups.size).toBe(0);
  });
});
