import { describe, it, expect } from 'vitest';
import { resolveLookupDisplayValue } from '../mirrorResolver';
import type { AppModel, AppRecord, ModelField, ModelSection } from '@/types';

// Fresh builders per call so tests never share mutable schema state.
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

// Three-model chain:
//   deals.project ──lookup──▶ projects.region ──lookup──▶ regions.region_name (text)
//   projects.region_name_mirror is a `mirror` that surfaces regions.region_name
//   through the projects.region sibling lookup.
function build(opts: { multi?: boolean } = {}) {
  const regions = model({
    id: 'm_regions',
    name: 'regions',
    sections: [section({ id: 'reg_s0', fields: [field({ name: 'region_name' })] })],
  });

  const projects = model({
    id: 'm_projects',
    name: 'projects',
    sections: [
      section({
        id: 'proj_s0',
        fields: [
          field({ name: 'project_name' }),
          field({
            id: 'proj_region',
            name: 'region',
            type: 'lookup',
            lookup_model_id: 'm_regions',
            lookup_display_field: 'region_name',
            is_multi: opts.multi ?? false,
          }),
          field({
            id: 'proj_region_mirror',
            name: 'region_name_mirror',
            type: 'mirror',
            mirror_via_lookup_field_id: 'proj_region',
            mirror_target_field_name: 'region_name',
          }),
        ],
      }),
    ],
  });

  const deals = model({
    id: 'm_deals',
    name: 'deals',
    sections: [
      section({
        id: 'deal_s0',
        fields: [
          field({
            id: 'deal_project',
            name: 'project',
            type: 'lookup',
            lookup_model_id: 'm_projects',
            lookup_display_field: 'region_name_mirror', // ← the mirror is the display field
          }),
        ],
      }),
    ],
  });

  return { regions, projects, deals };
}

describe('resolveLookupDisplayValue', () => {
  it('resolves a mirror display field through the target model’s sibling lookup', () => {
    const { regions, projects, deals } = build();
    const allModels = [regions, projects, deals];
    const allRecords: Record<string, AppRecord[]> = {
      m_regions: [rec('reg1', 'm_regions', { region_name: 'Riyadh' })],
      m_projects: [rec('proj1', 'm_projects', { project_name: 'Tower A', region: 'reg1' })],
    };
    const projectRecord = allRecords.m_projects[0]!;

    const value = resolveLookupDisplayValue(projectRecord, 'region_name_mirror', {
      targetModel: projects,
      allModels,
      allRecords,
    });
    expect(value).toBe('Riyadh');
  });

  it('collapses a multi-valued mirror to a comma-joined string', () => {
    const { regions, projects, deals } = build({ multi: true });
    const allModels = [regions, projects, deals];
    const allRecords: Record<string, AppRecord[]> = {
      m_regions: [
        rec('reg1', 'm_regions', { region_name: 'Riyadh' }),
        rec('reg2', 'm_regions', { region_name: 'Jeddah' }),
      ],
      m_projects: [rec('proj1', 'm_projects', { region: ['reg1', 'reg2'] })],
    };

    const value = resolveLookupDisplayValue(allRecords.m_projects[0]!, 'region_name_mirror', {
      targetModel: projects,
      allModels,
      allRecords,
    });
    expect(value).toBe('Riyadh, Jeddah');
  });

  it('returns the raw stored value for a normal (non-mirror) display field', () => {
    const { regions, projects, deals } = build();
    const allModels = [regions, projects, deals];
    const allRecords: Record<string, AppRecord[]> = {
      m_regions: [rec('reg1', 'm_regions', { region_name: 'Riyadh' })],
    };
    const value = resolveLookupDisplayValue(allRecords.m_regions[0]!, 'region_name', {
      targetModel: regions,
      allModels,
      allRecords,
    });
    expect(value).toBe('Riyadh');
  });

  it('degrades to the raw read (undefined for a mirror slug) when context is missing', () => {
    const { projects } = build();
    const projectRecord = rec('proj1', 'm_projects', { region: 'reg1' });
    // No targetModel/allModels/allRecords → cannot resolve a mirror → raw read.
    expect(resolveLookupDisplayValue(projectRecord, 'region_name_mirror', {})).toBeUndefined();
    // targetModel present but the slug names a mirror with no stored value → still raw.
    expect(
      resolveLookupDisplayValue(projectRecord, 'region_name_mirror', { targetModel: projects }),
    ).toBeUndefined();
  });

  it('returns undefined when the mirror’s sibling lookup has no selection', () => {
    const { regions, projects, deals } = build();
    const allModels = [regions, projects, deals];
    const allRecords: Record<string, AppRecord[]> = { m_regions: [], m_projects: [] };
    const projectRecord = rec('proj1', 'm_projects', {}); // region not selected
    const value = resolveLookupDisplayValue(projectRecord, 'region_name_mirror', {
      targetModel: projects,
      allModels,
      allRecords,
    });
    expect(value).toBeUndefined();
  });
});
