import { describe, it, expect } from 'vitest';
import { getAdhocFilterableFields, applyAdhocFilters, type AdhocFilterState } from '../adhocFilterUtils';
import type { AppModel, AppRecord, ModelField, ModelSection } from '@/types';

// Builders return FRESH objects each call so tests never share mutable schema state.
function field(partial: Partial<ModelField> & { name: string }): ModelField {
  return {
    id: partial.id ?? `f_${partial.name}`,
    name: partial.name,
    label_ar: partial.label_ar ?? partial.name,
    label_en: partial.label_en ?? partial.name,
    type: partial.type ?? 'text',
    required: partial.required ?? false,
    order: partial.order ?? 0,
    ...partial,
  };
}

function section(partial: Partial<ModelSection> & { id: string; fields: ModelField[] }): ModelSection {
  return {
    id: partial.id,
    label_ar: partial.label_ar ?? partial.id,
    label_en: partial.label_en ?? partial.id,
    order: partial.order ?? 0,
    is_base: partial.is_base ?? true,
    fields: partial.fields,
    ...partial,
  };
}

function model(partial: { id: string; name: string; sections: ModelSection[] }): AppModel {
  return {
    id: partial.id,
    name: partial.name,
    label_ar: partial.name,
    label_en: partial.name,
    icon: 'box',
    group_id: null,
    order: 0,
    schema: { sections: partial.sections, section_selector_field_id: null },
  };
}

