import { describe, it, expect } from 'vitest';
import { resolveProjectFacts, composeProjectMessage, type ProjectMessageFacts } from '../projectMessageFacts';
import type { AppModel, AppRecord, ModelField, ModelSection, ModelOption } from '@/types';

function field(partial: Partial<ModelField> & { name: string }): ModelField {
  return {
    id: partial.id ?? `f_${partial.name}`,
    name: partial.name,
    label_ar: partial.label_ar ?? partial.name,
    label_en: partial.label_en ?? partial.name,
    type: partial.type ?? 'text',
    required: partial.required ?? false,
    order: partial.order ?? 0,
    section_id: partial.section_id ?? 's0',
    width: partial.width ?? 'half',
    show_in_table: partial.show_in_table ?? true,
    ...partial,
  };
}

function model(name: string, id: string, fields: ModelField[]): AppModel {
  const section: ModelSection = { id: 's0', label_ar: 's0', label_en: 's0', order: 0, is_base: true, fields };
  return {
    id, name, label_ar: name, label_en: name, icon: 'box', group_id: null, order: 0,
    schema: { sections: [section], section_selector_field_id: null },
  } as AppModel;
}

function rec(id: string, modelId: string, data: Record<string, unknown>): AppRecord {
  return { id, model_id: modelId, data, created_at: '', updated_at: '' };
}

const opt = (value: string, ar: string, en: string): ModelOption => ({ id: `o_${value}`, value, label_ar: ar, label_en: en });

// ── Fixtures ──────────────────────────────────────────────────────────
const AP_ID = 'm_all';
const OP_ID = 'm_our';
const UN_ID = 'm_units';

const allProjects = model('all_projects', AP_ID, [
  field({ name: 'project_name', type: 'text' }),
  field({ name: 'location', type: 'location' }), // region→city→district cascade (geography ids)
  field({ name: 'min_price', type: 'currency' }),
  field({ name: 'brochure_link', type: 'url' }),
  field({ name: 'project_location', type: 'url' }), // the maps URL (distinct from the geography `location`)
  field({ name: 'main_image', type: 'image' }),
  field({ name: 'project_images', type: 'multi_image' }),
]);

const ourProjects = model('our_projects', OP_ID, [
  field({ name: 'project_name', type: 'text' }),
  field({ name: 'project', type: 'lookup', lookup_model_id: AP_ID, lookup_display_field: 'project_name' }),
  field({ name: 'price_range', type: 'range', is_rollup: true, rollup_kind:'price_range' }),
  field({ name: 'bedroom_range', type: 'range', is_rollup: true, rollup_kind:'bedroom_range' }),
  field({ name: 'bathroom_range', type: 'range', is_rollup: true, rollup_kind:'bathroom_range' }),
  field({ name: 'area_range', type: 'range', is_rollup: true, rollup_kind:'area_range' }),
  // Available-units-only rollups (QA-003) — what customer messages quote.
  field({ name: 'available_price_range', type: 'range', is_rollup: true, rollup_kind:'available_price_range' }),
  field({ name: 'available_area_range', type: 'range', is_rollup: true, rollup_kind:'available_area_range' }),
]);

const units = model('units', UN_ID, [
  field({ name: 'project_id', type: 'lookup', lookup_model_id: AP_ID }),
  field({ name: 'unit_type', type: 'dropdown', options: [opt('apartment', 'شقة', 'Apartment'), opt('villa', 'فيلا', 'Villa')] }),
  field({ name: 'bedrooms', type: 'number' }),
  field({ name: 'bathrooms', type: 'number' }),
  field({ name: 'total_price', type: 'number' }),
  field({ name: 'unit_status', type: 'dropdown' }),
]);

// Frozen geography reference models — resolveProjectFacts resolves the project's
// location.{city,district} ids to display names against these records in the store.
const CITIES_ID = 'm_cities';
const DISTRICTS_ID = 'm_districts';
const cities = model('cities', CITIES_ID, [field({ name: 'display_name', type: 'text' })]);
const districts = model('districts', DISTRICTS_ID, [field({ name: 'display_name', type: 'text' })]);
const geoRecords: Record<string, AppRecord[]> = {
  [CITIES_ID]: [rec('c-riyadh', CITIES_ID, { display_name: 'الرياض' })],
  [DISTRICTS_ID]: [rec('d-narjis', DISTRICTS_ID, { display_name: 'النرجس' })],
};

