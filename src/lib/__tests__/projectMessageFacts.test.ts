import { describe, it, expect } from 'vitest';
import { resolveProjectFacts } from '../projectMessageFacts';
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
  field({ name: 'city', type: 'dropdown', options: [opt('riyadh', 'الرياض', 'Riyadh'), opt('jeddah', 'جدة', 'Jeddah')] }),
  field({ name: 'district', type: 'dropdown', options: [opt('narjis', 'النرجس', 'Al Narjis')] }),
  field({ name: 'min_price', type: 'currency' }),
  field({ name: 'brochure_link', type: 'url' }),
  field({ name: 'location', type: 'text' }),
]);

const ourProjects = model('our_projects', OP_ID, [
  field({ name: 'project_name', type: 'text' }),
  field({ name: 'project', type: 'lookup', lookup_model_id: AP_ID, lookup_display_field: 'project_name' }),
  field({ name: 'price_range', type: 'range', is_computed: true, computed_kind: 'price_range' }),
  field({ name: 'bedroom_range', type: 'range', is_computed: true, computed_kind: 'bedroom_range' }),
  field({ name: 'bathroom_range', type: 'range', is_computed: true, computed_kind: 'bathroom_range' }),
]);

const units = model('units', UN_ID, [
  field({ name: 'project_id', type: 'lookup', lookup_model_id: AP_ID }),
  field({ name: 'unit_type', type: 'dropdown', options: [opt('apartment', 'شقة', 'Apartment'), opt('villa', 'فيلا', 'Villa')] }),
  field({ name: 'bedrooms', type: 'number' }),
  field({ name: 'bathrooms', type: 'number' }),
  field({ name: 'total_price', type: 'number' }),
  field({ name: 'unit_status', type: 'dropdown' }),
]);

const models = [allProjects, ourProjects, units];

