import { describe, it, expect } from 'vitest';
import { resolveProjectView, formatPriceRange, type ProjectStoreSlices } from '../projectView';
import type { AppModel, AppRecord } from '@/types';

// Minimal all_projects model mirroring the live schema's relevant fields.
function makeStore(): ProjectStoreSlices {
  const allProjects: AppModel = {
    id: 'ap-model',
    name: 'all_projects',
    label_ar: '', label_en: 'All Projects',
    icon: '', color: '#B8734F',
    schema: {
      sections: [
        {
          id: 's0', label_ar: '', label_en: 'Identity', order: 0, is_base: true,
          fields: [
            { id: 'f_name', name: 'project_name', label_ar: '', label_en: 'Name', type: 'text', required: false, order: 0, section_id: 's0' },
            { id: 'f_dev', name: 'developer', label_ar: '', label_en: 'Developer', type: 'lookup', required: false, order: 1, section_id: 's0', lookup_model_id: 'dev-model', lookup_display_field: 'name' },
            { id: 'f_status', name: 'project_status', label_ar: '', label_en: 'Status', type: 'dropdown', required: false, order: 2, section_id: 's0',
              options: [{ id: 'o1', value: 'active', label_ar: 'نشط', label_en: 'Active', color: '#10B981' }] },
            { id: 'f_avail', name: 'available_units', label_ar: '', label_en: 'Available', type: 'number', required: false, order: 3, section_id: 's0', is_rollup: true, rollup_kind: 'units_available_count', read_only: true },
            { id: 'f_price', name: 'price_range', label_ar: '', label_en: 'Price Range', type: 'range', required: false, order: 4, section_id: 's0', is_rollup: true, rollup_kind: 'price_range', read_only: true },
          ],
        },
      ],
    },
    card_config: { title_field_id: 'f_name', shown_field_ids: [] },
    maps_config: {} as AppModel['maps_config'],
    is_system: true,
    created_at: '2026-01-01', updated_at: '2026-01-01',
  } as AppModel;

  const devModel: AppModel = { ...allProjects, id: 'dev-model', name: 'developers', schema: { sections: [] } } as AppModel;
  const cities: AppModel = { ...allProjects, id: 'cities-model', name: 'cities', schema: { sections: [] } } as AppModel;

  return {
    models: [allProjects, devModel, cities],
    records: {
      'dev-model': [{ id: 'dev-1', model_id: 'dev-model', data: { name: 'Almajdiah' }, created_at: '', updated_at: '' } as AppRecord],
      'cities-model': [{ id: 'city-1', model_id: 'cities-model', data: { display_name: 'Riyadh' }, created_at: '', updated_at: '' } as AppRecord],
    },
  };
}

describe('resolveProjectView', () => {
  it('resolves names, lookups, geography, options and stored rollups', () => {
    const store = makeStore();
    const rec: AppRecord = {
      id: 'p1', model_id: 'ap-model', created_at: '2026-06-01', updated_at: '2026-06-01',
      data: {
        project_name: 'Wassel Tower',
        developer: 'dev-1',
        project_status: 'active',
        location: { city: 'city-1' },
        available_units: 12,
        price_range: { min: 800000, max: 1500000 },
        is_targeted: true,
      },
    } as AppRecord;
    const v = resolveProjectView(store, rec);
    expect(v.name).toBe('Wassel Tower');
    expect(v.developer).toBe('Almajdiah');
    expect(v.city).toBe('Riyadh');
    expect(v.status?.label_en).toBe('Active');
    expect(v.status?.color).toBe('#10B981');
    expect(v.availableUnits).toBe(12);
    expect(v.priceRange).toEqual({ min: 800000, max: 1500000 });
    expect(v.hasGeo).toBe(true);
    expect(v.isTargeted).toBe(true);
  });

  it('returns null (never a guess) for genuinely missing facts', () => {
    const store = makeStore();
    const rec: AppRecord = {
      id: 'p2', model_id: 'ap-model', created_at: '2026-06-01', updated_at: '2026-06-01',
      data: {}, // empty project
    } as AppRecord;
    const v = resolveProjectView(store, rec);
    expect(v.name).toBeNull();
    expect(v.developer).toBeNull();
    expect(v.city).toBeNull();
    expect(v.district).toBeNull();
    expect(v.status).toBeNull();
    expect(v.availableUnits).toBeNull();
    expect(v.priceRange).toBeNull();
    expect(v.hasGeo).toBe(false);
    expect(v.isTargeted).toBe(false);
    expect(formatPriceRange(v.priceRange, true)).toBeNull();
  });

  // Bilingual W6: language-aware name / developer / geo via injected opts.
  it('localizes name, developer, and geography in English mode', () => {
    const store = makeStore();
    // Give the city a bilingual official name so geoLocalized resolves.
    store.records['cities-model'] = [
      { id: 'city-1', model_id: 'cities-model', data: { name_ar: 'الرياض', name_en: 'Riyadh' }, created_at: '', updated_at: '' } as AppRecord,
    ];
    const rec: AppRecord = {
      id: 'p1', model_id: 'ap-model', created_at: '2026-06-01', updated_at: '2026-06-01',
      data: { project_name: 'برج وصل', developer: 'dev-1', location: { city: 'city-1' } },
    } as AppRecord;
    const translations: Record<string, string> = {
      'p1|project_name|en': 'Wassel Tower',
      'dev-1|name|en': 'Almajdiah Development',
    };
    const translate = (id: string, path: string, lang: 'ar' | 'en') => translations[`${id}|${path}|${lang}`] ?? null;

    const en = resolveProjectView(store, rec, { isAr: false, translate });
    expect(en.name).toBe('Wassel Tower');           // translation, not the Arabic source
    expect(en.developer).toBe('Almajdiah Development');
    expect(en.city).toBe('Riyadh');                 // official English geo name

    // Arabic mode (or no opts) keeps source + Arabic geo — server callers unchanged.
    const ar = resolveProjectView(store, rec, { isAr: true, translate });
    expect(ar.name).toBe('برج وصل');
    expect(ar.city).toBe('الرياض');
    const bare = resolveProjectView(store, rec);
    expect(bare.name).toBe('برج وصل');
    expect(bare.city).toBe('الرياض');
  });

  it('falls back to Arabic geo when the record has no name_en (never blank)', () => {
    const store = makeStore(); // city-1 has display_name only, no name_en
    const rec: AppRecord = {
      id: 'p3', model_id: 'ap-model', created_at: '', updated_at: '',
      data: { location: { city: 'city-1' } },
    } as AppRecord;
    const en = resolveProjectView(store, rec, { isAr: false });
    expect(en.city).toBe('Riyadh'); // Arabic-source display_name, better than an empty English cell
  });
});
