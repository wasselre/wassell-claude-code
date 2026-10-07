import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { amenityAnswers, amenityLabels, hasAmenities, resolveAmenity, splitAmenities } from '../amenities';
import { resolveFeatures } from '../features';

// The live rows behind the 2026-10-07 chat («شقة 3 غرف فيها مسبح وجيم»).
const TALL_ALRABWA = { preferred_amenities: ['sports_club', 'بزنس-سنتر', 'lounge', 'green_spaces', 'garden', 'children_play_area', 'جلسات-خارجية', 'نظام-مراقبة-امنية', 'بلكونات', 'اسطح-خاصة', 'مصاعد', 'mosque', 'basement_parking'] };
const SAFA_101 = { preferred_amenities: ['نظام-دخول-ذكي', 'نظام-مراقبة-امنية', 'شواحن-سيارات-كهربايية', 'مصاعد', 'بلكونات', 'جلسات-خارجية', 'مواقف-خارجية', 'غرفة-بريد'] };
const WITH_POOL = { preferred_amenities: ['swimming_pool', 'gym'] };
const NONE = {};

describe('project amenities', () => {
  it('pool and gym are project amenities, not unknown unit features', () => {
    const f = resolveFeatures(['مسبح', 'جيم', 'غرفة خادمة']);
    expect(f.known).toEqual(['غرفه خادمه']);
    const a = splitAmenities(f.unknown);
    expect(a.unknown).toEqual([]);
    expect(a.asks.map((x) => x.label)).toEqual(['مسبح', 'نادي رياضي']);
  });

  it('understands the ways customers say them', () => {
    for (const w of ['المسبح', 'بركة سباحة', 'pool']) expect(resolveAmenity(w)?.label).toBe('مسبح');
    for (const w of ['نادي رياضي', 'النادي', 'صالة رياضية', 'gym']) expect(resolveAmenity(w)?.label).toBe('نادي رياضي');
    expect(resolveAmenity('ملعب أطفال')?.label).toBe('منطقة ألعاب أطفال');
    expect(resolveAmenity('مصلى')?.label).toBe('مسجد');
  });

  it('a word that is neither stays unknown (floor plans), never guessed', () => {
    expect(splitAmenities(['مطبخ مفتوح']).unknown).toEqual(['مطبخ مفتوح']);
  });

  it('answers per project: has / lacks / not recorded', () => {
    const asks = splitAmenities(['مسبح', 'جيم']).asks;
    expect(amenityAnswers(TALL_ALRABWA, asks)).toEqual({ 'مسبح': false, 'نادي رياضي': true });
    expect(amenityAnswers(SAFA_101, asks)).toEqual({ 'مسبح': false, 'نادي رياضي': false });
    expect(amenityAnswers(WITH_POOL, asks)).toEqual({ 'مسبح': true, 'نادي رياضي': true });
    expect(amenityAnswers(NONE, asks)).toEqual({ 'مسبح': null, 'نادي رياضي': null });
  });

  it('a project passes only when it lists every ask; none recorded never passes', () => {
    const asks = splitAmenities(['مسبح', 'جيم']).asks;
    expect(hasAmenities(WITH_POOL, asks)).toBe(true);
    expect(hasAmenities(TALL_ALRABWA, asks)).toBe(false);
    expect(hasAmenities(NONE, asks)).toBe(false);
    expect(hasAmenities(NONE, [])).toBe(true);
  });

  it('lists a project\'s amenities in Arabic', () => {
    const l = amenityLabels(TALL_ALRABWA)!;
    expect(l).toEqual(expect.arrayContaining(['نادي رياضي', 'منطقة ألعاب أطفال', 'مسجد', 'مواقف قبو', 'مصاعد', 'حديقة']));
    expect(l.some((x) => /[a-z_]/.test(x))).toBe(false);
    expect(amenityLabels(NONE)).toBeNull();
  });
});

vi.mock('../../trackedLinks.js', async () => {
  const actual = await vi.importActual<typeof import('../../trackedLinks.js')>('../../trackedLinks.js');
  return { ...actual, loadAvailableUnits: vi.fn(async () => [{ id: 'u1', data: { unit_status: 'available', unit_type: 'شقة', bedrooms: 3, total_price: 900_000 } }]) };
});

describe('searchUnits with an amenity', () => {
  it('answers it from the project, without filtering units or calling it unknown', async () => {
    const { searchUnits, unitSearchView } = await import('../units');
    const svc = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { data: TALL_ALRABWA }, error: null }) }) }) }),
    } as unknown as SupabaseClient;
    const r = await searchUnits(svc, 'p', { features: ['مسبح', 'جيم'] });
    expect(r.matched).toBe(1);
    expect(r.features?.unknown).toEqual([]);
    expect(r.project_amenities?.asked).toEqual({ 'مسبح': false, 'نادي رياضي': true });
    expect(unitSearchView(r).project_amenities).toBeTruthy();
  });
});
