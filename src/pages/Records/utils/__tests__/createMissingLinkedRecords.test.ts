import { describe, it, expect } from 'vitest';
import { createMissingLinkedRecords } from '../createMissingLinkedRecords';
import { normalizePhone } from '@/lib/phone';
import type { AppModel, AppRecord, ModelField, ModelSection, SaveResult } from '@/types';

const CLIENTS = 'clients';

function field(p: Partial<ModelField> & { name: string }): ModelField {
  return {
    id: p.id ?? `f_${p.name}`,
    name: p.name,
    label_ar: p.label_ar ?? p.name,
    label_en: p.label_en ?? p.name,
    type: p.type ?? 'text',
    required: p.required ?? false,
    order: p.order ?? 0,
    ...p,
  };
}

function section(id: string, fields: ModelField[]): ModelSection {
  return { id, label_ar: id, label_en: id, order: 0, is_base: true, fields };
}

function rec(id: string, model_id: string, data: Record<string, unknown>): AppRecord {
  return { id, model_id, data, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
}

/** A visits-shaped model: client_id lookup + a phone field wired to create-on-save. */
function visitsModel(): AppModel {
  const clientLookup = field({
    id: 'f_client', name: 'client_id', type: 'lookup', lookup_model_id: CLIENTS, lookup_display_field: 'client_id',
  });
  const phone = field({
    name: 'phone', type: 'phone',
    auto_link_lookup_field_id: 'f_client',
    auto_link_target_field_name: 'phone_number',
    auto_link_normalize: 'phone',
    auto_link_create_if_missing: true,
    auto_link_create_timing: 'on_save',
    auto_link_create_min_length: 9,
    auto_link_create_copy_fields: [{ from: 'name', to: 'client_name' }],
  });
  const name = field({ name: 'name', type: 'text' });
  return {
    id: 'visits', name: 'visits', label_ar: 'visits', label_en: 'visits', icon: 'box', group_id: null, order: 0,
    schema: { sections: [section('s0', [clientLookup, phone, name])], section_selector_field_id: null },
  };
}

/** Mock saveRecord that records every created record. */
function mockSaver() {
  const saved: AppRecord[] = [];
  const saveRecord = async (r: AppRecord): Promise<SaveResult> => {
    saved.push(r);
    return { status: 'saved' };
  };
  return { saved, saveRecord };
}

describe('createMissingLinkedRecords', () => {
  it('creates a new client (phone + copied name) when no phone matches and links it', async () => {
    const { saved, saveRecord } = mockSaver();
    const res = await createMissingLinkedRecords({
      model: visitsModel(),
      formData: { phone: '+966500000001', name: 'غلا' },
      records: { [CLIENTS]: [] },
      saveRecord,
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]!.model_id).toBe(CLIENTS);
    expect(saved[0]!.data.phone_number).toBe(normalizePhone('+966500000001'));
    expect(saved[0]!.data.client_name).toBe('غلا'); // copy_fields applied
    expect(res.patch.client_id).toBe(saved[0]!.id); // visit links to the new client
    expect(res.created).toEqual([{ id: saved[0]!.id, label: 'غلا', modelId: CLIENTS }]);
  });

  it('links an existing client by phone and does NOT create', async () => {
    const { saved, saveRecord } = mockSaver();
    const existing = rec('client-1', CLIENTS, { phone_number: '+966500000002', client_name: 'موجود' });
    const res = await createMissingLinkedRecords({
      model: visitsModel(),
      formData: { phone: '+966500000002', name: 'typed' },
      records: { [CLIENTS]: [existing] },
      saveRecord,
    });

    expect(saved).toHaveLength(0); // no create
    expect(res.created).toHaveLength(0);
    expect(res.patch.client_id).toBe('client-1');
  });

  it('does nothing when the client lookup is already set', async () => {
    const { saved, saveRecord } = mockSaver();
    const res = await createMissingLinkedRecords({
      model: visitsModel(),
      formData: { phone: '+966500000003', name: 'غلا', client_id: 'already-picked' },
      records: { [CLIENTS]: [] },
      saveRecord,
    });

    expect(saved).toHaveLength(0);
    expect(res.created).toHaveLength(0);
    expect(res.patch).toEqual({});
  });

  it('ignores fields whose create timing is while_typing (handled by useAutoLink, not on save)', async () => {
    const model = visitsModel();
    // Flip the phone field back to the while-typing default.
    const phone = model.schema.sections[0]!.fields.find((f) => f.name === 'phone')!;
    phone.auto_link_create_timing = 'while_typing';

    const { saved, saveRecord } = mockSaver();
    const res = await createMissingLinkedRecords({
      model,
      formData: { phone: '+966500000004', name: 'غلا' },
      records: { [CLIENTS]: [] },
      saveRecord,
    });

    expect(saved).toHaveLength(0);
    expect(res.patch).toEqual({});
  });

  it('skips creation when the normalized value is shorter than the min length', async () => {
    const { saved, saveRecord } = mockSaver();
    const res = await createMissingLinkedRecords({
      model: visitsModel(),
      // Too few digits → normalizePhone returns null OR a value below min length → no create.
      formData: { phone: '123', name: 'غلا' },
      records: { [CLIENTS]: [] },
      saveRecord,
    });

    expect(saved).toHaveLength(0);
    expect(res.patch).toEqual({});
  });
});