const models = [allProjects, ourProjects, units, cities, districts];

describe('resolveProjectFacts', () => {
  it('resolves the full hybrid fact set for a project with units', () => {
    const records: Record<string, AppRecord[]> = {
      ...geoRecords,
      [AP_ID]: [rec('ap1', AP_ID, {
        project_name: 'مينا 52',
        location: { region: 'r-riyadh', city: 'c-riyadh', district: 'd-narjis' },
        min_price: 900000,
        brochure_link: 'https://wassel.re/brochure.pdf',
        project_location: '24.7,46.6',
        main_image: 'img-hero',
        project_images: ['img-hero', 'img-2', 'img-3'], // main_image already in the gallery → deduped
      })],
      // The all-unit ranges include a SOLD 500k unit; the available-only
      // rollups start at 550k — the message must quote the available floor.
      [OP_ID]: [rec('op1', OP_ID, { project_name: 'مينا 52 (لنا)', project: 'ap1', price_range: { min: 500000, max: 750000 }, bedroom_range: { min: 2, max: 5 }, bathroom_range: { min: 2, max: 4 }, area_range: { min: 114.28, max: 186.07 }, available_price_range: { min: 550000, max: 750000 }, available_area_range: { min: 120.4, max: 186.07 } })],
      [UN_ID]: [
        rec('u1', UN_ID, { project_id: 'ap1', unit_type: 'apartment', bedrooms: 2, bathrooms: 2, total_price: 500000, unit_status: 'sold' }),
        rec('u2', UN_ID, { project_id: 'ap1', unit_type: 'villa', bedrooms: 5, bathrooms: 4, total_price: 750000, unit_status: 'available' }),
        rec('u3', UN_ID, { project_id: 'ap1', unit_type: 'apartment', bedrooms: 3, bathrooms: 2, total_price: 600000, unit_status: 'available' }),
      ],
    };

    const f = resolveProjectFacts(records[OP_ID][0]!, models, records);

    expect(f.allProjectId).toBe('ap1');                       // links to the master
    expect(f.name).toBe('مينا 52');                            // prefers master name
    expect(f.city).toEqual({ ar: 'الرياض', en: 'الرياض' });    // denormalized city_name (lookup)
    expect(f.district).toEqual({ ar: 'النرجس', en: 'النرجس' }); // denormalized district_name (lookup)
    expect(f.unitTypes).toEqual([                              // distinct, first-seen order
      { ar: 'شقة', en: 'Apartment' },
      { ar: 'فيلا', en: 'Villa' },
    ]);
    expect(f.bedrooms).toEqual({ min: 2, max: 5 });            // rollup from units (all units)
    expect(f.bathrooms).toEqual({ min: 2, max: 4 });
    expect(f.areaRange).toEqual({ min: 120.4, max: 186.07 });  // AVAILABLE-only area rollup
    expect(f.minPrice).toEqual({ ar: '550,000 ر.س', en: 'SAR 550,000' }); // available floor, NOT the sold 500k
    expect(f.brochureLink).toBe('https://wassel.re/brochure.pdf');
    expect(f.locationLink).toBe('https://www.google.com/maps?q=24.7,46.6'); // lat,lng → maps URL
    expect(f.websiteUnitsLink).toBe('https://wassel.re/project?id=ap1#units'); // → units grid
    expect(f.imageFileIds).toEqual(['img-hero', 'img-2', 'img-3']);            // main_image deduped, order kept
    expect(f.missing).toEqual([]);                            // nothing missing
  });

  it('flags every missing field when the master link + units are absent', () => {
    const records: Record<string, AppRecord[]> = {
      [AP_ID]: [],
      [OP_ID]: [rec('op2', OP_ID, { project_name: 'بدون ربط', project: null })],
      [UN_ID]: [],
    };

    const f = resolveProjectFacts(records[OP_ID][0]!, models, records);

    expect(f.allProjectId).toBeNull();
    expect(f.name).toBe('بدون ربط');                          // falls back to our_projects name
    expect(f.city).toBeNull();
    expect(f.unitTypes).toEqual([]);
    expect(f.bedrooms).toBeNull();
    expect(f.minPrice).toBeNull();
    expect(f.websiteUnitsLink).toBeNull();                    // no master → no link
    expect(f.imageFileIds).toEqual([]);
    // name is present (our_projects), so it's NOT in missing; the link is missing
    // because there's no master id to point at (location/brochure are no longer tracked).
    expect(f.missing).toEqual(['city', 'district', 'unit_types', 'bedrooms', 'area', 'bathrooms', 'min_price', 'link']);
  });

  it('uses a full http(s) location value as the link verbatim, and falls back to master min_price', () => {
    const records: Record<string, AppRecord[]> = {
      [AP_ID]: [rec('ap3', AP_ID, {
        project_name: 'P3',
        min_price: 1200000,                                   // no priced units → this is the fallback
        brochure_link: '', project_location: 'https://maps.app.goo.gl/abc123',
      })],
      [OP_ID]: [rec('op3', OP_ID, { project_name: 'P3 ours', project: 'ap3' })],
      [UN_ID]: [],                                            // no units
    };

    const f = resolveProjectFacts(records[OP_ID][0]!, models, records);

    expect(f.locationLink).toBe('https://maps.app.goo.gl/abc123'); // http URL used as-is
    expect(f.minPrice).toEqual({ ar: '1,200,000 ر.س', en: 'SAR 1,200,000' }); // master fallback
    expect(f.websiteUnitsLink).toBe('https://wassel.re/project?id=ap3#units'); // master present → link
    expect(f.missing).toContain('unit_types');                // no units
    expect(f.missing).not.toContain('link');                  // master present
    expect(f.missing).not.toContain('brochure');              // brochure no longer tracked
    expect(f.missing).not.toContain('location');              // location no longer tracked
    expect(f.missing).not.toContain('min_price');
  });

  // Regression for the prod bug: the LIVE all_projects model was rebuilt in the
  // Builder with different slugs than the seed (preferred_city, brochure_url,
  // project_location, unit_types multiselect) and the rollups are computed on
  // all_projects, not our_projects. The old resolver hardcoded seed slugs +
  // our_projects rollups, so everything but unit types came back "Not available".
  it('resolves the LIVE topology — Builder-renamed slugs + rollups on all_projects', () => {
    const AP = 'm_all2', OP = 'm_our2', UN = 'm_units2';
    const allLive = model('all_projects', AP, [
      field({ name: 'project_name', type: 'text' }),
      field({ name: 'location', type: 'location' }),
      field({ name: 'unit_types', type: 'multiselect', options: [opt('apartment', 'شقة', 'Apartment'), opt('villa', 'فيلا', 'Villa')] }),
      field({ name: 'brochure_url', type: 'url' }),
      field({ name: 'project_location', type: 'url' }),
      field({ name: 'price_range', type: 'range', is_rollup: true, rollup_kind:'price_range' }),
      field({ name: 'bedroom_range', type: 'range', is_rollup: true, rollup_kind:'bedroom_range' }),
      field({ name: 'bathroom_range', type: 'range', is_rollup: true, rollup_kind:'bathroom_range' }),
      field({ name: 'area_range', type: 'range', is_rollup: true, rollup_kind:'area_range' }),
      field({ name: 'available_price_range', type: 'range', is_rollup: true, rollup_kind:'available_price_range' }),
      field({ name: 'available_area_range', type: 'range', is_rollup: true, rollup_kind:'available_area_range' }),
    ]);
    // Live our_projects is a thin sidecar: just the lookup, no rollup fields.
    const ourLive = model('our_projects', OP, [
      field({ name: 'project', type: 'lookup', lookup_model_id: AP, lookup_display_field: 'project_name' }),
    ]);
    const unitsLive = model('units', UN, [
      field({ name: 'project_id', type: 'lookup', lookup_model_id: AP }),
      field({ name: 'bedrooms', type: 'number' }),
      field({ name: 'bathrooms', type: 'number' }),
      field({ name: 'total_price', type: 'number' }),
    ]);
    const ms = [allLive, ourLive, unitsLive, cities, districts];
    const recs: Record<string, AppRecord[]> = {
      ...geoRecords,
      [AP]: [rec('ap', AP, {
        project_name: 'مينا 52',
        location: { region: 'r-riyadh', city: 'c-riyadh', district: 'd-narjis' },
        unit_types: ['apartment'],
        brochure_url: 'https://wassel.re/m52.pdf',
        project_location: 'https://maps.app.goo.gl/KvrmddYBhAjiQfcNA',
        // All-unit range starts at a sold 1.2m unit; the cheapest AVAILABLE
        // unit is 1.45m — the quoted starting price must be the latter.
        price_range: { min: 1200000, max: 1700000 },
        bedroom_range: { min: 2, max: 3 },
        bathroom_range: { min: 2, max: 3 },
        area_range: { min: 120, max: 180 },
        available_price_range: { min: 1450000, max: 1700000 },
        available_area_range: { min: 135, max: 180 },
      })],
      [OP]: [rec('op', OP, { project: 'ap' })],
      [UN]: [
        rec('u1', UN, { project_id: 'ap', bedrooms: 2, bathrooms: 2, total_price: 1200000 }),
        rec('u2', UN, { project_id: 'ap', bedrooms: 3, bathrooms: 3, total_price: 1700000 }),
      ],
    };
    const f = resolveProjectFacts(recs[OP][0]!, ms, recs);
    expect(f.name).toBe('مينا 52');
    expect(f.city).toEqual({ ar: 'الرياض', en: 'الرياض' });               // city_name (lookup)
    expect(f.district).toEqual({ ar: 'النرجس', en: 'النرجس' });           // district_name (lookup)
    expect(f.unitTypes).toEqual([{ ar: 'شقة', en: 'Apartment' }]);        // all_projects unit_types
    expect(f.bedrooms).toEqual({ min: 2, max: 3 });                       // rollup on all_projects
    expect(f.bathrooms).toEqual({ min: 2, max: 3 });
    expect(f.areaRange).toEqual({ min: 135, max: 180 });                  // available_area_range
    expect(f.minPrice).toEqual({ ar: '1,450,000 ر.س', en: 'SAR 1,450,000' }); // available_price_range.min
    expect(f.brochureLink).toBe('https://wassel.re/m52.pdf');             // brochure_url
    expect(f.locationLink).toBe('https://maps.app.goo.gl/KvrmddYBhAjiQfcNA'); // project_location (http verbatim)
    expect(f.missing).toEqual([]);                                        // nothing missing now
  });

  // QA-003: a project whose units are all sold/reserved must NOT quote the
  // all-unit price/area ranges to customers — both facts come back null (the
  // composer omits the lines) and are flagged in `missing`.
  it('omits price + area entirely when no units are available (no fallback to all-unit ranges)', () => {
    const records: Record<string, AppRecord[]> = {
      ...geoRecords,
      [AP_ID]: [rec('ap4', AP_ID, {
        project_name: 'مباع بالكامل',
        location: { region: 'r-riyadh', city: 'c-riyadh', district: 'd-narjis' },
      })],
      // All-unit rollups present (historical), available rollups null — the
      // exact shape the DB trigger stores for a sold-out project.
      [OP_ID]: [rec('op4', OP_ID, {
        project_name: 'مباع بالكامل', project: 'ap4',
        price_range: { min: 900000, max: 2000000 },
        area_range: { min: 100, max: 250 },
        available_price_range: null,
        available_area_range: null,
        bedroom_range: { min: 2, max: 4 },
        bathroom_range: { min: 2, max: 3 },
      })],
      [UN_ID]: [
        rec('u1', UN_ID, { project_id: 'ap4', unit_type: 'apartment', total_price: 900000, unit_status: 'sold' }),
      ],
    };

    const f = resolveProjectFacts(records[OP_ID][0]!, models, records);

    expect(f.minPrice).toBeNull();                 // NOT the sold 900k floor
    expect(f.areaRange).toBeNull();                // NOT the all-unit area range
    expect(f.missing).toContain('min_price');
    expect(f.missing).toContain('area');

    const { body_ar, body_en } = composeProjectMessage(f);
    expect(body_ar).not.toContain('الأسعار تبدأ من');
    expect(body_ar).not.toContain('المساحة');
    expect(body_en).not.toContain('Prices start from');
    expect(body_en).not.toContain('Area:');
  });
});

