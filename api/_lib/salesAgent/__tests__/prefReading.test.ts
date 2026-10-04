import { describe, it, expect } from 'vitest';
import { readingFromSuggestions, applyCustomerReading } from '../prefReading.js';

const s = (slug: string, value: unknown) => ({ slug, value, quote: 'q', confidence: 90 });

describe('readingFromSuggestions — the shared extractor\'s output as search fields', () => {
  it('maps type / budget / bedrooms / size and writes one state line', () => {
    const r = readingFromSuggestions({
      preferred_unit_type: s('preferred_unit_type', ['شقة', 'استوديو']),
      budget: s('budget', { max: 900000 }),
      preferred_bedrooms: s('preferred_bedrooms', { min: 3, max: 3 }),
      preferred_area: s('preferred_area', { min: 120 }),
      purchase_objective: s('purchase_objective', ['residential']),
    }, 'deepseek-chat');
    expect(r.unit_types).toContain('شقة');
    expect(r.budget_max).toBe(900000);
    expect(r.bedrooms_min).toBe(3);
    expect(r.area_min).toBe(120);
    expect(r.line).toContain('budget: up to 900,000 SAR');
    expect(r.line).toContain('purpose: سكن');
  });
  it('nothing read → no line, nothing applied', () => {
    const r = readingFromSuggestions({}, 'deepseek-chat');
    expect(r.line).toBeNull();
    expect(applyCustomerReading({ budget_max: 1_000_000 }, r).criteria.budget_max).toBe(1_000_000);
  });
});

describe('applyCustomerReading — the reader is authoritative for the fields it read', () => {
  it('overrides what the agent typed and reports it; keeps fields the reader left empty', () => {
    const r = readingFromSuggestions({ budget: s('budget', { max: 900000 }), preferred_unit_type: s('preferred_unit_type', ['دور']) }, 'm');
    const { criteria, overrides } = applyCustomerReading({ budget_max: 1_200_000, unit_types: ['شقة'], bedrooms_min: 3 }, r);
    expect(criteria).toMatchObject({ budget_max: 900000, unit_types: ['دور'], bedrooms_min: 3 });
    expect(overrides).toEqual(['unit_types ["شقة"]→["دور"]', 'budget_max 1200000→900000']);
  });
  it('no reading → criteria unchanged', () => {
    expect(applyCustomerReading({ bedrooms_min: 2 }, null)).toEqual({ criteria: { bedrooms_min: 2 }, overrides: [] });
  });
});
