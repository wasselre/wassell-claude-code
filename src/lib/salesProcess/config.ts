// DEFAULT_SALES_PROCESS — the authoritative sales-process recipe.
//
// This is a hardcoded TS constant in v1 (reviewable in PRs, diff-able, and
// type-gated: every stage/status literal below is checked against the generated
// Arabic unions, so a typo is a build error — correction #7's build-time half).
// `getSalesProcessConfig()` is the single accessor a future persisted/Studio-
// editable layer slots into. The config previews what each outcome will do; the
// bound workflows (Phase 5/7) actually execute it — never a second write path.

import type {
  SalesProcessConfig,
  FollowUpTypeConfig,
  FollowUpOutcomeConfig,
  SalesStageConfig,
  FollowUpTypeKey,
} from './types';
import type { OutcomeValue } from './outcomes';
import type { ClientStageValue, ClientStatusValue } from './arabicEnums.generated';
import type { SalesProcessOverride } from '@/types';

// ── small builders for the outcomes that recur with the same shape ───────────

const REQ_ACTUAL = { actual_datetime: true } as const;

/** No-answer retry: same type, +delay days. */
function noAnswer(nextType: FollowUpTypeKey, delayDays = 1): FollowUpOutcomeConfig {
  return {
    value: 'no_answer',
    requires: { ...REQ_ACTUAL },
    client_update_preview: { status: 'لا يوجد رد', note_en: 'No answer — schedule retry', note_ar: 'لا يوجد رد — جدولة محاولة' },
    next_action_preview: { kind: 'create_followup', create_followup_type: nextType, delay_days: delayDays },
  };
}

/**
 * Recontact later: the client is open in principle but not now — for ANY
 * reason. Requires reschedule_contact_date; the rep picks when. Reschedules the
 * same activity.
 *
 * This ABSORBED the retired `wrong_time` outcome on 2026-07-30. The two were
 * indistinguishable in practice: both required a reschedule date and both fired
 * the identical `schedule_recontact` action, so the only difference reaching the
 * client was a status string. Reps did not split them consistently — in a
 * 50-call audit of real completed follow-ups, «اتصل بي بعد نص ساعة، أنا في
 * اجتماع» was filed as recontact_later while «برجع لك» was filed as wrong_time,
 * i.e. exactly backwards from the definitions. Collapsing them removed 4 of 7
 * classification errors outright (86% → 94% agreement with the human label).
 *
 * `wrong_time` is NOT deleted from OUTCOME_CATALOG — ~43 historical follow-ups
 * still carry it and must keep rendering a label. It is simply no longer
 * offered to a rep.
 */
function recontactLater(nextType: FollowUpTypeKey): FollowUpOutcomeConfig {
  return {
    value: 'recontact_later',
    requires: { ...REQ_ACTUAL, reschedule_contact_date: true },
    client_update_preview: { status: 'إعادة تواصل لاحقًا' },
    next_action_preview: { kind: 'schedule_recontact', create_followup_type: nextType, use_field: 'reschedule_contact_date' },
  };
}

/** Terminal not-interested with a required lost reason. */
function notInterested(stage: ClientStageValue, status: ClientStatusValue = 'غير مهتم'): FollowUpOutcomeConfig {
  return {
    value: 'not_interested',
    requires: { ...REQ_ACTUAL, lost_reason: true, outcome_notes: true },
    client_update_preview: { stage, status },
    is_terminal: true,
  };
}

const APPOINTMENT_BOOKED: FollowUpOutcomeConfig = {
  // Owned by the Appointment Created workflow (W3). The Workspace requires an
  // Appointment record to be created+linked; it does NOT move the client here.
  value: 'appointment_booked',
  requires: { ...REQ_ACTUAL, appointment_created: true },
  next_action_preview: { kind: 'book_appointment', note_en: 'Create appointment → confirmation follow-ups', note_ar: 'إنشاء موعد → متابعات تأكيد' },
};

// ── stages (Arabic values, ordered along the lifecycle) ──────────────────────

