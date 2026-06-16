// Pure sales-manager metrics — computed in-memory from the store (Part 13's
// "views first"). The headline is "active clients with no next action = 0";
// the rest are operational counts + a few derived rates managers watch.

import type { AppRecord } from '@/types';
import { computeNoNextAction } from './queueViews';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';

export interface Distribution {
  key: string;
  count: number;
}

export interface ManagerMetrics {
  totalClients: number;
  noNextAction: number;
  openFollowups: number;
  overdue: number;
  completed30d: number;
  completedLate: number;
  /** Clients by lifecycle stage (the funnel). */
  byStage: Distribution[];
  /** Completed follow-up outcomes (call_result). */
  outcomes: Distribution[];
  /** Lost reasons across completed follow-ups + lost clients. */
  lostReasons: Distribution[];
  /** Per-rep open + completed(30d) counts, keyed by user id. */
  perRep: Array<{ repId: string; open: number; completed: number }>;
  rates: {
    /** completed booking calls that were no-answer / all completed booking calls. */
    noAnswerRate: number | null;
    /** completed follow-ups that were on time / all completed. */
    onTimeRate: number | null;
  };
}

const OPEN = new Set(['open', 'in_progress']);
const ms = (iso: unknown) => (typeof iso === 'string' ? new Date(iso).getTime() : NaN);

function bump(map: Map<string, number>, key: string | undefined | null) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}
function toDist(map: Map<string, number>): Distribution[] {
  return [...map.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

export function computeManagerMetrics(
  clients: AppRecord[],
  followups: AppRecord[],
  now: number,
): ManagerMetrics {
  const cutoff30 = now - 30 * 24 * 3600 * 1000;
  const byStage = new Map<string, number>();
  const outcomes = new Map<string, number>();
  const lostReasons = new Map<string, number>();
  const perRepOpen = new Map<string, number>();
  const perRepDone = new Map<string, number>();

  for (const c of clients) {
    bump(byStage, c.data.client_stage as string);
    if (c.data.lost_reason) bump(lostReasons, c.data.lost_reason as string);
  }

  let openFollowups = 0, overdue = 0, completed30d = 0, completedLate = 0;
  let bookingCompleted = 0, bookingNoAnswer = 0, completedOnTime = 0;

  for (const f of followups) {
    const d = f.data;
    const status = (d.followup_status as string) || 'open';
    const rep = (d.sales_rep as string) || '';
    const sched = ms(d.scheduled_datetime);
    const actual = ms(d.actual_datetime);
    const type = readFollowupType(d);

    if (OPEN.has(status)) {
      openFollowups++;
      if (rep) bump(perRepOpen, rep);
      if (!Number.isNaN(sched) && sched < now) overdue++;
    }
    if (status === 'completed') {
      if (!Number.isNaN(actual) && actual >= cutoff30) completed30d++;
      if (rep) bump(perRepDone, rep);
      const late = !Number.isNaN(actual) && !Number.isNaN(sched) && actual > sched;
      if (late) completedLate++; else completedOnTime++;
      const cr = d.call_result as string;
      bump(outcomes, cr);
      if (d.lost_reason) bump(lostReasons, d.lost_reason as string);
      if (type === 'appointment_booking_call') {
        bookingCompleted++;
        if (cr === 'no_answer') bookingNoAnswer++;
      }
    }
  }

  const totalCompleted = completedLate + completedOnTime;
  const repIds = new Set<string>([...perRepOpen.keys(), ...perRepDone.keys()]);
  const perRep = [...repIds]
    .map((repId) => ({ repId, open: perRepOpen.get(repId) ?? 0, completed: perRepDone.get(repId) ?? 0 }))
    .sort((a, b) => b.open + b.completed - (a.open + a.completed));

  return {
    totalClients: clients.length,
    noNextAction: computeNoNextAction(clients, followups).length,
    openFollowups,
    overdue,
    completed30d,
    completedLate,
    byStage: toDist(byStage),
    outcomes: toDist(outcomes),
    lostReasons: toDist(lostReasons),
    perRep,
    rates: {
      noAnswerRate: bookingCompleted > 0 ? bookingNoAnswer / bookingCompleted : null,
      onTimeRate: totalCompleted > 0 ? completedOnTime / totalCompleted : null,
    },
  };
}
