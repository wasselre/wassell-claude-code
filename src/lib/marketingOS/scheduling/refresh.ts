/**
 * Paid creative forecasting — how many creatives a paid child campaign needs,
 * and when each batch must be in production.
 *
 * The number is CALCULATED from the campaign's real dates. Nothing is
 * hardcoded. Two calendars, deliberately separate (plan v2.1 §7.1):
 *
 *   • production calendar — fixed here, at plan time. Every kept refresh gets
 *     its replacements produced ahead of time, with a hard ready date. It never
 *     depends on performance, because with a 7-day cycle and a ~7-working-day
 *     lead time, cycle k+1's production starts BEFORE cycle k's decision.
 *   • performance calendar — decided near each refresh, from windowed metrics.
 *     It never delays production.
 *
 * PURE.
 */
import type { WorkCalendar } from './calendar';
import { addDays, addWorkingDays, daysBetween } from './calendar';
import type { PaidPolicy, PlannedCycle } from './types';

export interface CycleForecast extends PlannedCycle {
  /** Slot kinds this cycle must produce, in order. */
  slotKinds: Array<'initial' | 'replacement' | 'fifth'>;
}

export interface ForecastInput {
  executionKey: string;
  startsOn: string;
  endsOn: string;
  policy: PaidPolicy;
}

/**
 * The launch + every kept weekly refresh, with the creatives each must produce.
 *
 * Rules:
 *   R_k = startsOn + k·cycleDays for k ≥ 1, kept only while
 *   (endsOn − R_k + 1) ≥ minRemainingDays — a final partial week short of that
 *   never gets its own refresh (its creatives would run for a day or two).
 *
 *   ready_by          = one working day before the refresh
 *   production_start  = the day that leaves exactly `leadTimeWorkingDays`
 *                       working days up to and including ready_by
 *   decision_due      = one working day before the refresh (same day as ready_by:
 *                       everything is built and verified, so the human decides
 *                       with the replacements already in hand)
 *
 * Production per kept refresh:
 *   policy A → slateSize, minus one when a BANKED spare is a known fact at that
 *              cycle's production start (earmarked exclusively to it);
 *   policy B → slateSize − keepMin, and the fifth is conditional.
 */
export function forecastCycles(input: ForecastInput, cal: WorkCalendar): CycleForecast[] {
  const { policy } = input;
  const slate = Math.max(1, Math.floor(policy.slateSize));
  // A date the operator sized by hand wins for that date alone. `keepMin` is
  // re-clamped against it, so a 2-creative batch cannot be asked to keep 4.
  const slateFor = (day: string): number => {
    const v = policy.slateOn?.[day];
    return Number.isFinite(v) && (v as number) > 0 ? Math.max(1, Math.floor(v as number)) : slate;
  };
  const keepMinFor = (s: number): number => Math.max(0, Math.min(s - 1, Math.floor(policy.keepMin)));
  const cycleDays = Math.max(1, Math.floor(policy.cycleDays));
  const minRemaining = Math.max(0, Math.floor(policy.minRemainingDays));
  const lead = Math.max(1, Math.floor(policy.leadTimeWorkingDays));
  const totalDays = daysBetween(input.startsOn, input.endsOn) + 1;

  const out: CycleForecast[] = [];
  // A batch already in production (a re-plan) keeps its round and produces nothing new.
  const frozen = new Set(policy.frozenOn ?? []);

  // Round 0 — the launch slate.
  const launchReady = addWorkingDays(input.startsOn, -1, cal);
  const launchFrozen = frozen.has(input.startsOn);
  const launchSlate = launchFrozen ? 0 : slateFor(input.startsOn);
  out.push({
    executionKey: input.executionKey,
    round: 0,
    refreshOn: input.startsOn,
    readyBy: launchReady,
    productionStartOn: addWorkingDays(launchReady, -(lead - 1), cal),
    decisionDueOn: null,
    produced: launchSlate,
    bankedSpareSlotId: null,
    slotKinds: Array.from({ length: launchSlate }, () => 'initial' as const),
    note: launchFrozen
      ? 'launch slate — already in production, frozen by the re-plan'
      : launchSlate === slate ? 'launch slate' : `launch slate — sized ${launchSlate} for this date`,
  });

  if (totalDays <= 0) return out;

  for (let k = 1; ; k += 1) {
    const refreshOn = addDays(input.startsOn, k * cycleDays);
    const daysLeft = daysBetween(refreshOn, input.endsOn) + 1;
    if (daysLeft <= 0) break;
    if (daysLeft < minRemaining) {
      // A refresh this close to the end is deliberately skipped — recorded so
      // the preview can explain the number instead of just showing it.
      out.push({
        executionKey: input.executionKey,
        round: k,
        refreshOn,
        readyBy: null,
        productionStartOn: null,
        decisionDueOn: null,
        produced: 0,
        bankedSpareSlotId: null,
        slotKinds: [],
        note: `skipped — only ${daysLeft} day(s) remain (minimum ${minRemaining})`,
      });
      break;
    }
    const readyBy = addWorkingDays(refreshOn, -1, cal);
    const productionStartOn = addWorkingDays(readyBy, -(lead - 1), cal);
    if (frozen.has(refreshOn)) {
      out.push({
        executionKey: input.executionKey,
        round: k,
        refreshOn,
        readyBy,
        productionStartOn,
        decisionDueOn: readyBy,
        produced: 0,
        bankedSpareSlotId: null,
        slotKinds: [],
        note: 'already in production — frozen by the re-plan',
      });
      continue;
    }
    const cycleSlate = slateFor(refreshOn);
    const cycleKeep = keepMinFor(cycleSlate);
    const replacements = cycleSlate - cycleKeep;
    const kinds: Array<'replacement' | 'fifth'> = Array.from({ length: replacements }, () => 'replacement' as const);
    if (policy.fifthPolicy === 'A') {
      for (let i = 0; i < cycleKeep; i += 1) kinds.push('fifth');
    }
    out.push({
      executionKey: input.executionKey,
      round: k,
      refreshOn,
      readyBy,
      productionStartOn,
      decisionDueOn: readyBy,
      produced: kinds.length,
      bankedSpareSlotId: null,
      slotKinds: kinds,
      note: policy.fifthPolicy === 'A'
        ? `${replacements} replacements + ${cycleKeep} fifth (replace-all always available)`
        : `${replacements} replacements; a fifth is conditional`,
    });
  }

  if (policy.fifthPolicy === 'A') applyBank(out, policy, cal);
  return out;
}

