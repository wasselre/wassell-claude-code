import { describe, it, expect } from 'vitest';
import { followupsCancelledBy, SUPERSEDE_MATRIX, isOpenFollowupStatus } from '../supersede';
import type { SupersedeCandidate } from '../supersede';

// Helper: one open follow-up of a given type.
const fu = (id: string, type: string, status: string | null = 'open'): SupersedeCandidate =>
  ({ id, followup_type: [type], followup_status: status });

// A client sitting on a full spread of one open task of every type.
const everyType = (): SupersedeCandidate[] => [
  fu('booking', 'appointment_booking_call'),
  fu('wa', 'whatsapp_follow_up'),
  fu('noshow', 'no_show_recovery_call'),
  fu('confirm', 'appointment_confirmation_call'),
  fu('sameday', 'same_day_appointment_confirmation'),
  fu('aftervisit', 'follow_up_call_after_visit'),
  fu('offer', 'offer_follow_up'),
  fu('respay', 'reservation_payment_follow_up'),
  fu('financing', 'financing_follow_up'),
  fu('transfer', 'ownership_transfer_follow_up'),
];

describe('supersede matrix — cancels obsolete, keeps the new next task', () => {
  it('1. appointment created cancels booking/WhatsApp (+no-show) but NOT confirmation', () => {
    const cancelled = followupsCancelledBy('appointment_created', everyType());
    expect(cancelled).toEqual(expect.arrayContaining(['booking', 'wa', 'noshow']));
    expect(cancelled).not.toContain('confirm');
    expect(cancelled).not.toContain('sameday');
    expect(cancelled).not.toContain('aftervisit');
  });

  it('2. visit created cancels confirmation + old WhatsApp but NOT the after-visit follow-up', () => {
    const cancelled = followupsCancelledBy('visit_created', everyType());
    expect(cancelled).toEqual(expect.arrayContaining(['booking', 'wa', 'noshow', 'confirm', 'sameday']));
    expect(cancelled).not.toContain('aftervisit');
    expect(cancelled).not.toContain('offer');
  });

  it('3. offer created cancels after-visit but NOT the offer follow-up', () => {
    const cancelled = followupsCancelledBy('offer_created', everyType());
    expect(cancelled).toContain('aftervisit');
    expect(cancelled).not.toContain('offer');
    expect(cancelled).not.toContain('respay');
  });

  it('4. reservation created cancels offer follow-up but NOT reservation-payment / financing', () => {
    const cancelled = followupsCancelledBy('reservation_created', everyType());
    expect(cancelled).toContain('offer');
    expect(cancelled).not.toContain('respay');
    expect(cancelled).not.toContain('financing');
  });

  it('5. financing advanced cancels reservation-payment + offer but NOT the financing follow-up', () => {
    const cancelled = followupsCancelledBy('financing_advanced', everyType());
    expect(cancelled).toEqual(expect.arrayContaining(['offer', 'respay']));
    expect(cancelled).not.toContain('financing');
    expect(cancelled).not.toContain('transfer');
  });

  it('6. transfer started cancels the financing follow-up but NOT the ownership-transfer follow-up', () => {
    const cancelled = followupsCancelledBy('transfer_started', everyType());
    expect(cancelled).toContain('financing');
    expect(cancelled).not.toContain('transfer');
  });

  it('7. lost / closed-won / transfer-completed cancel ALL open follow-ups', () => {
    for (const ev of ['client_lost', 'client_closed_won', 'transfer_completed'] as const) {
      const cancelled = followupsCancelledBy(ev, everyType());
      expect(cancelled.sort()).toEqual(everyType().map((f) => f.id).sort());
    }
  });

  it('8. completed / cancelled / skipped / scheduled follow-ups are never touched', () => {
    const rows: SupersedeCandidate[] = [
      fu('done', 'whatsapp_follow_up', 'completed'),
      fu('cancelled', 'whatsapp_follow_up', 'cancelled'),
      fu('skipped', 'whatsapp_follow_up', 'skipped'),
      fu('ratingtimer', 'rating_request', 'scheduled'),
    ];
    expect(followupsCancelledBy('client_lost', rows)).toEqual([]); // even cancel-ALL skips non-open
    expect(followupsCancelledBy('appointment_created', rows)).toEqual([]);
  });

  it('9. multiple obsolete open tasks of the same type are ALL cancelled', () => {
    const rows = [
      fu('wa1', 'whatsapp_follow_up'),
      fu('wa2', 'whatsapp_follow_up'),
      fu('booking1', 'appointment_booking_call'),
    ];
    expect(followupsCancelledBy('appointment_created', rows).sort()).toEqual(['booking1', 'wa1', 'wa2']);
  });

  it('10. the remaining (non-cancelled) open task is the correct next action', () => {
    // After an offer is created, only the offer follow-up should remain open.
    const rows = everyType().filter((f) => ['booking', 'wa', 'aftervisit', 'offer'].includes(f.id));
    const cancelled = new Set(followupsCancelledBy('offer_created', rows));
    const remaining = rows.filter((f) => !cancelled.has(f.id)).map((f) => f.id);
    expect(remaining).toEqual(['offer']);
  });

  it('11. re-running supersede is idempotent (cancelled rows are no longer open)', () => {
    const rows = everyType();
    const firstPass = new Set(followupsCancelledBy('appointment_created', rows));
    // Apply the cancellation, then run again — nothing left to cancel.
    const after = rows.map((f) => (firstPass.has(f.id) ? { ...f, followup_status: 'cancelled' } : f));
    expect(followupsCancelledBy('appointment_created', after)).toEqual([]);
  });

  it('12. a Phase A replied/waiting WhatsApp task is cancelled by any pre-reservation event', () => {
    const replied = [fu('war', 'whatsapp_follow_up', 'open')]; // whatsapp_state is irrelevant to open-ness
    for (const ev of ['appointment_created', 'visit_created', 'offer_created', 'reservation_created'] as const) {
      expect(followupsCancelledBy(ev, replied)).toEqual(['war']);
    }
  });
});

describe('isOpenFollowupStatus mirrors the SQL predicate', () => {
  it('treats null/empty as open, open/in_progress as open, the rest as closed', () => {
    expect(isOpenFollowupStatus(null)).toBe(true);
    expect(isOpenFollowupStatus('')).toBe(true);
    expect(isOpenFollowupStatus('open')).toBe(true);
    expect(isOpenFollowupStatus('in_progress')).toBe(true);
    expect(isOpenFollowupStatus('completed')).toBe(false);
    expect(isOpenFollowupStatus('cancelled')).toBe(false);
    expect(isOpenFollowupStatus('scheduled')).toBe(false);
  });
});

describe('matrix integrity — each non-terminal event keeps its own new task', () => {
  it('never lists the type its workflow creates next', () => {
    const keepsByEvent: Record<string, string> = {
      appointment_created: 'appointment_confirmation_call',
      visit_created: 'follow_up_call_after_visit',
      offer_created: 'offer_follow_up',
      reservation_created: 'financing_follow_up',
      financing_advanced: 'financing_follow_up',
      transfer_started: 'ownership_transfer_follow_up',
    };
    for (const [ev, keep] of Object.entries(keepsByEvent)) {
      const set = SUPERSEDE_MATRIX[ev as keyof typeof SUPERSEDE_MATRIX];
      expect(set === 'ALL' || !set.includes(keep)).toBe(true);
    }
  });
});
