import type { AppRecord } from '@/types';
import { followupChannel, type FollowupChannel } from './myWork';

/**
 * Daily sales activity — what actually HAPPENED in a period (default:
 * yesterday, Riyadh time) — for the Sales Workspace overview (operator,
 * 2026-10-05: "yesterday's calls… how many answered… filter by WhatsApp
 * results, call results, appointments, visits, answer rate, interested").
 * Pure, so it is unit-tested.
 *
 * A follow-up result is dated by WHEN IT HAPPENED (`actual_datetime`), never by
 * `updated_at`: background jobs touch old tasks, and on 5 Oct «updated
 * yesterday» included results recorded on 31 August. The automatic «no reply»
 * close of a WhatsApp task has no actual time; it is dated by `fired_at`.
 */

export type ActivityFilter =
  | { kind: 'all' }
  | { kind: 'channel'; channel: FollowupChannel }
  | { kind: 'answered' }
  | { kind: 'not_answered' }
  | { kind: 'interested' }
  | { kind: 'result'; channel: FollowupChannel; result: string }
  | { kind: 'appointments' }
  | { kind: 'visits' };

export interface ActivityResult {
  id: string;
  clientId: string | null;
  at: string;
  channel: FollowupChannel;
  typeKey: string;
  result: string;
  repId: string | null;
  /** Recorded by the AI from the chat (no person). */
  byAi: boolean;
  /** Closed automatically because the customer never replied. */
  auto: boolean;
  notes: string | null;
}

export interface ActivityBooking {
  id: string;
  kind: 'appointment' | 'visit';
  clientId: string | null;
  at: string;
  repId: string | null;
  projectId: string | null;
  status: string | null;
  byAi: boolean;
}

export interface Tally { key: string; count: number }

export interface RepRow {
  repId: string | null;
  calls: number; answered: number; whatsapp: number; replied: number;
  interested: number; appointments: number; visits: number;
}

export interface DailyActivity {
  results: ActivityResult[];
  appointments: ActivityBooking[];
  visits: ActivityBooking[];
  calls: number;
  answered: number;
  /** answered / calls, or null with no calls. */
  answerRate: number | null;
  whatsapp: number;
  replied: number;
  interested: number;
  callResults: Tally[];
  whatsappResults: Tally[];
  reps: RepRow[];
}

/** A call that never reached the customer. */
export const NOT_REACHED = new Set(['no_answer', 'invalid_number', 'no_message_sent']);
/** A WhatsApp follow-up the customer did not answer. */
export const NO_REPLY = new Set(['no_response', 'message_sent', 'no_message_sent']);
/** Results that mean the customer wants to go on. */
export const INTERESTED = new Set(['interested', 'still_interested', 'request_offer', 'appointment_booked', 'requested_another_visit']);