const STAGES: SalesStageConfig[] = [
  { value: 'جديد', label_ar: 'جديد', label_en: 'New', order: 0, color: '#3B82F6', followup_types: ['appointment_booking_call'] },
  { value: 'الاتصال لحجز موعد', label_ar: 'الاتصال لحجز موعد', label_en: 'Appointment Booking', order: 1, color: '#C09B5F', followup_types: ['appointment_booking_call', 'whatsapp_follow_up'] },
  { value: 'موعد زيارة', label_ar: 'موعد زيارة', label_en: 'Appointment Scheduled', order: 2, color: '#10B981', followup_types: ['appointment_confirmation_call', 'same_day_appointment_confirmation', 'no_show_recovery_call'] },
  { value: 'زيارة', label_ar: 'زيارة', label_en: 'Visit', order: 3, color: '#10B981', followup_types: ['follow_up_call_after_visit'] },
  { value: 'متابعة بعد الزيارة', label_ar: 'متابعة بعد الزيارة', label_en: 'After-Visit Follow-up', order: 4, color: '#C09B5F', followup_types: ['follow_up_call_after_visit'] },
  { value: 'عرض سعر', label_ar: 'عرض سعر', label_en: 'Offer', order: 5, color: '#C09B5F', followup_types: ['offer_follow_up'] },
  { value: 'حجز', label_ar: 'حجز', label_en: 'Reservation', order: 6, color: '#10B981', followup_types: ['reservation_payment_follow_up'] },
  { value: 'تمويل', label_ar: 'تمويل', label_en: 'Financing', order: 7, color: '#C09B5F', followup_types: ['financing_follow_up'] },
  { value: 'الإفراغ', label_ar: 'الإفراغ', label_en: 'Ownership Transfer', order: 8, color: '#C09B5F', followup_types: ['ownership_transfer_follow_up'] },
  { value: 'مغلق ناجح', label_ar: 'مغلق ناجح', label_en: 'Closed Won', order: 9, color: '#10B981', followup_types: [] },
  { value: 'غير مؤهل', label_ar: 'غير مؤهل', label_en: 'Unqualified', order: 10, color: '#6B7280', followup_types: [] },
  { value: 'خاسر', label_ar: 'خاسر', label_en: 'Lost', order: 11, color: '#8E4E3A', followup_types: [] },
];

// ── follow-up types with their per-type outcome matrix ───────────────────────

