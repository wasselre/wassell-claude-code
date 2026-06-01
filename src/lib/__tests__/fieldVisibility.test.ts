import { describe, it, expect } from 'vitest';
import { isFieldVisible } from '../fieldVisibility';
import type { AppModel, ModelField, ModelSection } from '@/types';

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

function makeModel(fields: ModelField[]): AppModel {
  const section: ModelSection = {
    id: 's0', label_ar: 's0', label_en: 's0', order: 0, is_base: true, fields,
  };
  return {
    id: 'm', name: 'followups', label_ar: 'f', label_en: 'f', icon: 'box',
    group_id: null, order: 0,
    schema: { sections: [section], section_selector_field_id: 'ctrl' },
  } as AppModel;
}

// Controller is a section_selector (multi-value → stored as an array), mirroring
// the live `followup_type` field.
const controller = field({ id: 'ctrl', name: 'followup_type', type: 'section_selector' });

const apptField = field({
  name: 'appointment_id',
  type: 'lookup',
  visible_when: { field_id: 'ctrl', values: ['appointment_confirmation_call'] },
});

const model = makeModel([controller, apptField]);

describe('isFieldVisible', () => {
  it('shows a field with no rule', () => {
    expect(isFieldVisible(field({ name: 'plain' }), {}, model)).toBe(true);
  });

  it('shows the field when the array controller value matches', () => {
    expect(isFieldVisible(apptField, { followup_type: ['appointment_confirmation_call'] }, model)).toBe(true);
  });

  it('hides the field when the controller value does not match (orphan value)', () => {
    expect(isFieldVisible(apptField, { followup_type: ['5a6ec52f-old-section-id'] }, model)).toBe(false);
  });

  it('hides the field when the controller is empty/unset', () => {
    expect(isFieldVisible(apptField, { followup_type: [] }, model)).toBe(false);
    expect(isFieldVisible(apptField, {}, model)).toBe(false);
  });

  it('shows the field anyway if it already holds a value (never hide data)', () => {
    // Orphan controller value, but appointment_id is populated → must stay visible.
    expect(
      isFieldVisible(apptField, { followup_type: ['orphan'], appointment_id: 'rec-123' }, model),
    ).toBe(true);
  });

  it('treats an empty string / empty array value as "no value" (still hidden)', () => {
    expect(isFieldVisible(apptField, { followup_type: ['orphan'], appointment_id: '' }, model)).toBe(false);
    expect(isFieldVisible(apptField, { followup_type: ['orphan'], appointment_id: [] }, model)).toBe(false);
  });

  it('matches a scalar controller value (e.g. a plain dropdown)', () => {
    const scalarCtrl = field({ id: 'ctrl', name: 'followup_type', type: 'dropdown' });
    const m = makeModel([scalarCtrl, apptField]);
    expect(isFieldVisible(apptField, { followup_type: 'appointment_confirmation_call' }, m)).toBe(true);
    expect(isFieldVisible(apptField, { followup_type: 'whatsapp_follow_up' }, m)).toBe(false);
  });

  it('matches numeric controller values via string coercion', () => {
    const numCtrl = field({ id: 'ctrl', name: 'stage', type: 'dropdown' });
    const gated = field({ name: 'g', visible_when: { field_id: 'ctrl', values: ['2'] } });
    const m = makeModel([numCtrl, gated]);
    expect(isFieldVisible(gated, { stage: 2 }, m)).toBe(true);
    expect(isFieldVisible(gated, { stage: 3 }, m)).toBe(false);
  });

  it('fails open when the controller field is missing or values are empty', () => {
    const dangling = field({ name: 'd', visible_when: { field_id: 'does-not-exist', values: ['x'] } });
    expect(isFieldVisible(dangling, {}, model)).toBe(true);
    const noValues = field({ name: 'n', visible_when: { field_id: 'ctrl', values: [] } });
    expect(isFieldVisible(noValues, { followup_type: ['orphan'] }, model)).toBe(true);
  });
});
