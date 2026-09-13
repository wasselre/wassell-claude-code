/**
 * §7.6 ranking rules, executable. Every case here is a rule from the plan that
 * a future refactor must not quietly break — above all CPL = spend ÷ leads and
 * "below the data threshold is neither winner nor loser".
 */
import { describe, expect, it } from 'vitest';
import {
  arNum, rankCreatives, RANKING_DEFAULTS,
  type CreativeRow, type MetricTotals, type RankingWindow,
} from '../creativeRanking.js';

const WINDOW: RankingWindow = { since: '2026-10-01', until: '2026-10-07' };

/** Above both data gates by default (spend 150+, impressions 2000+). */
function totals(p: Partial<MetricTotals> = {}): MetricTotals {
  return { spend: 600, impressions: 40_000, clicks: 500, leads: 10, reach: 30_000, frequency: 1.3, ...p };
}

function row(id: string, p: Partial<CreativeRow> = {}): CreativeRow {
  return { adRowId: id, label: id, createdAt: '2026-09-01T00:00:00Z', current: totals(), ...p };
}

describe('rankCreatives — CPL', () => {
  it('is spend ÷ leads, not leads ÷ spend', () => {
    const r = rankCreatives([
      row('cheap', { current: totals({ spend: 300, leads: 10 }) }),   // CPL 30
      row('dear', { current: totals({ spend: 900, leads: 10 }) }),    // CPL 90
    ], WINDOW);
    expect(r.ranked.map((c) => c.adRowId)).toEqual(['cheap', 'dear']);
    expect(r.ranked[0]!.cpl).toBe(30);
    expect(r.ranked[1]!.cpl).toBe(90);
    expect(r.defaultKeep).toBe('cheap');
    expect(r.defaultReplace).toEqual(['dear']);
  });

  it('leaves CPL undefined on zero leads instead of dividing by zero', () => {
    const r = rankCreatives([row('none', { current: totals({ leads: 0 }) })], WINDOW);
    expect(r.ranked[0]!.cpl).toBeNull();
    expect(Number.isFinite(r.ranked[0]!.ctr)).toBe(true);
  });

  it('ranks every zero-lead creative below every creative with leads', () => {
    const r = rankCreatives([
      // A brilliant CTR but no leads must still lose to an expensive lead.
      row('noleads', { current: totals({ leads: 0, clicks: 8000 }) }),
      row('expensive', { current: totals({ spend: 5000, leads: 1 }) }), // CPL 5000
    ], WINDOW);
    expect(r.ranked.map((c) => c.adRowId)).toEqual(['expensive', 'noleads']);
  });

  it('orders zero-lead creatives by CTR desc then CPM asc', () => {
    const r = rankCreatives([
      row('lowctr', { current: totals({ leads: 0, clicks: 100 }) }),
      row('hictr', { current: totals({ leads: 0, clicks: 900 }) }),
      // Same CTR as hictr, but cheaper per thousand impressions → wins the tie.
      row('hictr_cheap', { current: totals({ leads: 0, clicks: 900, spend: 200 }) }),
    ], WINDOW);
    expect(r.ranked.map((c) => c.adRowId)).toEqual(['hictr_cheap', 'hictr', 'lowctr']);
  });
});

describe('rankCreatives — division by zero and empty data', () => {
  it('survives an all-zero row (no spend, no impressions, no clicks, no leads)', () => {
    const r = rankCreatives([
      row('dead', { current: { spend: 0, impressions: 0, clicks: 0, leads: 0, frequency: 0 } }),
    ], WINDOW);
    const c = r.unranked[0]!;
    expect(c.ctr).toBe(0);
    expect(c.cpm).toBeNull();
    expect(c.cpl).toBeNull();
    expect(r.ranked).toHaveLength(0);
    expect(r.defaultKeep).toBeNull();
    expect(r.defaultReplace).toEqual([]);
  });

  it('zero spend with leads is a CPL of 0 but stays unranked (spend gate)', () => {
    const r = rankCreatives([
      row('free', { current: totals({ spend: 0, leads: 4 }) }),
    ], WINDOW);
    expect(r.unranked[0]!.cpl).toBe(0);
    expect(r.unranked[0]!.eligible).toBe(false);
    expect(r.defaultKeep).toBeNull();
  });

  it('returns an empty, safe result for an empty slate', () => {
    const r = rankCreatives([], WINDOW);
    expect(r.ranked).toEqual([]);
    expect(r.unranked).toEqual([]);
    expect(r.defaultKeep).toBeNull();
    expect(r.defaultReplace).toEqual([]);
    expect(r.summary.ar.length).toBeGreaterThan(0);
    expect(r.summary.en.length).toBeGreaterThan(0);
  });
});

