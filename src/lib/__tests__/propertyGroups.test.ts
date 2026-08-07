import { describe, it, expect } from 'vitest';
import { groupRecordsByProperty } from '../marketListings/propertyGroups';
import type { AppRecord } from '@/types';

/**
 * Fixtures are REAL rows copied out of wassell-prod `market_listings` after the
 * 2026-08-08 Aqar dupe-group backfill — the same shapes the summary view
 * projects into the store (price arrives as a JSON number).
 */
const rec = (id: string, data: Record<string, unknown>): AppRecord =>
  ({ id, model_id: 'm', data, created_at: '', updated_at: '' }) as unknown as AppRecord;

/** Deed-keyed (`dn_`): one 312 m² plot in Riyadh, three brokers, 2.8M–3.0M. */
const DEED = [
  rec('a1', { price: 3000000, dupe_group_id: 'dn_1019292974200000_312_24.8829_46.6230', dupe_role: 'canonical', advertiser_name: 'شركة واحة التعمير العقاري شركة شخص واحد' }),
  rec('a2', { price: 2800000, dupe_group_id: 'dn_1019292974200000_312_24.8829_46.6230', dupe_role: 'duplicate', advertiser_name: 'مكتب روائع الرياض الجديده للخدمات العقارية' }),
  rec('a3', { price: 2800000, dupe_group_id: 'dn_1019292974200000_312_24.8829_46.6230', dupe_role: 'duplicate', advertiser_name: 'مكتب روائع الرياض الجديده للخدمات العقارية' }),
  rec('a4', { price: 2800000, dupe_group_id: 'dn_1019292974200000_312_24.8829_46.6230', dupe_role: 'duplicate', advertiser_name: 'مكتب العولمة للعقارات' }),
];

/** Coordinates+area only (`ga_`) — no official identifier, so tier 3. */
const GEO = [
  rec('g1', { price: 270000, dupe_group_id: 'ga_24.4136_46.8421_600', dupe_role: 'canonical', advertiser_name: 'حمد القحطاني' }),
  rec('g2', { price: 400000, dupe_group_id: 'ga_24.4136_46.8421_600', dupe_role: 'duplicate', advertiser_name: 'مكتب عبدالله ابراهيم المنيع للعقارات' }),
  rec('g3', { price: 300000, dupe_group_id: 'ga_24.4136_46.8421_600', dupe_role: 'duplicate', advertiser_name: 'سعد بن حمد بن محمد القحطاني' }),
];

/** RERA-permit keyed (`pk_`), written by the UAE importer — also confirmed. */
const PERMIT = [
  rec('p1', { price: 7400000, dupe_group_id: 'pk_1144589547', dupe_role: 'canonical', advertiser_name: 'Elliot Hughes' }),
  rec('p2', { price: 3400000, dupe_group_id: 'pk_1144589547', dupe_role: 'duplicate', advertiser_name: 'Elliot Hughes' }),
];

describe('groupRecordsByProperty', () => {
  it('collapses a deed-keyed property to one row carrying every broker', () => {
    const { rows, groups, collapsed } = groupRecordsByProperty(DEED);

    expect(rows).toHaveLength(1);
    expect(collapsed).toBe(3);

    const g = groups.get('a1');
    expect(g).toBeDefined();
    expect(g!.tier).toBe(2);
    expect(g!.members).toHaveLength(4);
    // Three distinct advertisers across four ads — one broker posted twice.
    expect(g!.agentCount).toBe(3);
    expect(g!.priceMin).toBe(2800000);
    expect(g!.priceMax).toBe(3000000);
  });

  it('treats a coordinates+area key as probable and an identifier key as confirmed', () => {
    expect(groupRecordsByProperty(GEO).groups.get('g1')!.tier).toBe(3);
    expect(groupRecordsByProperty(DEED).groups.get('a1')!.tier).toBe(2);
    // The UAE importer's permit keys must not be labelled "probable".
    expect(groupRecordsByProperty(PERMIT).groups.get('p1')!.tier).toBe(2);
  });

  it('groups the UAE portals too, not just Aqar', () => {
    const { rows, groups, collapsed } = groupRecordsByProperty(PERMIT);
    expect(rows).toHaveLength(1);
    expect(collapsed).toBe(1);
    expect(groups.get('p1')!.members).toHaveLength(2);
  });

  it('keeps the first row in the incoming order as the representative', () => {
    // Grouping runs AFTER the sort, so whichever member sorts first must be the
    // row that survives — otherwise the user's sort silently stops applying.
    // `dupe_role` is deliberately NOT consulted for this.
    const reversed = [...DEED].reverse();
    const { rows, groups } = groupRecordsByProperty(reversed);
    expect(rows[0]!.id).toBe('a4');
    expect(groups.has('a4')).toBe(true);
    expect(groups.has('a1')).toBe(false);
  });

  it('leaves a user-split listing out of its group', () => {
    const split = DEED.map((r, i) => (i === 1 ? rec(r.id, { ...r.data, dupe_split: true }) : r));
    const { rows, groups, collapsed } = groupRecordsByProperty(split);

    expect(rows).toHaveLength(2); // the group's representative + the split-out row
    expect(collapsed).toBe(2);
    expect(groups.get('a1')!.members.map((m) => m.id)).not.toContain('a2');
  });

  it('never groups unkeyed listings together', () => {
    // Rows with no identifier AND no usable coordinates must each stand alone,
    // not collapse into one giant "null key" property.
    const unkeyed = [
      rec('x', { price: 1, dupe_group_id: null }),
      rec('y', { price: 2 }),
      rec('z', { price: 3, dupe_group_id: '' }),
    ];
    const { rows, groups, collapsed } = groupRecordsByProperty(unkeyed);
    expect(rows).toHaveLength(3);
    expect(groups.size).toBe(0);
    expect(collapsed).toBe(0);
  });

  it('passes non-market models through untouched', () => {
    const plain = [rec('m1', { name: 'a' }), rec('m2', { name: 'b' })];
    const { rows, groups, collapsed } = groupRecordsByProperty(plain);
    expect(rows).toEqual(plain);
    expect(groups.size).toBe(0);
    expect(collapsed).toBe(0);
  });

  it('does not treat a lone keyed listing as a group', () => {
    const { rows, groups } = groupRecordsByProperty([DEED[0]!]);
    expect(rows).toHaveLength(1);
    expect(groups.size).toBe(0);
  });
});
