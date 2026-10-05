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

describe('reconcile — status_only scope (secondary source)', () => {
  const policy: ReconcilePolicy = { absentAvailable: 'leave', createMissing: false, updatePrices: false, forwardOnly: true };
  it('moves status forward only and never touches the price', () => {
    const r = reconcile(
      [crm('u1', { unit_model: 'A1', total_price: 1_261_068 }), crm('u2', { unit_model: 'A2', unit_status: 'sold' })],
      [src('A1', { status: 'reserved', price: 1_201_017 }), src('A2', { status: 'available' })], policy, CTX);
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0]!.patch).toEqual({ unit_status: 'reserved' });
  });
  it('creates nothing', () => {
    const r = reconcile([], [src('Z1', { status: 'available', price: 1 })], policy, CTX);
    expect(r.creates).toHaveLength(0);
  });
});

describe('reconcile — Al-Ramz style ids (unit_model is a layout, not an id)', () => {
  const units = [
    crm('a', { unit_model: 'D', block: '53', building_number: '17', floor: 'اول', unit_number: 67 }),
    crm('b', { unit_model: 'D', block: '53', building_number: '17', floor: 'ارضي', unit_number: 60 }),
    crm('c', { unit_model: 'D', block: '56', building_number: '3', floor: 'اول', unit_number: 4 }),
  ];
  it('matches «بلك 53 عمارة 17 الدور الأول» to the one unit, not to every «D»', () => {
    const r = reconcile(units, [{ sourceId: null, unitModel: null, block: '53', buildingNumber: '17', floor: 'الدور الأول', status: 'reserved' }], RIVA, CTX);
    expect(r.updates.map((u) => u.unitId)).toEqual(['a']);
    expect(r.ambiguous).toEqual([]);
  });
  it('matches a booking post «فيلا 31 / بلك 494» by block + number', () => {
    const r = reconcile([crm('v', { unit_model: 'V2', block: '494', unit_number: 31 }), crm('w', { unit_model: 'V2', block: '494', unit_number: 32 })],
      [{ sourceId: null, unitModel: null, block: '494', unitNumber: 31, status: 'reserved' }], RIVA, CTX);
    expect(r.updates.map((u) => u.unitId)).toEqual(['v']);
  });
  it('reports a code shared by several units as ambiguous instead of guessing', () => {
    const r = reconcile(units, [src('D', { status: 'sold' })], RIVA, CTX);
    expect(r.ambiguous).toEqual(['D']);
    expect(r.updates).toHaveLength(0);
  });
});

describe('visibleText', () => {
  it('drops scripts and tags', async () => {
    const { visibleText } = await import('../projectUpdates/riva');
    expect(visibleText('<head><title>x</title></head><h1>أكنان 24</h1><script>var a=1</script><p>حي الرمال</p>')).toBe('أكنان 24 حي الرمال');
  });
});

describe('rivaProjectMeta — what a new project is created from', () => {
  it('reads place / developer / type / url from the share message, licence + description from the page', async () => {
    const { rivaProjectMeta } = await import('../projectUpdates/riva');
    const share = '\ud83c\udfe1 \u0623\u0643\u0646\u0627\u0646 24 \n\ud83d\udccd \u0627\u0644\u0631\u064a\u0627\u0636 - \u0627\u0644\u0631\u0645\u0627\u0644 \n\ud83c\udfd7\ufe0f \u0627\u0644\u0645\u0637\u0648\u0651\u0631: \u0623\u0643\u0646\u0627\u0646 \n\ud83c\udff7\ufe0f \u0646\u0648\u0639 \u0627\u0644\u0645\u0634\u0631\u0648\u0639: \u0634\u0642\u0642\n\ud83d\udcb0 \u0627\u0644\u0623\u0633\u0639\u0627\u0631 \u062a\u0628\u062f\u0623 \u0645\u0646 692,200 \u0631.\u0633\nhttps:\/\/riva.sa\/project\/aknan-24';
    const html = `<div x-data="{ projectShareMessage: '${share}', shareOpen: false }"><h1>أكنان 24</h1><p>رخصة إعلان: 7201136815</p><p>عمولتك على هذا المشروع 1% من قيمة كل وحدة مباعة يُعد مشروع أكنان 24 أحد المجمعات السكنية الحديثة في حي الرمال بشرق الرياض.</p></div>`;
    expect(rivaProjectMeta(html)).toMatchObject({
      city: 'الرياض', district: 'الرمال', developer: 'أكنان', project_type_text: 'شقق',
      public_url: 'https://riva.sa/project/aknan-24', price_from: 692200, ad_license: '7201136815',
    });
    expect(String(rivaProjectMeta(html).description)).toContain('يُعد مشروع أكنان 24');
  });
});

