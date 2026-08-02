/**
 * Bilingual W5 — search folding + cross-language haystack.
 *
 * The core promise: a query typed in one language/script finds a record whose
 * source is in the other. `normalizeForSearch` must fold Arabic orthography the
 * SAME way the SQL `wassell_search_norm` does, and `buildRecordSearchText` must
 * index translations, assignee names, and geo/lookup displays.
 */
import { describe, it, expect } from 'vitest';
import { normalizeForSearch, foldArabic, buildRecordSearchText, type RecordSearchContext } from '../recordSearch';
import type { AppModel, AppRecord, User } from '@/types';

const FIELD = (over: Record<string, unknown>) => ({
  id: over.name as string, label_ar: '', label_en: '', required: false, order: 0,
  section_id: 's', width: 'full', show_in_table: true, ...over,
});

describe('normalizeForSearch — Arabic folding (parity with SQL wassell_search_norm)', () => {
  it('folds hamza-carrying alef to bare alef', () => {
    expect(normalizeForSearch('الأصيل')).toBe(normalizeForSearch('الاصيل'));
    expect(foldArabic('إآأ')).toBe('ااا');
  });
  it('folds ta-marbuta → heh and alef-maqsura → yeh', () => {
    expect(foldArabic('مدرسة')).toBe('مدرسه');
    expect(foldArabic('مصطفى')).toBe('مصطفي');
  });
  it('strips tatweel and unifies digits + case', () => {
    expect(normalizeForSearch('كـــتاب')).toBe('كتاب');
    expect(normalizeForSearch('١٤A')).toBe('14a');
  });
});

const model = {
  id: 'm1', name: 'units', label_ar: '', label_en: '',
  schema: {
    sections: [{
      id: 's', label_ar: '', label_en: '', order: 0, is_base: true,
      fields: [
        FIELD({ name: 'notes', type: 'textarea' }),
        FIELD({ name: 'sales_rep', type: 'assignee' }),
        FIELD({ name: 'project_id', type: 'lookup', lookup_model_id: 'm2', lookup_display_field: 'project_name' }),
      ],
    }],
  },
} as unknown as AppModel;

const projectModel = {
  id: 'm2', name: 'all_projects', label_ar: '', label_en: '',
  schema: { sections: [{ id: 's', label_ar: '', label_en: '', order: 0, is_base: true,
    fields: [FIELD({ name: 'project_name', type: 'text' })] }] },
} as unknown as AppModel;

const unit = {
  id: 'u1', model_id: 'm1',
  data: { notes: 'قريب من المسجد', sales_rep: 'user-1', project_id: 'p1' },
} as unknown as AppRecord;

const project = { id: 'p1', model_id: 'm2', data: { project_name: 'مساكن الأصيل' } } as unknown as AppRecord;

const users: User[] = [
  { id: 'user-1', name_ar: 'محمد', name_en: 'Mohammed', email: '', profile_id: '', role_assignments: [], is_active: true, created_at: '', updated_at: '' },
];

const translations: Record<string, string> = {
  'u1|notes|en': 'Close to the mosque',
  'p1|project_name|en': 'Masaken Al Aseel',
};

const ctx: RecordSearchContext = {
  models: [model, projectModel],
  records: { m2: [project] },
  users,
  translate: (id, path, lang) => translations[`${id}|${path}|${lang}`] ?? null,
};

describe('buildRecordSearchText — cross-language haystack', () => {
  const hay = () => normalizeForSearch(buildRecordSearchText(unit, model, ctx));

  it('indexes the Arabic source AND its English translation', () => {
    const h = hay();
    expect(h).toContain(normalizeForSearch('قريب من المسجد'));
    expect(h).toContain(normalizeForSearch('close to the mosque'));
  });

  it('resolves the assignee id to the user name in both languages', () => {
    const h = hay();
    expect(h).toContain(normalizeForSearch('محمد'));
    expect(h).toContain(normalizeForSearch('Mohammed'));
    expect(h).not.toContain('user-1'); // the raw uuid is not the search target
  });

  it('indexes the linked project name AND its English translation', () => {
    const h = hay();
    expect(h).toContain(normalizeForSearch('مساكن الأصيل'));
    expect(h).toContain(normalizeForSearch('Masaken Al Aseel'));
  });

  it('an English query for an Arabic-source project matches (the whole point)', () => {
    expect(hay()).toContain(normalizeForSearch('masaken'));
  });

  it('without a translate resolver, only source text is indexed (no crash)', () => {
    const bare: RecordSearchContext = { models: [model, projectModel], records: { m2: [project] }, users };
    const h = normalizeForSearch(buildRecordSearchText(unit, model, bare));
    expect(h).toContain(normalizeForSearch('قريب من المسجد'));
    expect(h).not.toContain(normalizeForSearch('close to the mosque'));
    expect(h).toContain(normalizeForSearch('محمد')); // assignee still resolves (no translation needed)
  });
});
