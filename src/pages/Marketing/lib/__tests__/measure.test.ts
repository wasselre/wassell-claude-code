import { describe, it, expect } from 'vitest';
import type { MosCampaign, MosMeasureSource, MosSuccessMeasure } from '@/lib/marketingOS/client';
import { measureActual, pickMainMeasure, pickVolumeMeasure } from '../measure';

/** A measure with only the fields the math reads. */
const measure = (o: Partial<MosSuccessMeasure> & { source: MosMeasureSource }): MosSuccessMeasure => ({
  type_key: o.source,
  label_ar: o.source,
  label_en: o.source,
  direction: o.direction ?? 'higher',
  unit: o.unit ?? 'count',
  source: o.source,
  threshold: o.threshold ?? null,
});

/** A campaign carrying just the fields the measure helpers read. */
const campaign = (o: Partial<MosCampaign>): MosCampaign => ({
  success_measures: [],
  total_spend: null, total_leads: null, total_qualified: null,
  total_impressions: null, total_clicks: null,
  ...o,
} as MosCampaign);

describe('pickMainMeasure — the card headline', () => {
  it('is the FIRST measure that carries a real target (the picked/primary row)', () => {
    const c = campaign({ success_measures: [
      measure({ source: 'cpl', direction: 'lower', unit: 'currency', threshold: 40 }),
      measure({ source: 'qualified', threshold: 150 }),
    ] });
    expect(pickMainMeasure(c)?.source).toBe('cpl'); // first-with-target wins, even a cost measure
  });

  it('skips a leading measure with no threshold', () => {
    const c = campaign({ success_measures: [
      measure({ source: 'qualified', threshold: null }),
      measure({ source: 'leads', threshold: 200 }),
    ] });
    expect(pickMainMeasure(c)?.source).toBe('leads');
  });

  it('is null when no measure has a target', () => {
    expect(pickMainMeasure(campaign({ success_measures: [] }))).toBeNull();
    expect(pickMainMeasure(campaign({ success_measures: [measure({ source: 'none', threshold: null })] }))).toBeNull();
  });
});

describe('pickVolumeMeasure — the detail pace math', () => {
  it('honors the main choice when it is a volume goal', () => {
    const c = campaign({ success_measures: [
      measure({ source: 'leads', threshold: 200 }),   // main + volume
      measure({ source: 'qualified', threshold: 150 }),
    ] });
    expect(pickVolumeMeasure(c)?.source).toBe('leads');
  });

  it('falls back to the first volume measure when the main is cost/rate', () => {
    const c = campaign({ success_measures: [
      measure({ source: 'cpl', direction: 'lower', unit: 'currency', threshold: 40 }), // main, not volume
      measure({ source: 'qualified', threshold: 150 }),
    ] });
    expect(pickVolumeMeasure(c)?.source).toBe('qualified');
  });

  it('is null when the campaign has only cost/rate measures', () => {
    const c = campaign({ success_measures: [
      measure({ source: 'cpl', direction: 'lower', unit: 'currency', threshold: 40 }),
      measure({ source: 'ctr', direction: 'lower', unit: 'percent', threshold: 2 }),
    ] });
    expect(pickVolumeMeasure(c)).toBeNull();
  });
});

describe('measureActual — the live value per source', () => {
  const c = campaign({
    total_spend: 4000, total_leads: 100, total_qualified: 40,
    total_impressions: 20000, total_clicks: 500,
  });

  it('reads scalar sources straight off the rollups', () => {
    expect(measureActual('leads', c)).toBe(100);
    expect(measureActual('qualified', c)).toBe(40);
    expect(measureActual('spend', c)).toBe(4000);
    expect(measureActual('impressions', c)).toBe(20000);
    expect(measureActual('clicks', c)).toBe(500);
  });

  it('computes derived cost/rate sources', () => {
    expect(measureActual('cpl', c)).toBe(40);            // 4000 / 100
    expect(measureActual('cpl_qualified', c)).toBe(100); // 4000 / 40
    expect(measureActual('ctr', c)).toBe(2.5);           // 500 / 20000 * 100
  });

  it('returns null (not 0 or NaN) when a derived source has no denominator', () => {
    const zero = campaign({ total_spend: 500, total_leads: 0, total_qualified: 0, total_impressions: 0 });
    expect(measureActual('cpl', zero)).toBeNull();
    expect(measureActual('cpl_qualified', zero)).toBeNull();
    expect(measureActual('ctr', zero)).toBeNull();
    expect(measureActual('none', zero)).toBeNull();
  });
});
