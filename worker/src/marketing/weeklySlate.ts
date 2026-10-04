/**
 * THE WEEKLY AD RULE — five new a week, keep the best one of last week.
 * ============================================================================
 * Operator rule (restated 2026-10-04): "we launch 5 ads per week, and every
 * week we stop. We only keep one ad from the last batch, which is the best ad,
 * and then stop the others."
 *
 * Why this replaced the ranking swap. Until 2026-10-05 the weekly turnover was
 * `decideCycle` → a person confirms → `applyCycle`, and it never paused a single
 * ad in the first plan:
 *   • the decision waited on the marketing manager (auto-apply was off) and the
 *     three decision tasks sat open from 28 Sep;
 *   • the ranking kept every ad it could not "judge" (≥ SAR 101 and ≥ 2,000
 *     impressions in its own week) — and with one project's budget split over
 *     5–7 ads almost none can be judged, so the default was "keep everything";
 *   • the swap paused only as many ads as it activated from READY slots, and the
 *     live ads never came through slots at all: `mos_settings.meta_auto_ad
 *     .status = ACTIVE` created each one live the minute its design was
 *     approved. So the slate only ever grew.
 *
 * The rule now, enforced every tick by `reconcileWeeklySlates`
 * (`runRefreshCycleJob.ts`) from the CURRENT state, so a missed tick, a late
 * design or a crashed machine is simply caught up on the next one:
 *
 *   • A batch is the set of creatives whose slot starts on the same day
 *     (`mos_creative_slots.activate_on`, Tuesdays in the Sep–Oct plan).
 *   • A creative goes live on its batch day, never before (ads are created
 *     PAUSED). One approved after its batch day goes live straight away.
 *   • On each batch day the previous batch is ranked ONCE and its single best
 *     creative is kept; that choice is stored on the batch's refresh cycle so it
 *     never flips mid-week. Every other creative of the previous batch, and
 *     everything older, is paused.
 *   • Never fewer than `planning.min_active_creatives` (5) live: when this
 *     week's designs are late, the best-ranked of the ones due to stop keep
 *     running until the new ones are live — then they stop, one for each.
 *   • A creative already live early (approved before its batch day under the
 *     old setting) is left running; it is this week's creative tomorrow anyway.
 *   • Nothing this rule paused is ever re-activated, and an ad a person paused
 *     by hand is not turned back on (only never-started ads are activated).
 *
 * "Best" = the most leads in the creative's own first week (OUR leads — the
 * WhatsApp conversations its ad opened; Meta's count only when no creative in
 * the batch has one of ours yet), then the lower cost per lead, then more
 * clicks. A thin week still picks one: that is the rule.
 *
 * Pure — no database, no Meta — so the whole rule is testable.
 */

/** One creative of one paid execution (its feed row + story shadow, as one). */
export interface SlateCreative {
  /** The creative key: the primary (feed) ad row id. */
  key: string;
  /** Human reference for logs and the stored decision (P-123). */
  ref: string | null;
  /** The batch day of its slot; null = a creative no slot names (treated as oldest). */
  batchDay: string | null;
  /** On Meta at all (has a platform ad id). Creatives not on Meta are ignored. */
  onMeta: boolean;
  /** The primary row's status: running | watch | paused | waiting. */
  status: string;
  activatedAt: string | null;
  /** Set when THIS rule paused it — such a creative is never re-activated. */
  retiredAt: string | null;
  /** Its own first week, for the ranking. */
  leads: number;
  metaLeads: number;
  spend: number;
  clicks: number;
}

export interface SlatePlanInput {
  /** Riyadh civil date, YYYY-MM-DD. */
  today: string;
  /** Every batch day the execution's slots name. */
  batchDays: string[];
  creatives: SlateCreative[];
  /** `planning.min_active_creatives`. */
  minActive: number;
  /**
   * The previous batch's keeper as stored on this batch's cycle, when already
   * chosen. `undefined` = not chosen yet (the plan proposes one).
   */
  storedKeep?: string | null;
}

export interface RankedCreative {
  key: string;
  ref: string | null;
  leads: number;
  spend: number;
  costPerLead: number | null;
  clicks: number;
}

