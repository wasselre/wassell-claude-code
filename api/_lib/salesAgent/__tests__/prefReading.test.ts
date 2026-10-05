import { describe, it, expect } from 'vitest';
import { readingFromSuggestions, applyCustomerReading, readingWindow } from '../prefReading.js';

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

describe('ready / off-plan (2026-10-05)', () => {
  it('one value said → searched with it, and in the state line', () => {
    const r = readingFromSuggestions({ preferred_readiness: s('preferred_readiness', ['ready']) }, 'm');
    expect(r.readiness).toBe('ready');
    expect(r.line).toContain('ready only');
    const a = applyCustomerReading({ readiness: 'off_plan' }, r);
    expect(a.criteria.readiness).toBe('ready');
    expect(a.overrides).toContain('readiness off_plan→ready');
  });
  it('both said → no readiness filter (either is fine)', () => {
    const r = readingFromSuggestions({ preferred_readiness: s('preferred_readiness', ['ready', 'off_plan']) }, 'm');
    expect(r.readiness).toBeNull();
    expect(applyCustomerReading({ readiness: null }, r).criteria.readiness).toBeNull();
  });
});

describe('the customer changes their mind (live test 2026-10-05)', () => {
  it('a restart («انسى اللي قبل», «غيرت رأيي») — the reader reads from there on', () => {
    const w = readingWindow([
      { who: 'customer', text: 'ابي شقة جاهزة ٣ غرف' },
      { who: 'us', text: 'أبشر' },
      { who: 'customer', text: 'خلاص غيرت رأيي، ابي دور في ظهرة لبن' },
    ]);
    expect(w.turns.map((t) => t.text)).toEqual(['خلاص غيرت رأيي، ابي دور في ظهرة لبن']);
    expect(w.current).toEqual(['خلاص غيرت رأيي، ابي دور في ظهرة لبن']);
  });
  it('current = the customer messages after our last reply', () => {
    const w = readingWindow([
      { who: 'customer', text: 'ابي شقة' },
      { who: 'us', text: 'كم غرفة؟' },
      { who: 'customer', text: '٣' },
      { who: 'customer', text: 'بالشمال' },
    ]);
    expect(w.turns).toHaveLength(4);
    expect(w.current).toEqual(['٣', 'بالشمال']);
  });
  it('a value read only from older messages does not replace what the agent read now', () => {
    const r = { ...readingFromSuggestions({ preferred_unit_type: s('preferred_unit_type', ['شقة']), budget: s('budget', { max: 1_500_000 }) }, 'm'), older_only: ['unit_types' as const] };
    const { criteria, overrides } = applyCustomerReading({ unit_types: ['دور'], budget_max: 1_400_000 }, r);
    expect(criteria.unit_types).toEqual(['دور']);
    expect(criteria.budget_max).toBe(1_500_000);
    expect(overrides).toContain("kept agent's unit_types (reader's quote is from an older message)");
  });
  it('an older value still fills a field the agent left empty', () => {
    const r = { ...readingFromSuggestions({ preferred_bedrooms: s('preferred_bedrooms', { min: 4 }) }, 'm'), older_only: ['bedrooms_min' as const] };
    expect(applyCustomerReading({ bedrooms_min: null }, r).criteria.bedrooms_min).toBe(4);
  });
});
