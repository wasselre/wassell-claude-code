/**
 * Creative ranking for the weekly paid refresh decision.
 *
 * PURE — no Supabase, no Meta, no clock. Everything it needs arrives in the
 * arguments, so the whole §7.6 rule set is unit-testable
 * (worker/src/marketing/__tests__/creativeRanking.test.ts).
 *
 * The rules (docs/plans/campaign-scheduling-plan.md §7.6, contract §6):
 *
 *   • **CPL = spend ÷ leads.** Not leads ÷ spend — an earlier draft had it
 *     upside down, which would have kept the WORST creative every week.
 *     Zero leads → CPL is undefined (null), never 0 and never Infinity.
 *   • **Data threshold** (`min_spend_sar`, `min_impressions` 2000): a creative
 *     below EITHER gate is *unranked* — it is never the default winner and
 *     never a guaranteed loser. It only joins the default replacement list
 *     when ranked evidence exists elsewhere; when NOTHING is ranked, the
 *     default decision keeps everything, says why, and raises an EXCEPTION
 *     (`ranking_empty`) so the silence reaches a human — see `exception`.
 *   • Ranked creatives with leads > 0 sort by CPL ascending. Creatives with
 *     zero leads rank BELOW all of those, ordered by CTR desc then CPM asc.
 *   • **Fatigue**: frequency > 3.0, or CTR down more than 40 % versus the
 *     previous window. A fatigued creative may not be the DEFAULT keep (a
 *     human may still keep it — this only moves the pre-ticked box) — UNLESS
 *     it is the only ad Meta scaled, in which case §3.6 says keep it and FLAG
 *     it, never pause it and hand the ad set to five untested creatives.
 *   • Ties: higher CTR → more leads → older creative (→ ad-row id, so the
 *     order is total and the same slate always produces the same decision).
 *
 * The three §3.6 guards added on 2026-09-15, which turn a ranking into a
 * DECISION a machine may apply without a human reading it:
 *
 *   • **The leader needs at least `min_leader_leads` (5) of OUR leads.** Below
 *     that the lead count is not a signal, so the comparison falls back to the
 *     **cost-per-click axis**, which sits on the same cost dimension and
 *     agreed with CPL in the live data where click-through rate did not.
 *   • **The leader must beat the next scaled ad by `leader_margin_pct` (20 %)**
 *     on whichever axis is in play. Inside that margin the difference is noise
 *     at these lead counts, so BOTH are kept and a second week resolves it.
 *   • **Nothing is ever deleted**, and nothing is ever paused for being
 *     un-judgeable: an unranked creative is neither winner nor loser.
 *
 * Every reason string is bilingual (`{ar, en}`); Arabic numbers use
 * Arabic-Indic digits with «٫» as the decimal mark and «٪» for percent — the
 * same convention as `src/pages/Marketing/lib/format.ts` (the worker is a
 * standalone package and cannot import from `src/`, so the two small
 * formatters below are a deliberate COPY of that convention, not of the file).
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Types                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

export interface Bilingual { ar: string; en: string }

/** Windowed totals for one creative, as stored in `mos_ad_metrics_daily`. */
export interface MetricTotals {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  reach?: number;
  /** Average frequency over the window (Meta's own metric, not derived). */
  frequency?: number;
}

export interface CreativeRow {
  /** `mos_execution_ads.id` — the identity every decision is written against. */
  adRowId: string;
  contentId?: string | null;
  label?: string | null;
  slotId?: string | null;
  /** ISO timestamp the creative went live; the final tie-break prefers older. */
  createdAt?: string | null;
  /**
   * The COST window: §3.6's "its own first seven days from activation". Every
   * cost number the decision turns on — spend, impressions, clicks, leads —
   * is read from here.
   */
  current: MetricTotals;
  /** The window immediately before `current`; null when there is no history. */
  previous?: MetricTotals | null;
  /**
   * The FATIGUE window pair, when the caller wants fatigue judged somewhere
   * other than the cost window.
   *
   * Cost is judged on the audition (the ad's first seven days); fatigue is a
   * statement about NOW. For a freshly activated ad the two coincide and this
   * is omitted. For one kept across several cycles the audition is frozen in
   * the past, so frequency and the CTR drop must be read from the days just
   * gone or the fatigue rule quietly stops firing as an ad ages — which is the
   * exact case §3.6's keep-and-flag exists for.
   *
   * Omitted → fatigue falls back to `current` / `previous`, which is what
   * every pre-2026-09-15 caller and test does.
   */
  fatigue?: { current: MetricTotals; previous?: MetricTotals | null } | null;
}

