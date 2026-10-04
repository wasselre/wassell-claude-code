import { describe, it, expect } from 'vitest';
import { brakeReason, mapFloor, mapUnitType, normUnitKey, reconcile } from '../projectUpdates/reconcile';
import { declaredTotal, extractProjectList, extractUnitJsons, rivaUnit } from '../projectUpdates/riva';
import type { CrmUnit, ReconcilePolicy, SourceUnit } from '../projectUpdates/types';

const CTX = { projectId: 'p1', developerId: 'd1', projectName: 'أكنان 25', sourceLabel: 'بوابة وسطاء ريفا', today: '2026-10-04' };
const RIVA: ReconcilePolicy = { absentAvailable: 'leave', createMissing: true, updatePrices: true };
const SHEET: ReconcilePolicy = { absentAvailable: 'sold', createMissing: true, updatePrices: true };

function crm(id: string, data: Record<string, unknown>): CrmUnit {
  return { id, data: { unit_status: 'available', ...data } };
}
function src(model: string, extra: Partial<SourceUnit> = {}): SourceUnit {
  return { sourceId: model, unitModel: model, ...extra };
}

describe('normUnitKey — the join key', () => {
  it('treats «17 - A» and «17-A» as the same unit', () => {
    expect(normUnitKey('17 - A')).toBe(normUnitKey('17-A'));
  });
  it('drops «( وحدة العرض )» and leading zeros', () => {
    expect(normUnitKey('A01 ( وحدة العرض )')).toBe('A1');
  });
  it('reads Arabic-Indic digits', () => {
    expect(normUnitKey('١٧-A')).toBe('17-A');
  });
});

describe('reconcile — status + price', () => {
  it('takes the source status and price for a matched unit', () => {
    const r = reconcile([crm('u1', { unit_model: '10-B', total_price: 1_000_000 })],
      [src('10 - B', { status: 'reserved', price: 1_050_000 })], RIVA, CTX);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]!.patch).toEqual({ unit_status: 'reserved', total_price: 1_050_000 });
    expect(r.stats.toSoldOrReserved).toBe(1);
  });
  it('writes nothing when the unit already matches', () => {
    const r = reconcile([crm('u1', { unit_model: '10-B', total_price: 900000 })],
      [src('10-B', { status: 'available', price: 900000 })], RIVA, CTX);
    expect(r.updates).toHaveLength(0);
  });
  it('never overwrites a price with «عند الطلب» (no price)', () => {
    const r = reconcile([crm('u1', { unit_model: 'A1', total_price: 700000 })],
      [src('A1', { status: 'available', price: null })], RIVA, CTX);
    expect(r.updates).toHaveLength(0);
  });
  it('a source that hides prices (updatePrices=false) changes status only', () => {
    const r = reconcile([crm('u1', { unit_model: 'A1', total_price: 700000 })],
      [src('A1', { status: 'sold', price: 650000 })], { ...RIVA, updatePrices: false }, CTX);
    expect(r.updates[0]!.patch).toEqual({ unit_status: 'sold' });
  });
});

describe('reconcile — units the source does not list', () => {
  const units = [crm('u1', { unit_model: 'A1' }), crm('u2', { unit_model: 'A2' }), crm('u3', { unit_model: 'A3', unit_status: 'reserved' })];
  it('Riva: leaves them alone (the portal hides some cards)', () => {
    const r = reconcile(units, [src('A1')], RIVA, CTX);
    expect(r.updates).toHaveLength(0);
    expect(r.missingFromSource).toEqual(['A2', 'A3']);
  });
  it('an available-units sheet: available → sold, reserved untouched', () => {
    const r = reconcile(units, [src('A1')], SHEET, CTX);
    expect(r.updates.map((u) => [u.label, u.patch.unit_status])).toEqual([['A2', 'sold']]);
    expect(r.missingFromSource).toEqual(['A3']);
  });
});

describe('reconcile — matching safety', () => {
  it('skips a source unit that matches two CRM units instead of guessing', () => {
    const r = reconcile([crm('u1', { unit_model: 'A1' }), crm('u2', { unit_model: 'A-1'.replace('-', '') })],
      [src('A1', { status: 'sold' })], RIVA, CTX);
    expect(r.ambiguous).toEqual(['A1']);
    expect(r.updates).toHaveLength(0);
  });
  it('falls back to (building, unit number) when the code does not match', () => {
    const r = reconcile([crm('u1', { unit_model: 'X', building_number: '6', unit_number: 2 })],
      [{ sourceId: 's', unitModel: 'عمارة 6 شقة 2', buildingNumber: '6', unitNumber: 2, status: 'reserved' }], RIVA, CTX);
    expect(r.updates[0]!.unitId).toBe('u1');
  });
  it('counts a unit listed twice (unstable pagination) once', () => {
    const r = reconcile([crm('u1', { unit_model: 'A1' })], [src('A1', { status: 'sold' }), src('A1', { status: 'sold' })], RIVA, CTX);
    expect(r.updates).toHaveLength(1);
    expect(r.stats.sourceUnits).toBe(1);
  });
});

