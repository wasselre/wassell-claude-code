// Phase B — the canonical supersede policy.
//
// This is the SINGLE SOURCE describing which OPEN follow-up types a stronger
// lifecycle event cancels. It is mirrored 1:1 by the SQL reconciler
// `reconcile_superseded_followups` in
// supabase/migrations/2026-07-04_supersede_followups.sql — the SQL is what
// actually runs (server-side trigger, covers every write path); this module is
// the human-readable policy + the thing the unit tests assert against, so drift
// between the two is caught in review. KEEP THE TWO IN SYNC.

export type SupersedeEvent =
  | 'appointment_created'
  | 'visit_created'
  | 'offer_created'
  | 'reservation_created'
  | 'financing_advanced'
  | 'transfer_started'
  | 'transfer_completed'
  | 'client_closed_won'
  | 'client_lost';

/**
 * Follow-up types each event cancels. `'ALL'` = cancel every open follow-up
 * (terminal events). Each non-terminal set intentionally EXCLUDES the type the
 * event's own workflow creates next (e.g. appointment_created excludes the
 * confirmation types), so the new next-task is never superseded.
 */
export const SUPERSEDE_MATRIX: Record<SupersedeEvent, readonly string[] | 'ALL'> = {
  appointment_created: [
    'appointment_booking_call', 'whatsapp_follow_up', 'no_show_recovery_call',
  ],
  visit_created: [
    'appointment_booking_call', 'whatsapp_follow_up', 'no_show_recovery_call',
    'appointment_confirmation_call', 'same_day_appointment_confirmation',
  ],
  offer_created: [
    'appointment_booking_call', 'whatsapp_follow_up', 'no_show_recovery_call',
    'appointment_confirmation_call', 'same_day_appointment_confirmation',
    'follow_up_call_after_visit',
  ],
  reservation_created: [
    'appointment_booking_call', 'whatsapp_follow_up', 'no_show_recovery_call',
    'appointment_confirmation_call', 'same_day_appointment_confirmation',
    'follow_up_call_after_visit', 'offer_follow_up',
  ],
  financing_advanced: [
    'appointment_booking_call', 'whatsapp_follow_up', 'no_show_recovery_call',
    'appointment_confirmation_call', 'same_day_appointment_confirmation',
    'follow_up_call_after_visit', 'offer_follow_up', 'reservation_payment_follow_up',
  ],
  transfer_started: [
    'appointment_booking_call', 'whatsapp_follow_up', 'no_show_recovery_call',
    'appointment_confirmation_call', 'same_day_appointment_confirmation',
    'follow_up_call_after_visit', 'offer_follow_up', 'reservation_payment_follow_up',
    'financing_follow_up',
  ],
  transfer_completed: 'ALL',
  client_closed_won: 'ALL',
  client_lost: 'ALL',
};

/** Open = not done. Mirrors the SQL predicate COALESCE(NULLIF(status,''),'open') IN (open,in_progress). */
export function isOpenFollowupStatus(status: string | null | undefined): boolean {
  const v = (status ?? '').trim();
  if (v === '') return true; // null/'' → open (legacy workflow-created rows)
  return v === 'open' || v === 'in_progress';
}

export interface SupersedeCandidate {
  id: string;
  followup_type: string[] | string;
  followup_status?: string | null;
}

/**
 * Given an event and a client's follow-ups, return the ids supersede would
 * cancel. Pure — the unit-test oracle and a reference for any UI that explains
 * "why cancelled". Matches the SQL: open-only, array-or-scalar type overlap.
 */
export function followupsCancelledBy(
  event: SupersedeEvent,
  followups: readonly SupersedeCandidate[],
): string[] {
  const set = SUPERSEDE_MATRIX[event];
  return followups
    .filter((f) => {
      if (!isOpenFollowupStatus(f.followup_status)) return false; // never touch completed/cancelled/skipped/scheduled
      if (set === 'ALL') return true;
      const types = Array.isArray(f.followup_type) ? f.followup_type : [f.followup_type];
      return types.some((t) => set.includes(t));
    })
    .map((f) => f.id);
}
