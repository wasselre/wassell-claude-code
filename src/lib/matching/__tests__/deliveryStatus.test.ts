import { describe, it, expect } from 'vitest';
import { resolveDeliveryStatus, deliveryLabel, formatHandoverMonth } from '../deliveryStatus';

/**
 * The Project Finder's delivery-readiness badge. The values exercised here are the
 * REAL live `all_projects` values measured on 2026-08-18 (1,037 rows): the seven
 * `construction_status` options, the six `project_status` options, and the legacy
 * free-text Arabic statuses that predate the dropdown.
 */
describe('resolveDeliveryStatus', () => {
  it('reads construction_status=ready as Ready', () => {
    expect(resolveDeliveryStatus({ construction_status: 'ready' }).kind).toBe('ready');
  });

  it('reads every pre-completion construction stage as off-plan', () => {
    for (const s of ['excavation', 'foundations', 'structure', 'finishing', 'facade_installation', 'تحت-التطوير']) {
      expect(resolveDeliveryStatus({ construction_status: s }).kind).toBe('off_plan');
    }
  });

  it('lets construction_status win over a conflicting project_status', () => {
    // 14 live rows are construction_status=ready + project_status=available_on_map.
    expect(resolveDeliveryStatus({ construction_status: 'ready', project_status: 'available_on_map' }).kind).toBe('ready');
    // 46 live rows are تحت-التطوير + under_construction; 29 are تحت-التطوير + available_on_map.
    expect(resolveDeliveryStatus({ construction_status: 'تحت-التطوير', project_status: 'available' }).kind).toBe('off_plan');
  });

  it('falls back to project_status when construction_status is absent (862 of 1,037 live rows)', () => {
    expect(resolveDeliveryStatus({ project_status: 'under_construction' }).kind).toBe('off_plan');
    expect(resolveDeliveryStatus({ project_status: 'available_on_map' }).kind).toBe('off_plan');
    expect(resolveDeliveryStatus({ project_status: 'upcoming' }).kind).toBe('off_plan');
    expect(resolveDeliveryStatus({ project_status: 'قريبا' }).kind).toBe('off_plan');
  });

  it('NEVER guesses Ready from an ambiguous or unrelated status', () => {
    // 'available'/'sold_out'/'unknown' say nothing about construction.
    for (const s of ['available', 'sold_out', 'unknown', 'للتاجير', 'للبيع', 'مشاريع حالية']) {
      expect(resolveDeliveryStatus({ project_status: s }).kind).toBe('unknown');
    }
    // 'مكتمل' is excluded on purpose — it also reads as "مكتمل البيع" (sold out).
    expect(resolveDeliveryStatus({ project_status: 'مكتمل' }).kind).toBe('unknown');
  });

  it('accepts only the unambiguous legacy "finished" statuses as Ready', () => {
    expect(resolveDeliveryStatus({ project_status: 'منجز' }).kind).toBe('ready');
    expect(resolveDeliveryStatus({ project_status: 'تم الانتهاء' }).kind).toBe('ready');
  });

  it('is unknown when nothing is set (market listings carry neither field)', () => {
    expect(resolveDeliveryStatus({}).kind).toBe('unknown');
    expect(resolveDeliveryStatus({ construction_status: '', project_status: '  ' }).kind).toBe('unknown');
  });

  it('carries the raw handover date through', () => {
    const r = resolveDeliveryStatus({ project_status: 'under_construction', handover_date: '2027-09-30' });
    expect(r).toEqual({ kind: 'off_plan', handoverDate: '2027-09-30' });
    expect(resolveDeliveryStatus({ project_status: 'under_construction' }).handoverDate).toBeNull();
  });
});

describe('formatHandoverMonth', () => {
  it('renders a Gregorian month + year in both languages', () => {
    expect(formatHandoverMonth('2027-09-30', true)).toBe('سبتمبر 2027');
    expect(formatHandoverMonth('2027-09-30', false)).toBe('September 2027');
    expect(formatHandoverMonth('2026-12-31', true)).toBe('ديسمبر 2026');
  });

  it('returns null rather than a stray string for missing / unparseable input', () => {
    expect(formatHandoverMonth(null, true)).toBeNull();
    expect(formatHandoverMonth('', true)).toBeNull();
    expect(formatHandoverMonth('not a date', true)).toBeNull();
    expect(formatHandoverMonth('2027-13-01', true)).toBeNull();
  });
});

describe('deliveryLabel', () => {
  it('is bilingual and never blank', () => {
    expect(deliveryLabel('ready', true)).toBe('جاهز');
    expect(deliveryLabel('ready', false)).toBe('Ready');
    expect(deliveryLabel('off_plan', true)).toBe('على الخارطة');
    expect(deliveryLabel('off_plan', false)).toBe('Off-plan');
    expect(deliveryLabel('unknown', true)).toBe('غير محدد');
    expect(deliveryLabel('unknown', false)).toBe('Not specified');
  });
});