const FOLLOWUP_TYPES: FollowUpTypeConfig[] = [
  {
    type: 'appointment_booking_call',
    label_ar: 'مكالمة حجز موعد',
    label_en: 'Appointment Booking Call',
    objective_ar: 'حجز موعد زيارة للمشروع',
    objective_en: 'Book a project visit',
    primary_channel: 'call',
    stage: 'الاتصال لحجز موعد',
    context_blocks: ['lead_source', 'campaign', 'preferred_project', 'budget', 'preferred_area', 'preferred_unit_type', 'previous_attempts', 'latest_call_summary', 'latest_whatsapp'],
    preference_summary_fields: ['budget', 'preferred_projects', 'location', 'preferred_unit_type', 'preferred_area', 'preferred_language'],
    script: {
      ar: ['ما المنطقة التي تهمك؟', 'ما نطاق الميزانية المناسب لك؟', 'هل البحث للاستخدام الشخصي أم للاستثمار؟', 'هل يناسبك تحديد موعد زيارة قريبًا؟'],
      en: ['Which area interests you?', 'What budget range are you considering?', 'Personal use or investment?', 'Could we schedule a project visit soon?'],
    },
    allowed_outcomes: [
      APPOINTMENT_BOOKED,
      {
        value: 'interested',
        requires: { ...REQ_ACTUAL },
        client_update_preview: { stage: 'الاتصال لحجز موعد', status: 'مهتم' },
        next_action_preview: { kind: 'create_followup', create_followup_type: 'whatsapp_follow_up', delay_days: 1 },
      },
      noAnswer('appointment_booking_call', 1),
      recontactLater('appointment_booking_call'),
      notInterested('غير مؤهل'),
      { value: 'invalid_number', requires: { ...REQ_ACTUAL, lost_reason: true }, client_update_preview: { stage: 'غير مؤهل', status: 'رقم خاطئ' }, is_terminal: true },
      { value: 'duplicate', requires: { ...REQ_ACTUAL, lost_reason: true }, client_update_preview: { stage: 'غير مؤهل', status: 'مكرر' }, is_terminal: true },
    ],
  },
  {
    type: 'whatsapp_follow_up',
    label_ar: 'متابعة واتساب',
    label_en: 'WhatsApp Follow-up',
    // This is a reply-CHECKPOINT / continuation task, NOT a "send the first
    // project" task — the project is normally already sent during/right after
    // the first call. The rep checks whether the client replied and continues.
    objective_ar: 'متابعة رد العميل على المشروع',
    objective_en: "Follow up on the client's response to the project",
    primary_channel: 'whatsapp',
    stage: 'الاتصال لحجز موعد',
    context_blocks: ['latest_whatsapp', 'suggested_template', 'preference_summary', 'next_recommended'],
    preference_summary_fields: ['budget', 'preferred_projects', 'preferred_unit_type', 'preferred_language'],
    script: {
      ar: [
        'أُرسل المشروع للعميل بعد المكالمة — تحقّق أولاً إن كان قد ردّ.',
        'إن ردّ: أكمل المحادثة وسجّل النتيجة على هذه المهمة.',
        'إن لم يردّ: أرسل رسالة تفقّد — مثال: «السلام عليكم، وش رأيك بالمشروع؟».',
        'إن أعطى تفضيلات جديدة: حدّث تفضيلاته، استخدم الباحث، وأرسل خياراً أنسب.',
      ],
      en: [
        'The project was already sent after the call — first check whether the client replied.',
        'If they replied: continue the conversation and record the outcome on this task.',
        'If not: send a check-in — e.g. "Hi, what did you think of the project?".',
        'If preferences changed: update them, use Project Finder, and send a better option.',
      ],
    },
    // FOLLOWUP_3: sending a WhatsApp is an ACTION (the Workspace puts the
    // follow-up into a waiting state — whatsapp_state='message_sent_waiting_response'),
    // NOT an outcome. These are the REAL customer-response outcomes the rep
    // records after a reply. `message_sent`/`message_replied` are no longer
    // selectable (message_sent is reused as the whatsapp_state send marker);
    // `no_response` is written by the escalation workflow, not picked here.
    allowed_outcomes: [
      {
        value: 'interested',
        requires: { ...REQ_ACTUAL },
        warn: ['completed_by_chat_id'],
        client_update_preview: { status: 'مهتم' },
        next_action_preview: { kind: 'create_followup', create_followup_type: 'whatsapp_follow_up', delay_days: 5 },
      },
      APPOINTMENT_BOOKED,
      {
        value: 'request_offer',
        requires: { ...REQ_ACTUAL },
        warn: ['completed_by_chat_id'],
        client_update_preview: { stage: 'عرض سعر', status: 'تم طلب عرض سعر' },
        next_action_preview: { kind: 'none', note_en: 'Offer follow-up is created in the offer stage', note_ar: 'تُنشأ متابعة العرض في مرحلة العرض' },
      },
      {
        // Client replied "recontact later" — only offered after the client has
        // actually responded (gated in the OutcomePanel to the reply phase).
        value: 'recontact_later',
        requires: { ...REQ_ACTUAL, reschedule_contact_date: true },
        client_update_preview: { status: 'إعادة تواصل لاحقًا' },
        next_action_preview: { kind: 'schedule_recontact', create_followup_type: 'whatsapp_follow_up', use_field: 'reschedule_contact_date' },
      },
      notInterested('غير مؤهل'),
      {
        // The rep deliberately did NOT send a message. A pre-reply action (shown
        // before any customer response). Requires a reason (notes) + the next
        // contact date; the workflow schedules the next WhatsApp on that date.
        // 'wrong_time' was removed from WhatsApp — this is its honest replacement
        // for "not the right moment to message".
        value: 'no_message_sent',
        requires: { ...REQ_ACTUAL, outcome_notes: true, reschedule_contact_date: true },
        next_action_preview: { kind: 'schedule_recontact', create_followup_type: 'whatsapp_follow_up', use_field: 'reschedule_contact_date', note_en: 'No message sent — schedule the next WhatsApp on the chosen date', note_ar: 'لم تُرسل رسالة — جدولة متابعة واتساب في التاريخ المحدد' },
      },
    ],
  },
  {
    type: 'appointment_confirmation_call',
    label_ar: 'مكالمة تأكيد الموعد',
    label_en: 'Appointment Confirmation Call',
    objective_ar: 'ضمان حضور العميل للموعد',
    objective_en: 'Ensure the client attends the appointment',
    primary_channel: 'call',
    stage: 'موعد زيارة',
    context_blocks: ['appointment', 'project_location', 'appointment_status', 'sales_rep', 'previous_confirmations'],
    preference_summary_fields: ['preferred_projects', 'preferred_language'],
    script: {
      ar: ['تأكيد تاريخ ووقت الموعد', 'تأكيد اسم المشروع وموقعه', 'هل تحتاج إلى الاتجاهات؟'],
      en: ['Confirm the appointment date and time', 'Confirm the project name and location', 'Do you need directions?'],
    },
    allowed_outcomes: [
      { value: 'attendance_confirmed', requires: { ...REQ_ACTUAL, appointment_id: true }, client_update_preview: { stage: 'موعد زيارة', status: 'تم تأكيد الحضور' }, next_action_preview: { kind: 'none' } },
      {
        value: 'no_answer',
        requires: { ...REQ_ACTUAL, appointment_id: true },
        client_update_preview: { status: 'لا يوجد رد' },
        next_action_preview: { kind: 'create_followup', create_followup_type: 'appointment_confirmation_call', delay_days: 0, note_en: 'WhatsApp reminder + retry if not same-day', note_ar: 'تذكير واتساب + إعادة محاولة إن لم يكن نفس اليوم' },
      },
      {
        value: 'rescheduled',
        requires: { ...REQ_ACTUAL, appointment_id: true, new_appointment_datetime: true },
        client_update_preview: { status: 'تمت إعادة الجدولة' },
        next_action_preview: { kind: 'book_appointment', use_field: 'new_appointment_datetime', note_en: 'Update appointment + new confirmations', note_ar: 'تحديث الموعد + متابعات تأكيد جديدة' },
      },
      {
        value: 'appointment_cancelled_rebook',
        requires: { ...REQ_ACTUAL, appointment_id: true, outcome_notes: true },
        client_update_preview: { status: 'تم إلغاء الموعد' },
        next_action_preview: { kind: 'create_followup', create_followup_type: 'appointment_booking_call', delay_days: 0 },
      },
      {
        value: 'appointment_cancelled_lost',
        requires: { ...REQ_ACTUAL, appointment_id: true, lost_reason: true },
        client_update_preview: { stage: 'غير مؤهل', status: 'تم إلغاء الموعد' },
        is_terminal: true,
      },
      recontactLater('appointment_confirmation_call'),
      notInterested('غير مؤهل'),
    ],
  },
  {
    // Same-day confirmation shares the confirmation outcome set.
    type: 'same_day_appointment_confirmation',
    label_ar: 'تأكيد الموعد في نفس اليوم',
    label_en: 'Same-Day Appointment Confirmation',
    objective_ar: 'تأكيد الحضور في يوم الموعد',
    objective_en: 'Confirm attendance on the appointment day',
    primary_channel: 'call',
    stage: 'موعد زيارة',
    context_blocks: ['appointment', 'project_location', 'appointment_status', 'sales_rep'],
    preference_summary_fields: ['preferred_projects'],
    allowed_outcomes: [
      { value: 'attendance_confirmed', requires: { ...REQ_ACTUAL, appointment_id: true }, client_update_preview: { stage: 'موعد زيارة', status: 'تم تأكيد الحضور' }, next_action_preview: { kind: 'none' } },
      { value: 'no_answer', requires: { ...REQ_ACTUAL, appointment_id: true }, client_update_preview: { status: 'لا يوجد رد' }, next_action_preview: { kind: 'none', note_en: 'Same-day — keep appointment, flag risk', note_ar: 'نفس اليوم — إبقاء الموعد مع الإشارة للخطورة' } },
      { value: 'rescheduled', requires: { ...REQ_ACTUAL, appointment_id: true, new_appointment_datetime: true }, client_update_preview: { status: 'تمت إعادة الجدولة' }, next_action_preview: { kind: 'book_appointment', use_field: 'new_appointment_datetime' } },
      { value: 'appointment_cancelled_lost', requires: { ...REQ_ACTUAL, appointment_id: true, lost_reason: true }, client_update_preview: { stage: 'غير مؤهل', status: 'تم إلغاء الموعد' }, is_terminal: true },
    ],
  },
  {
    type: 'no_show_recovery_call',
    label_ar: 'مكالمة استرجاع بعد عدم الحضور',
    label_en: 'No-Show Recovery Call',
    objective_ar: 'استرجاع العملاء الذين فاتهم الموعد',
    objective_en: 'Recover clients who missed the appointment',
    primary_channel: 'call',
    stage: 'موعد زيارة',
    context_blocks: ['missed_appointment_date', 'appointment', 'previous_confirmations', 'reschedule_suggestion'],
    preference_summary_fields: ['preferred_projects', 'budget'],
    allowed_outcomes: [
      { value: 'rescheduled', requires: { ...REQ_ACTUAL, new_appointment_datetime: true }, client_update_preview: { status: 'تمت إعادة الجدولة' }, next_action_preview: { kind: 'book_appointment', use_field: 'new_appointment_datetime' } },
      { value: 'still_interested', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'مهتم' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'appointment_booking_call', delay_days: 0 } },
      notInterested('غير مؤهل'),
      noAnswer('no_show_recovery_call', 1),
      recontactLater('no_show_recovery_call'),
    ],
  },
  {
    type: 'follow_up_call_after_visit',
    label_ar: 'مكالمة متابعة بعد الزيارة',
    label_en: 'After-Visit Follow-up',
    objective_ar: 'نقل العميل من الزيارة إلى طلب عرض السعر',
    objective_en: 'Move the client from visit to offer request',
    primary_channel: 'call',
    stage: 'متابعة بعد الزيارة',
    context_blocks: ['visited_project', 'visit_date', 'visited_units', 'customer_feedback', 'budget', 'objections', 'offer_readiness'],
    preference_summary_fields: ['budget', 'preferred_projects', 'preferred_unit_type'],
    allowed_outcomes: [
      { value: 'request_offer', requires: { ...REQ_ACTUAL, outcome_notes: true }, client_update_preview: { stage: 'عرض سعر', status: 'تم طلب عرض سعر' }, next_action_preview: { kind: 'create_offer', note_en: 'Create/open offer + offer follow-up', note_ar: 'إنشاء/فتح عرض سعر + متابعة العرض' } },
      { value: 'still_interested', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'مهتم' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'follow_up_call_after_visit', delay_days: 2 } },
      { value: 'needs_financing_info', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'يحتاج معلومات تمويل' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'follow_up_call_after_visit', delay_days: 2, note_en: 'Send financing info on WhatsApp', note_ar: 'إرسال معلومات التمويل عبر واتساب' } },
      { value: 'family_discussion', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'نقاش عائلي' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'follow_up_call_after_visit', delay_days: 3 } },
      // Wants to come again → re-enter the booking cycle (a fresh booking call).
      { value: 'requested_another_visit', requires: { ...REQ_ACTUAL }, client_update_preview: { stage: 'الاتصال لحجز موعد', status: 'مهتم' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'appointment_booking_call', delay_days: 0, note_en: 'Re-enter the booking cycle', note_ar: 'إعادة الدخول لدورة حجز الموعد' } },
      // Visited a different project → at-risk; NOT auto-lost. A Sales-Manager
      // review task gives the at-risk lead an explicit owner (assignment is set
      // in the workflow + editable via the Studio assignments overlay).
      { value: 'visited_other_project', requires: { ...REQ_ACTUAL, outcome_notes: true }, client_update_preview: { status: 'زار مشروعًا آخر — للمراجعة' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'follow_up_call_after_visit', delay_days: 1, note_en: 'Manager review task (keep nurturing)', note_ar: 'مهمة مراجعة للمدير (الاستمرار في المتابعة)' } },
      // Call later → reschedule the after-visit call to the chosen date.
      { value: 'recontact_later', requires: { ...REQ_ACTUAL, reschedule_contact_date: true }, client_update_preview: { status: 'إعادة تواصل لاحقًا' }, next_action_preview: { kind: 'schedule_recontact', create_followup_type: 'follow_up_call_after_visit', use_field: 'reschedule_contact_date' } },
      // Wrong number / unreachable → terminal (unqualified).
      { value: 'invalid_number', requires: { ...REQ_ACTUAL, lost_reason: true }, client_update_preview: { stage: 'غير مؤهل', status: 'رقم خاطئ' }, is_terminal: true },
      notInterested('خاسر'),
      noAnswer('follow_up_call_after_visit', 1),
    ],
  },
  {
    type: 'offer_follow_up',
    label_ar: 'متابعة عرض السعر',
    label_en: 'Offer Follow-up',
    objective_ar: 'تحويل العرض إلى دفعة حجز',
    objective_en: 'Convert the offer into a reservation payment',
    primary_channel: 'call',
    stage: 'عرض سعر',
    context_blocks: ['offer_details', 'preference_summary'],
    preference_summary_fields: ['budget', 'preferred_projects'],
    allowed_outcomes: [
      { value: 'offer_accepted', requires: { ...REQ_ACTUAL }, client_update_preview: { stage: 'حجز', status: 'بانتظار دفعة الحجز' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'reservation_payment_follow_up', delay_days: 1 } },
      { value: 'waiting_decision', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'بانتظار القرار' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'offer_follow_up', delay_days: 2 } },
      { value: 'needs_financing_info', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'يحتاج معلومات تمويل' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'offer_follow_up', delay_days: 2 } },
      { value: 'offer_rejected', requires: { ...REQ_ACTUAL, lost_reason: true }, client_update_preview: { stage: 'خاسر', status: 'تم رفض العرض' }, is_terminal: true },
      noAnswer('offer_follow_up', 1),
      recontactLater('offer_follow_up'),
    ],
  },
  {
    type: 'reservation_payment_follow_up',
    label_ar: 'متابعة دفعة الحجز',
    label_en: 'Reservation Payment Follow-up',
    objective_ar: 'تأكيد استلام دفعة الحجز والانتقال للتمويل',
    objective_en: 'Confirm the reservation payment and move to financing',
    primary_channel: 'call',
    stage: 'حجز',
    context_blocks: ['offer_details'],
    preference_summary_fields: ['preferred_projects'],
    allowed_outcomes: [
      { value: 'payment_received', requires: { ...REQ_ACTUAL }, client_update_preview: { stage: 'تمويل', status: 'تم الحجز' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'financing_follow_up', delay_days: 1 } },
      { value: 'payment_pending', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'بانتظار دفعة الحجز' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'reservation_payment_follow_up', delay_days: 2 } },
      noAnswer('reservation_payment_follow_up', 1),
      recontactLater('reservation_payment_follow_up'),
    ],
  },
  {
    type: 'financing_follow_up',
    label_ar: 'متابعة التمويل',
    label_en: 'Financing Follow-up',
    objective_ar: 'متابعة مراحل التمويل البنكي حتى الإفراغ',
    objective_en: 'Track financing stages toward title transfer',
    primary_channel: 'call',
    stage: 'تمويل',
    context_blocks: ['preference_summary'],
    preference_summary_fields: ['preferred_projects'],
    allowed_outcomes: [
      { value: 'documents_pending', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'البنك' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'financing_follow_up', delay_days: 2 } },
      { value: 'payment_received', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'التقييم' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'financing_follow_up', delay_days: 3 } },
      { value: 'waiting_decision', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'البنك' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'financing_follow_up', delay_days: 2 } },
      noAnswer('financing_follow_up', 1),
      recontactLater('financing_follow_up'),
    ],
  },
  {
    type: 'ownership_transfer_follow_up',
    label_ar: 'متابعة الإفراغ',
    label_en: 'Ownership Transfer Follow-up',
    objective_ar: 'إتمام نقل الملكية (الإفراغ) وإغلاق الصفقة',
    objective_en: 'Complete the title transfer and close the deal',
    primary_channel: 'call',
    stage: 'الإفراغ',
    context_blocks: ['preference_summary'],
    preference_summary_fields: ['preferred_projects'],
    allowed_outcomes: [
      { value: 'documents_pending', requires: { ...REQ_ACTUAL }, client_update_preview: { status: 'تم إصدار نموذج الإفراغ' }, next_action_preview: { kind: 'create_followup', create_followup_type: 'ownership_transfer_follow_up', delay_days: 2 } },
      { value: 'payment_received', requires: { ...REQ_ACTUAL }, client_update_preview: { stage: 'مغلق ناجح', status: 'تم الإفراغ' }, is_terminal: true },
      noAnswer('ownership_transfer_follow_up', 1),
    ],
  },
];

