/**
 * The acceptance fixtures from the plan's §22 — the worked examples, checked in
 * as data so they are TESTS, not prose (v2.1 correction 2 of the second review).
 *
 * Calendar: Saudi week, Friday off, no holidays. 2026-10-01 is a Thursday.
 * Team: writer W, montage M1 + M2, manager MM.
 */
import { DEFAULT_CALENDAR, type WorkCalendar } from '../calendar';
import type { LedgerRow, PersonCapacity, WorkloadSnapshot } from '../types';

export const CAL: WorkCalendar = { ...DEFAULT_CALENDAR, holidays: [] };

export const W = 'user-writer';
export const M1 = 'user-montage-1';
export const M2 = 'user-montage-2';
export const MM = 'user-manager';
export const OPS = 'user-ops';

export const TEAM: PersonCapacity[] = [
  { userId: W, roles: ['writer'], caps: { post: 10, video: 4, approvals: 20, publishing: 8 }, leaves: [] },
  { userId: M1, roles: ['montage'], caps: { post: 4, video: 4, approvals: 20, publishing: 8 }, leaves: [] },
  { userId: M2, roles: ['montage'], caps: { post: 4, video: 4, approvals: 20, publishing: 8 }, leaves: [] },
  { userId: MM, roles: ['marketing_manager'], caps: { post: 0, video: 0, approvals: 20, publishing: 8 }, leaves: [] },
  { userId: OPS, roles: ['ops_supervisor'], caps: { post: 4, video: 4, approvals: 20 }, leaves: [] },
];

export function snapshot(today: string, ledger: LedgerRow[] = [], people = TEAM): WorkloadSnapshot {
  return { today, calendar: CAL, people, ledger, hash: `test-${today}-${ledger.length}` };
}

const busy = (userId: string, day: string, n: number): LedgerRow[] =>
  Array.from({ length: n }, (_, i) => ({
    userId, day, bucket: 'post' as const, weight: 1, source: 'task' as const, refId: `x${i}`,
  }));

/**
 * §22.1 base ledger — "other campaigns":
 *   M1 two open designs on Oct 6 and one on Oct 7
 *   M2 a reserved 2-day design Oct 6–7
 */
export const LEDGER_221: LedgerRow[] = [
  ...busy(M1, '2026-10-06', 2),
  ...busy(M1, '2026-10-07', 1),
  { userId: M2, day: '2026-10-06', bucket: 'post', weight: 1, source: 'reservation', refId: 'campaignX' },
  { userId: M2, day: '2026-10-07', bucket: 'post', weight: 1, source: 'reservation', refId: 'campaignX' },
];

/** §22.1 variant — M2 also carries two more open designs on Oct 7. */
export const LEDGER_221_TIGHT: LedgerRow[] = [
  ...LEDGER_221,
  ...busy(M2, '2026-10-07', 2),
];

export const PROJECT_A = { projectId: 'proj-a', projectName: 'A' };
export const PROJECT_B = { projectId: 'proj-b', projectName: 'B' };
export const PROJECT_C = { projectId: 'proj-c', projectName: 'C' };
export const PROJECT_D = { projectId: 'proj-d', projectName: 'D' };
export const PROJECT_E = { projectId: 'proj-e', projectName: 'E' };
