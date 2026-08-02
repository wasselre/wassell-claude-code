/**
 * Bilingual W4 — workflow token language formatters.
 *
 * `{slug}` stays RAW (X1 regression guard: conditions/integrations depend on
 * stored values); `{slug|ar}` / `{slug|en}` localize; `{slug|human_en}` renders
 * the friendly English date phrase; dot-path tokens localize against the
 * TARGET record.
 */
import { describe, it, expect } from 'vitest';
import { substituteFieldTokens, type SubstituteTokensContext } from '../workflowEngineCore';
import { formatDateHumanEn } from '../dateFormat';
import type { AppModel, AppRecord } from '@/types';

const FIELD = (over: Record<string, unknown>) => ({
  id: 'f', label_ar: '', label_en: '', required: false, order: 0,
  section_id: 's', width: 'full', show_in_table: false, ...over,
});

const model = {
  id: 'm1',
  name: 'units',
  label_ar: 'وحدات', label_en: 'Units',
  schema: {
    sections: [{
      id: 's', label_ar: '', label_en: '', order: 0, is_base: true,
      fields: [
        FIELD({ name: 'notes', type: 'textarea' }),
        FIELD({
          name: 'unit_status', type: 'dropdown',
          options: [{ id: 'o1', value: 'available', label_ar: 'متاحة', label_en: 'Available', color: '#0f0' }],
        }),
        FIELD({ name: 'project_id', type: 'lookup', lookup_model_id: 'm2' }),
      ],
    }],
  },
} as unknown as AppModel;

const projectModel = {
  id: 'm2', name: 'all_projects', label_ar: '', label_en: '',
  schema: {
    sections: [{
      id: 's', label_ar: '', label_en: '', order: 0, is_base: true,
      fields: [FIELD({ name: 'project_name', type: 'text' })],
    }],
  },
} as unknown as AppModel;

const record = {
  id: 'r1', model_id: 'm1',
  data: { notes: 'قريب من المسجد', unit_status: 'available', project_id: 'p1' },
} as unknown as AppRecord;

const project = { id: 'p1', model_id: 'm2', data: { project_name: 'مساكن الأصيل' } } as unknown as AppRecord;

const translations: Record<string, string> = {
  'r1|notes|en': 'Close to the mosque',
  'p1|project_name|en': 'Masaken Al Aseel',
};

const ctx: SubstituteTokensContext = {
  triggerModel: model,
  models: [model, projectModel],
  recordsByModel: { m2: [project] },
  localizeField: (rid, path, lang) => translations[`${rid}|${path}|${lang}`] ?? null,
};

describe('bare tokens stay raw (X1)', () => {
  it('{slug} substitutes the stored value untouched', () => {
    expect(substituteFieldTokens('حالة: {unit_status}', record, ctx)).toBe('حالة: available');
    expect(substituteFieldTokens('{notes}', record, ctx)).toBe('قريب من المسجد');
  });
});

describe('|ar / |en formatters', () => {
  it('dropdown value renders its option label in the requested language', () => {
    expect(substituteFieldTokens('{unit_status|en}', record, ctx)).toBe('Available');
    expect(substituteFieldTokens('{unit_status|ar}', record, ctx)).toBe('متاحة');
  });

  it('free text resolves its translation, falling back to source', () => {
    expect(substituteFieldTokens('{notes|en}', record, ctx)).toBe('Close to the mosque');
    // No AR target exists for an AR source — the source itself comes back.
    expect(substituteFieldTokens('{notes|ar}', record, ctx)).toBe('قريب من المسجد');
  });

  it('without localizeField the formatter degrades to the stored value', () => {
    const bare = { ...ctx, localizeField: undefined };
    expect(substituteFieldTokens('{notes|en}', record, bare)).toBe('قريب من المسجد');
  });

  it('dot-path token localizes against the TARGET record', () => {
    expect(substituteFieldTokens('{project_id.project_name|en}', record, ctx)).toBe('Masaken Al Aseel');
    expect(substituteFieldTokens('{project_id.project_name}', record, ctx)).toBe('مساكن الأصيل');
  });
});

describe('human_en', () => {
  it('formats a far-away datetime as an English phrase', () => {
    const out = substituteFieldTokens('{when|human_en}', {
      ...record, data: { when: '2030-03-05T14:30' },
    } as AppRecord, ctx);
    expect(out).toBe(formatDateHumanEn('2030-03-05T14:30'));
    expect(out).toContain('March');
    expect(out).toContain('2:30 PM');
  });
});
