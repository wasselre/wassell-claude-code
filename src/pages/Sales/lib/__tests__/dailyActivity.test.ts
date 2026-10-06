import { describe, it, expect } from 'vitest';
import type { AppRecord } from '@/types';
import { computeDailyActivity, matchesFilter, parseWhen, riyadhDay, riyadhDayRange } from '../dailyActivity';

const rec = (id: string, data: Record<string, unknown>, extra: Partial<AppRecord> = {}): AppRecord =>
  ({ id, model_id: 'm', data, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-05T10:00:00Z', ...extra } as AppRecord);

const day = riyadhDayRange('2026-10-05');
const call = (id: string, result: string, at: string, rep = 'u1', more: Record<string, unknown> = {}) =>
  rec(id, { followup_type: ['appointment_booking_call'], followup_status: 'completed', call_result: result, actual_datetime: at, sales_rep: rep, client_id: `c-${id}`, ...more });
const wa = (id: string, result: string, more: Record<string, unknown>) =>
  rec(id, { followup_type: ['whatsapp_follow_up'], followup_status: 'completed', call_result: result, sales_rep: 'u1', ...more });

describe('riyadh days', () => {
  it('a Riyadh day starts at 21:00 UTC the day before', () => {
    expect(new Date(day.from).toISOString()).toBe('2026-10-04T21:00:00.000Z');
    expect(day.to - day.from).toBe(86_400_000);
  });
  it('yesterday in Riyadh', () => {
    expect(riyadhDay(-1, Date.parse('2026-10-06T22:30:00Z'))).toBe('2026-10-06');
  });
  it('reads a bare local time as Riyadh time', () => {
    expect(new Date(parseWhen('2026-10-05T19:00') as number).toISOString()).toBe('2026-10-05T16:00:00.000Z');
  });
});

describe('computeDailyActivity', () => {
  const followups = [
    call('a', 'no_answer', '2026-10-05T07:00:00Z'),
    call('b', 'interested', '2026-10-05T08:00:00Z', 'u2'),
    call('c', 'not_interested', '2026-10-05T09:00:00Z'),
    call('d', 'invalid_number', '2026-10-05T10:00:00Z'),
    // recorded on 31 Aug but touched yesterday — must NOT count
    call('old', 'interested', '2026-08-31T11:00:00Z'),
    // AI-recorded WhatsApp result
    wa('w1', 'unanswered_request', { actual_datetime: '2026-10-05T12:00:00Z', completed_by_chat_id: 'chat1' }),
    // automatic no-reply close, dated by fired_at
    wa('w2', 'no_response', { whatsapp_state: 'no_response_expired', fired_at: '2026-10-05T07:30:00Z' }),
    // still open — not a result
    rec('open', { followup_type: ['appointment_booking_call'], followup_status: 'open', actual_datetime: '2026-10-05T07:00:00Z' }),
  ];
  const appointments = [
    rec('ap1', { client_id: 'c-b', sales_rep: 'u2', appointment_status: 'scheduled' }, { created_at: '2026-10-05T08:05:00Z', created_by_user_id: 'u2' }),
    rec('ap2', { client_id: 'x' }, { created_at: '2026-10-04T08:05:00Z' }),
  ];
  const visits = [rec('v1', { client_id: 'c-b', scheduled_datetime: '2026-10-05T19:00', sales_representative: 'u2' })];
  const a = computeDailyActivity(followups, appointments, visits, day);

  it('counts calls and the answer rate from results dated that day', () => {
    expect(a.calls).toBe(4);
    expect(a.answered).toBe(2);
    expect(a.answerRate).toBe(0.5);
  });
  it('counts WhatsApp results and replies; AI and automatic ones are marked', () => {
    expect(a.whatsapp).toBe(2);
    expect(a.replied).toBe(1);
    expect(a.results.find((r) => r.id === 'w1')?.byAi).toBe(true);
    expect(a.results.find((r) => r.id === 'w2')?.auto).toBe(true);
  });
  it('counts interested, appointments booked that day and visits held that day', () => {
    expect(a.interested).toBe(1);
    expect(a.appointments.map((b) => b.id)).toEqual(['ap1']);
    expect(a.visits.map((b) => b.id)).toEqual(['v1']);
  });
  it('breaks results down per rep', () => {
    const u2 = a.reps.find((r) => r.repId === 'u2');
    expect(u2).toMatchObject({ calls: 1, answered: 1, interested: 1, appointments: 1, visits: 1 });
  });
  it('filters', () => {
    expect(a.results.filter((r) => matchesFilter(r, { kind: 'not_answered' })).map((r) => r.id).sort()).toEqual(['a', 'd']);
    expect(a.results.filter((r) => matchesFilter(r, { kind: 'result', channel: 'whatsapp', result: 'no_response' })).map((r) => r.id)).toEqual(['w2']);
  });
  it('no calls → no answer rate', () => {
    expect(computeDailyActivity([], [], [], day).answerRate).toBeNull();
  });
});
