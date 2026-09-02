import { describe, expect, it } from 'vitest';
import { buildFactsPackage, deriveReadiness } from '../facts.js';

const NOW = new Date('2026-09-02T00:00:00Z');

const OFF_PLAN = {
  project_name: 'أكنان ٢٥',
  project_status: 'available_on_map',
  construction_status: 'structure',
  unit_count: 40,
  available_units: 10,
  sold_units: 30,
  price_range: { min: 500000, max: 900000 },
  available_price_range: { min: 674497, max: 900000 },
  available_area_range: { min: 120, max: 150 },
  bedroom_range: { min: 3, max: 4 },
  unit_types: ['villa', 'townhouse', 'villas'],
  features: [{ feature: 'مسبح' }, { feature: 'نادي رياضي' }, { feature: 'حديقة' }],
  preferred_amenities: ['prayer_room'],
  services: [{ service: 'أمن ٢٤ ساعة' }],
  nearby_landmarks: [{ landmark: 'المطار', distance: '٣ كم', duration: '٥ دقائق' }, { landmark: 'الجامعة', distance: 'قريب' }],
  guarantees: [{ col_1: 'هيكل', col_2: '10 سنوات' }],
  handover_date: '2026-12-01',
  down_payment_percent: 5,
  payment_plan_summary: 'دفعة أولى ٥٪ والباقي على دفعات',
  location: { district: 'النرجس', city: 'الرياض' },
  status_checked_at: '2026-08-20T00:00:00Z',
  marketing_document: 'مشروع راقٍ بعائد ممتاز ١٢٪ وتمويل ٩٠٪',
  financing_note: 'تمويل ٩٠٪ من البنك',
};

describe('deriveReadiness (enums only)', () => {
  it.each([
    ['available_on_map', '', 'off_plan'],
    ['under_construction', 'finishing', 'off_plan'],
    ['upcoming', '', 'off_plan'],
    ['available', 'ready', 'ready'],
    ['', 'ready', 'ready'],
    ['available', '', 'ready'],
    ['available', 'structure', 'off_plan'],
    ['available_on_map', 'ready', 'conflict'],
    ['under_construction', 'ready', 'conflict'],
    ['unknown', '', 'unknown'],
    ['sold_out', '', 'unknown'],
  ])('project_status=%s construction_status=%s → %s', (ps, cs, exp) => {
    expect(deriveReadiness(ps, cs)).toBe(exp);
  });
});

