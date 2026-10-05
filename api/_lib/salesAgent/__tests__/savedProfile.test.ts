import { describe, it, expect } from 'vitest';
import { profileLine, profilesLine, requestChecklistLine } from '../savedProfile.js';

describe('profileLine — the client\'s saved profile, as agent state', () => {
  it('empty profile → no line', () => {
    expect(profileLine({}).line).toBeNull();
  });
  it('lists type, budget, bedrooms, purpose and places', () => {
    const r = profileLine({
      preferred_unit_type: ['شقة'], budget: { max: 1500000 }, preferred_bedrooms: { min: 3, max: 4 }, purchase_objective: ['residential'],
      location_items: [
        { id: 'a', kind: 'district', polarity: 'include', district_id: '11111111-1111-4111-8111-111111111111', district_label: 'النرجس' },
        { id: 'b', kind: 'district', polarity: 'exclude', district_id: '22222222-2222-4222-8222-222222222222', district_label: 'العليا' },
      ],
    });
    expect(r.line).toContain('unit type: شقة');
    expect(r.line).toContain('budget: up to 1,500,000 SAR');
    expect(r.line).toContain('bedrooms: 3–4');
    expect(r.line).toContain('purpose: سكن');
    expect(r.line).toContain('places: النرجس');
    expect(r.line).toContain('avoids: العليا');
    expect(r.placeLabels).toEqual(['النرجس']);
    expect(r.items).toHaveLength(2);
  });
});

describe('readinessText — the saved ready / off-plan preference', () => {
  it('reads one, both, or none', async () => {
    const { readinessText, profileLine } = await import('../savedProfile.js');
    expect(readinessText(['ready'])).toMatch(/^ready only/);
    expect(readinessText(['off_plan'])).toMatch(/^off-plan only/);
    expect(readinessText(['ready', 'off_plan'])).toBe('either');
    expect(readinessText([])).toBeNull();
    expect(profileLine({ preferred_readiness: ['ready'] }).line).toContain('ready or off-plan: ready only');
  });
});

describe('requestChecklistLine — what a specialized search still needs (rule 10a)', () => {
  const district = { id: 'a', kind: 'district', polarity: 'include', district_id: '11111111-1111-4111-8111-111111111111', district_label: 'x' };
  it('an empty client is missing all three', () => {
    const l = requestChecklistLine({});
    expect(l).toContain('unit type: MISSING');
    expect(l).toContain('at least one district: MISSING');
    expect(l).toContain('one of budget / bedrooms / size: MISSING');
    expect(l).toContain('ask only for what is still missing');
  });
  it('bedrooms alone satisfy the third item — budget is not required', () => {
    const l = requestChecklistLine({ preferred_unit_type: ['فيلا'], location_items: [district], preferred_bedrooms: { min: 4 } });
    expect(l).toContain('complete');
    expect(l).not.toContain('MISSING');
  });
  it('names only the missing piece', () => {
    const l = requestChecklistLine({ preferred_unit_type: ['دور'], budget: { max: 1200000 } });
    expect(l).toContain('at least one district: MISSING');
    expect(l).toContain('unit type: known');
    expect(l).toContain('one of budget / bedrooms / size: known');
  });
});

describe('profilesLine — a client with several profiles (one per property)', () => {
  it('one profile → no extra line (the single-profile line stands)', () => {
    expect(profilesLine({ preferred_unit_type: ['فيلا'] })).toBeNull();
  });
  it('lists each profile with its id; the active one from the flat fields, the others from their snapshot', () => {
    const line = profilesLine({
      preferred_unit_type: ['فيلا'], budget: { max: 3000000 },
      active_profile_id: 'default',
      preference_profiles: [
        { id: 'default', name: 'التفضيل الرئيسي', created_at: '', data: {} },
        { id: 'p-son', name: 'شقة لولدي - الياسمين', created_at: '', data: { preferred_unit_type: ['شقة'], budget: { max: 900000 } } },
      ],
    })!;
    expect(line).toContain('[profile_id=default] «التفضيل الرئيسي» (active): unit type: فيلا');
    expect(line).toContain('[profile_id=p-son] «شقة لولدي - الياسمين»: unit type: شقة · budget: up to 900,000 SAR');
    expect(line).toContain('2 SEPARATE properties');
  });
});
