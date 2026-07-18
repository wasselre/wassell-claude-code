import { describe, it, expect } from 'vitest';
import type { AppRecord } from '@/types';
import {
  followupDayBucket,
  followupChannel,
  isDoneFollowup,
  buildFollowupTasks,
  indexClientFollowups,
} from '../myWork';

// Local noon on a fixed day — using the local Date constructor (no trailing Z)
// keeps "today / late / future" deterministic regardless of the CI timezone.
const NOW = new Date(2026, 5, 20, 12, 0, 0).getTime();
const iso = (y: number, mo: number, d: number, h = 12) => new Date(y, mo, d, h, 0, 0).toISOString();
const YESTERDAY = iso(2026, 5, 19, 23);
const EARLIER_TODAY = iso(2026, 5, 20, 9);
const LATER_TODAY = iso(2026, 5, 20, 18);
const TOMORROW = iso(2026, 5, 21, 1);

function followup(data: Record<string, unknown>, id = 'f'): AppRecord {
  return { id, model_id: 'm', data, created_by_user_id: 'u', created_at: '', updated_at: '', version: 1 };
}

describe('followupDayBucket', () => {
  it('classifies a follow-up scheduled before today as late', () => {
    expect(followupDayBucket(YESTERDAY, NOW)).toBe('late');
  });

  it('treats a follow-up scheduled EARLIER today as today, not late', () => {
    expect(followupDayBucket(EARLIER_TODAY, NOW)).toBe('today');
  });

  it('treats a follow-up scheduled later today as today', () => {
    expect(followupDayBucket(LATER_TODAY, NOW)).toBe('today');
  });

  it('classifies a future follow-up as future', () => {
    expect(followupDayBucket(TOMORROW, NOW)).toBe('future');
  });

  it('returns none for a missing/invalid date', () => {
    expect(followupDayBucket(null, NOW)).toBe('none');
    expect(followupDayBucket('not-a-date', NOW)).toBe('none');
  });
});

describe('followupChannel', () => {
  it('maps WhatsApp follow-ups to the whatsapp channel', () => {
    expect(followupChannel('whatsapp_follow_up')).toBe('whatsapp');
  });
  it('maps call follow-ups to the call channel', () => {
    expect(followupChannel('appointment_confirmation_call')).toBe('call');
    expect(followupChannel('appointment_booking_call')).toBe('call');
  });
  it('treats a rating request as a conversation', () => {
    expect(followupChannel('rating_request')).toBe('whatsapp');
  });
  it('defaults unknown types to call', () => {
    expect(followupChannel(null)).toBe('call');
    expect(followupChannel('something_else')).toBe('call');
  });
});

describe('isDoneFollowup', () => {
  it('treats completed/cancelled/skipped as done', () => {
    expect(isDoneFollowup('completed')).toBe(true);
    expect(isDoneFollowup('cancelled')).toBe(true);
    expect(isDoneFollowup('skipped')).toBe(true);
  });
  it('treats open/in_progress/scheduled as not done', () => {
    expect(isDoneFollowup('open')).toBe(false);
    expect(isDoneFollowup('in_progress')).toBe(false);
    expect(isDoneFollowup('scheduled')).toBe(false);
  });
});

