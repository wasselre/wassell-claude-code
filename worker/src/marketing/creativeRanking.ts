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
 *   • **Data threshold** (`min_spend_sar` 150, `min_impressions` 2000): a
 *     creative below EITHER gate is *unranked* — it is never the default
 *     winner and never a guaranteed loser. It only joins the default
 *     replacement list when ranked evidence exists elsewhere; when NOTHING is
 *     ranked, the default decision keeps everything and says why.
 *   • Ranked creatives with leads > 0 sort by CPL ascending. Creatives with
 *     zero leads rank BELOW all of those, ordered by CTR desc then CPM asc.
 *   • **Fatigue**: frequency > 3.0, or CTR down more than 40 % versus the
 *     previous window. A fatigued creative may not be the DEFAULT keep (a
 *     human may still keep it — this only moves the pre-ticked box).
 *   • Ties: higher CTR → more leads → older creative (→ ad-row id, so the
 *     order is total and the same slate always produces the same decision).
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
  current: MetricTotals;
  /** The window immediately before `window`; null when there is no history. */
  previous?: MetricTotals | null;
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
}

/** `mos_settings.ranking` defaults (contract §6). */
export const RANKING_DEFAULTS: RankingSettings = {
  minSpendSar: 150,
  minImpressions: 2000,
  fatigueFrequency: 3.0,
  fatigueCtrDropPct: 40,
};

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
  frequency: number;
  /** CTR in the previous window, when one was supplied. */
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

export interface RankingResult {
  window: RankingWindow;
  settings: RankingSettings;
  /** Cleared the data threshold, best first. */
  ranked: RankedCreative[];
  /** Below the data threshold, in the same comparator order (for display). */
  unranked: RankedCreative[];
  /** The pre-ticked "keep this one" — null means "replace all" / "no data". */
  defaultKeep: string | null;
  /** The pre-ticked "replace these" ad-row ids. */
  defaultReplace: string[];
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
  const frequency = finite(row.current.frequency);

  const ctr = impressions > 0 ? clicks / impressions : 0;
  const cpm = impressions > 0 ? (spend / impressions) * 1000 : null;
  // CPL = spend ÷ leads. No leads → undefined, NEVER 0 (which would look like
  // the cheapest creative in the account) and never a division by zero.
  const cpl = leads > 0 ? spend / leads : null;

  const previousCtr = row.previous ? ctrOf(row.previous) : null;
  const ctrDropPct = previousCtr != null && previousCtr > 0
    ? ((previousCtr - ctr) / previousCtr) * 100
    : null;

  // Strictly ABOVE the limit, with a float guard: a CTR that fell by exactly
  // 40 % computes as 40.00000000000001 in IEEE-754, and "exactly at the
  // threshold" must not be fatigue.
  const above = (v: number, limit: number): boolean => v - limit > 1e-9;
  const fatigueReasons: FatigueReason[] = [];
  if (above(frequency, settings.fatigueFrequency)) fatigueReasons.push('frequency');
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
    frequency,
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

function reasonFor(c: RankedCreative, settings: RankingSettings, isDefaultKeep: boolean): Bilingual {
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
    const cpmTxt = c.cpm != null
      ? { ar: `، تكلفة الألف ظهور ${arNum(c.cpm, 2)} ر.س`, en: `, CPM SAR ${enNum(c.cpm, 2)}` }
      : { ar: '', en: '' };
    parts.push({
      ar: `بلا عملاء في النافذة — الترتيب بنسبة النقر ${p.ar}${cpmTxt.ar}.`,
      en: `No leads in the window — ranked by CTR ${p.en}${cpmTxt.en}.`,
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

  return { ar: parts.map((p) => p.ar).join(' '), en: parts.map((p) => p.en).join(' ') };
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

  // A fatigued creative may NOT be the pre-ticked keep, even when it ranks
  // first — the manager can still keep it by hand.
  const keep = ranked.find((c) => !c.fatigued) ?? null;
  const defaultKeep = keep?.adRowId ?? null;

  let defaultReplace: string[];
  let summary: Bilingual;
  if (ranked.length === 0) {
    // Nothing cleared the data gates: an unranked creative is never a
    // guaranteed loser, so the default decision changes nothing and says so.
    defaultReplace = [];
    summary = {
      ar: `لا يوجد تصميم بلغ حد البيانات (${arNum(settings.minSpendSar)} ر.س و${arNum(settings.minImpressions)} ظهور) في الفترة ${window.since} → ${window.until} — القرار الافتراضي: إبقاء الجميع، والقرار لك.`,
      en: `No creative reached the data threshold (SAR ${enNum(settings.minSpendSar)} and ${enNum(settings.minImpressions)} impressions) between ${window.since} and ${window.until} — the default is to keep everything and let you decide.`,
    };
  } else {
    defaultReplace = measured.filter((c) => c.adRowId !== defaultKeep).map((c) => c.adRowId);
    if (defaultKeep) {
      const k = ranked.find((c) => c.adRowId === defaultKeep)!;
      summary = {
        ar: `القرار الافتراضي: إبقاء «${k.label ?? k.adRowId}» (تكلفة العميل ${k.cpl != null ? `${arNum(k.cpl, 2)} ر.س` : 'غير محسوبة'}) واستبدال ${arNum(defaultReplace.length)}.`,
        en: `Default: keep “${k.label ?? k.adRowId}” (CPL ${k.cpl != null ? `SAR ${enNum(k.cpl, 2)}` : 'n/a'}) and replace ${enNum(defaultReplace.length)}.`,
      };
    } else {
      summary = {
        ar: `كل التصاميم المصنّفة مُجهَدة — القرار الافتراضي: استبدال ${arNum(defaultReplace.length)} بالكامل.`,
        en: `Every ranked creative is fatigued — the default is to replace all ${enNum(defaultReplace.length)}.`,
      };
    }
  }

  const reasons: Record<string, Bilingual> = {};
  for (const c of measured) reasons[c.adRowId] = reasonFor(c, settings, c.adRowId === defaultKeep);

  return { window, settings, ranked, unranked, defaultKeep, defaultReplace, reasons, summary };
}
