import { describe, expect, it, vi } from 'vitest';
import {
  BINGHATTI_FX_RATE, BINGHATTI_MAX_AGE_MS, binghattiOptionsOf, binghattiPolicy,
  binghattiProjectId, binghattiProjectIdFromRow, enrichBinghattiTypes,
  fetchBinghattiProject, loadBinghattiSnapshot, parseBinghattiSnapshot,
} from '../projectUpdates/binghatti';
import { mapUnitType, numericUnitNumber, reconcile } from '../projectUpdates/reconcile';
import type { CrmUnit, ReconcilePolicy } from '../projectUpdates/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import realCapture from '../projectUpdates/fixtures/binghatti-real-inventory.json';
import realCrm from '../projectUpdates/fixtures/binghatti-crm-units.json';

const NOW = Date.parse('2026-10-05T08:00:00Z');
const OPTIONS = { areaBasis: 'net' as const, areaUnit: 'sqft' as const, unitTypeMap: { residential: 'شقة', commercial: 'مكتب' } };
const CTX = { projectId: 'crm-project', developerId: 'developer', projectName: 'Synthetic project', sourceLabel: 'Binghatti test', today: '2026-10-05' };
const POLICY: ReconcilePolicy = { absentAvailable: 'sold', createMissing: true, updatePrices: true, keepReserved: true, matchByUnitNumber: true };

// Synthetic contract examples, NOT a live capture or evidence for production
// project/type mappings. A trimmed real capture is added after first sign-in.
function item(extra: Record<string, unknown> = {}) {
  return { id: 'unit-1', projectId: 'phase-1', number: 'TA208', code: 'EXAMPLE-208', unitTypeId: 'residential', actualPrice: 1_000_000,
    netArea: 603.75, totalArea: 663.16, bedroomsCount: 1, floorNumber: 2, ...extra };
}
function capture(items = [item()], savedAt = '2026-10-05T07:00:00Z') {
  return { saved_at: savedAt, totalCount: items.length, items };
}
function crm(id: string, data: Record<string, unknown>): CrmUnit {
  return { id, data: { unit_status: 'available', ...data } };
}

describe('Binghatti complete capture gate', () => {
  it('requires a fresh complete snapshot with unique valid row identities', () => {
    const snapshot = parseBinghattiSnapshot(capture(), NOW);
    expect(snapshot.fresh).toBe(true);
    expect(snapshot.totalCount).toBe(1);
    expect([...snapshot.byProject.keys()]).toEqual(['phase-1']);
    expect(() => parseBinghattiSnapshot({ ...capture(), totalCount: 2 }, NOW)).toThrow(/incomplete/);
    expect(() => parseBinghattiSnapshot(capture([item(), item()]), NOW)).toThrow(/duplicate/);
    expect(() => parseBinghattiSnapshot(capture([item({ projectId: '' })]), NOW)).toThrow(/valid/);
    expect(() => parseBinghattiSnapshot(capture([item({ id: {} })]), NOW)).toThrow(/valid/);
    expect(() => parseBinghattiSnapshot(capture([item({ code: null, number: 'unidentified' })]), NOW)).toThrow(/stable code/);
    expect(() => parseBinghattiSnapshot({ ...capture(), saved_at: 'broken' }, NOW)).toThrow(/saved_at/);
    expect(() => parseBinghattiSnapshot(capture(undefined, '2026-10-05T09:00:00Z'), NOW)).toThrow(/future/);
  });
  it('refuses every write from an absent or stale capture (36 hours is stale)', async () => {
    const stale = parseBinghattiSnapshot(capture(undefined, new Date(NOW - BINGHATTI_MAX_AGE_MS).toISOString()), NOW);
    expect(stale.fresh).toBe(false);
    await expect(fetchBinghattiProject('phase-1', stale, OPTIONS)).rejects.toThrow(/36 hours/);
    await expect(fetchBinghattiProject('phase-1', null, OPTIONS)).rejects.toThrow(/complete/);
  });
  it('loads the private portal file and surfaces non-missing storage errors', async () => {
    const download = vi.fn().mockResolvedValue({ data: { text: async () => JSON.stringify(capture()) }, error: null });
    const client = { storage: { from: vi.fn(() => ({ download })) } } as unknown as SupabaseClient;
    expect((await loadBinghattiSnapshot(client, 'portal-id', NOW))?.fresh).toBe(true);
    expect(download).toHaveBeenCalledWith('inventory/portal-id/units.json');
    download.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    expect(await loadBinghattiSnapshot(client, 'portal-id', NOW)).toBeNull();
    download.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    await expect(loadBinghattiSnapshot(client, 'portal-id', NOW)).rejects.toThrow(/permission denied/);
  });
});