export const DEFAULT_SALES_PROCESS: SalesProcessConfig = {
  stages: STAGES,
  followup_types: FOLLOWUP_TYPES,
};

// ── accessors ────────────────────────────────────────────────────────────────

/** The single seam a future persisted/Studio-editable config slots into. */
export function getSalesProcessConfig(): SalesProcessConfig {
  return DEFAULT_SALES_PROCESS;
}

/**
 * Parse a newline-separated call-guidance override into trimmed bullet lines.
 * Returns undefined for a null/blank override so the caller falls back to the
 * hardcoded default script (a partial override never blanks the guidance).
 */
function parseScriptOverride(raw: string | null | undefined): string[] | undefined {
  if (typeof raw !== 'string') return undefined;
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines : undefined;
}

/**
 * Merge manager-edited instruction overrides over the hardcoded config — the
 * objective text (mission Goal) AND the call-guidance script (Call Guidance
 * panel) per follow-up type. A null/blank override field falls back to the
 * default, so a partially-filled override never blanks the instruction. Keyed
 * by override.id === FollowUpTypeConfig.type. Returns the base unchanged when
 * there are no overrides (cheap common case).
 */
export function applyOverridesToConfig(
  overrides: SalesProcessOverride[] | undefined,
  base: SalesProcessConfig = DEFAULT_SALES_PROCESS,
): SalesProcessConfig {
  if (!overrides || overrides.length === 0) return base;
  const byType = new Map(overrides.map((o) => [o.id, o]));
  return {
    ...base,
    followup_types: base.followup_types.map((t) => {
      const o = byType.get(t.type);
      if (!o) return t;
      const scriptAr = parseScriptOverride(o.script_ar);
      const scriptEn = parseScriptOverride(o.script_en);
      const script =
        scriptAr || scriptEn
          ? { ar: scriptAr ?? t.script?.ar ?? [], en: scriptEn ?? t.script?.en ?? [] }
          : t.script;
      return {
        ...t,
        objective_ar: o.objective_ar?.trim() ? o.objective_ar : t.objective_ar,
        objective_en: o.objective_en?.trim() ? o.objective_en : t.objective_en,
        script,
      };
    }),
  };
}

