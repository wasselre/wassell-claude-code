/**
 * §7.6 ranking rules, executable. Every case here is a rule from the plan that
 * a future refactor must not quietly break — above all CPL = spend ÷ leads and
 * "below the data threshold is neither winner nor loser".
 */
import { describe, expect, it } from 'vitest';
import {
  arNum, deriveMinSpendSar, rankCreatives, RANKING_DEFAULTS,
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
      // A second scaled creative, so this stays a test about the FLAG and not
      // about §3.6's keep-and-flag, which has its own tests below.
      row('healthy', { current: totals({ spend: 900, leads: 10 }) }),
    ], WINDOW);
    const faded = r.ranked.find((c) => c.adRowId === 'faded')!;
    expect(faded.fatigueReasons).toEqual(['ctr_drop']);
    expect(Math.round(faded.ctrDropPct!)).toBe(60);
    expect(r.defaultKeep).toBe('healthy');
    expect(r.reasons.faded!.en).toContain('Fatigued');
  });

  it('keeps and FLAGS a fatigued creative when it is the only one Meta scaled', () => {
    // §3.6, in as many words: "Fatigue on the only scaled ad means keep it and
    // flag it, never pause it." The old rule replaced it and handed the ad set
    // to five untested creatives.
    const r = rankCreatives([
      row('sole', { current: totals({ spend: 600, leads: 10, frequency: 4.2 }) }),
      // Below both gates, so it is unranked — not a rival, and not a loser.
      row('tiny', { current: totals({ spend: 10, impressions: 90, leads: 0 }) }),
    ], WINDOW);
    expect(r.ranked.map((c) => c.adRowId)).toEqual(['sole']);
    expect(r.ranked[0]!.fatigued).toBe(true);
    expect(r.defaultKeep).toBe('sole');
    expect(r.defaultKeeps).toEqual(['sole']);
    expect(r.flagged).toEqual(['sole']);
    expect(r.defaultReplace).toEqual(['tiny']);
    expect(r.reasons.sole!.en).toContain('kept and flagged');
    expect(r.reasons.sole!.ar).toContain('التنبيه');
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

  it('reads fatigue from its own window when one is supplied', () => {
    // Cost is judged on the audition — the ad's first seven days. Fatigue is a
    // statement about NOW. An ad that auditioned well months ago and is burning
    // out today must still be flagged, or the fatigue rule quietly stops firing
    // the longer an ad survives.
    const r = rankCreatives([
      row('aged', {
        current: totals({ spend: 400, leads: 10, frequency: 1.1 }),   // a calm audition
        fatigue: { current: totals({ frequency: 4.5 }) },             // and a hot present
      }),
      row('fresh', { current: totals({ spend: 900, leads: 10, frequency: 1.1 }) }),
    ], WINDOW);
    const aged = r.ranked.find((c) => c.adRowId === 'aged')!;
    expect(aged.fatigued).toBe(true);
    expect(aged.fatigueReasons).toEqual(['frequency']);
    expect(aged.frequency).toBeCloseTo(4.5);
    // It still ranks first on cost — fatigue moves the pre-ticked box, not the
    // ranking.
    expect(r.ranked[0]!.adRowId).toBe('aged');
    expect(r.defaultKeep).toBe('fresh');
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

describe('rankCreatives — the §3.6 guards', () => {
  it('keeps BOTH when the leader beats the next scaled ad by less than 20 %', () => {
    const r = rankCreatives([
      row('a', { current: totals({ spend: 450, leads: 10 }) }),   // CPL 45
      row('b', { current: totals({ spend: 500, leads: 10 }) }),   // CPL 50 → 10 % gap
      row('c', { current: totals({ spend: 900, leads: 10 }) }),   // CPL 90
    ], WINDOW);
    expect(r.defaultKeeps).toEqual(['a', 'b']);
    expect(r.defaultKeep).toBe('a');
    expect(r.defaultReplace).toEqual(['c']);
    expect(r.summary.en).toContain('keep both');
  });

  it('keeps only the leader at exactly the 20 % margin', () => {
    const r = rankCreatives([
      row('a', { current: totals({ spend: 400, leads: 10 }) }),   // CPL 40
      row('b', { current: totals({ spend: 500, leads: 10 }) }),   // CPL 50 → exactly 20 %
    ], WINDOW);
    expect(r.defaultKeeps).toEqual(['a']);
    expect(r.defaultReplace).toEqual(['b']);
  });

  it('falls back to cost per click when the leader has fewer than 5 leads', () => {
    // 'few' wins on CPL (SAR 50 vs 60) but on four leads, which §3.6 says is
    // not a signal. On cost per click 'clicky' is far cheaper and takes it.
    const r = rankCreatives([
      row('few', { current: totals({ spend: 200, leads: 4, clicks: 200 }) }),      // CPL 50, CPC 1.00
      row('clicky', { current: totals({ spend: 600, leads: 10, clicks: 2000 }) }), // CPL 60, CPC 0.30
    ], WINDOW);
    expect(r.axis).toBe('cpc');
    expect(r.defaultKeep).toBe('clicky');
    expect(r.defaultKeeps).toEqual(['clicky']);
    expect(r.defaultReplace).toEqual(['few']);
    expect(r.summary.en).toContain('cost per click');
  });

  it('applies the margin guard on the cost-per-click axis too', () => {
    const r = rankCreatives([
      row('a', { current: totals({ spend: 200, leads: 1, clicks: 400 }) }),  // CPC 0.50
      row('b', { current: totals({ spend: 220, leads: 1, clicks: 400 }) }),  // CPC 0.55 → 9 % gap
    ], WINDOW);
    expect(r.axis).toBe('cpc');
    expect(r.defaultKeeps.sort()).toEqual(['a', 'b']);
    expect(r.defaultReplace).toEqual([]);
  });

  it('keeps every scaled creative when there is no cost signal at all', () => {
    const r = rankCreatives([
      row('a', { current: totals({ spend: 300, leads: 0, clicks: 0 }) }),
      row('b', { current: totals({ spend: 400, leads: 0, clicks: 0 }) }),
    ], WINDOW);
    expect(r.defaultKeeps.sort()).toEqual(['a', 'b']);
    expect(r.defaultReplace).toEqual([]);
    expect(r.summary.en).toContain('No cost signal');
  });

  it('raises an exception when NOTHING clears the data gates', () => {
    // The E1b silence: with the decision applied automatically and no screen to
    // read, "keep everything" means the week's five new creatives activate
    // against a slate nothing retired. It must produce a line.
    const r = rankCreatives([
      row('a', { current: totals({ spend: 20, impressions: 100, leads: 1 }) }),
      row('b', { current: totals({ spend: 10, impressions: 50, leads: 0 }) }),
    ], WINDOW);
    expect(r.ranked).toHaveLength(0);
    expect(r.exception).not.toBeNull();
    expect(r.exception!.code).toBe('ranking_empty');
    expect(r.exception!.message.en).toBe(r.summary.en);
  });

  it('raises no exception for an empty slate — there is nothing to decide', () => {
    const r = rankCreatives([], WINDOW);
    expect(r.exception).toBeNull();
    expect(r.defaultKeeps).toEqual([]);
  });
});

describe('deriveMinSpendSar — the gate follows the budget (E1c)', () => {
  it('turns the standing 2,000 a month into ~101 a week, not 150', () => {
    // 2,000 over 30 days is ~467 a week. The 150 gate was calibrated against a
    // campaign spending ~691 a week, so the same rule at the smaller budget is
    // the same SHARE of it.
    expect(deriveMinSpendSar(2000, 30)).toBe(101);
    expect(deriveMinSpendSar(2000, 30)).toBeLessThan(RANKING_DEFAULTS.minSpendSar);
  });

  it('reproduces the calibration it came from', () => {
    // A campaign spending 691 a week — 2,961 over 30 days — gets the 150 gate
    // back. This is the check that the ratio is a translation, not a new rule.
    expect(deriveMinSpendSar((691 * 30) / 7, 30)).toBe(150);
  });

  it('scales with the budget and never returns a zero gate', () => {
    // Proportional to within the rounding: 2,000 → 101, 4,000 → 203 (not 202,
    // because each is rounded to a whole riyal on its own).
    expect(deriveMinSpendSar(4000, 30)).toBe(203);
    expect(deriveMinSpendSar(4000, 30) / deriveMinSpendSar(2000, 30)).toBeCloseTo(2, 1);
    // A budget of zero would otherwise produce a gate of zero, which marks a
    // creative that never spent a riyal as one Meta scaled.
    expect(deriveMinSpendSar(0, 30)).toBe(1);
    expect(deriveMinSpendSar(2000, 0)).toBeGreaterThan(0);
    expect(deriveMinSpendSar(Number.NaN, 30)).toBe(1);
  });
});

/**
 * The real numbers, from the live database on 2026-09-15.
 *
 * Campaign C-037 أكنان ٢٥, execution ea8617c5. Each creative is summed over ITS
 * OWN first seven days from its first spending day, spend and clicks from
 * `mos_ad_metrics_daily`, and leads counted as OUR WhatsApp conversations
 * (`chat_messages.meta.ad.resolved.ad_id`, de-duplicated by chat) over the same
 * days — not Meta's `actions` count.
 *
 * The lead numbers are the ones the pipeline itself produces, which is why
 * إعلان ٣ carries 27 and not the 28 a quick `count(distinct chat_wid)` gives:
 * a conversation is counted on the RIYADH day of its OPENING message, and one
 * of ٣'s opened at 21:24 UTC on 2026-09-12 — half past midnight on the 13th in
 * Riyadh, the calendar Meta dates its spend in. Measured both ways on
 * 2026-09-15: 27 by Riyadh first-touch, 28 by UTC.
 *
 * This fixture is here because a rule that produces the right answer on
 * invented numbers and the wrong one on real numbers is not a rule. The
 * expected outcome — keep إعلان ٣, replace ١ ٢ ٤ ٦ ٧ — is the decision the
 * operator and the plan both read off this data by hand.
 */
describe('rankCreatives — أكنان ٢٥, the real slate', () => {
  const akanan: CreativeRow[] = [
    // No spend at all: created, never delivered.
    { adRowId: '1', label: 'إعلان ١', createdAt: '2026-09-03T08:17:18Z', current: { spend: 0, impressions: 0, clicks: 0, leads: 0, frequency: 0 } },
    // 2026-09-02 → 09-08. 18 of our conversations.
    { adRowId: '2', label: 'إعلان ٢', createdAt: '2026-09-02T00:00:00Z', current: { spend: 306.48, impressions: 4286, clicks: 87, leads: 18, frequency: 1.295853 } },
    // 2026-09-06 → 09-12. 27 of our conversations — the winner.
    { adRowId: '3', label: 'إعلان ٣', createdAt: '2026-09-06T00:00:00Z', current: { spend: 274.37, impressions: 2083, clicks: 75, leads: 27, frequency: 1.368421 } },
    // 2026-09-06 → 09-12. Declined by day three, as §3.6 describes.
    { adRowId: '4', label: 'إعلان ٤', createdAt: '2026-09-06T00:00:00Z', current: { spend: 59.37, impressions: 619, clicks: 16, leads: 5, frequency: 1.422951 } },
    // 2026-09-07 → 09-13.
    { adRowId: '6', label: 'إعلان ٦', createdAt: '2026-09-07T00:00:00Z', current: { spend: 9.58, impressions: 117, clicks: 2, leads: 0, frequency: 1.235294 } },
    { adRowId: '7', label: 'إعلان ٧', createdAt: '2026-09-07T00:00:00Z', current: { spend: 42.02, impressions: 419, clicks: 10, leads: 3, frequency: 1.245283 } },
  ];

  it('keeps إعلان ٣ and replaces ١ ٢ ٤ ٦ ٧', () => {
    const r = rankCreatives(akanan, { since: '2026-09-02', until: '2026-09-15' }, {
      ...RANKING_DEFAULTS,
      // The live gate: 2,000 a month per project (E1c), not the legacy 150.
      minSpendSar: deriveMinSpendSar(2000, 30),
    });

    // Only ٢ and ٣ cleared both gates. ٤ ٦ ٧ are unjudgeable, not losers — and
    // ١ never spent a riyal.
    expect(r.ranked.map((c) => c.adRowId)).toEqual(['3', '2']);
    expect(r.unranked.map((c) => c.adRowId).sort()).toEqual(['1', '4', '6', '7']);

    expect(r.axis).toBe('cpl');
    expect(r.ranked[0]!.cpl).toBeCloseTo(10.16, 2);  // 274.37 ÷ 27
    expect(r.ranked[1]!.cpl).toBeCloseTo(17.03, 2);  // 306.48 ÷ 18

    // 27 leads clears the 5-lead guard, and 40 % clears the 20 % margin, so the
    // decision is one keep, not two.
    expect(r.defaultKeeps).toEqual(['3']);
    expect(r.defaultReplace.sort()).toEqual(['1', '2', '4', '6', '7']);
    expect(r.flagged).toEqual([]);
    expect(r.exception).toBeNull();
  });

  it('would have kept BOTH if the two had been within the margin', () => {
    // The same slate with ٣ only 12 % cheaper — a difference §3.6 calls noise at
    // these counts. Nothing about the data changes except the one number.
    const closer = akanan.map((c) => (c.adRowId === '3'
      ? { ...c, current: { ...c.current, spend: 419.0 } }   // CPL 14.96 vs 17.03
      : c));
    const r = rankCreatives(closer, { since: '2026-09-02', until: '2026-09-15' }, {
      ...RANKING_DEFAULTS, minSpendSar: deriveMinSpendSar(2000, 30),
    });
    expect(r.defaultKeeps.sort()).toEqual(['2', '3']);
    expect(r.defaultReplace.sort()).toEqual(['1', '4', '6', '7']);
  });

  it('at the LEGACY 150 gate إعلان ٣ would still clear, but the gate is the point', () => {
    // A check on the direction of E1c: the derived gate is 101, so it admits
    // strictly more evidence than 150 did. Nothing that cleared 150 stops
    // clearing; ٤ ٦ ٧ remain far below either.
    const legacy = rankCreatives(akanan, { since: '2026-09-02', until: '2026-09-15' }, RANKING_DEFAULTS);
    const derived = rankCreatives(akanan, { since: '2026-09-02', until: '2026-09-15' }, {
      ...RANKING_DEFAULTS, minSpendSar: deriveMinSpendSar(2000, 30),
    });
    expect(legacy.defaultKeep).toBe('3');
    expect(derived.ranked.length).toBeGreaterThanOrEqual(legacy.ranked.length);
  });
});

describe('arNum', () => {
  it('writes Arabic-Indic digits with ٬ thousands and ٫ decimals', () => {
    expect(arNum(1234)).toBe('١٬٢٣٤');
    expect(arNum(12.5, 2)).toBe('١٢٫٥٠');
    expect(arNum(0)).toBe('٠');
  });
});