describe('Binghatti genuine captured row (August 7, explicitly trimmed)', () => {
  it('cannot be mistaken for a complete production capture', () => {
    expect(() => parseBinghattiSnapshot(realCapture, NOW)).toThrow(/trimmed fixture/);
  });
  it('matches the real CRM code, area convention and AED price without guessing a type id', async () => {
    // Test-only wrapper around the genuine row. Preserve its original time
    // and evaluate freshness at that time; the production fixture stays stale
    // and visibly trimmed. This does not certify an actual complete capture.
    const snapshot = parseBinghattiSnapshot({ saved_at: realCapture.saved_at, totalCount: 1, items: realCapture.items }, Date.parse(realCapture.saved_at));
    const src = await fetchBinghattiProject('10101', snapshot, { ...OPTIONS, unitTypeMap: {} });
    expect(src.units[0]?.unitType).toBeNull();
    await enrichBinghattiTypes(src, realCrm.units);
    expect(src.units[0]).toMatchObject({ sourceId: '84934', unitCode: 'BWRT-645', unitType: 'شقة', bedrooms: 1,
      area: 56.1, sourceNetArea: 603.86, sourceTotalArea: 663.27, sourceAreaUnit: 'sqft',
      sourcePrice: 1_336_999, price: 1_365_214, sourceUnitType: 'One Bedroom', sourceUnitTypeId: '2' });
    // A trimmed example is tested with 'leave': its absent BWRT-208 row is
    // not evidence that that unit has sold.
    const result = reconcile(realCrm.units, src.units, { ...POLICY, absentAvailable: 'leave' }, CTX);
    expect(result.stats.matched).toBe(1);
    expect(result.updates[0]?.unitId).toBe('0e3e6953-8863-4cf2-9030-0786f1d1f1d2');
    expect(result.updates.every((unit) => unit.patch.unit_status !== 'sold')).toBe(true);
  });
});