describe('buildFollowupTasks', () => {
  const clientsById = new Map<string, Record<string, unknown>>([
    ['c1', { client_name: 'Salem', phone_number: '+966500000001' }],
  ]);

  it('includes today + late open follow-ups and drops future + done', () => {
    const followups = [
      followup({ client_id: 'c1', scheduled_datetime: LATER_TODAY, followup_status: 'open', followup_type: 'appointment_booking_call' }, 'today1'),
      followup({ client_id: 'c1', scheduled_datetime: YESTERDAY, followup_status: 'open', followup_type: 'whatsapp_follow_up' }, 'late1'),
      followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'open', followup_type: 'appointment_booking_call' }, 'future1'),
      followup({ client_id: 'c1', scheduled_datetime: EARLIER_TODAY, followup_status: 'completed', followup_type: 'appointment_booking_call' }, 'done1'),
    ];
    const tasks = buildFollowupTasks(followups, clientsById, NOW);
    const ids = tasks.map((t) => t.followupId).sort();
    expect(ids).toEqual(['late1', 'today1']);
  });

  it('surfaces a future WhatsApp follow-up once the customer has replied', () => {
    // Reply-checkpoint task scheduled tomorrow, but the client just replied →
    // must appear now (the inbound reconciler set whatsapp_state='replied').
    const followups = [
      followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'open', followup_type: 'whatsapp_follow_up', whatsapp_state: 'replied' }, 'replied1'),
      followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'open', followup_type: 'whatsapp_follow_up' }, 'quiet1'),
    ];
    const tasks = buildFollowupTasks(followups, clientsById, NOW);
    const ids = tasks.map((t) => t.followupId);
    expect(ids).toContain('replied1'); // replied → surfaced despite future date
    expect(ids).not.toContain('quiet1'); // no reply + future → still hidden
    // Must be promoted to TODAY so the My Tasks page (renders today+late only) shows it.
    expect(tasks.find((t) => t.followupId === 'replied1')?.bucket).toBe('today');
  });

  it('surfaces a future FRESH WhatsApp task once the client has messaged (early-message indicator)', () => {
    const followups = [
      followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'open', followup_type: 'whatsapp_follow_up', client_messaged_at: YESTERDAY }, 'early1'),
      followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'open', followup_type: 'whatsapp_follow_up' }, 'quiet1'),
    ];
    const tasks = buildFollowupTasks(followups, clientsById, NOW);
    const ids = tasks.map((t) => t.followupId);
    expect(ids).toContain('early1'); // client messaged pre-check-in → surfaced
    expect(ids).not.toContain('quiet1');
    expect(tasks.find((t) => t.followupId === 'early1')?.bucket).toBe('today');
  });

  it('does NOT early-surface a waiting task via a stale client_messaged_at stamp', () => {
    const tasks = buildFollowupTasks(
      [followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'in_progress', followup_type: 'whatsapp_follow_up', whatsapp_state: 'message_sent_waiting_response', client_messaged_at: YESTERDAY }, 'w')],
      clientsById, NOW,
    );
    expect(tasks.map((t) => t.followupId)).not.toContain('w');
  });

  it('keeps a replied WhatsApp task in the LATE bucket when genuinely overdue', () => {
    const tasks = buildFollowupTasks(
      [followup({ client_id: 'c1', scheduled_datetime: YESTERDAY, followup_status: 'open', followup_type: 'whatsapp_follow_up', whatsapp_state: 'replied' }, 'r')],
      clientsById, NOW,
    );
    expect(tasks[0].bucket).toBe('late');
  });

  it('exposes whatsappState on the built task', () => {
    const followups = [
      followup({ client_id: 'c1', scheduled_datetime: YESTERDAY, followup_status: 'in_progress', followup_type: 'whatsapp_follow_up', whatsapp_state: 'message_sent_waiting_response' }, 'w'),
    ];
    expect(buildFollowupTasks(followups, clientsById, NOW)[0].whatsappState).toBe('message_sent_waiting_response');
  });

  it('resolves client name/phone + channel + bucket', () => {
    const followups = [
      followup({ client_id: 'c1', scheduled_datetime: YESTERDAY, followup_status: 'open', followup_type: 'whatsapp_follow_up' }, 'late1'),
    ];
    const [t] = buildFollowupTasks(followups, clientsById, NOW);
    expect(t.clientName).toBe('Salem');
    expect(t.phone).toBe('+966500000001');
    expect(t.channel).toBe('whatsapp');
    expect(t.bucket).toBe('late');
  });
});

describe('indexClientFollowups', () => {
  it('summarizes latest done, next open, late flag', () => {
    const followups = [
      followup({ client_id: 'c1', followup_status: 'completed', actual_datetime: YESTERDAY, followup_type: 'appointment_booking_call', call_result: 'interested' }, 'a'),
      followup({ client_id: 'c1', followup_status: 'open', scheduled_datetime: YESTERDAY, followup_type: 'whatsapp_follow_up' }, 'b'),
      followup({ client_id: 'c1', followup_status: 'open', scheduled_datetime: TOMORROW, followup_type: 'appointment_booking_call' }, 'c'),
    ];
    const idx = indexClientFollowups(followups, NOW);
    const s = idx.get('c1');
    expect(s).toBeDefined();
    expect(s?.late).toBe(true);
    expect(s?.openCount).toBe(2);
    expect(s?.latest?.result).toBe('interested');
    expect(s?.next?.scheduledISO).toBe(YESTERDAY); // earliest open
  });

  it('is not late when the only open follow-up is today or future', () => {
    const followups = [
      followup({ client_id: 'c1', followup_status: 'open', scheduled_datetime: EARLIER_TODAY }, 'a'),
    ];
    expect(indexClientFollowups(followups, NOW).get('c1')?.late).toBe(false);
  });

  it('skips follow-ups with no client link', () => {
    const followups = [followup({ followup_status: 'open', scheduled_datetime: YESTERDAY }, 'a')];
    expect(indexClientFollowups(followups, NOW).size).toBe(0);
  });
});