/**
 * Earmark banked spares, earliest eligible cycle first, ONE per cycle.
 *
 * A spare only counts when it is a fact before the cycle's production start —
 * `availableFrom < productionStartOn`. That is why, with a 7-day cycle and a
 * 7-working-day lead, the initial plan of a fresh campaign never reduces any
 * cycle: nothing has been decided yet. Spares appear later, and the operator's
 * re-plan (revise) picks them up. Each earmark is exclusive; the database
 * refuses a second claim on the same slot.
 */
function applyBank(cycles: CycleForecast[], policy: PaidPolicy, _cal: WorkCalendar): void {
  const bank = (policy.bankedSpares ?? [])
    .slice()
    .sort((a, b) => (a.availableFrom < b.availableFrom ? -1 : a.availableFrom > b.availableFrom ? 1 : a.slotId < b.slotId ? -1 : 1));
  let bi = 0;
  for (const c of cycles) {
    if (c.round === 0 || !c.productionStartOn || !c.slotKinds.length) continue;
    if (bi >= bank.length) break;
    const spare = bank[bi];
    if (!spare) break;
    if (daysBetween(spare.availableFrom, c.productionStartOn) <= 0) continue; // not strictly before
    const fifthIdx = c.slotKinds.lastIndexOf('fifth');
    if (fifthIdx < 0) continue;
    c.slotKinds.splice(fifthIdx, 1);
    c.produced = c.slotKinds.length;
    c.bankedSpareSlotId = spare.slotId;
    c.note += ` · one fifth covered by banked spare ${spare.slotId.slice(0, 8)} (reserved exclusively)`;
    bi += 1;
  }
}

/** Totals for the preview, computed from the forecast (never hardcoded). */
export function creativeTotals(cycles: CycleForecast[]): {
  initial: number; replacements: number; fifths: number; total: number; cycles: number;
} {
  let initial = 0;
  let replacements = 0;
  let fifths = 0;
  let kept = 0;
  for (const c of cycles) {
    if (c.round > 0 && c.produced > 0) kept += 1;
    for (const k of c.slotKinds) {
      if (k === 'initial') initial += 1;
      else if (k === 'replacement') replacements += 1;
      else fifths += 1;
    }
  }
  return { initial, replacements, fifths, total: initial + replacements + fifths, cycles: kept };
}