describe('rankCreatives — data threshold', () => {
  it('never makes a below-threshold creative the default winner', () => {
    const r = rankCreatives([
      // Spectacular CPL, but only SAR 100 spent → unranked.
      row('tiny', { current: totals({ spend: 100, impressions: 3000, leads: 20 }) }),
      row('solid', { current: totals({ spend: 600, leads: 6 }) }),   // CPL 100
    ], WINDOW);
    expect(r.unranked.map((c) => c.adRowId)).toEqual(['tiny']);
    expect(r.defaultKeep).toBe('solid');
    // …and it IS replaced by default, because ranked evidence exists.
    expect(r.defaultReplace).toContain('tiny');
  });

  it('gates on impressions as well as spend', () => {
    const r = rankCreatives([
      row('quiet', { current: totals({ spend: 900, impressions: 1_999 }) }),
    ], WINDOW);
    expect(r.ranked).toHaveLength(0);
    expect(r.unranked[0]!.eligible).toBe(false);
  });

  it('all-below-threshold → keep everything, replace nothing, and say why', () => {
    const r = rankCreatives([
      row('a', { current: totals({ spend: 20, impressions: 100, leads: 1 }) }),
      row('b', { current: totals({ spend: 10, impressions: 50, leads: 0 }) }),
      row('c', { current: totals({ spend: 0, impressions: 0, clicks: 0, leads: 0 }) }),
    ], WINDOW);
    expect(r.ranked).toHaveLength(0);
    expect(r.unranked).toHaveLength(3);
    expect(r.defaultKeep).toBeNull();
    expect(r.defaultReplace).toEqual([]);
    expect(r.summary.ar).toContain('إبقاء الجميع');
    expect(r.reasons.a!.en).toContain('Not enough data');
    expect(r.reasons.a!.ar).toContain('بيانات غير كافية');
  });
});

describe('rankCreatives — fatigue', () => {
  it('a fatigued leader keeps rank 1 but cannot be the default keep', () => {
    const r = rankCreatives([
      row('leader', { current: totals({ spend: 300, leads: 10, frequency: 3.4 }) }), // CPL 30, freq > 3
      row('second', { current: totals({ spend: 600, leads: 10 }) }),                  // CPL 60
    ], WINDOW);
    expect(r.ranked[0]!.adRowId).toBe('leader');
    expect(r.ranked[0]!.fatigued).toBe(true);
    expect(r.ranked[0]!.fatigueReasons).toEqual(['frequency']);
    expect(r.defaultKeep).toBe('second');
    expect(r.defaultReplace).toEqual(['leader']);
    expect(r.reasons.leader!.en).toContain('Fatigued');
  });

  it('flags a CTR collapse of more than 40 % against the previous window', () => {
    const r = rankCreatives([
      row('faded', {
        current: totals({ clicks: 200 }),                 // CTR 0.5 %
        previous: totals({ clicks: 500 }),                // CTR 1.25 % → −60 %
      }),
    ], WINDOW);
    expect(r.ranked[0]!.fatigueReasons).toEqual(['ctr_drop']);
    expect(Math.round(r.ranked[0]!.ctrDropPct!)).toBe(60);
    expect(r.defaultKeep).toBeNull();
    expect(r.summary.en).toContain('fatigued');
  });

  it('does not flag a drop of exactly the threshold', () => {
    const r = rankCreatives([
      row('steady', { current: totals({ clicks: 300 }), previous: totals({ clicks: 500 }) }), // −40 % exactly
    ], WINDOW);
    expect(r.ranked[0]!.fatigued).toBe(false);
    expect(r.defaultKeep).toBe('steady');
  });

  it('every ranked creative fatigued → replace all', () => {
    const r = rankCreatives([
      row('a', { current: totals({ frequency: 4 }) }),
      row('b', { current: totals({ frequency: 5, spend: 900 }) }),
    ], WINDOW);
    expect(r.defaultKeep).toBeNull();
    expect(r.defaultReplace.sort()).toEqual(['a', 'b']);
  });
});