describe('buildFactsPackage', () => {
  it('off-plan project: full package, viable, price from the available range', () => {
    const p = buildFactsPackage(OFF_PLAN, { now: NOW, developerName: 'أكنان', marketerName: 'ريفا العقارية' });
    expect(p.readiness).toBe('off_plan');
    expect(p.sold_out).toBe(false);
    expect(p.viable).toBe(true);
    expect(p.missing).toEqual([]);
    const price = p.facts.find((f) => f.key === 'price_from')!;
    expect(price.value).toBe(674497);
    expect(price.claimable).toBe(true);
    expect(price.source_field).toBe('available_price_range.min');
    expect(p.facts.find((f) => f.key === 'handover_date')?.rendered_ar).toContain('2026-12');
    expect(p.facts.filter((f) => f.class === 'unit_type').map((f) => f.value)).toEqual(['فيلا', 'تاون هاوس', 'فلل']);
    expect(p.facts.find((f) => f.key === 'distance:المطار')?.value).toBe(3);
    expect(p.facts.find((f) => f.key === 'duration:المطار')?.value).toBe(5);
    expect(p.facts.find((f) => f.key === 'distance:الجامعة')?.claimable).toBe(false);
    const g = p.facts.find((f) => f.class === 'guarantee')!;
    expect(g.claimable).toBe(false);
    expect(g.note).toContain('needs_labeling');
    expect(p.facts.find((f) => f.key === 'down_payment_percent')?.claimable).toBe(true);
    expect(p.facts.find((f) => f.key === 'payment_plan_summary')?.claimable).toBe(false);
    expect(p.facts.find((f) => f.class === 'feature' && f.value === 'مصلى')).toBeTruthy();
    expect(p.facts.find((f) => f.class === 'location')?.rendered_ar).toBe('النرجس، الرياض');
    expect(p.facts.map((f) => f.id)).toEqual(p.facts.map((_, i) => `F${i + 1}`));
    expect(p.warnings).toEqual([]);
    expect(p.developer_name).toBe('أكنان');
    expect(p.marketer_name).toBe('ريفا العقارية');
  });
  it('never emits financing / returns / yield facts, even when the record mentions them', () => {
    const p = buildFactsPackage(OFF_PLAN, { now: NOW });
    expect(p.facts.some((f) => /financ|return|yield/i.test(f.source_field))).toBe(false);
    const md = p.facts.find((f) => f.key === 'marketing_document')!;
    expect(md.claimable).toBe(false);
    expect(md.note).toMatch(/NEVER a source for numbers/);
  });
  it('sold-out: no price fact, sold_out flag, price listed as missing', () => {
    const p = buildFactsPackage({ ...OFF_PLAN, project_status: 'sold_out', construction_status: 'ready', available_units: 0, sold_units: 40 }, { now: NOW });
    expect(p.sold_out).toBe(true);
    expect(p.facts.some((f) => f.class === 'price')).toBe(false);
    expect(p.facts.some((f) => f.class === 'availability')).toBe(false);
    expect(p.missing).toContain('price');
    expect(p.warnings.some((w) => /sold out/.test(w))).toBe(true);
  });
  it('ready project: readiness=ready, no handover fact, viable', () => {
    const p = buildFactsPackage({ ...OFF_PLAN, project_status: 'available', construction_status: 'ready' }, { now: NOW });
    expect(p.readiness).toBe('ready');
    expect(p.facts.find((f) => f.class === 'status')?.rendered_ar).toContain('جاهز');
    expect(p.facts.some((f) => f.key === 'handover_date')).toBe(false);
    expect(p.viable).toBe(true);
  });
  it('conflict: not viable, readiness missing, loud warning', () => {
    const p = buildFactsPackage({ ...OFF_PLAN, project_status: 'available_on_map', construction_status: 'ready' }, { now: NOW });
    expect(p.readiness).toBe('conflict');
    expect(p.viable).toBe(false);
    expect(p.missing).toContain('readiness');
    expect(p.warnings.some((w) => /conflict/.test(w))).toBe(true);
  });
  it('missing everything: not viable with a complete missing list', () => {
    const p = buildFactsPackage({}, { now: NOW });
    expect(p.viable).toBe(false);
    expect(p.missing).toEqual(expect.arrayContaining(['project_name', 'readiness', 'price', 'unit_types', 'location', 'features']));
    expect(p.warnings.some((w) => /never verified/.test(w))).toBe(true);
  });
  it('price is omitted when available_units is unknown, with a warning', () => {
    const { available_units: _skip, ...rest } = OFF_PLAN;
    const p = buildFactsPackage(rest, { now: NOW });
    expect(p.sold_out).toBe(false);
    expect(p.facts.some((f) => f.class === 'price')).toBe(false);
    expect(p.warnings.some((w) => /no unit inventory/.test(w))).toBe(true);
  });
  it('freshness warning after 90 days', () => {
    const p = buildFactsPackage({ ...OFF_PLAN, status_checked_at: '2026-01-01T00:00:00Z' }, { now: NOW });
    expect(p.warnings.some((w) => /days ago/.test(w))).toBe(true);
  });
  it('truncates qualitative context at 6000 chars', () => {
    const p = buildFactsPackage({ ...OFF_PLAN, project_analysis: 'ن'.repeat(7000) }, { now: NOW });
    const f = p.facts.find((x) => x.key === 'project_analysis')!;
    expect((f.value as string).length).toBe(6000);
    expect(f.claimable).toBe(false);
  });
});
