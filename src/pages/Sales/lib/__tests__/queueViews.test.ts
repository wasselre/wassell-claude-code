import { describe, it, expect } from 'vitest';
import type { AppRecord } from '@/types';
import { buildQueueItems, bucketize } from '../queueViews';

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

  it('does not surface a replied task once it is completed', () => {
    const items = buildQueueItems(
      [followup({ client_id: 'c1', scheduled_datetime: TOMORROW, followup_status: 'completed', followup_type: ['whatsapp_follow_up'], whatsapp_state: 'replied' }, 'done')],
      clientsById,
      NOW,
    );
    expect(bucketize(items, null, NOW).due_now.map((i) => i.followupId)).not.toContain('done');
  });
});