/** Localized label for a follow-up primary channel. */
export function channelLabel(channel: string | undefined, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    call: { ar: 'مكالمة', en: 'Call' },
    whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
    manual: { ar: 'يدوي', en: 'Manual' },
  };
  const e = channel ? map[channel] : undefined;
  return e ? (isAr ? e.ar : e.en) : (channel ?? '');
}

export function getFollowUpTypeConfig(
  type: string | null | undefined,
  config: SalesProcessConfig = DEFAULT_SALES_PROCESS,
): FollowUpTypeConfig | undefined {
  if (!type) return undefined;
  return config.followup_types.find((t) => t.type === type);
}

export function getOutcomeConfig(
  type: string | null | undefined,
  outcomeValue: string | null | undefined,
  config: SalesProcessConfig = DEFAULT_SALES_PROCESS,
): FollowUpOutcomeConfig | undefined {
  if (!outcomeValue) return undefined;
  return getFollowUpTypeConfig(type, config)?.allowed_outcomes.find((o) => o.value === outcomeValue);
}

export function getStageConfig(
  stage: string | null | undefined,
  config: SalesProcessConfig = DEFAULT_SALES_PROCESS,
): SalesStageConfig | undefined {
  if (!stage) return undefined;
  return config.stages.find((s) => s.value === stage);
}

/**
 * Every stage/status/outcome value the config references — fed to
 * assertSalesProcessEnums() so a drift between the config and the live model
 * options fails loudly (correction #7's runtime half).
 */
export function collectConfigEnumRefs(config: SalesProcessConfig = DEFAULT_SALES_PROCESS): {
  stages: ClientStageValue[];
  statuses: ClientStatusValue[];
  outcomes: OutcomeValue[];
} {
  const stages = new Set<ClientStageValue>();
  const statuses = new Set<ClientStatusValue>();
  const outcomes = new Set<OutcomeValue>();
  for (const stage of config.stages) stages.add(stage.value);
  for (const type of config.followup_types) {
    for (const outcome of type.allowed_outcomes) {
      outcomes.add(outcome.value);
      if (outcome.client_update_preview?.stage) stages.add(outcome.client_update_preview.stage);
      if (outcome.client_update_preview?.status) statuses.add(outcome.client_update_preview.status);
    }
  }
  return { stages: [...stages], statuses: [...statuses], outcomes: [...outcomes] };
}