const DONE = new Set(['completed', 'done']);

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}
function firstId(v: unknown): string | null {
  return str(Array.isArray(v) ? v[0] : v);
}
function typeOf(d: Record<string, unknown>): string {
  const t = d.followup_type;
  return (Array.isArray(t) ? str(t[0]) : str(t)) ?? '';
}
/** A date-time string → epoch ms. A bare local `YYYY-MM-DDTHH:MM` is Riyadh time. */
export function parseWhen(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.length === 16 ? `${s}:00` : s}+03:00`);
  return Number.isFinite(t) ? t : null;
}

/** [from, to) of a Riyadh calendar day (YYYY-MM-DD), as epoch ms. */
export function riyadhDayRange(day: string, days = 1): { from: number; to: number } {
  const from = Date.parse(`${day}T00:00:00+03:00`);
  return { from, to: from + days * 86_400_000 };
}

/** Riyadh YYYY-MM-DD, `offset` days from now. */
export function riyadhDay(offset = 0, now = Date.now()): string {
  return new Date(now + 3 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
}

export function computeDailyActivity(
  followups: readonly AppRecord[],
  appointments: readonly AppRecord[],
  visits: readonly AppRecord[],
  range: { from: number; to: number },
): DailyActivity {
  const inRange = (t: number | null): t is number => t !== null && t >= range.from && t < range.to;

  const results: ActivityResult[] = [];
  for (const r of followups) {
    const d = r.data as Record<string, unknown>;
    const result = str(d.call_result);
    if (!result || !DONE.has(str(d.followup_status) ?? '')) continue;
    const autoClosed = (str(d.whatsapp_state) ?? '').endsWith('expired');
    const t = parseWhen(d.actual_datetime) ?? (autoClosed ? parseWhen(d.fired_at) : null);
    if (!inRange(t)) continue;
    const typeKey = typeOf(d);
    const channel = followupChannel(typeKey);
    results.push({
      id: r.id, clientId: firstId(d.client_id), at: new Date(t).toISOString(), channel, typeKey, result,
      repId: firstId(d.completed_by_user) ?? firstId(d.sales_rep),
      byAi: !firstId(d.completed_by_user) && !!str(d.completed_by_chat_id) && channel === 'whatsapp',
      auto: autoClosed && !str(d.actual_datetime),
      notes: str(d.outcome_notes),
    });
  }
  results.sort((a, b) => b.at.localeCompare(a.at));

  const bookings = (rows: readonly AppRecord[], kind: 'appointment' | 'visit'): ActivityBooking[] => rows
    .map((r) => {
      const d = r.data as Record<string, unknown>;
      // An appointment counts on the day it was BOOKED; a visit on the day it took place.
      const t = kind === 'appointment' ? parseWhen(r.created_at) : (parseWhen(d.scheduled_datetime) ?? parseWhen(r.created_at));
      if (!inRange(t)) return null;
      return {
        id: r.id, kind, clientId: firstId(d.client_id), at: new Date(t).toISOString(),
        repId: firstId(kind === 'appointment' ? d.sales_rep : d.sales_representative),
        projectId: firstId(d.project_id),
        status: str(d.appointment_status),
        byAi: !r.created_by_user_id,
      };
    })
    .filter((b): b is ActivityBooking => b !== null)
    .sort((a, b) => b.at.localeCompare(a.at));

  const appts = bookings(appointments, 'appointment');
  const vis = bookings(visits, 'visit');

  const calls = results.filter((r) => r.channel === 'call');
  const was = results.filter((r) => r.channel === 'whatsapp');
  const answered = calls.filter((r) => !NOT_REACHED.has(r.result)).length;
  const replied = was.filter((r) => !NO_REPLY.has(r.result)).length;

  const tally = (rs: ActivityResult[]): Tally[] => {
    const m = new Map<string, number>();
    for (const r of rs) m.set(r.result, (m.get(r.result) ?? 0) + 1);
    return [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  };

  const repMap = new Map<string, RepRow>();
  const rep = (id: string | null): RepRow => {
    const k = id ?? '';
    let row = repMap.get(k);
    if (!row) { row = { repId: id, calls: 0, answered: 0, whatsapp: 0, replied: 0, interested: 0, appointments: 0, visits: 0 }; repMap.set(k, row); }
    return row;
  };
  for (const r of results) {
    const row = rep(r.repId);
    if (r.channel === 'call') { row.calls++; if (!NOT_REACHED.has(r.result)) row.answered++; }
    else { row.whatsapp++; if (!NO_REPLY.has(r.result)) row.replied++; }
    if (INTERESTED.has(r.result)) row.interested++;
  }
  for (const b of appts) rep(b.repId).appointments++;
  for (const b of vis) rep(b.repId).visits++;

  return {
    results, appointments: appts, visits: vis,
    calls: calls.length, answered, answerRate: calls.length ? answered / calls.length : null,
    whatsapp: was.length, replied,
    interested: results.filter((r) => INTERESTED.has(r.result)).length,
    callResults: tally(calls), whatsappResults: tally(was),
    reps: [...repMap.values()].sort((a, b) => (b.calls + b.whatsapp) - (a.calls + a.whatsapp)),
  };
}

/** Does a result row pass the active filter? (Bookings filters show bookings, not results.) */
export function matchesFilter(r: ActivityResult, f: ActivityFilter): boolean {
  switch (f.kind) {
    case 'all': return true;
    case 'channel': return r.channel === f.channel;
    case 'answered': return r.channel === 'call' && !NOT_REACHED.has(r.result);
    case 'not_answered': return r.channel === 'call' && NOT_REACHED.has(r.result);
    case 'interested': return INTERESTED.has(r.result);
    case 'result': return r.channel === f.channel && r.result === f.result;
    default: return false;
  }
}
