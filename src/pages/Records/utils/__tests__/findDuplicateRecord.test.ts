import { describe, it, expect } from 'vitest';
import { findDuplicateRecord, getDuplicateCheckField } from '../findDuplicateRecord';
import type { AppModel, AppRecord, ModelField, ModelSection } from '@/types';

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

function section(id: string, fields: ModelField[], extra?: Partial<ModelSection>): ModelSection {
  return { id, label_ar: id, label_en: id, order: 0, is_base: true, fields, ...extra };
}

function rec(id: string, data: Record<string, unknown>): AppRecord {
  return { id, model_id: CLIENTS, data, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
}

/** A clients-shaped model whose duplicate-check field is the phone field. */
function clientsModel(dedupFieldId: string | null = 'f_phone'): AppModel {
  const phone = field({ id: 'f_phone', name: 'phone_number', type: 'phone' });
  const name = field({ id: 'f_name', name: 'client_name', type: 'text' });
  return {
    id: 'clients', name: CLIENTS, label_ar: 'العملاء', label_en: 'Clients', icon: 'box', group_id: null, order: 0,
    schema: { sections: [section('s0', [phone, name])], section_selector_field_id: null, duplicate_check_field_id: dedupFieldId },
  };
}

describe('getDuplicateCheckField', () => {
  it('resolves the configured field', () => {
    expect(getDuplicateCheckField(clientsModel())?.name).toBe('phone_number');
  });
  it('returns null when no dedup field is configured', () => {
    expect(getDuplicateCheckField(clientsModel(null))).toBeNull();
  });
  it('returns null when the referenced field no longer exists', () => {
    expect(getDuplicateCheckField(clientsModel('f_deleted'))).toBeNull();
  });
});

describe('findDuplicateRecord', () => {
  const existing = [
    rec('r240', { phone_number: '+966554446108', client_name: 'ريان' }),
    rec('r100', { phone_number: '+966500000009', client_name: 'سارة' }),
  ];

  it('matches an identical phone (this is the ع244/ع240 case)', () => {
    const m = findDuplicateRecord(clientsModel(), { phone_number: '+966554446108', client_name: 'ريان' }, existing);
    expect(m?.record.id).toBe('r240');
    expect(m?.field.name).toBe('phone_number');
    expect(m?.existingValue).toBe('+966554446108');
  });

  it('matches across phone formats — 05x vs +9665x collapse to the same key', () => {
    const m = findDuplicateRecord(clientsModel(), { phone_number: '0554446108' }, existing);
    expect(m?.record.id).toBe('r240');
  });

  it('returns null when the phone is new', () => {
    expect(findDuplicateRecord(clientsModel(), { phone_number: '+966512121212' }, existing)).toBeNull();
  });

  it('returns null when no dedup field is configured', () => {
    expect(findDuplicateRecord(clientsModel(null), { phone_number: '+966554446108' }, existing)).toBeNull();
  });

  it('returns null when the incoming value is empty', () => {
    expect(findDuplicateRecord(clientsModel(), { phone_number: '' }, existing)).toBeNull();
    expect(findDuplicateRecord(clientsModel(), {}, existing)).toBeNull();
  });

  it('excludes the record being edited so an in-place save never matches itself', () => {
    expect(
      findDuplicateRecord(clientsModel(), { phone_number: '+966554446108' }, existing, 'r240'),
    ).toBeNull();
  });

  it('dedupes non-phone fields case/whitespace-insensitively', () => {
    const model = clientsModel('f_name'); // dedup on the text name field
    const m = findDuplicateRecord(model, { client_name: '  Ryan ' }, [rec('rX', { client_name: 'ryan' })]);
    expect(m?.record.id).toBe('rX');
  });
});