describe('arKey — Arabic name comparison for developer / district lookup', () => {
  it('ignores «حي», «شركة … للتطوير العقاري», alef forms and spacing', async () => {
    const { arKey } = await import('../projectUpdates/newProject');
    expect(arKey('حي الرمال')).toBe(arKey('الرمال'));
    expect(arKey('شركة أكنان للتطوير العقاري')).toBe(arKey('اكنان'));
  });
});

describe('reconcile — a new project whose units share one title', () => {
  it('creates every unit (nothing in the CRM to confuse them with)', () => {
    const units = Array.from({ length: 10 }, (_, i) => ({ sourceId: `p${i}`, unitModel: 'شقة', status: 'available' as const, price: 692200 + i }));
    const r = reconcile([], units, RIVA, CTX);
    expect(r.creates).toHaveLength(10);
    expect(r.ambiguous).toEqual([]);
  });
  it('but still refuses to guess when the CRM has one of them', () => {
    const units = [{ sourceId: 'p1', unitModel: 'شقة', status: 'sold' as const }, { sourceId: 'p2', unitModel: 'شقة', status: 'available' as const }];
    const r = reconcile([crm('u1', { unit_model: 'شقة' })], units, RIVA, CTX);
    expect(r.updates).toHaveLength(0);
    expect(r.ambiguous.length).toBe(2);
  });
});

describe('reconcile — the source unit id', () => {
  it('records it on a unit matched by title, and matches on it next time', () => {
    const first = reconcile([crm('u1', { unit_model: '10-B' })], [src('10-B', { unitCode: 'RIVA-901' })], RIVA, CTX);
    expect(first.updates[0]!.patch).toEqual({ developer_unit_code: 'RIVA-901' });
    const later = reconcile([crm('u1', { unit_model: 'شقة', developer_unit_code: 'RIVA-901' }), crm('u2', { unit_model: 'شقة', developer_unit_code: 'RIVA-902' })],
      [{ sourceId: '901', unitCode: 'RIVA-901', unitModel: 'شقة', status: 'sold' }], RIVA, CTX);
    expect(later.updates.map((u) => [u.unitId, u.patch.unit_status])).toEqual([['u1', 'sold']]);
  });
  it('never stores one of OUR codes (U-123) as the developer code', () => {
    const r = reconcile([], [{ sourceId: null, unitCode: 'U-123', unitModel: 'A1', status: 'available' }], RIVA, CTX);
    expect(r.creates[0]!.data.developer_unit_code).toBeUndefined();
  });
});

describe('WhatsApp evidence check — an update must be quoted from the cited message', () => {
  const post = 'شركاء النجاح ✨\n\nنبارك للوسيط العقاري/\n*سعود بن دغش*\n\n📍 تفاصيل الحجز:\nريا النخيل - مبنى 6 | شقة 2\n\nمبروك';
  it('accepts a quote despite markdown, bars and alef variants', async () => {
    const { evidenceHolds } = await import('../projectUpdates/whatsapp');
    expect(evidenceHolds('ريا النخيل - مبنى 6 | شقة 2', [post])).toBe(true);
    expect(evidenceHolds('تفاصيل الحجز: ريا النخيل مبنى 6 شقة 2', [post])).toBe(true);
  });
  it('rejects a quote that is not there (a made-up unit)', async () => {
    const { evidenceHolds } = await import('../projectUpdates/whatsapp');
    expect(evidenceHolds('ريا النخيل - مبنى 7 | شقة 3', [post])).toBe(false);
    expect(evidenceHolds('', [post])).toBe(false);
    expect(evidenceHolds(null, [post])).toBe(false);
  });
  it('reads Arabic-Indic digits in the quote', async () => {
    const { evidenceHolds } = await import('../projectUpdates/whatsapp');
    expect(evidenceHolds('عمولة ٣٪', ['عمولة 3٪ لفترة محدودة'])).toBe(true);
  });
});

