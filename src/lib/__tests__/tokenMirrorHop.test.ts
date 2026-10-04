/**
 * Dot-path tokens read through a MIRROR (2026-10-04): appointments.project_id
 * now points at Our Projects, whose entries carry no project_name / location
 * of their own — they mirror them from the master project through their
 * `project` lookup. `{project_id.project_name}` must still resolve.
 */
import { describe, it, expect } from 'vitest';
import { substituteFieldTokens, type SubstituteTokensContext } from '../workflowEngineCore';
import type { AppModel, AppRecord } from '@/types';

const FIELD = (over: Record<string, unknown>) => ({
  id: 'f', label_ar: '', label_en: '', required: false, order: 0,
  section_id: 's', width: 'full', show_in_table: false, ...over,
});

const master = {
  id: 'm-all', name: 'all_projects', label_ar: '', label_en: '',
  schema: { sections: [{ id: 'sec-data', label_ar: '', label_en: '', order: 0, is_base: true, fields: [
    FIELD({ id: 'f-name', name: 'project_name', type: 'text' }),
    FIELD({ id: 'f-loc', name: 'project_location', type: 'url' }),
  ] }] },
} as unknown as AppModel;

const ours = {
  id: 'm-ours', name: 'our_projects', label_ar: '', label_en: '',
  schema: { sections: [{ id: 's', label_ar: '', label_en: '', order: 0, is_base: true, fields: [
    FIELD({ id: 'f-project', name: 'project', type: 'lookup', lookup_model_id: 'm-all' }),
    FIELD({ id: 'f-mirror', name: 'project_data', type: 'section_mirror', section_mirror_via_lookup_field_id: 'f-project', section_mirror_source_section_id: 'sec-data' }),
    FIELD({ id: 'f-pitch', name: 'sales_pitch', type: 'textarea' }),
  ] }] },
} as unknown as AppModel;

const appointments = {
  id: 'm-appt', name: 'appointments', label_ar: '', label_en: '',
  schema: { sections: [{ id: 's', label_ar: '', label_en: '', order: 0, is_base: true, fields: [
    FIELD({ id: 'f-pid', name: 'project_id', type: 'lookup', lookup_model_id: 'm-ours' }),
  ] }] },
} as unknown as AppModel;

const masterRec = { id: 'p1', model_id: 'm-all', data: { project_name: 'صفا 82', project_location: 'https://maps.example/1' } } as unknown as AppRecord;
const ourRec = { id: 'o1', model_id: 'm-ours', data: { project: 'p1', sales_pitch: 'قريب من الخدمات' } } as unknown as AppRecord;
const appt = { id: 'a1', model_id: 'm-appt', data: { project_id: 'o1' } } as unknown as AppRecord;

const ctx: SubstituteTokensContext = {
  triggerModel: appointments,
  recordsByModel: { 'm-all': [masterRec], 'm-ours': [ourRec] },
  models: [master, ours, appointments],
};

describe('dot-path tokens through a mirror', () => {
  it('reads a mirrored field from the linked master project', () => {
    expect(substituteFieldTokens('{project_id.project_name} — {project_id.project_location}', appt, ctx))
      .toBe('صفا 82 — https://maps.example/1');
  });

  it("still reads the target's own fields directly", () => {
    expect(substituteFieldTokens('{project_id.sales_pitch}', appt, ctx)).toBe('قريب من الخدمات');
  });

  it('substitutes empty when the mirrored record is not loaded', () => {
    expect(substituteFieldTokens('{project_id.project_name}', appt, { ...ctx, recordsByModel: { 'm-ours': [ourRec] } })).toBe('');
  });

  it('does not invent a field no mirror carries', () => {
    expect(substituteFieldTokens('{project_id.unknown_field}', appt, ctx)).toBe('');
  });
});