describe('resolveProjectFacts', () => {
  it('resolves the full hybrid fact set for a project with units', () => {
    const records: Record<string, AppRecord[]> = {
      [AP_ID]: [rec('ap1', AP_ID, {
        project_name: 'مينا 52',
        city: 'riyadh',
        district: 'narjis',
        min_price: 900000,
        brochure_link: 'https://wassel.re/brochure.pdf',
        location: '24.7,46.6',
      })],
      [OP_ID]: [rec('op1', OP_ID, { project_name: 'مينا 52 (لنا)', project: 'ap1' })],
      [UN_ID]: [
        rec('u1', UN_ID, { project_id: 'ap1', unit_type: 'apartment', bedrooms: 2, bathrooms: 2, total_price: 500000 }),
        rec('u2', UN_ID, { project_id: 'ap1', unit_type: 'villa', bedrooms: 5, bathrooms: 4, total_price: 750000 }),
        rec('u3', UN_ID, { project_id: 'ap1', unit_type: 'apartment', bedrooms: 3, bathrooms: 2, total_price: 600000 }),
      ],
    };

    const f = resolveProjectFacts(records[OP_ID][0]!, models, records);

    expect(f.allProjectId).toBe('ap1');                       // links to the master
    expect(f.name).toBe('مينا 52');                            // prefers master name
    expect(f.city).toEqual({ ar: 'الرياض', en: 'Riyadh' });    // dropdown → bilingual labels
    expect(f.district).toEqual({ ar: 'النرجس', en: 'Al Narjis' });
    expect(f.unitTypes).toEqual([                              // distinct, first-seen order
      { ar: 'شقة', en: 'Apartment' },
      { ar: 'فيلا', en: 'Villa' },
    ]);
    expect(f.bedrooms).toEqual({ min: 2, max: 5 });            // rollup from units
    expect(f.bathrooms).toEqual({ min: 2, max: 4 });
    expect(f.minPrice).toEqual({ ar: '500,000 ر.س', en: 'SAR 500,000' }); // computed floor wins
    expect(f.brochureLink).toBe('https://wassel.re/brochure.pdf');
    expect(f.locationLink).toBe('https://www.google.com/maps?q=24.7,46.6'); // lat,lng → maps URL
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
    // name is present (our_projects), so it's NOT in missing; the other 8 are.
    expect(f.missing).toEqual(['city', 'district', 'unit_types', 'bedrooms', 'bathrooms', 'min_price', 'brochure', 'location']);
  });

  it('uses a full http(s) location value as the link verbatim, and falls back to master min_price', () => {
    const records: Record<string, AppRecord[]> = {
      [AP_ID]: [rec('ap3', AP_ID, {
        project_name: 'P3', city: 'jeddah', district: 'narjis',
        min_price: 1200000,                                   // no priced units → this is the fallback
        brochure_link: '', location: 'https://maps.app.goo.gl/abc123',
      })],
      [OP_ID]: [rec('op3', OP_ID, { project_name: 'P3 ours', project: 'ap3' })],
      [UN_ID]: [],                                            // no units
    };

    const f = resolveProjectFacts(records[OP_ID][0]!, models, records);

    expect(f.locationLink).toBe('https://maps.app.goo.gl/abc123'); // http URL used as-is
    expect(f.minPrice).toEqual({ ar: '1,200,000 ر.س', en: 'SAR 1,200,000' }); // master fallback
    expect(f.missing).toContain('brochure');                  // empty string → missing
    expect(f.missing).toContain('unit_types');                // no units
    expect(f.missing).not.toContain('location');
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
      field({ name: 'preferred_city', type: 'dropdown', options: [opt('riyadh', 'الرياض', 'Riyadh')] }),
      field({ name: 'preferred_neighborhoods', type: 'dropdown', options: [opt('narjis', 'النرجس', 'Al Narjis')] }),
      field({ name: 'unit_types', type: 'multiselect', options: [opt('apartment', 'شقة', 'Apartment'), opt('villa', 'فيلا', 'Villa')] }),
      field({ name: 'brochure_url', type: 'url' }),
      field({ name: 'project_location', type: 'url' }),
      field({ name: 'price_range', type: 'range', is_computed: true, computed_kind: 'price_range' }),
      field({ name: 'bedroom_range', type: 'range', is_computed: true, computed_kind: 'bedroom_range' }),
      field({ name: 'bathroom_range', type: 'range', is_computed: true, computed_kind: 'bathroom_range' }),
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
    const ms = [allLive, ourLive, unitsLive];
    const recs: Record<string, AppRecord[]> = {
      [AP]: [rec('ap', AP, {
        project_name: 'مينا 52',
        preferred_city: 'riyadh',
        preferred_neighborhoods: 'narjis',
        unit_types: ['apartment'],
        brochure_url: 'https://wassel.re/m52.pdf',
        project_location: 'https://maps.app.goo.gl/KvrmddYBhAjiQfcNA',
      })],
      [OP]: [rec('op', OP, { project: 'ap' })],
      [UN]: [
        rec('u1', UN, { project_id: 'ap', bedrooms: 2, bathrooms: 2, total_price: 1200000 }),
        rec('u2', UN, { project_id: 'ap', bedrooms: 3, bathrooms: 3, total_price: 1700000 }),
      ],
    };
    const f = resolveProjectFacts(recs[OP][0]!, ms, recs);
    expect(f.name).toBe('مينا 52');
    expect(f.city).toEqual({ ar: 'الرياض', en: 'Riyadh' });               // preferred_city
    expect(f.district).toEqual({ ar: 'النرجس', en: 'Al Narjis' });        // preferred_neighborhoods
    expect(f.unitTypes).toEqual([{ ar: 'شقة', en: 'Apartment' }]);        // all_projects unit_types
    expect(f.bedrooms).toEqual({ min: 2, max: 3 });                       // rollup on all_projects
    expect(f.bathrooms).toEqual({ min: 2, max: 3 });
    expect(f.minPrice).toEqual({ ar: '1,200,000 ر.س', en: 'SAR 1,200,000' }); // price_range.min
    expect(f.brochureLink).toBe('https://wassel.re/m52.pdf');             // brochure_url
    expect(f.locationLink).toBe('https://maps.app.goo.gl/KvrmddYBhAjiQfcNA'); // project_location (http verbatim)
    expect(f.missing).toEqual([]);                                        // nothing missing now
  });
});
