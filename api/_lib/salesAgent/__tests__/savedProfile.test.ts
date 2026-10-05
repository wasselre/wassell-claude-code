import { describe, it, expect } from 'vitest';
import { profileLine } from '../savedProfile.js';

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
