// Sales-process OUTCOME CATALOG — the single source of truth for every
// `call_result` (follow-up outcome) value the sales operating system can save.
//
// WHY THIS FILE EXISTS
//   The custom Follow-up Workspace, the sales-process config (DEFAULT_SALES_PROCESS),
//   the validators, and the model's `call_result` dropdown options must ALL agree
//   on the same set of outcome values. This catalog is that set. The Phase-1
//   migration appends every value here to the live `followups.call_result` options,
//   and `assertSalesProcessEnums()` fails loudly if the config ever references an
//   outcome that isn't in this catalog (and therefore can't be stored). Append-only:
//   the `value` strings are stable API names — never rename one that records use.
//
// Tone drives the outcome-button color in the Workspace (positive = green,
// neutral = gold, negative = red), matching the Wassel design system.

export type OutcomeTone = 'positive' | 'neutral' | 'negative';

export interface OutcomeCatalogEntry {
  /** Stable API value stored on `followups.call_result`. snake_case, never renamed. */
  value: string;
  label_ar: string;
  label_en: string;
  tone: OutcomeTone;
}

export const OUTCOME_CATALOG: readonly OutcomeCatalogEntry[] = [
  // --- existing live values (already in the model's call_result options) ---
  { value: 'interested', label_ar: 'مهتم', label_en: 'Interested', tone: 'positive' },
  { value: 'not_interested', label_ar: 'غير مهتم', label_en: 'Not Interested', tone: 'negative' },
  { value: 'no_answer', label_ar: 'لا يوجد رد', label_en: 'No Answer', tone: 'neutral' },
  // RETIRED 2026-07-30 — folded into `recontact_later`, which requires the same
  // reschedule date and fires the same `schedule_recontact` action. No longer in
  // any type's `allowed_outcomes`, so a rep cannot pick it; kept here (append-
  // only rule) because ~43 historical follow-ups still store it and the table,
  // the generic form, and reporting all need a label for those rows.
  { value: 'wrong_time', label_ar: 'الوقت غير مناسب', label_en: 'Wrong Time', tone: 'neutral' },
  { value: 'appointment_booked', label_ar: 'تم حجز موعد', label_en: 'Appointment Booked', tone: 'positive' },
  { value: 'rescheduled', label_ar: 'تمت إعادة الجدولة', label_en: 'Rescheduled', tone: 'neutral' },
  { value: 'attendance_confirmed', label_ar: 'تم تأكيد الحضور', label_en: 'Attendance Confirmed', tone: 'positive' },
  { value: 'appointment_cancelled', label_ar: 'تم إلغاء الموعد', label_en: 'Appointment Cancelled', tone: 'negative' },
  { value: 'recontact_later', label_ar: 'إعادة تواصل لاحقًا', label_en: 'Recontact Later', tone: 'neutral' },
  // --- new values appended by the Phase-1 migration ---
  { value: 'invalid_number', label_ar: 'رقم خاطئ', label_en: 'Invalid Number', tone: 'negative' },
  { value: 'duplicate', label_ar: 'مكرر', label_en: 'Duplicate', tone: 'negative' },
  { value: 'message_sent', label_ar: 'تم إرسال الرسالة', label_en: 'Message Sent', tone: 'neutral' }, // legacy — no longer a selectable outcome (see whatsapp_state)
  { value: 'message_replied', label_ar: 'تم الرد', label_en: 'Message Replied', tone: 'positive' }, // legacy — replaced by the real response outcomes
  { value: 'no_response', label_ar: 'لا يوجد رد', label_en: 'No Response', tone: 'neutral' }, // auto-set by the WhatsApp no-response escalation workflow
  { value: 'request_offer', label_ar: 'طلب عرض سعر', label_en: 'Request Offer', tone: 'positive' },
  { value: 'still_interested', label_ar: 'لا يزال مهتمًا', label_en: 'Still Interested', tone: 'positive' },
  { value: 'needs_financing_info', label_ar: 'يحتاج معلومات تمويل', label_en: 'Needs Financing Info', tone: 'neutral' },
  { value: 'family_discussion', label_ar: 'نقاش عائلي', label_en: 'Family Discussion', tone: 'neutral' },
  { value: 'offer_accepted', label_ar: 'قبول العرض', label_en: 'Offer Accepted', tone: 'positive' },
  { value: 'offer_rejected', label_ar: 'رفض العرض', label_en: 'Offer Rejected', tone: 'negative' },
  { value: 'waiting_decision', label_ar: 'بانتظار القرار', label_en: 'Waiting Decision', tone: 'neutral' },
  { value: 'payment_pending', label_ar: 'بانتظار الدفع', label_en: 'Payment Pending', tone: 'neutral' },
  { value: 'payment_received', label_ar: 'تم استلام الدفعة', label_en: 'Payment Received', tone: 'positive' },
  { value: 'documents_pending', label_ar: 'بانتظار المستندات', label_en: 'Documents Pending', tone: 'neutral' },
  { value: 'appointment_cancelled_rebook', label_ar: 'إلغاء الموعد - إعادة حجز', label_en: 'Cancelled — Rebook', tone: 'neutral' },
  { value: 'appointment_cancelled_lost', label_ar: 'إلغاء الموعد - خسارة', label_en: 'Cancelled — Lost', tone: 'negative' },
  // --- after-visit cycle outcomes (appended by the 2026-06-21 migration) ---
  { value: 'requested_another_visit', label_ar: 'طلب زيارة أخرى', label_en: 'Requested Another Visit', tone: 'positive' },
  { value: 'visited_other_project', label_ar: 'زار مشروعًا آخر', label_en: 'Visited Another Project', tone: 'negative' },
  // --- WhatsApp: the rep deliberately did NOT send a message (reason + next date required) ---
  { value: 'no_message_sent', label_ar: 'لم تُرسل رسالة', label_en: 'No Message Sent', tone: 'neutral' },
  // --- 'wants rent' terminal classification (2026-09-03): the client wants a
  // RENTAL, which Wassel does not currently offer. Classifies + stops all
  // follow-up (like not_interested), but as its own status so rent-seekers stay
  // countable and re-engageable if rentals ever launch. ---
  { value: 'wants_rent', label_ar: 'يريد إيجار', label_en: 'Wants Rent', tone: 'negative' },
] as const;

export type OutcomeValue = (typeof OUTCOME_CATALOG)[number]['value'];

/** Set of every catalog value, for fast membership / superset checks. */
export const OUTCOME_VALUES: readonly string[] = OUTCOME_CATALOG.map((o) => o.value);

const OUTCOME_BY_VALUE = new Map(OUTCOME_CATALOG.map((o) => [o.value, o]));

export function getOutcome(value: string | null | undefined): OutcomeCatalogEntry | undefined {
  if (!value) return undefined;
  return OUTCOME_BY_VALUE.get(value);
}
