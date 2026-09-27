import { describe, it, expect } from 'vitest';
import type { AppRecord } from '@/types';
import { buildQueueItems, bucketize, computeNoNextAction } from '../queueViews';

// Local noon on a fixed day so SLA buckets are timezone-stable in CI.
const NOW = new Date(2026, 5, 20, 12, 0, 0).getTime();
const iso = (y: number, mo: number, d: number, h = 12) => new Date(y, mo, d, h, 0, 0).toISOString();
const YESTERDAY = iso(2026, 5, 19, 23);
const TOMORROW = iso(2026, 5, 21, 1);

function followup(data: Record<string, unknown>, id: string): AppRecord {
  return { id, model_id: 'm', data, created_by_user_id: 'u', created_at: '', updated_at: '', version: 1 };
}

const clientsById = new Map<string, Record<string, unknown>>([
  ['c1', { client_name: 'Salem', phone_number: '+966500000001', client_stage: 'الاتصال لحجز موعد', client_status: 'مهتم' }],
]);

describe('buildQueueItems', () => {
  it('carries whatsapp_state onto the queue item', () => {
    const items = buildQueueItems(
      [followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'open', followup_type: ['whatsapp_follow_up'], whatsapp_state: 'replied' }, 'r')],
      clientsById,
      NOW,
    );
    expect(items[0].whatsappState).toBe('replied');
  });
});

describe('bucketize — replied WhatsApp surfacing', () => {
  it('puts a replied WhatsApp task in Due Now even when scheduled in the future', () => {
    const items = buildQueueItems(
      [
        followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'open', followup_type: ['whatsapp_follow_up'], whatsapp_state: 'replied' }, 'replied1'),
        followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'open', followup_type: ['whatsapp_follow_up'] }, 'quiet1'),
      ],
      clientsById,
      NOW,
    );
    const dueNow = bucketize(items, null, NOW).due_now.map((i) => i.followupId);
    expect(dueNow).toContain('replied1'); // replied → due now regardless of schedule
    expect(dueNow).not.toContain('quiet1'); // future + no reply → not due now
  });

  it('still buckets a genuinely overdue task as overdue (unchanged)', () => {
    const items = buildQueueItems(
      [followup({ client_id: 'c1', scheduled_datetime: YESTERDAY, followup_status: 'open', followup_type: ['appointment_booking_call'] }, 'od')],
      clientsById,
      NOW,
    );
    expect(bucketize(items, null, NOW).overdue.map((i) => i.followupId)).toContain('od');
  });

  it('puts a FRESH task the client already messaged in Due Now (early-message indicator)', () => {
    const items = buildQueueItems(
      [
        followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'open', followup_type: ['whatsapp_follow_up'], client_messaged_at: YESTERDAY }, 'early1'),
        followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'open', followup_type: ['whatsapp_follow_up'] }, 'quiet1'),
      ],
      clientsById,
      NOW,
    );
    const dueNow = bucketize(items, null, NOW).due_now.map((i) => i.followupId);
    expect(dueNow).toContain('early1'); // client messaged pre-check-in → surface now
    expect(dueNow).not.toContain('quiet1');
  });

  it('does NOT early-surface a waiting task via a stale client_messaged_at stamp', () => {
    // Once a check-in is sent, only a real reply (whatsapp_state='replied')
    // surfaces the task — the fresh-phase stamp must not leak through.
    const items = buildQueueItems(
      [followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'in_progress', followup_type: ['whatsapp_follow_up'], whatsapp_state: 'message_sent_waiting_response', client_messaged_at: YESTERDAY }, 'w')],
      clientsById,
      NOW,
    );
    expect(bucketize(items, null, NOW).due_now.map((i) => i.followupId)).not.toContain('w');
  });

  it('does not surface a replied task once it is completed', () => {
    const items = buildQueueItems(
      [followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'completed', followup_type: ['whatsapp_follow_up'], whatsapp_state: 'replied' }, 'done')],
      clientsById,
      NOW,
    );
    expect(bucketize(items, null, NOW).due_now.map((i) => i.followupId)).not.toContain('done');
  });
});

describe('computeNoNextAction — only clients who SHOULD have a task', () => {
  const TODAY = '2026-09-27';
  const client = (id: string, stage: string) =>
    followup({ client_name: id, phone_number: '5000', client_stage: stage, client_status: stage }, id);
  const appt = (clientId: string, status: string, date: string) =>
    followup({ client_id: clientId, appointment_status: status, appointment_date: date }, `a-${clientId}-${status}`);
  const ids = (rows: { clientId: string }[]) => rows.map((r) => r.clientId).sort();

  it('flags an active-stage client with no open follow-up', () => {
    expect(ids(computeNoNextAction([client('stranded', 'جديد')], [], [], TODAY))).toEqual(['stranded']);
  });

  it('skips every stage that expects no follow-up — wants rent included', () => {
    const clients = ['مغلق ناجح', 'غير مؤهل', 'خاسر', 'يريد إيجار', 'طلب غير مجاب'].map((st, i) => client(`t${i}`, st));
    expect(computeNoNextAction(clients, [], [], TODAY)).toEqual([]);
  });

  it('an open or in-progress follow-up is a next action; a completed one is not', () => {
    const clients = [client('open', 'جديد'), client('prog', 'جديد'), client('done', 'جديد')];
    const fus = [
      followup({ client_id: 'open', followup_status: 'open' }, 'f1'),
      followup({ client_id: 'prog', followup_status: 'in_progress' }, 'f2'),
      followup({ client_id: 'done', followup_status: 'completed' }, 'f3'),
    ];
    expect(ids(computeNoNextAction(clients, fus, [], TODAY))).toEqual(['done']);
  });

  it('an upcoming scheduled/confirmed/rescheduled appointment counts as the next action', () => {
    const clients = [client('sched', 'موعد زيارة'), client('conf', 'موعد زيارة'), client('resched', 'موعد زيارة'), client('todayAppt', 'موعد زيارة')];
    const appts = [
      appt('sched', 'scheduled', '2026-10-01T09:00:00Z'),
      appt('conf', 'confirmed', '2026-09-30'),
      appt('resched', 'rescheduled', '2026-09-28T15:00:00Z'),
      appt('todayAppt', 'scheduled', '2026-09-27T20:00:00Z'),
    ];
    expect(computeNoNextAction(clients, [], appts, TODAY)).toEqual([]);
  });

  it('a past, cancelled, completed or no-show appointment does NOT count', () => {
    const clients = [client('past', 'موعد زيارة'), client('cancel', 'موعد زيارة'), client('noshow', 'موعد زيارة'), client('done', 'زيارة')];
    const appts = [
      appt('past', 'scheduled', '2026-09-20T09:00:00Z'),
      appt('cancel', 'cancelled', '2026-10-01T09:00:00Z'),
      appt('noshow', 'no_show', '2026-10-01T09:00:00Z'),
      appt('done', 'completed', '2026-10-01T09:00:00Z'),
    ];
    expect(ids(computeNoNextAction(clients, [], appts, TODAY))).toEqual(['cancel', 'done', 'noshow', 'past']);
  });
});