export interface RankingWindow {
  /** Inclusive YYYY-MM-DD. */
  since: string;
  /** Inclusive YYYY-MM-DD. */
  until: string;
}

export interface RankingSettings {
  minSpendSar: number;
  minImpressions: number;
  fatigueFrequency: number;
  fatigueCtrDropPct: number;
  /** §3.6: below this many of OUR leads the leader is judged on cost per CLICK. */
  minLeaderLeads: number;
  /** §3.6: the leader must beat the next scaled ad by this much, or both stay. */
  leaderMarginPct: number;
}

/**
 * The four weekly-rule numbers (`mos_month_template`, A8) with the contract's
 * defaults. `minSpendSar` here is the LAST resort — the live gate is derived
 * from the standing budget by `deriveMinSpendSar`, see below.
 */
export const RANKING_DEFAULTS: RankingSettings = {
  minSpendSar: 150,
  minImpressions: 2000,
  fatigueFrequency: 3.0,
  fatigueCtrDropPct: 40,
  minLeaderLeads: 5,
  leaderMarginPct: 20,
};

/* ── E1c: the spend gate is a SHARE of the budget, not an absolute ───────── */

/**
 * The 150 SAR gate was not chosen in the abstract: it was calibrated on a
 * campaign that was actually spending about 691 SAR a week. The standing month
 * budgets 2,000 SAR per project over 30 days — about 467 SAR a week — so
 * carrying 150 across unchanged makes the SAME rule materially stricter, and a
 * gate nothing clears is the ratchet E1b exists to stop.
 *
 * These two constants are the calibration, kept visible so the ratio can be
 * argued with rather than reverse-engineered out of a rounded number.
 */
export const CALIBRATION_GATE_SAR = 150;
export const CALIBRATION_WEEKLY_SPEND_SAR = 691;

/**
 * The spend gate implied by a standing budget, in riyals.
 *
 * `budgetPerProject` is per campaign (per month); `campaignLengthDays` turns it
 * into a weekly rate, and the calibration ratio above turns that into the gate.
 * At the live numbers (2,000 over 30 days) this is 101 rather than 150.
 *
 * Clamped to at least 1: a zero gate would mark every creative "scaled",
 * including one that never spent a riyal, which is worse than too strict.
 */
export function deriveMinSpendSar(budgetPerProject: number, campaignLengthDays = 30): number {
  const budget = finite(budgetPerProject);
  const days = Math.max(1, finite(campaignLengthDays) || 30);
  const weekly = (budget * 7) / days;
  const gate = Math.round((weekly * CALIBRATION_GATE_SAR) / CALIBRATION_WEEKLY_SPEND_SAR);
  return Math.max(1, gate);
}

export type FatigueReason = 'frequency' | 'ctr_drop';

export interface RankedCreative {
  adRowId: string;
  contentId: string | null;
  label: string | null;
  slotId: string | null;
  createdAt: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  /** spend ÷ leads; null when the creative produced no leads. */
  cpl: number | null;
  /** clicks ÷ impressions, as a ratio (0.012 = 1.2 %). 0 when no impressions. */
  ctr: number;
  /** spend ÷ impressions × 1000; null when there were no impressions. */
  cpm: number | null;
  /** spend ÷ clicks; null when the creative got no clicks. The fallback axis. */
  cpc: number | null;
  frequency: number;
  /** CTR in the window before the fatigue window, when one was supplied. */
  previousCtr: number | null;
  /** Percentage drop from the previous CTR (positive = worse). */
  ctrDropPct: number | null;
  fatigued: boolean;
  fatigueReasons: FatigueReason[];
  /** True when the creative cleared BOTH data gates. */
  eligible: boolean;
  /** 1-based position among the ranked creatives; null for unranked. */
  rank: number | null;
}

/** Which cost axis decided the slate — see the `minLeaderLeads` guard. */
export type RankingAxis = 'cpl' | 'cpc';