describe('listCoverage — "not on the list → sold" only inside the buildings the list names', () => {
  it('a list for buildings 1 and 2 never touches buildings 3 and 4', async () => {
    const { listCoverage, inCoverage } = await import('../projectUpdates/whatsapp');
    const scope = listCoverage([{ sourceId: null, unitModel: null, buildingNumber: '1' }, { sourceId: null, unitModel: null, buildingNumber: '2' }]);
    expect(inCoverage(scope, { building_number: '1' })).toBe(true);
    expect(inCoverage(scope, { building_number: '3' })).toBe(false);
  });
  it('block + building rows cover that pair only', async () => {
    const { listCoverage, inCoverage } = await import('../projectUpdates/whatsapp');
    const scope = listCoverage([{ sourceId: null, unitModel: null, block: '53', buildingNumber: '3' }]);
    expect(inCoverage(scope, { block: '53', building_number: '3' })).toBe(true);
    expect(inCoverage(scope, { block: '56', building_number: '3' })).toBe(false);
  });
  it('rows with no building or block cover nothing (the run refuses to guess)', async () => {
    const { listCoverage } = await import('../projectUpdates/whatsapp');
    expect(listCoverage([{ sourceId: null, unitModel: 'A1' }]).size).toBe(0);
  });
});

describe('Almajdiah API mapping', () => {
  it('maps statuses (booked / booked_paid = reserved) and keeps the pre-tax price', async () => {
    const { majdUnit, majdStatus } = await import('../projectUpdates/almajdiah');
    expect(majdStatus('booked_paid')).toBe('reserved');
    expect(majdStatus('booked')).toBe('reserved');
    expect(majdStatus('sold')).toBe('sold');
    const u = majdUnit({ id: 20802, building_name: 'A', unit_number: '1', status: 'available', price_before_tax: 1219000, area: '94.6', room_count: '2', floor: 'ground' });
    expect(u).toMatchObject({ unitCode: 'MAJD-20802', unitModel: 'A 1', buildingNumber: 'A', unitNumber: 1, status: 'available', price: 1219000, area: 94.6, floor: 'ارضي' });
  });
  it('a full unit code (TY01-H-0-1) is the identity itself', async () => {
    const { majdUnit } = await import('../projectUpdates/almajdiah');
    expect(majdUnit({ id: 13411, building_name: 'H', unit_number: 'TY01-H-0-1', status: 'sold' })).toMatchObject({ unitCode: 'TY01-H-0-1', unitModel: 'TY01-H-0-1' });
  });
  it('matches «A 1» in the CRM, and «Block 1» stored as a block', async () => {
    const { majdUnit } = await import('../projectUpdates/almajdiah');
    const r1 = reconcile([crm('u1', { unit_model: 'A 1', building_number: 'A', unit_number: 1 })], [majdUnit({ id: 1, building_name: 'A', unit_number: '1', status: 'sold' })], RIVA, CTX);
    expect(r1.updates[0]!.patch.unit_status).toBe('sold');
    const r2 = reconcile([crm('u2', { block: 'Block 1', unit_number: 101 })], [majdUnit({ id: 2, building_name: 'Block 1', unit_number: '101', status: 'sold' })], RIVA, CTX);
    expect(r2.updates[0]!.unitId).toBe('u2');
  });
});