describe('reconcile — new units', () => {
  it('creates a released unit and copies layout fields from the closest sibling', () => {
    const sib = crm('u1', { unit_model: '10-B', unit_type: 'شقة', bedrooms: 2, unit_area: 150, unit_components: ['مجلس', 'مطبخ'], parking_space: ['internal'] });
    const r = reconcile([sib], [src('10-B'), src('32-B', { unitType: 'شقة', bedrooms: 2, area: 151, price: 1_439_000, status: 'available', floor: '1' })], RIVA, CTX);
    expect(r.creates).toHaveLength(1);
    const d = r.creates[0]!.data;
    expect(d).toMatchObject({ project_id: 'p1', developer_id: 'd1', unit_model: '32-B', unit_type: 'شقة', total_price: 1_439_000, unit_area: 151, floor: '1', unit_components: ['مجلس', 'مطبخ'], parking_space: ['internal'], unit_status: 'available' });
    expect(String(d.notes)).toContain('10-B');
  });
  it('does not import a unit the source already shows as sold', () => {
    const r = reconcile([], [src('Z9', { status: 'sold' })], RIVA, CTX);
    expect(r.creates).toHaveLength(0);
  });
});

describe('brakeReason — the safety brake', () => {
  const many = Array.from({ length: 10 }, (_, i) => crm(`u${i}`, { unit_model: `A${i}` }));
  it('holds a run that would sell 8 of 10 units at once', () => {
    const r = reconcile(many, many.slice(0, 8).map((u) => src(String(u.data.unit_model), { status: 'sold' })), RIVA, CTX);
    expect(brakeReason(r, { share: 0.5, minUnits: 6 })).toMatch(/8 of 10/);
  });
  it('lets a normal week through (2 of 10)', () => {
    const r = reconcile(many, many.slice(0, 2).map((u) => src(String(u.data.unit_model), { status: 'sold' })), RIVA, CTX);
    expect(brakeReason(r, { share: 0.5, minUnits: 6 })).toBeNull();
  });
  it('holds an empty scrape of a project that has units', () => {
    const r = reconcile(many, [], RIVA, CTX);
    expect(brakeReason(r, { share: 0.5, minUnits: 6 })).toMatch(/no units/);
  });
});

describe('mapUnitType / mapFloor', () => {
  it('maps source wording to the units options', () => {
    expect(mapUnitType('تاون هاوس')).toBe('تاون هاوس');
    expect(mapUnitType('Penthouse')).toBe('بنتهاوس');
    expect(mapUnitType('شقة سكنية')).toBe('شقة');
    expect(mapFloor('الدور الأرضي')).toBe('ارضي');
    expect(mapFloor('3')).toBe('3');
    expect(mapFloor('0')).toBe('ارضي');
    expect(mapFloor('غير معروف')).toBeNull();
  });
});

describe('Riva portal parsing', () => {
  // Laravel's Js::from() output inside an Alpine @click attribute.
  const unit = { id: 901, title: '32 - B', building_number: '2', unit_number: 32, unit_type: 'شقة', unit_area: '151', beadrooms: 2, bathrooms: 3, floor: '1', case: 1, unit_price: '1,439,000', raw_price: null, gallery: [{ url: 'https://fls-x.laravel.cloud/a.png', is_plan: false }, { url: 'https://fls-x.laravel.cloud/plan.png', is_plan: true }], description: "غرفة نوم ماستر - مجلس" };
  const js = JSON.stringify(unit).replace(/"/g, '\\u0022').replace(/'/g, '\\u0027').replace(/\//g, '\\/');
  const html = `<div><button type="button" @click="selectedUnit = JSON.parse('${js}'); open = true">التفاصيل</button></div>
    <div><button @click="selectedUnit = JSON.parse('{\\u0022id\\u0022:902,\\u0022title\\u0022:\\u002233 - B\\u0022,\\u0022case\\u0022:2,\\u0022unit_price\\u0022:\\u0022\\u0022}')">x</button></div>
    <p class="text-sm">Showing <span>1</span> to <span>12</span> of <span>69</span> results</p>`;

  it('pulls every unit JSON out of the card buttons', () => {
    const js2 = extractUnitJsons(html);
    expect(js2).toHaveLength(2);
    expect(js2[0]!.title).toBe('32 - B');
  });
  it('maps case / price / plan', () => {
    const u = rivaUnit(extractUnitJsons(html)[0]!);
    expect(u).toMatchObject({ sourceId: '901', unitModel: '32 - B', status: 'reserved', price: 1_439_000, area: 151, bedrooms: 2, planUrl: 'https://fls-x.laravel.cloud/plan.png' });
    const sold = rivaUnit(extractUnitJsons(html)[1]!);
    expect(sold.status).toBe('sold');
    expect(sold.price).toBeNull();
  });
  it('also decodes an HTML-entity-escaped payload', () => {
    const ent = `<button @click="selectedUnit = JSON.parse('{&quot;id&quot;:5,&quot;title&quot;:&quot;A1&quot;,&quot;case&quot;:0}')">`;
    expect(rivaUnit(extractUnitJsons(ent)[0]!)).toMatchObject({ unitModel: 'A1', status: 'available' });
  });
  it('reads the declared total from the footer', () => {
    expect(declaredTotal(html)).toBe(69);
  });
  it('lists projects from the cards', () => {
    const list = extractProjectList(`<a href="https://riva.sa/broker/projects/71" class="c"><img alt="أكنان 25"><h3>أكنان 25</h3><p>12 وحدة متاحة من 69</p></a><a href="/broker/projects/76">أكنان 23</a><a href="/broker/projects/71">التفاصيل</a>`);
    expect(list.map((p) => p.id)).toEqual(['71', '76']);
    expect(list[0]!.name).toContain('أكنان 25');
  });
});