/**
 * A decision that could not be taken, for the exceptions list (C7).
 *
 * `ranking_empty` is the one this module raises: nothing cleared both data
 * gates, so the default changes nothing. That was harmless while a human read
 * every decision; with automatic application it is SILENCE — the week's five
 * new creatives activate regardless and the live slate grows by five with
 * nothing retired. An empty ranking must produce a line, not a shrug.
 */
export interface RankingException {
  code: 'ranking_empty';
  message: Bilingual;
}

export interface RankingResult {
  window: RankingWindow;
  settings: RankingSettings;
  /** Cleared the data threshold, best first (always in CPL order). */
  ranked: RankedCreative[];
  /** Below the data threshold, in the same comparator order (for display). */
  unranked: RankedCreative[];
  /** Which cost axis decided this slate. */
  axis: RankingAxis;
  /** The PRIMARY pre-ticked keep — null means "replace all" / "no data". */
  defaultKeep: string | null;
  /**
   * The FULL pre-ticked keep set. One normally; TWO when the margin guard
   * found the gap to be noise; every ranked creative when there is no cost
   * signal on either axis; empty when every ranked creative is fatigued.
   * `defaultKeep` is its first element — apply reads THIS.
   */
  defaultKeeps: string[];
  /** The pre-ticked "replace these" ad-row ids. */
  defaultReplace: string[];
  /** Kept but flagged — §3.6's fatigued sole scaled ad. Never paused. */
  flagged: string[];
  /** Set when the slate produced no decision at all. Feeds the C7 list. */
  exception: RankingException | null;
  /** Per-ad-row explanation of its position. */
  reasons: Record<string, Bilingual>;
  /** One line explaining the DEFAULT decision itself. */
  summary: Bilingual;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Number helpers (bilingual output)                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/** Non-finite / negative inputs are data errors, not zeros with a meaning —
 *  they are clamped to 0 so one bad row can never produce Infinity or NaN in a
 *  decision a human reads. */
function finite(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Arabic-Indic digits, «٫» decimal mark, «٬» thousands mark. */
export function arNum(n: number, decimals = 0): string {
  const fixed = Math.abs(n).toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  const grouped = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  const joined = frac ? `${grouped}٫${frac}` : grouped;
  return `${n < 0 ? '-' : ''}${joined}`.replace(/\d/g, (d) => AR_DIGITS[Number(d)]!);
}

/** Western digits with thousands separators — the English half of a reason. */
function enNum(n: number, decimals = 0): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** A CTR/percentage pair: «١٫٢٪» / "1.2%". */
function pct(ratio: number): { ar: string; en: string } {
  const v = ratio * 100;
  return { ar: `${arNum(v, 2)}٪`, en: `${enNum(v, 2)}%` };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Ranking                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function ctrOf(m: MetricTotals): number {
  const impressions = finite(m.impressions);
  if (impressions <= 0) return 0;
  return finite(m.clicks) / impressions;
}

function measure(row: CreativeRow, settings: RankingSettings): RankedCreative {
  const spend = finite(row.current.spend);
  const impressions = finite(row.current.impressions);
  const clicks = finite(row.current.clicks);
  const leads = finite(row.current.leads);

  const ctr = impressions > 0 ? clicks / impressions : 0;
  const cpm = impressions > 0 ? (spend / impressions) * 1000 : null;
  // CPL = spend ÷ leads. No leads → undefined, NEVER 0 (which would look like
  // the cheapest creative in the account) and never a division by zero.
  const cpl = leads > 0 ? spend / leads : null;
  // Same shape for the fallback axis: no clicks → no cost per click.
  const cpc = clicks > 0 ? spend / clicks : null;

  // Fatigue is a statement about NOW, so it reads its own window when the
  // caller supplied one (see `CreativeRow.fatigue`) and the cost window
  // otherwise.
  const fatigueNow = row.fatigue?.current ?? row.current;
  const fatigueBefore = row.fatigue ? (row.fatigue.previous ?? null) : (row.previous ?? null);
  const fatigueFrequency = finite(fatigueNow.frequency);
  const fatigueCtr = ctrOf(fatigueNow);

  const previousCtr = fatigueBefore ? ctrOf(fatigueBefore) : null;
  const ctrDropPct = previousCtr != null && previousCtr > 0
    ? ((previousCtr - fatigueCtr) / previousCtr) * 100
    : null;

  // Strictly ABOVE the limit, with a float guard: a CTR that fell by exactly
  // 40 % computes as 40.00000000000001 in IEEE-754, and "exactly at the
  // threshold" must not be fatigue.
  const above = (v: number, limit: number): boolean => v - limit > 1e-9;
  const fatigueReasons: FatigueReason[] = [];
  if (above(fatigueFrequency, settings.fatigueFrequency)) fatigueReasons.push('frequency');
  if (ctrDropPct != null && above(ctrDropPct, settings.fatigueCtrDropPct)) fatigueReasons.push('ctr_drop');

  return {
    adRowId: row.adRowId,
    contentId: row.contentId ?? null,
    label: row.label ?? null,
    slotId: row.slotId ?? null,
    createdAt: row.createdAt ?? null,
    spend,
    impressions,
    clicks,
    leads,
    cpl,
    ctr,
    cpm,
    cpc,
    frequency: fatigueFrequency,
    previousCtr,
    ctrDropPct,
    fatigued: fatigueReasons.length > 0,
    fatigueReasons,
    eligible: spend >= settings.minSpendSar && impressions >= settings.minImpressions,
    rank: null,
  };
}

/** Older first; a creative with no timestamp sorts after every dated one. */
function byAge(a: RankedCreative, b: RankedCreative): number {
  const ta = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
  const tb = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
  const va = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
  const vb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
  return va - vb;
}

/**
 * The one comparator. Leads-bearing creatives first (by CPL asc), then the
 * zero-lead ones (CTR desc, CPM asc), then the declared tie-breaks: higher CTR
 * → more leads → older creative → ad-row id (so the order is total).
 */
function compare(a: RankedCreative, b: RankedCreative): number {
  const ga = a.leads > 0 ? 0 : 1;
  const gb = b.leads > 0 ? 0 : 1;
  if (ga !== gb) return ga - gb;

  if (ga === 0) {
    // Both have leads → both have a CPL.
    const d = (a.cpl as number) - (b.cpl as number);
    if (Math.abs(d) > 1e-9) return d;
  } else {
    if (Math.abs(a.ctr - b.ctr) > 1e-12) return b.ctr - a.ctr;
    const ca = a.cpm ?? Number.POSITIVE_INFINITY;
    const cb = b.cpm ?? Number.POSITIVE_INFINITY;
    if (Math.abs(ca - cb) > 1e-9) return ca - cb;
  }

  if (Math.abs(a.ctr - b.ctr) > 1e-12) return b.ctr - a.ctr;
  if (a.leads !== b.leads) return b.leads - a.leads;
  const age = byAge(a, b);
  if (age !== 0) return age;
  return a.adRowId < b.adRowId ? -1 : a.adRowId > b.adRowId ? 1 : 0;
}

function reasonFor(
  c: RankedCreative, settings: RankingSettings, isDefaultKeep: boolean, isFlagged: boolean,
): Bilingual {
  const parts: Bilingual[] = [];

  if (!c.eligible) {
    const missing: Bilingual[] = [];
    if (c.spend < settings.minSpendSar) {
      missing.push({
        ar: `الإنفاق ${arNum(c.spend)} ر.س دون الحد ${arNum(settings.minSpendSar)}`,
        en: `spend SAR ${enNum(c.spend)} is under the SAR ${enNum(settings.minSpendSar)} gate`,
      });
    }
    if (c.impressions < settings.minImpressions) {
      missing.push({
        ar: `الظهور ${arNum(c.impressions)} دون الحد ${arNum(settings.minImpressions)}`,
        en: `${enNum(c.impressions)} impressions is under the ${enNum(settings.minImpressions)} gate`,
      });
    }
    parts.push({
      ar: `بيانات غير كافية للحكم (${missing.map((m) => m.ar).join('، ')}) — لا يُحتسب فائزًا ولا خاسرًا.`,
      en: `Not enough data to judge (${missing.map((m) => m.en).join('; ')}) — neither winner nor loser.`,
    });
  } else if (c.cpl != null) {
    const p = pct(c.ctr);
    parts.push({
      ar: `تكلفة العميل ${arNum(c.cpl, 2)} ر.س من ${arNum(c.leads)} عميل، نسبة نقر ${p.ar}.`,
      en: `CPL SAR ${enNum(c.cpl, 2)} over ${enNum(c.leads)} leads, CTR ${p.en}.`,
    });
  } else {
    const p = pct(c.ctr);
    const cpcTxt = c.cpc != null
      ? { ar: `، تكلفة النقرة ${arNum(c.cpc, 2)} ر.س`, en: `, CPC SAR ${enNum(c.cpc, 2)}` }
      : { ar: '', en: '' };
    const cpmTxt = c.cpm != null
      ? { ar: `، تكلفة الألف ظهور ${arNum(c.cpm, 2)} ر.س`, en: `, CPM SAR ${enNum(c.cpm, 2)}` }
      : { ar: '', en: '' };
    parts.push({
      ar: `بلا عملاء في النافذة — الترتيب بنسبة النقر ${p.ar}${cpcTxt.ar}${cpmTxt.ar}.`,
      en: `No leads in the window — ranked by CTR ${p.en}${cpcTxt.en}${cpmTxt.en}.`,
    });
  }

  if (c.fatigueReasons.includes('frequency')) {
    parts.push({
      ar: `إجهاد: التكرار ${arNum(c.frequency, 2)} فوق الحد ${arNum(settings.fatigueFrequency, 1)}.`,
      en: `Fatigued: frequency ${enNum(c.frequency, 2)} is above the ${enNum(settings.fatigueFrequency, 1)} limit.`,
    });
  }
  if (c.fatigueReasons.includes('ctr_drop') && c.ctrDropPct != null) {
    parts.push({
      ar: `إجهاد: انخفضت نسبة النقر ${arNum(c.ctrDropPct, 0)}٪ عن النافذة السابقة.`,
      en: `Fatigued: CTR fell ${enNum(c.ctrDropPct, 0)}% versus the previous window.`,
    });
  }
  if (isDefaultKeep) {
    parts.push({ ar: 'المرشّح الافتراضي للبقاء.', en: 'The default keep.' });
  }
  if (isFlagged) {
    parts.push({
      ar: 'التصميم الوحيد الذي وسّعته ميتا — يبقى مع التنبيه، ولا يُوقَف.',
      en: 'The only creative Meta scaled — kept and flagged, never paused.',
    });
  }

  return { ar: parts.map((p) => p.ar).join(' '), en: parts.map((p) => p.en).join(' ') };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The default decision (§3.6's three guards)                                 */
/* ────────────────────────────────────────────────────────────────────────── */

/** At least `limit`, with the same float guard the fatigue check uses. */
const atLeast = (v: number, limit: number): boolean => v - limit > -1e-9;

const metricOn = (axis: RankingAxis) => (c: RankedCreative): number | null =>
  (axis === 'cpl' ? c.cpl : c.cpc);

interface DefaultDecision {
  axis: RankingAxis;
  keeps: string[];
  flagged: string[];
  /** Set when the margin guard kept a second creative. */
  marginHeld: boolean;
  /** Set when neither axis produced a cost number to compare. */
  noCostSignal: boolean;
}

/**
 * Turn a ranked slate into the pre-ticked keep set.
 *
 * Order matters and is the rule, not an implementation detail:
 *   1. pick the axis — cost per lead, unless the CPL leader is below the lead
 *      guard, in which case cost per click;
 *   2. the leader is the best NON-fatigued creative on that axis, except that
 *      a sole scaled creative is kept and flagged even when fatigued;
 *   3. compare it with the NEXT creative on that axis (the next scaled ad) and
 *      keep both when the gap is inside the margin.
 *
 * Callers pass `ranked` in CPL order; nothing here mutates it.
 */
function decideDefaults(ranked: RankedCreative[], settings: RankingSettings): DefaultDecision {
  const empty: DefaultDecision = { axis: 'cpl', keeps: [], flagged: [], marginHeld: false, noCostSignal: false };
  if (ranked.length === 0) return empty;

  // 1. the axis. `ranked` is already CPL-first, so the CPL leader is simply the
  //    best non-fatigued row — or the sole row, fatigued or not.
  const cplLeader = ranked.find((c) => !c.fatigued) ?? (ranked.length === 1 ? ranked[0]! : null);
  const axis: RankingAxis = cplLeader != null && cplLeader.leads >= settings.minLeaderLeads ? 'cpl' : 'cpc';
  const metric = metricOn(axis);
  const ordered = axis === 'cpl'
    ? ranked
    : [...ranked].sort((a, b) => {
      const va = metric(a) ?? Number.POSITIVE_INFINITY;
      const vb = metric(b) ?? Number.POSITIVE_INFINITY;
      if (Math.abs(va - vb) > 1e-9) return va - vb;
      return compare(a, b);
    });

  // 2. the leader. A fatigued creative may not be the default keep — unless it
  //    is the only one Meta scaled: pausing it would hand the ad set to five
  //    untested creatives, which §3.6 forbids outright.
  const flagged: string[] = [];
  let leader = ordered.find((c) => !c.fatigued) ?? null;
  if (!leader && ordered.length === 1) {
    leader = ordered[0]!;
    flagged.push(leader.adRowId);
  }
  if (!leader) return { ...empty, axis };

  const keeps = [leader.adRowId];

  // No cost number on either axis (no leads anywhere and no clicks): there is
  // nothing to rank on, so nothing Meta scaled is replaced by default.
  if (metric(leader) == null) {
    for (const c of ordered) if (!keeps.includes(c.adRowId)) keeps.push(c.adRowId);
    return { axis, keeps, flagged, marginHeld: false, noCostSignal: true };
  }

  // 3. the margin guard, against the NEXT scaled ad — the one after the leader
  //    in the axis order. A better-but-fatigued creative sitting above it is
  //    not a "next scaled ad"; it is one we declined to keep.
  const li = ordered.findIndex((c) => c.adRowId === leader!.adRowId);
  const runnerUp = ordered[li + 1] ?? null;
  const lm = metric(leader)!;
  const rm = runnerUp ? metric(runnerUp) : null;
  let marginHeld = false;
  if (runnerUp && rm != null && rm > 0) {
    const marginPct = ((rm - lm) / rm) * 100;
    if (!atLeast(marginPct, settings.leaderMarginPct)) {
      // Inside the margin the difference is noise at these lead counts, so both
      // stay and a second week resolves it. A fatigued runner-up stays too:
      // pausing it would act on a gap we have just called noise.
      keeps.push(runnerUp.adRowId);
      marginHeld = true;
    }
  }

  return { axis, keeps, flagged, marginHeld, noCostSignal: false };
}

/**
 * Rank one slate for one refresh cycle.
 *
 * @param rows     the ACTIVE creatives of the child campaign, with their window
 *                 totals (and the previous window's, for the fatigue check).
 * @param window   the window the totals cover — echoed back for display.
 * @param settings `mos_settings.ranking`.
 */
export function rankCreatives(
  rows: CreativeRow[],
  window: RankingWindow,
  settings: RankingSettings = RANKING_DEFAULTS,
): RankingResult {
  const measured = rows.map((r) => measure(r, settings)).sort(compare);
  const ranked = measured.filter((c) => c.eligible);
  const unranked = measured.filter((c) => !c.eligible);
  ranked.forEach((c, i) => { c.rank = i + 1; });

  const decision = decideDefaults(ranked, settings);
  const defaultKeeps = decision.keeps;
  const defaultKeep = defaultKeeps[0] ?? null;
  const keepSet = new Set(defaultKeeps);
  const flaggedSet = new Set(decision.flagged);

  const axisName: Bilingual = decision.axis === 'cpl'
    ? { ar: 'تكلفة العميل', en: 'cost per lead' }
    : { ar: 'تكلفة النقرة', en: 'cost per click' };

  let defaultReplace: string[];
  let summary: Bilingual;
  let exception: RankingException | null = null;

  if (ranked.length === 0) {
    // Nothing cleared the data gates: an unranked creative is never a
    // guaranteed loser, so the default decision changes nothing — and SAYS SO
    // OUT LOUD. With the decision applied automatically this silence is what
    // lets the live slate grow by five every week with nothing retired, so it
    // is raised as an exception rather than left in a summary line nobody
    // reads (E1b / C7).
    defaultReplace = [];
    summary = {
      ar: `لا يوجد تصميم بلغ حد البيانات (${arNum(settings.minSpendSar)} ر.س و${arNum(settings.minImpressions)} ظهور) في الفترة ${window.since} → ${window.until} — القرار الافتراضي: إبقاء الجميع، والقرار لك.`,
      en: `No creative reached the data threshold (SAR ${enNum(settings.minSpendSar)} and ${enNum(settings.minImpressions)} impressions) between ${window.since} and ${window.until} — the default is to keep everything and let you decide.`,
    };
    if (measured.length > 0) exception = { code: 'ranking_empty', message: summary };
  } else {
    defaultReplace = measured.filter((c) => !keepSet.has(c.adRowId)).map((c) => c.adRowId);
    if (defaultKeeps.length === 0) {
      summary = {
        ar: `كل التصاميم المصنّفة مُجهَدة — القرار الافتراضي: استبدال ${arNum(defaultReplace.length)} بالكامل.`,
        en: `Every ranked creative is fatigued — the default is to replace all ${enNum(defaultReplace.length)}.`,
      };
    } else if (decision.noCostSignal) {
      summary = {
        ar: `لا يوجد مؤشر تكلفة (بلا عملاء وبلا نقرات) — القرار الافتراضي: إبقاء كل ما وسّعته ميتا (${arNum(defaultKeeps.length)}) واستبدال ${arNum(defaultReplace.length)}.`,
        en: `No cost signal at all (no leads, no clicks) — the default keeps every creative Meta scaled (${enNum(defaultKeeps.length)}) and replaces ${enNum(defaultReplace.length)}.`,
      };
    } else if (decision.marginHeld) {
      const [a, b] = defaultKeeps;
      const ka = ranked.find((c) => c.adRowId === a)!;
      const kb = ranked.find((c) => c.adRowId === b)!;
      summary = {
        ar: `الفارق بين «${ka.label ?? ka.adRowId}» و«${kb.label ?? kb.adRowId}» في ${axisName.ar} أقل من ${arNum(settings.leaderMarginPct)}٪ — ضجيج عند هذه الأعداد. القرار الافتراضي: إبقاء الاثنين واستبدال ${arNum(defaultReplace.length)}.`,
        en: `“${ka.label ?? ka.adRowId}” beats “${kb.label ?? kb.adRowId}” on ${axisName.en} by less than ${enNum(settings.leaderMarginPct)}% — noise at these counts. Default: keep both and replace ${enNum(defaultReplace.length)}.`,
      };
    } else {
      const k = ranked.find((c) => c.adRowId === defaultKeep)!;
      const value = decision.axis === 'cpl'
        ? { ar: k.cpl != null ? `${arNum(k.cpl, 2)} ر.س` : 'غير محسوبة', en: k.cpl != null ? `SAR ${enNum(k.cpl, 2)}` : 'n/a' }
        : { ar: k.cpc != null ? `${arNum(k.cpc, 2)} ر.س` : 'غير محسوبة', en: k.cpc != null ? `SAR ${enNum(k.cpc, 2)}` : 'n/a' };
      const flagNote: Bilingual = flaggedSet.has(k.adRowId)
        ? { ar: ' (مُجهَد ووحيد — يبقى مع التنبيه)', en: ' (fatigued and alone — kept and flagged)' }
        : { ar: '', en: '' };
      const axisNote: Bilingual = decision.axis === 'cpc'
        ? { ar: ` العملاء أقل من ${arNum(settings.minLeaderLeads)} فالمقارنة على ${axisName.ar}.`, en: ` Fewer than ${enNum(settings.minLeaderLeads)} leads, so the comparison is on ${axisName.en}.` }
        : { ar: '', en: '' };
      summary = {
        ar: `القرار الافتراضي: إبقاء «${k.label ?? k.adRowId}» (${axisName.ar} ${value.ar})${flagNote.ar} واستبدال ${arNum(defaultReplace.length)}.${axisNote.ar}`,
        en: `Default: keep “${k.label ?? k.adRowId}” (${axisName.en} ${value.en})${flagNote.en} and replace ${enNum(defaultReplace.length)}.${axisNote.en}`,
      };
    }
  }

  const reasons: Record<string, Bilingual> = {};
  for (const c of measured) {
    reasons[c.adRowId] = reasonFor(c, settings, keepSet.has(c.adRowId), flaggedSet.has(c.adRowId));
  }

  return {
    window, settings, ranked, unranked,
    axis: decision.axis,
    defaultKeep, defaultKeeps, defaultReplace,
    flagged: decision.flagged,
    exception,
    reasons, summary,
  };
}