function rec(id: string, model_id: string, data: Record<string, unknown>): AppRecord {
  return { id, model_id, data, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
}

// A Clients model whose base section (id 'm_clients_s0') holds name + city (dropdown). Fresh per call.
function makeClients(): AppModel {
  return model({
    id: 'm_clients',
    name: 'clients',
    sections: [
      section({
        id: 'm_clients_s0',
        fields: [
          field({ name: 'name' }),
          field({
            id: 'cli_city',
            name: 'city',
            type: 'dropdown',
            options: [
              { id: 'o1', value: 'riyadh', label_ar: 'الرياض', label_en: 'Riyadh' },
              { id: 'o2', value: 'jeddah', label_ar: 'جدة', label_en: 'Jeddah' },
            ],
          }),
        ],
      }),
    ],
  });
}
function makeClientRecords(): AppRecord[] {
  return [rec('c1', 'm_clients', { name: 'Alpha', city: 'riyadh' }), rec('c2', 'm_clients', { name: 'Beta', city: 'jeddah' })];
}
const lookupField = (multi = false) =>
  field({ id: 'fu_client', name: 'client', type: 'lookup', lookup_model_id: 'm_clients', lookup_display_field: 'name', is_multi: multi });

// Shape 1 — scalar `mirror` field.
function makeScalarMirror(opts: { multi?: boolean; targetName?: string } = {}): AppModel {
  return model({
    id: 'm_follow',
    name: 'followups',
    sections: [section({
      id: 'm_follow_s0',
      fields: [
        field({ name: 'note' }),
        lookupField(opts.multi),
        field({ id: 'fu_client_city', name: 'client_city', type: 'mirror', mirror_via_lookup_field_id: 'fu_client', mirror_target_field_name: opts.targetName ?? 'city' }),
      ],
    })],
  });
}

// Shape 2 — mirrored section (section.is_mirrored, empty own fields).
function makeMirroredSection(): AppModel {
  return model({
    id: 'm_follow',
    name: 'followups',
    sections: [
      section({ id: 'm_follow_base', fields: [field({ name: 'note' }), lookupField()] }),
      section({ id: 'fu_mirror_sec', label_en: 'Client info', label_ar: 'بيانات العميل', is_base: false, is_mirrored: true, mirror_via_lookup_field_id: 'fu_client', mirror_source_section_id: 'm_clients_s0', fields: [] }),
    ],
  });
}

// Shape 3 — section_mirror field.
function makeSectionMirrorField(opts: { custom?: boolean } = {}): AppModel {
  return model({
    id: 'm_follow',
    name: 'followups',
    sections: [section({
      id: 'm_follow_s0',
      fields: [
        field({ name: 'note' }),
        lookupField(),
        field({ id: 'fu_cli_info', name: 'cli_info', type: 'section_mirror', label_en: 'Client', label_ar: 'العميل', section_mirror_via_lookup_field_id: 'fu_client', section_mirror_source_section_id: 'm_clients_s0', section_mirror_field_mode: opts.custom ? 'custom' : 'all', section_mirror_field_names: opts.custom ? ['city'] : undefined }),
      ],
    })],
  });
}

describe('getAdhocFilterableFields', () => {
  it('surfaces a scalar mirror as its target (mirror id kept, target type+options borrowed)', () => {
    const fu = makeScalarMirror();
    const entry = getAdhocFilterableFields(fu, [fu, makeClients()]).find((e) => e.field.id === 'fu_client_city');
    expect(entry).toBeDefined();
    expect(entry!.field.type).toBe('dropdown');
    expect(entry!.field.options?.map((o) => o.value)).toEqual(['riyadh', 'jeddah']);
    expect(entry!.target?.targetField.name).toBe('city');
  });

  it('omits a scalar mirror whose target field cannot be resolved', () => {
    const fu = makeScalarMirror({ targetName: 'nope' });
    expect(getAdhocFilterableFields(fu, [fu, makeClients()]).find((e) => e.field.id === 'fu_client_city')).toBeUndefined();
  });

  it('surfaces every filterable field of a mirrored section under a composite key', () => {
    const fu = makeMirroredSection();
    const cityEntry = getAdhocFilterableFields(fu, [fu, makeClients()]).find((e) => e.field.id === 'fu_mirror_sec::cli_city');
    expect(cityEntry).toBeDefined();
    expect(cityEntry!.field.type).toBe('dropdown');
    expect(cityEntry!.field.label_en).toBe('city'); // label is the source field name; only the id carries the container prefix
    expect(cityEntry!.target?.multiMode).toBe('first');
  });

  it('honors a section_mirror field-mode (custom → only picked child fields)', () => {
    const fu = makeSectionMirrorField({ custom: true });
    const entries = getAdhocFilterableFields(fu, [fu, makeClients()]);
    expect(entries.find((e) => e.field.id === 'fu_cli_info::cli_city')).toBeDefined();
    expect(entries.find((e) => e.field.id === 'fu_cli_info::f_name')).toBeUndefined(); // 'name' not picked
  });
});

describe('applyAdhocFilters — scalar mirror', () => {
  it('filters by a single-valued mirror', () => {
    const fu = makeScalarMirror();
    const records = [rec('f1', 'm_follow', { client: 'c1' }), rec('f2', 'm_follow', { client: 'c2' }), rec('f3', 'm_follow', {})];
    const state: AdhocFilterState = { fu_client_city: { kind: 'values', values: ['riyadh'], mode: 'is' } };
    const result = applyAdhocFilters(records, state, fu, [fu, makeClients()], { m_clients: makeClientRecords(), m_follow: records });
    expect(result.map((r) => r.id)).toEqual(['f1']);
  });

  it('"is_not" passes rows whose mirrored value is missing', () => {
    const fu = makeScalarMirror();
    const records = [rec('f1', 'm_follow', { client: 'c1' }), rec('f2', 'm_follow', { client: 'c2' }), rec('f3', 'm_follow', {})];
    const state: AdhocFilterState = { fu_client_city: { kind: 'values', values: ['riyadh'], mode: 'is_not' } };
    const result = applyAdhocFilters(records, state, fu, [fu, makeClients()], { m_clients: makeClientRecords(), m_follow: records });
    expect(result.map((r) => r.id)).toEqual(['f2', 'f3']);
  });

  it('matches when ANY value of a multi-valued sibling matches (multiMode all)', () => {
    const fu = makeScalarMirror({ multi: true });
    const records = [rec('f1', 'm_follow', { client: ['c1', 'c2'] }), rec('f2', 'm_follow', { client: ['c2'] })];
    const state: AdhocFilterState = { fu_client_city: { kind: 'values', values: ['riyadh'], mode: 'is' } };
    const result = applyAdhocFilters(records, state, fu, [fu, makeClients()], { m_clients: makeClientRecords(), m_follow: records });
    expect(result.map((r) => r.id)).toEqual(['f1']);
  });

  it('ignores an orphaned mirror filter (target removed → chip not offered → stale key skipped)', () => {
    // A mirror whose target field no longer resolves isn't offered as a chip, so it can only exist
    // as leftover localStorage state. Such a filter is skipped — same as a stale deleted-field filter.
    const fu = makeScalarMirror({ targetName: 'nope' });
    const records = [rec('f1', 'm_follow', { client: 'c1' }), rec('f2', 'm_follow', { client: 'c2' })];
    const state: AdhocFilterState = { fu_client_city: { kind: 'values', values: ['riyadh'], mode: 'is' } };
    const result = applyAdhocFilters(records, state, fu, [fu, makeClients()], { m_clients: makeClientRecords(), m_follow: records });
    expect(result.map((r) => r.id)).toEqual(['f1', 'f2']);
  });
});

describe('applyAdhocFilters — mirrored section & section_mirror', () => {
  it('filters by a mirrored-section child field', () => {
    const fu = makeMirroredSection();
    const records = [rec('f1', 'm_follow', { client: 'c1' }), rec('f2', 'm_follow', { client: 'c2' })];
    const state: AdhocFilterState = { 'fu_mirror_sec::cli_city': { kind: 'values', values: ['jeddah'], mode: 'is' } };
    const result = applyAdhocFilters(records, state, fu, [fu, makeClients()], { m_clients: makeClientRecords(), m_follow: records });
    expect(result.map((r) => r.id)).toEqual(['f2']);
  });

  it('filters by a section_mirror child field', () => {
    const fu = makeSectionMirrorField();
    const records = [rec('f1', 'm_follow', { client: 'c1' }), rec('f2', 'm_follow', { client: 'c2' })];
    const state: AdhocFilterState = { 'fu_cli_info::cli_city': { kind: 'values', values: ['riyadh'], mode: 'is' } };
    const result = applyAdhocFilters(records, state, fu, [fu, makeClients()], { m_clients: makeClientRecords(), m_follow: records });
    expect(result.map((r) => r.id)).toEqual(['f1']);
  });
});

describe('applyAdhocFilters — plain fields still work', () => {
  it('filters a non-mirror field', () => {
    const fu = makeScalarMirror();
    const records = [rec('f1', 'm_follow', { note: 'hello world' }), rec('f2', 'm_follow', { note: 'bye' })];
    const state: AdhocFilterState = { f_note: { kind: 'contains', query: 'hello' } };
    const result = applyAdhocFilters(records, state, fu, [fu, makeClients()], { m_clients: makeClientRecords(), m_follow: records });
    expect(result.map((r) => r.id)).toEqual(['f1']);
  });
});

// A model with a `location` cascade field (region → city → district). The level
// model_ids don't need real records for applyAdhocFilters — matching reads the
// compound value stored on the record itself, not the geography models.
function makeLocationModel(): AppModel {
  return model({
    id: 'm_listings',
    name: 'market_listings',
    sections: [section({
      id: 'm_listings_s0',
      fields: [
        field({ name: 'title' }),
        field({
          id: 'ml_loc',
          name: 'location',
          type: 'location',
          location_levels: [
            { key: 'region', model_id: 'm_regions', display_field: 'name_ar' },
            { key: 'city', model_id: 'm_cities', display_field: 'name_ar', parent_link_field: 'region_lookup' },
            { key: 'district', model_id: 'm_districts', display_field: 'name_ar', parent_link_field: 'city_lookup' },
          ],
        }),
      ],
    })],
  });
}

describe('location filter', () => {
  it('exposes a location field as filterable', () => {
    const m = makeLocationModel();
    const entry = getAdhocFilterableFields(m, [m]).find((e) => e.field.id === 'ml_loc');
    expect(entry).toBeDefined();
    expect(entry!.field.type).toBe('location');
  });

  it('matches by district on single-shape (scalar) location values', () => {
    const m = makeLocationModel();
    const records = [
      rec('l1', 'm_listings', { location: { region: 'r1', city: 'c1', district: 'd1' } }),
      rec('l2', 'm_listings', { location: { region: 'r1', city: 'c1', district: 'd2' } }),
      rec('l3', 'm_listings', {}), // no location → never matches an active filter
    ];
    const state: AdhocFilterState = { ml_loc: { kind: 'location', levels: { district: ['d1'] } } };
    const result = applyAdhocFilters(records, state, m, [m], { m_listings: records });
    expect(result.map((r) => r.id)).toEqual(['l1']);
  });

  it('OR within a level, AND across levels', () => {
    const m = makeLocationModel();
    const records = [
      rec('l1', 'm_listings', { location: { region: 'r1', city: 'c1', district: 'd1' } }),
      rec('l2', 'm_listings', { location: { region: 'r2', city: 'c9', district: 'd2' } }),
      rec('l3', 'm_listings', { location: { region: 'r1', city: 'c1', district: 'd3' } }),
    ];
    // district in {d1, d2} (OR) AND region = r1 → only l1 (l2 is r2, l3 district not picked).
    const state: AdhocFilterState = { ml_loc: { kind: 'location', levels: { district: ['d1', 'd2'], region: ['r1'] } } };
    const result = applyAdhocFilters(records, state, m, [m], { m_listings: records });
    expect(result.map((r) => r.id)).toEqual(['l1']);
  });

  it('matches multi-shape (array) location values', () => {
    const m = makeLocationModel();
    const records = [
      rec('l1', 'm_listings', { location: { region: ['r1'], city: ['c1'], district: ['d1', 'd2'] } }),
      rec('l2', 'm_listings', { location: { region: ['r1'], city: ['c1'], district: ['d3'] } }),
    ];
    const state: AdhocFilterState = { ml_loc: { kind: 'location', levels: { district: ['d2'] } } };
    const result = applyAdhocFilters(records, state, m, [m], { m_listings: records });
    expect(result.map((r) => r.id)).toEqual(['l1']);
  });

  it('an empty location selection is inactive (no filtering)', () => {
    const m = makeLocationModel();
    const records = [
      rec('l1', 'm_listings', { location: { district: 'd1' } }),
      rec('l2', 'm_listings', {}),
    ];
    const state: AdhocFilterState = { ml_loc: { kind: 'location', levels: { district: [] } } };
    const result = applyAdhocFilters(records, state, m, [m], { m_listings: records });
    expect(result.map((r) => r.id)).toEqual(['l1', 'l2']);
  });
});