describe('Binghatti mapping', () => {
  it('converts AED and square feet, retaining original values', async () => {
    const src = await fetchBinghattiProject('phase-1', parseBinghattiSnapshot(capture(), NOW), OPTIONS);
    expect(src.units[0]).toMatchObject({ sourceId: 'unit-1', unitCode: 'EXAMPLE-208', unitNumber: 208,
      price: 1_021_103, sourcePrice: 1_000_000, sourceCurrency: 'AED', sourceFxRate: BINGHATTI_FX_RATE,
      area: 56.09, sourceNetArea: 603.75, sourceTotalArea: 663.16, bedrooms: 1, floor: '2', status: 'available' });
    const total = await fetchBinghattiProject('phase-1', parseBinghattiSnapshot(capture(), NOW), { ...OPTIONS, areaBasis: 'total' });
    expect(total.units[0]?.area).toBe(61.61);
    const sqm = await fetchBinghattiProject('phase-1', parseBinghattiSnapshot(capture([item({ netArea: 56.09 })]), NOW), { ...OPTIONS, areaUnit: 'sqm' });
    expect(sqm.units[0]?.area).toBe(56.09);
  });
  it('requires the verified area convention; it never substitutes the other area', async () => {
    expect(() => binghattiOptionsOf({ binghatti_area_basis: 'net' })).toThrow(/area_unit/);
    expect(() => binghattiOptionsOf({ binghatti_area_unit: 'sqft' })).toThrow(/area_basis/);
    const src = await fetchBinghattiProject('phase-1', parseBinghattiSnapshot(capture([item({ netArea: null })]), NOW), OPTIONS);
    const result = reconcile([], src.units, POLICY, CTX);
    expect(result.creates).toHaveLength(0);
    expect(result.incomplete[0]?.missing).toEqual(['area']);
  });
  it('maps studios and offices without guessing unknown portal types', async () => {
    const src = await fetchBinghattiProject('phase-1', parseBinghattiSnapshot(capture([
      item({ bedroomsCount: 0 }),
      item({ id: 'unit-2', code: 'EXAMPLE-209', number: 'OF209', bedroomsCount: 0, unitTypeId: 'commercial' }),
      item({ id: 'unit-3', code: 'EXAMPLE-210', number: '210', bedroomsCount: 0, unitTypeId: 'unknown' }),
    ]), NOW), OPTIONS);
    const result = reconcile([], src.units, POLICY, CTX);
    expect(result.creates.map((unit) => [unit.data.unit_type, unit.data.bedrooms])).toEqual([['استوديو', 0], ['مكتب', 0]]);
    expect(result.incomplete).toEqual([{ unit: 'EXAMPLE-210', missing: ['unit_type'] }]);
    expect(mapUnitType('إستوديو')).toBe('استوديو');
    expect(mapUnitType('Office')).toBe('مكتب');
  });
  it('derives types only from exact unique code joins and rejects conflicting evidence', async () => {
    const snapshot = parseBinghattiSnapshot(capture([
      item({ unitTypeId: 'unmapped' }), item({ id: 'unit-2', code: 'EXAMPLE-209', number: 209, unitTypeId: 'unmapped' }),
    ]), NOW);
    const src = await fetchBinghattiProject('phase-1', snapshot, { ...OPTIONS, unitTypeMap: {} });
    await enrichBinghattiTypes(src, [crm('one', { developer_unit_code: 'EXAMPLE-208', unit_type: 'شقة' })]);
    expect(src.units.map((unit) => unit.unitType)).toEqual(['شقة', 'شقة']);
    const conflict = await fetchBinghattiProject('phase-1', snapshot, { ...OPTIONS, unitTypeMap: {} });
    await enrichBinghattiTypes(conflict, [crm('one', { developer_unit_code: 'EXAMPLE-208', unit_type: 'شقة' }), crm('two', { developer_unit_code: 'EXAMPLE-209', unit_type: 'مكتب' })]);
    expect(conflict.units.every((unit) => unit.unitType == null)).toBe(true);
    expect(conflict.meta?.conflicting_unit_type_ids).toEqual(['unmapped:other']);
    const duplicate = await fetchBinghattiProject('phase-1', snapshot, { ...OPTIONS, unitTypeMap: {} });
    await enrichBinghattiTypes(duplicate, [crm('one', { developer_unit_code: 'EXAMPLE-208', unit_type: 'شقة' }), crm('two', { developer_unit_code: 'EXAMPLE-208', unit_type: 'شقة' })]);
    expect(duplicate.units.every((unit) => unit.unitType == null)).toBe(true);
  });
  it('merges Skyflame / Flare style phases before reconciling, preventing double-sell', async () => {
    const snapshot = parseBinghattiSnapshot(capture([
      item(), item({ id: 'unit-2', projectId: 'phase-2', number: 'TA209', code: 'EXAMPLE-209' }),
    ]), NOW);
    const id = binghattiProjectIdFromRow({ source_project_ids: ['phase-1', 'phase-2'], source_url: 'https://partners.binghatti.com/Properties?projectId=phase-1' });
    expect(id).toBe('phase-1,phase-2');
    expect(binghattiProjectId('https://partners.binghatti.com/Properties?projectId=phase-1,phase-2')).toBe(id);
    expect(binghattiProjectId('https://example.com/Properties?projectId=phase-1')).toBeNull();
    const src = await fetchBinghattiProject(id!, snapshot, OPTIONS);
    const result = reconcile([crm('one', { developer_unit_code: 'EXAMPLE-208' }), crm('two', { developer_unit_code: 'EXAMPLE-209' })], src.units, binghattiPolicy('full', src), CTX);
    expect(result.stats.matched).toBe(2);
    expect(result.updates.some((unit) => unit.patch.unit_status === 'sold')).toBe(false);
  });
  it('rejects a code-less row whose fallback number is duplicated across merged phases', async () => {
    const snapshot = parseBinghattiSnapshot(capture([
      item({ code: null }), item({ id: 'unit-2', projectId: 'phase-2', number: 'OF208', code: 'EXAMPLE-OTHER' }),
    ]), NOW);
    await expect(fetchBinghattiProject(['phase-1', 'phase-2'], snapshot, OPTIONS)).rejects.toThrow(/non-unique fallback/);
  });
});