describe('brakeReason — a source that shares no unit with the CRM', () => {
  it('holds instead of stacking a second inventory', () => {
    const crmUnits = Array.from({ length: 22 }, (_, i) => crm(`c${i}`, { unit_model: `Block 3 - ${300 + i}` }));
    const src = Array.from({ length: 12 }, (_, i) => ({ sourceId: `s${i}`, unitModel: `Block 1 ${100 + i}`, status: 'available' as const, price: 1 }));
    expect(brakeReason(reconcile(crmUnits, src, RIVA, CTX), { share: 0.5, minUnits: 6 })).toMatch(/shares no unit/);
  });
});

describe('Safa adapter', () => {
  // A real public card (safainv.sa/project/units/64, 2026-10-04), trimmed.
  const card = `<div class="top-img overflow-hidden"><div class="item"><div class="overlay unitCard" data-id="13207"></div></div></div>
    <div class="label"> <a href="javascript:void(0)"> <i class="fa fa-key"></i> للبيع </a> <a class="mx-1 projectName"> SF085 </a> </div>
    <div class="category_type"> <span class="type"> شقة </span> </div>
    <div class="unit_details p-3 pt-4"> <div class="unit_info"> <div class="title"> <span class="unit-title" style="font-size: 15px">SF085-A01-F01-001-APT</span>
    <div class="info"><div class="location"><span> Jeddah </span></div><div class="space"><span class="">166.53 م²</span></div></div></div>
    <div class="price" dir="ltr"> <img src="x"> 717,773 <div class="icons d-flex align-items-center mt-3"> <span> <svg width="17"><mask id="m"><path d="M3 2"/></mask><g><path d="M1"/></g></svg> 3 </span> <span class="mx-3"> <svg><path d="M2"/></svg> 3 </span> <span> <svg><path/></svg> الأول </span> </div> </div></div></div>`;
  it('reads a public card — and keeps its price only as a note (different basis)', async () => {
    const { parsePublicCard } = await import('../projectUpdates/safa');
    const u = parsePublicCard(card, false)!;
    expect(u).toMatchObject({ unitModel: 'SF085-A01-F01-001-APT', unitCode: 'SF085-A01-F01-001-APT', unitType: 'شقة', status: 'available', area: 166.53, bedrooms: 3, bathrooms: 3, floor: 'الأول', price: null });
    expect(u.description).toContain('717,773');
  });
  it('a «قريباً» project lists units as under construction', async () => {
    const { parsePublicCard } = await import('../projectUpdates/safa');
    expect(parsePublicCard(card, true)!.status).toBe('under_construction');
  });
  it('a broker card: the code incl. roof units (-R01-), the unit price not the commission', async () => {
    const { parseBrokerCard } = await import('../projectUpdates/safa');
    const u = parseBrokerCard('<div class="unit_details"><span class="unit-title">SF083-A01-R01-019-APT</span><div class="space"><span>142.5 م²</span></div><div class="price"><div class="price-item"><span>السعر: </span><span> 1,195,000 </span></div><div class="badge"><span>مبلغ العمولة: </span><span> 23,900 </span></div></div><a href="/property/5521">عرض المزيد</a></div>')!;
    expect(u).toMatchObject({ unitModel: 'SF083-A01-R01-019-APT', price: 1_195_000, area: 142.5, sourceId: '5521' });
  });
  it('union: the broker price wins; a public-only unit carries no price', async () => {
    const { unionSafa } = await import('../projectUpdates/safa');
    const u = unionSafa(
      [{ sourceId: 'b', unitModel: 'A', price: 1_500_000, status: 'available' }],
      [{ sourceId: 'p', unitModel: 'A', price: null, status: 'available', area: 100 }, { sourceId: 'q', unitModel: 'B', price: null, status: 'available' }],
    );
    expect(u.find((x) => x.unitModel === 'A')).toMatchObject({ price: 1_500_000, area: 100 });
    expect(u.find((x) => x.unitModel === 'B')!.price).toBeNull();
  });
  it('keepReserved: a unit we marked reserved is not flipped back by a list that never shows reservations', () => {
    const r = reconcile([crm('u1', { unit_model: 'A', unit_status: 'reserved' }), crm('u2', { unit_model: 'B', unit_status: 'sold' })],
      [src('A', { status: 'available' }), src('B', { status: 'available' })],
      { absentAvailable: 'sold', createMissing: true, updatePrices: true, keepReserved: true }, CTX);
    expect(r.updates.map((x) => [x.unitId, x.patch.unit_status])).toEqual([['u2', 'available']]);
  });
});