export interface SlatePlan {
  currentBatch: string | null;
  previousBatch: string | null;
  /** The previous batch ranked best-first (what the keeper was chosen from). */
  ranking: RankedCreative[];
  /** Which lead count ranked it: ours, or Meta's when none of ours exist yet. */
  leadSource: 'ours' | 'meta' | null;
  /** The previous batch's keeper (key), or null when it has none on Meta. */
  keep: string | null;
  /** True when `keep` came from `storedKeep` rather than this plan. */
  keepWasStored: boolean;
  /** This batch's creatives to switch on now (never-started, on Meta). */
  activate: string[];
  /** Live creatives to stop now, worst first. */
  pause: string[];
  /** Live creatives due to stop that keep running only to hold the minimum. */
  holdForMinimum: string[];
  /** Live creatives after this plan (assuming every pause succeeds). */
  liveAfter: number;
}

const isLive = (c: SlateCreative): boolean => c.status === 'running' || c.status === 'watch';

/** Best first: most leads, then cheaper per lead, then more clicks; stable on ref/key. */
export function rankCreatives(list: SlateCreative[], source: 'ours' | 'meta'): RankedCreative[] {
  const rows = list.map((c) => {
    const leads = source === 'ours' ? c.leads : c.metaLeads;
    return {
      key: c.key, ref: c.ref, leads, spend: c.spend, clicks: c.clicks,
      costPerLead: leads > 0 ? c.spend / leads : null,
    };
  });
  rows.sort((a, b) => {
    if (a.leads !== b.leads) return b.leads - a.leads;
    const ca = a.costPerLead ?? Number.POSITIVE_INFINITY;
    const cb = b.costPerLead ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    if (a.clicks !== b.clicks) return b.clicks - a.clicks;
    const ra = a.ref ?? '';
    const rb = b.ref ?? '';
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return rows;
}

/** Which lead count to rank a group on: ours when any creative has one, else Meta's. */
export function leadSourceFor(list: SlateCreative[]): 'ours' | 'meta' {
  return list.some((c) => c.leads > 0) ? 'ours' : 'meta';
}

export function planWeeklySlate(input: SlatePlanInput): SlatePlan {
  const days = [...new Set(input.batchDays.filter(Boolean))].sort();
  const currentBatch = [...days].reverse().find((d) => d <= input.today) ?? null;
  const empty: SlatePlan = {
    currentBatch, previousBatch: null, ranking: [], leadSource: null, keep: null,
    keepWasStored: false, activate: [], pause: [], holdForMinimum: [],
    liveAfter: input.creatives.filter((c) => c.onMeta && isLive(c)).length,
  };
  // No batch has started yet: nothing to switch on, nothing to judge.
  if (!currentBatch) return empty;
  const previousBatch = [...days].reverse().find((d) => d < currentBatch) ?? null;

  const onMeta = input.creatives.filter((c) => c.onMeta);
  const current = onMeta.filter((c) => c.batchDay === currentBatch);
  const previous = previousBatch ? onMeta.filter((c) => c.batchDay === previousBatch) : [];
  const older = onMeta.filter((c) => c.batchDay === null
    || (previousBatch ? c.batchDay < previousBatch : c.batchDay < currentBatch));

  const leadSource = previous.length > 0 ? leadSourceFor(previous) : null;
  const ranking = leadSource ? rankCreatives(previous, leadSource) : [];
  const previousKeys = new Set(previous.map((c) => c.key));
  const keepWasStored = input.storedKeep !== undefined
    && (input.storedKeep === null || previousKeys.has(input.storedKeep));
  const keep = keepWasStored ? (input.storedKeep ?? null) : (ranking[0]?.key ?? null);

  // This batch goes live on its day — only creatives that never started (a
  // creative a person or this rule paused is left alone).
  const activate = current
    .filter((c) => !isLive(c) && !c.activatedAt && !c.retiredAt)
    .map((c) => c.key);

  // Due to stop: what is live from the previous batch (bar the keeper) and
  // from anything older. This week's and future weeks' creatives never stop.
  const dueToStop = [
    ...rankCreatives(previous.filter((c) => c.key !== keep && isLive(c)), leadSource ?? 'ours'),
    ...rankCreatives(older.filter((c) => isLive(c)), leadSourceFor(older)),
  ].map((r) => r.key);

  const liveNow = onMeta.filter(isLive).length;
  // The minimum is held by the BEST of what is due to stop (the list is best
  // first); the rest stop, worst first.
  const canStop = Math.max(0, Math.min(dueToStop.length, liveNow - input.minActive));
  const holdForMinimum = dueToStop.slice(0, dueToStop.length - canStop);
  const pause = dueToStop.slice(dueToStop.length - canStop).reverse();

  return {
    currentBatch, previousBatch, ranking, leadSource, keep, keepWasStored,
    activate, pause, holdForMinimum, liveAfter: liveNow - pause.length,
  };
}