describe('Binghatti matching and FX writes through the shared reconciler', () => {
  it('matches developer code before numeric fallback and keeps CRM reservations', async () => {
    const src = await fetchBinghattiProject('phase-1', parseBinghattiSnapshot(capture(), NOW), OPTIONS);
    const result = reconcile([
      crm('code', { developer_unit_code: 'EXAMPLE-208', unit_number: 999, unit_status: 'reserved' }),
      crm('number', { developer_unit_code: 'OTHER', unit_number: 'TA208', unit_status: 'reserved' }),
    ], src.units, POLICY, CTX);
    expect(result.stats.matched).toBe(1);
    expect(result.updates[0]?.unitId).toBe('code');
    expect(result.updates[0]?.patch.unit_status).toBeUndefined();
  });
  it('strips leading letters only under the source opt-in and only when unique on both sides', async () => {
    const src = await fetchBinghattiProject('phase-1', parseBinghattiSnapshot(capture(), NOW), OPTIONS);
    const unit = crm('one', { unit_number: 'TA208' });
    expect(reconcile([unit], src.units, { ...POLICY, absentAvailable: 'leave', matchByUnitNumber: false }, CTX).stats.matched).toBe(0);
    expect(reconcile([unit], src.units, POLICY, CTX).stats.matched).toBe(1);
    expect(numericUnitNumber('OF112')).toBe(112);
    expect(numericUnitNumber('208-other')).toBeNull();
    const ambiguous = reconcile([unit, crm('two', { unit_number: 208 })], src.units, POLICY, CTX);
    expect(ambiguous.ambiguous).toHaveLength(1);
    expect(ambiguous.updates).toHaveLength(0); // Ambiguity is never evidence for sold.
    const duplicateNumber = await fetchBinghattiProject('phase-1', parseBinghattiSnapshot(capture([
      item(), item({ id: 'unit-2', code: 'EXAMPLE-OTHER', number: 'OF208' }),
    ]), NOW), OPTIONS);
    expect(reconcile([unit], duplicateNumber.units, POLICY, CTX).stats.matched).toBe(0);
    expect(reconcile([unit], duplicateNumber.units, POLICY, CTX).updates).toHaveLength(0);
  });
  it('writes foreign and SAR prices together for changes and new units; a second run is empty', async () => {
    const src = await fetchBinghattiProject('phase-1', parseBinghattiSnapshot(capture(), NOW), OPTIONS);
    const original = crm('one', { developer_unit_code: 'EXAMPLE-208', total_price: 999_999 });
    const result = reconcile([original], src.units, POLICY, CTX);
    expect(result.updates[0]?.patch).toEqual({ total_price: 1_021_103, source_price: 1_000_000, source_currency: 'AED', source_fx_rate: BINGHATTI_FX_RATE });
    const updated = { ...original, data: { ...original.data, ...result.updates[0]!.patch } };
    expect(reconcile([updated], src.units, POLICY, CTX).updates).toHaveLength(0);
    const created = reconcile([], src.units, POLICY, CTX).creates[0]?.data;
    expect(created).toMatchObject({ total_price: 1_021_103, source_price: 1_000_000, source_currency: 'AED', source_fx_rate: BINGHATTI_FX_RATE,
      source_net_area: 603.75, source_total_area: 663.16, source_unit_type: 'residential', source_floor: '2' });
  });
  it('corrects AED provenance even when rounded SAR is unchanged and respects status-only', async () => {
    const src = await fetchBinghattiProject('phase-1', parseBinghattiSnapshot(capture(), NOW), OPTIONS);
    const original = crm('one', { developer_unit_code: 'EXAMPLE-208', total_price: 1_021_103, source_price: 999_999.99, source_currency: 'AED', source_fx_rate: BINGHATTI_FX_RATE });
    const result = reconcile([original], src.units, POLICY, CTX);
    expect(Object.keys(result.updates[0]!.patch)).toEqual(['total_price', 'source_price', 'source_currency', 'source_fx_rate']);
    expect(result.stats.priceChanges).toBe(0);
    expect(reconcile([original], src.units, binghattiPolicy('status_only', src), CTX).updates).toHaveLength(0);
    expect(() => reconcile([original], [{ ...src.units[0]!, sourceCurrency: null }], POLICY, CTX)).toThrow(/provenance/);
  });
});