describe('rankCreatives — ties', () => {
  it('breaks an exact CPL tie by CTR, then leads, then age', () => {
    const r = rankCreatives([
      // Same CPL (60), same CTR: the older creative wins.
      row('young', { current: totals({ spend: 600, leads: 10, clicks: 500 }), createdAt: '2026-09-10T00:00:00Z' }),
      row('old', { current: totals({ spend: 600, leads: 10, clicks: 500 }), createdAt: '2026-08-01T00:00:00Z' }),
      // Same CPL, better CTR → first.
      row('clicky', { current: totals({ spend: 600, leads: 10, clicks: 900 }), createdAt: '2026-09-20T00:00:00Z' }),
    ], WINDOW);
    expect(r.ranked.map((c) => c.adRowId)).toEqual(['clicky', 'old', 'young']);
  });

  it('is a total order — identical rows fall back to the ad-row id', () => {
    const same = { current: totals(), createdAt: '2026-09-01T00:00:00Z' };
    const a = rankCreatives([row('b2', same), row('a1', same)], WINDOW);
    const b = rankCreatives([row('a1', same), row('b2', same)], WINDOW);
    expect(a.ranked.map((c) => c.adRowId)).toEqual(['a1', 'b2']);
    expect(b.ranked.map((c) => c.adRowId)).toEqual(['a1', 'b2']);
  });

  it('a creative with no createdAt sorts after a dated twin', () => {
    const r = rankCreatives([
      row('undated', { createdAt: null }),
      row('dated', { createdAt: '2026-09-01T00:00:00Z' }),
    ], WINDOW);
    expect(r.ranked.map((c) => c.adRowId)).toEqual(['dated', 'undated']);
  });
});

describe('rankCreatives — a full slate', () => {
  it('five creatives with data produce keep-1 / replace-4 and a reason each', () => {
    const slate: CreativeRow[] = [
      row('c1', { label: 'أكنان ٢٣ · فيد', current: totals({ spend: 400, leads: 10 }) }),  // CPL 40
      row('c2', { label: 'أكنان ٢٣ · ستوري', current: totals({ spend: 500, leads: 10 }) }), // CPL 50
      row('c3', { label: 'ريفا · فيد', current: totals({ spend: 600, leads: 10 }) }),       // CPL 60
      row('c4', { label: 'ريفا · ستوري', current: totals({ spend: 700, leads: 10 }) }),     // CPL 70
      row('c5', { label: 'عرض السعر', current: totals({ spend: 900, leads: 5 }) }),         // CPL 180
    ];
    const r = rankCreatives(slate, WINDOW, RANKING_DEFAULTS);

    expect(r.ranked.map((c) => c.adRowId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(r.ranked.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(r.unranked).toHaveLength(0);
    expect(r.defaultKeep).toBe('c1');
    expect(r.defaultReplace).toEqual(['c2', 'c3', 'c4', 'c5']);
    for (const c of slate) {
      expect(r.reasons[c.adRowId]!.ar.length).toBeGreaterThan(0);
      expect(r.reasons[c.adRowId]!.en.length).toBeGreaterThan(0);
    }
    expect(r.reasons.c1!.ar).toContain('المرشّح الافتراضي');
    expect(r.summary.en).toContain('replace 4');
  });
});

describe('arNum', () => {
  it('writes Arabic-Indic digits with ٬ thousands and ٫ decimals', () => {
    expect(arNum(1234)).toBe('١٬٢٣٤');
    expect(arNum(12.5, 2)).toBe('١٢٫٥٠');
    expect(arNum(0)).toBe('٠');
  });
});