describe('recipe engine knows save_items', () => {
  it('parses a status recipe that ends in save_items', async () => {
    const { parseRecipe } = await import('../portals/recipe');
    const steps = parseRecipe(JSON.stringify([{ do: 'goto', url: 'https://x' }, { do: 'save_items', key: 'units', item_selector: 'div.unit_details', urls: ['https://x/p/1?page={{page}}'] }]));
    expect(steps[1]!.do).toBe('save_items');
  });
});

describe('Safa broker cards — the real layout (saved 2026-10-05)', () => {
  // Trimmed from a real card of صفا 101 (portal project 108): new code format,
  // price line vs commission line, SVG icon before every value, «RF» floor.
  const card = `<div class="unit_details p-3 pt-4"> <div class="unit_info d-flex unitCard" data-id="10197"> <div class="title"> <span class="unit-title" style="font-size: 15px">299-C5-4-41</span> <div class="info"> <div class="location"> <svg><path/></svg> <span class=""> الرياض </span> </div> <div class="space d-flex align-items-center mx-3"> <svg><path/></svg> <span class="">165.58 م²</span> </div> </div> </div> <div class="price"> <div class="price-item"> <span class="mx-1">السعر: </span> <span> 756,000 <img src="riyal.svg" width="14"> </span> </div> <div class="mt-2 badge badge--new"> <span class="mx-1">مبلغ العمولة: </span> <span> 7,560 <img src="riyal.svg"> </span> </div> <div class="icons d-flex align-items-center mt-3"> <span> <svg><mask id="m"><path/></mask></svg> 3 </span> <span class="mx-3"> <svg><path/></svg> 4 </span> <span> <svg><path/></svg> RF </span> </div> </div> </div> <div class="btns"> <a class="mainBtn unitCard" href="https://broker.safainv.sa/property/10197"> عرض المزيد </a> </div> </div>`;
  it('reads code (any format), price (not commission), area, beds, baths, floor, portal id', async () => {
    const { parseBrokerCard } = await import('../projectUpdates/safa');
    expect(parseBrokerCard(card)).toMatchObject({ unitModel: '299-C5-4-41', price: 756000, area: 165.58, bedrooms: 3, bathrooms: 4, floor: 'RF', sourceId: '10197', status: 'available' });
  });
  it('a card with no price is under construction, not available', async () => {
    const { parseBrokerCard } = await import('../projectUpdates/safa');
    expect(parseBrokerCard(card.replace('756,000', ''))!.status).toBe('under_construction');
  });
  it('maps every floor form found on the 448 real cards', () => {
    const cases: Array<[string, string]> = [['GF', 'ارضي'], ['FF', 'اول'], ['SF', 'ثاني'], ['TF', 'ثالث'], ['RF', 'الروف'], ['4F', '4'], ['7F', '7'], ['سَطح', 'الروف'], ['الرابع', '4'], ['الأرضي', 'ارضي'], ['الثالث', 'ثالث']];
    for (const [raw, want] of cases) expect([raw, mapFloor(raw)]).toEqual([raw, want]);
  });
  it('report-only prices: a different source price is listed, not written', () => {
    const r = reconcile([crm('u1', { unit_model: 'A', total_price: 1_521_879 })], [src('A', { status: 'available', price: 1_598_000 })],
      { absentAvailable: 'leave', createMissing: true, updatePrices: false }, CTX);
    expect(r.updates).toHaveLength(0);
    expect(r.priceDiffsNotApplied).toEqual([{ unit: 'A', crm: 1_521_879, source: 1_598_000 }]);
  });
});