describe('composeProjectMessage', () => {
  const base: ProjectMessageFacts = {
    ourProjectId: 'o', allProjectId: 'a', name: 'مينا 52',
    city: { ar: 'الرياض', en: 'Riyadh' },
    district: { ar: 'النرجس', en: 'An-Narjis' },
    unitTypes: [{ ar: 'شقة', en: 'Apartment' }],
    bedrooms: { min: 2, max: 3 }, bathrooms: { min: 2, max: 3 },
    areaRange: { min: 114.28, max: 186.07 },
    minPrice: { ar: '1,200,000 ر.س', en: 'SAR 1,200,000' },
    brochureLink: null,                                   // no longer rendered
    locationLink: 'https://maps.app.goo.gl/x',            // no longer rendered (location dropped)
    websiteUnitsLink: 'https://wassel.re/project?id=a#units',
    imageFileIds: [],
    missing: [],
  };

  it('no greeting/closing, drops location, renders the website link as الرابط/Link', () => {
    const { body_ar, body_en } = composeProjectMessage(base);
    // no greeting or closing fluff in either language
    expect(body_ar).not.toMatch(/مرحب|تتردد|تواصل معنا/);
    expect(body_en).not.toMatch(/welcome|feel free|reach out/i);
    // brochure is gone — replaced by the website link line
    expect(body_ar).not.toContain('البروشور');
    expect(body_en).not.toContain('Brochure');
    // location line is dropped entirely
    expect(body_ar).not.toContain('الموقع');
    expect(body_en).not.toContain('Location');
    // the website unit-details link is labeled الرابط / Link
    expect(body_ar).toContain('الرابط: https://wassel.re/project?id=a#units');
    expect(body_en).toContain('Link: https://wassel.re/project?id=a#units');
    // exact price label (الأسعار تبدأ من / Prices start from)
    expect(body_ar).toContain('الأسعار تبدأ من: 1,200,000 ر.س');
    expect(body_en).toContain('Prices start from: SAR 1,200,000');
    // structure: name on the first line, then the present fields
    expect(body_ar.split('\n')[0]).toBe('مينا 52');
    expect(body_ar).toContain('المدينة: الرياض');
    expect(body_ar).toContain('غرف النوم: 2 - 3');
    // area line, rounded to whole m², placed right after bedrooms
    expect(body_ar).toContain('المساحة: 114 - 186 م²');
    expect(body_en).toContain('Area: 114 - 186 m²');
    expect(body_ar.indexOf('المساحة')).toBeGreaterThan(body_ar.indexOf('غرف النوم'));
    expect(body_ar.indexOf('المساحة')).toBeLessThan(body_ar.indexOf('دورات المياه'));
    expect(body_en).toContain('City: Riyadh');
  });

  it('renders an equal-min/max range as a single number', () => {
    const f: ProjectMessageFacts = { ...base, bedrooms: { min: 3, max: 3 } };
    const { body_ar } = composeProjectMessage(f);
    expect(body_ar).toContain('غرف النوم: 3');
    expect(body_ar).not.toContain('غرف النوم: 3 - 3');
  });

  it('uses the translated English name for the English body title (Arabic body keeps the Arabic name)', () => {
    const { body_ar, body_en } = composeProjectMessage(base, { nameEn: 'Mena 52' });
    expect(body_ar.split('\n')[0]).toBe('مينا 52'); // Arabic title unchanged
    expect(body_en.split('\n')[0]).toBe('Mena 52'); // English title = translated name
    // no override → English body falls back to the Arabic name
    expect(composeProjectMessage(base).body_en.split('\n')[0]).toBe('مينا 52');
  });
});
