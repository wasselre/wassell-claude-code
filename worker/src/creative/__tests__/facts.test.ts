import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildFactsPackage } from '../../marketing/script/facts';
import { catalogLine, factsCatalog, loadCreativeFacts, renderFactAr, toArabicIndic } from '../facts';

/** A realistic all_projects jsonb (ready project, available units, price range). */
const RECORD: Record<string, unknown> = {
  project_name: 'مشروع الاختبار',
  project_status: 'available',
  construction_status: 'ready',
  developer: 'شركة الاختبار للتطوير',
  unit_count: 40,
  available_units: 12,
  available_price_range: { min: 1050000, max: 1800000 },
  available_area_range: { min: 120, max: 210 },
  unit_types: ['apartment'],
  location: { district_ar: 'حي الياسمين', city_ar: 'الرياض' },
  status_checked_at: '2026-08-01T00:00:00Z',
};

/** Minimal PostgREST chain stub — returns `record` for every unified_records read. */
function fakeSb(record: Record<string, unknown> | null): SupabaseClient {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: record ? { data: record } : null, error: null }),
  };
  return { from: () => q } as unknown as SupabaseClient;
}

describe('toArabicIndic', () => {
  it('converts Western digits, leaves separators and letters untouched', () => {
    expect(toArabicIndic('1,050,000')).toBe('١,٠٥٠,٠٠٠');
    expect(toArabicIndic(120)).toBe('١٢٠');
    expect(toArabicIndic('م²')).toBe('م²');
  });
});

describe('renderFactAr', () => {
  const fact = { rendered_ar: 'تبدأ من 1,050,000 ر.س' };
  it('keeps Western digits by request', () => {
    expect(renderFactAr(fact, { numerals: 'western' })).toBe('تبدأ من 1,050,000 ر.س');
  });
  it('renders Arabic-Indic digits on request', () => {
    expect(renderFactAr(fact, { numerals: 'arabic_indic' })).toBe('تبدأ من ١,٠٥٠,٠٠٠ ر.س');
  });
});

describe('factsCatalog / catalogLine', () => {
  it('renders the contracted line shape with the claimable flag', () => {
    const pkg = buildFactsPackage(RECORD, { developerName: 'شركة الاختبار للتطوير' });
    const price = pkg.facts.find((f) => f.key === 'price_from');
    expect(price).toBeDefined();
    expect(catalogLine(price!)).toBe(`${price!.id} · price_from · تبدأ من 1,050,000 ر.س (available_price_range.min) [claimable]`);
  });
  it('marks non-claimable facts context-only', () => {
    const pkg = buildFactsPackage({ ...RECORD, payment_plan_summary: 'دفعة أولى ثم أقساط ميسرة' }, {});
    const qual = pkg.facts.find((f) => f.key === 'payment_plan_summary');
    expect(qual?.claimable).toBe(false);
    expect(catalogLine(qual!)).toContain('[context-only]');
  });
  it('joins one line per fact in package order', () => {
    const pkg = buildFactsPackage(RECORD, {});
    const lines = factsCatalog(pkg.facts).split('\n');
    expect(lines).toHaveLength(pkg.facts.length);
    expect(lines[0]).toMatch(/^F1 · /);
  });
});

describe('loadCreativeFacts', () => {
  it('loads the record, resolves an inline developer, and returns package+catalog+refs', async () => {
    const out = await loadCreativeFacts(fakeSb(RECORD), 'proj-1');
    expect(out.package.project_name).toBe('مشروع الاختبار');
    expect(out.package.readiness).toBe('ready');
    expect(out.package.developer_name).toBe('شركة الاختبار للتطوير');
    const priceRef = out.refs.find((r) => r.key === 'price_from');
    expect(priceRef).toMatchObject({ rendered_ar: 'تبدأ من 1,050,000 ر.س', source_field: 'available_price_range.min', claimable: true });
    expect(out.catalog).toContain(`${priceRef!.id} · price_from · تبدأ من 1,050,000 ر.س`);
  });
  it('honours an explicit developerName without a lookup', async () => {
    const out = await loadCreativeFacts(fakeSb(RECORD), 'proj-1', { developerName: 'مطور صريح' });
    expect(out.package.developer_name).toBe('مطور صريح');
  });
  it('throws facts_insufficient when the record is missing', async () => {
    await expect(loadCreativeFacts(fakeSb(null), 'nope')).rejects.toThrow(/^facts_insufficient:/);
  });
});
