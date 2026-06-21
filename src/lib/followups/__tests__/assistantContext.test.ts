import { describe, it, expect } from 'vitest';
import { buildAssistantContext } from '../assistantContext';
import type { AppModel } from '@/types';

/** Minimal clients model carrying only the preference fields the context helper
 *  reads. Cast through unknown — the helper only touches schema.sections[].fields. */
const clientsModel = {
  schema: {
    sections: [
      {
        fields: [
          {
            name: 'preferred_city', type: 'multiselect',
            options: [
              { id: '1', value: 'الرياض', label_ar: 'الرياض', label_en: 'Riyadh' },
              { id: '2', value: 'جدة', label_ar: 'جدة', label_en: 'Jeddah' },
            ],
          },
          {
            name: 'preferred_neighborhoods', type: 'multiselect',
            options: [
              { id: '3', value: 'النرجس', label_ar: 'النرجس', label_en: 'An-Narjis' },
              { id: '4', value: 'حي العارض', label_ar: 'حي العارض', label_en: 'Al-Aridh' },
            ],
          },
          {
            name: 'preferred_unit_type', type: 'multiselect',
            options: [{ id: '5', value: 'تاون هاوس', label_ar: 'تاون هاوس', label_en: 'Townhouse' }],
          },
          { name: 'budget', type: 'range', options: [] },
          { name: 'preferred_area', type: 'range', options: [] },
          { name: 'preferred_amenities', type: 'multiselect', options: [] },
        ],
      },
    ],
  },
} as unknown as AppModel;

describe('buildAssistantContext — draft-first preference resolution', () => {
  it('prefers the unsaved draft value over the saved record value', () => {
    const savedClientData = { preferred_neighborhoods: ['النرجس'], budget: { min: 0, max: 2_000_000 } };
    const prefDraft = { preferred_neighborhoods: ['حي العارض'], budget: { min: 0, max: 2_500_000 } };

    const ctx = buildAssistantContext({
      clientsModel, prefDraft, savedClientData, followupDraft: {}, isAr: true,
    });

    const district = ctx.used.find((p) => p.slug === 'preferred_neighborhoods');
    const budget = ctx.used.find((p) => p.slug === 'budget');
    // DRAFT wins — العارض not النرجس, 2,500,000 not 2,000,000.
    expect(district?.value).toBe('حي العارض');
    expect(budget?.value).toContain('2,500,000');
    expect(ctx.preface).toContain('حي العارض');
    expect(ctx.preface).not.toContain('النرجس');
    expect(ctx.preface).toContain('2,500,000');
  });

  it('falls back to the saved value when the draft slot is empty', () => {
    const savedClientData = { preferred_city: ['الرياض'], preferred_unit_type: ['تاون هاوس'] };
    const prefDraft = {}; // nothing edited yet

    const ctx = buildAssistantContext({
      clientsModel, prefDraft, savedClientData, followupDraft: {}, isAr: true,
    });

    expect(ctx.used.find((p) => p.slug === 'preferred_city')?.value).toBe('الرياض');
    expect(ctx.used.find((p) => p.slug === 'preferred_unit_type')?.value).toBe('تاون هاوس');
    expect(ctx.hasAny).toBe(true);
  });

  it('formats a budget range with thousands separators and currency', () => {
    const ctx = buildAssistantContext({
      clientsModel,
      prefDraft: { budget: { min: 1_500_000, max: 2_500_000 } },
      savedClientData: null,
      followupDraft: {},
      isAr: true,
    });
    expect(ctx.used.find((p) => p.slug === 'budget')?.value).toBe('1,500,000 – 2,500,000 ر.س');
  });

  it('formats an area range in m²', () => {
    const ctx = buildAssistantContext({
      clientsModel,
      prefDraft: { preferred_area: { min: 150, max: 250 } },
      savedClientData: null,
      followupDraft: {},
      isAr: true,
    });
    expect(ctx.used.find((p) => p.slug === 'preferred_area')?.value).toBe('150 – 250 م²');
  });

  it('reports no preferences and emits a "missing" preface when both are empty', () => {
    const ctx = buildAssistantContext({
      clientsModel, prefDraft: {}, savedClientData: {}, followupDraft: {}, isAr: true,
    });
    expect(ctx.hasAny).toBe(false);
    expect(ctx.used).toHaveLength(0);
    expect(ctx.preface).toContain('لا توجد تفضيلات');
  });

  it('includes follow-up notes and project context in the preface', () => {
    const ctx = buildAssistantContext({
      clientsModel,
      prefDraft: { preferred_city: ['الرياض'] },
      savedClientData: null,
      followupDraft: { outcome_notes: 'يفضل التواصل مساءً' },
      projectName: 'دروازة',
      isAr: true,
    });
    expect(ctx.preface).toContain('يفضل التواصل مساءً');
    expect(ctx.preface).toContain('دروازة');
  });
});
