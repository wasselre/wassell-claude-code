import { describe, it, expect } from 'vitest';
import { buildAssistantContext } from '../assistantContext';
import type { AppModel } from '@/types';

/** Minimal clients model carrying only the preference fields the context helper
 *  reads. Geography is the `location` cascade compound { city:[], district:[] } of
 *  record ids resolved to names via geoNames. */
const clientsModel = {
  schema: {
    sections: [
      {
        fields: [
          { name: 'location', type: 'location', location_multi: true },
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

// id → display name for the districts/cities the tests reference.
const geoNames: Record<string, string> = {
  'c-riyadh': 'الرياض',
  'd-narjis': 'النرجس',
  'd-aridh': 'العارض',
};

describe('buildAssistantContext — draft-first preference resolution (lookup geography)', () => {
  const districtRow = (ctx: ReturnType<typeof buildAssistantContext>) =>
    ctx.used.find((p) => p.slug === 'location' && p.label_ar === 'الحي');
  const cityRow = (ctx: ReturnType<typeof buildAssistantContext>) =>
    ctx.used.find((p) => p.slug === 'location' && p.label_ar === 'المدينة');

  it('prefers the unsaved draft value over the saved record value', () => {
    const savedClientData = { location: { district: ['d-narjis'] }, budget: { min: 0, max: 2_000_000 } };
    const prefDraft = { location: { district: ['d-aridh'] }, budget: { min: 0, max: 2_500_000 } };

    const ctx = buildAssistantContext({
      clientsModel, prefDraft, savedClientData, followupDraft: {}, geoNames, isAr: true,
    });

    const budget = ctx.used.find((p) => p.slug === 'budget');
    // DRAFT wins — العارض not النرجس, 2,500,000 not 2,000,000.
    expect(districtRow(ctx)?.value).toBe('العارض');
    expect(budget?.value).toContain('2,500,000');
    expect(ctx.preface).toContain('العارض');
    expect(ctx.preface).not.toContain('النرجس');
    expect(ctx.preface).toContain('2,500,000');
  });

  it('falls back to the saved value when the draft slot is empty', () => {
    const savedClientData = { location: { city: ['c-riyadh'] }, preferred_unit_type: ['تاون هاوس'] };
    const prefDraft = {}; // nothing edited yet

    const ctx = buildAssistantContext({
      clientsModel, prefDraft, savedClientData, followupDraft: {}, geoNames, isAr: true,
    });

    expect(cityRow(ctx)?.value).toBe('الرياض');
    expect(ctx.used.find((p) => p.slug === 'preferred_unit_type')?.value).toBe('تاون هاوس');
    expect(ctx.hasAny).toBe(true);
  });

  it('resolves multiple preferred districts to a joined name list', () => {
    const ctx = buildAssistantContext({
      clientsModel,
      prefDraft: { location: { district: ['d-narjis', 'd-aridh'] } },
      savedClientData: null, followupDraft: {}, geoNames, isAr: true,
    });
    expect(districtRow(ctx)?.value).toBe('النرجس، العارض');
  });

  it('formats a budget range with thousands separators and currency', () => {
    const ctx = buildAssistantContext({
      clientsModel,
      prefDraft: { budget: { min: 1_500_000, max: 2_500_000 } },
      savedClientData: null, followupDraft: {}, geoNames, isAr: true,
    });
    expect(ctx.used.find((p) => p.slug === 'budget')?.value).toBe('1,500,000 – 2,500,000 ر.س');
  });

  it('formats an area range in m²', () => {
    const ctx = buildAssistantContext({
      clientsModel,
      prefDraft: { preferred_area: { min: 150, max: 250 } },
      savedClientData: null, followupDraft: {}, geoNames, isAr: true,
    });
    expect(ctx.used.find((p) => p.slug === 'preferred_area')?.value).toBe('150 – 250 م²');
  });

  it('reports no preferences and emits a "missing" preface when both are empty', () => {
    const ctx = buildAssistantContext({
      clientsModel, prefDraft: {}, savedClientData: {}, followupDraft: {}, geoNames, isAr: true,
    });
    expect(ctx.hasAny).toBe(false);
    expect(ctx.used).toHaveLength(0);
    expect(ctx.preface).toContain('لا توجد تفضيلات');
  });

  it('includes follow-up notes and project context in the preface', () => {
    const ctx = buildAssistantContext({
      clientsModel,
      prefDraft: { location: { city: ['c-riyadh'] } },
      savedClientData: null,
      followupDraft: { outcome_notes: 'يفضل التواصل مساءً' },
      projectName: 'دروازة',
      geoNames, isAr: true,
    });
    expect(ctx.preface).toContain('يفضل التواصل مساءً');
    expect(ctx.preface).toContain('دروازة');
  });
});
