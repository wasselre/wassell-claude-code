import { describe, it, expect } from 'vitest';
import {
  resolveLocation,
  resolveLocationWithCache,
  collectUrlsNeedingResolution,
  type LocationResolveCtx,
} from '../locationUtils';
import { VIRTUAL_FIELD_SEPARATOR } from '../sectionMirrorExpand';
import type { AppModel, AppRecord, MapsConfig, ModelField, ModelSection } from '@/types';

// --- builders -------------------------------------------------------------

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

function section(partial: { id: string; fields: ModelField[] }): ModelSection {
  return { id: partial.id, label_ar: partial.id, label_en: partial.id, order: 0, is_base: true, fields: partial.fields };
}

function mapsConfig(partial: Partial<MapsConfig>): MapsConfig {
  return {
    location_url_field_id: null,
    manual_lat_field_id: null,
    manual_lng_field_id: null,
    pin_color_field_id: null,
    pin_label_field_id: null,
    click_action: 'popup',
    popup_title_field_id: null,
    popup_subtitle_field_id: null,
    popup_badge_field_id: null,
    popup_shown_field_ids: [],
    map_style_json: null,
    default_center_lat: null,
    default_center_lng: null,
    default_zoom: null,
    ...partial,
  };
}

function model(partial: { id: string; name: string; sections: ModelSection[]; maps_config?: MapsConfig }): AppModel {
  return {
    id: partial.id,
    name: partial.name,
    label_ar: partial.name,
    label_en: partial.name,
    icon: 'box',
    group_id: null,
    order: 0,
    schema: { sections: partial.sections, section_selector_field_id: null },
    maps_config: partial.maps_config ?? mapsConfig({}),
  };
}

function rec(id: string, model_id: string, data: Record<string, unknown>): AppRecord {
  return { id, model_id, data, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
}

const CONTAINER_ID = 'c_geo_mirror';
const LONG_URL = 'https://www.google.com/maps/place/Project/@24.7,46.6,15z';
const SHORT_URL = 'https://maps.app.goo.gl/abc123XYZ';

/**
 * Mirrors the real Our Projects ↔ All Projects shape:
 *   sub.link ──lookup──▶ master                     (the `project` lookup)
 *   sub.geo_mirror is a `section_mirror` of master's "geo" section, which holds
 *   the `loc_url` url field — so `${CONTAINER_ID}::loc_url` is the compound
 *   location field id the Map Builder would store.
 */
function build(locUrlValue: string) {
  const master = model({
    id: 'm_master',
    name: 'projects_master',
    sections: [
      section({
        id: 'master_geo',
        fields: [field({ id: 'f_loc_url', name: 'loc_url', type: 'url' })],
      }),
    ],
  });

  const linkField = field({ id: 'f_link', name: 'link', type: 'lookup', lookup_model_id: 'm_master' });
  const containerField = field({
    id: CONTAINER_ID,
    name: 'geo_mirror',
    type: 'section_mirror',
    section_mirror_via_lookup_field_id: 'f_link',
    section_mirror_source_section_id: 'master_geo',
    section_mirror_field_mode: 'all',
  });

  const sub = model({
    id: 'm_sub',
    name: 'sub_projects',
    sections: [section({ id: 'sub_s0', fields: [linkField, containerField] })],
    maps_config: mapsConfig({ location_url_field_id: `${CONTAINER_ID}${VIRTUAL_FIELD_SEPARATOR}loc_url` }),
  });

  const masterRec = rec('master_1', 'm_master', { loc_url: locUrlValue });
  const subRec = rec('sub_1', 'm_sub', { link: 'master_1' });

  const allModels = [master, sub];
  const allRecords: Record<string, AppRecord[]> = { m_master: [masterRec], m_sub: [subRec] };
  const ctx: LocationResolveCtx = { allRecords, allModels };
  const subFields = sub.schema.sections.flatMap((s) => s.fields);

  return { master, sub, masterRec, subRec, ctx, subFields };
}

// --- tests ----------------------------------------------------------------

describe('section_mirror child as a map location source', () => {
  it('resolves lat/lng through the section-mirror child url field', () => {
    const { sub, subRec, ctx, subFields } = build(LONG_URL);
    const loc = resolveLocation(subRec, sub.maps_config, subFields, ctx);
    expect(loc).toEqual({ lat: 24.7, lng: 46.6 });
  });

  it('returns null WITHOUT ctx (a section-mirror child cannot resolve locally)', () => {
    const { sub, subRec, subFields } = build(LONG_URL);
    const loc = resolveLocation(subRec, sub.maps_config, subFields, undefined);
    expect(loc).toBeNull();
  });

  it('resolveLocationWithCache also follows the section-mirror child', () => {
    const { sub, subRec, ctx, subFields } = build(LONG_URL);
    const loc = resolveLocationWithCache(subRec, sub.maps_config, subFields, ctx);
    expect(loc).toEqual({ lat: 24.7, lng: 46.6 });
  });

  it('collectUrlsNeedingResolution surfaces a SHORT url mirrored through the child', () => {
    const { sub, subRec, ctx, subFields } = build(SHORT_URL);
    const urls = collectUrlsNeedingResolution([subRec], sub.maps_config, subFields, ctx);
    expect(urls).toEqual([SHORT_URL]);
  });

  it('collectUrlsNeedingResolution skips a LONG url (sync-parsed, no server hop)', () => {
    const { sub, subRec, ctx, subFields } = build(LONG_URL);
    const urls = collectUrlsNeedingResolution([subRec], sub.maps_config, subFields, ctx);
    expect(urls).toEqual([]);
  });

  it('returns null when the linked master record is missing', () => {
    const { sub, subRec, ctx, subFields } = build(LONG_URL);
    // Drop the master record so the sibling lookup resolves to nothing.
    const brokenCtx: LocationResolveCtx = { ...ctx, allRecords: { m_master: [], m_sub: [subRec] } };
    expect(resolveLocation(subRec, sub.maps_config, subFields, brokenCtx)).toBeNull();
  });
});
