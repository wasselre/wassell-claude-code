#!/usr/bin/env node
/**
 * build-sales-lifecycle-workflows.mjs
 * ----------------------------------------------------------------------------
 * Reviewable builders for the Sales Lifecycle automation workflows (W4–W7).
 * Each builder is parameterized by model/group ids so the SAME logic produces
 * the PROD workflow (real ids) and the dev-test variant (offline-store ids) —
 * only the ids differ, the branch/condition/action logic is identical. Action
 * shapes are copied verbatim from the live "Appointment booked via call" (W3)
 * dump so they match exactly what the engine expects.
 *
 * USAGE:  node scripts/build-sales-lifecycle-workflows.mjs w4
 *   -> writes supabase/migrations/2026-06-17_sales_os_<wf>.sql (INSERT, DISABLED)
 *      and tmp/<wf>.json (the workflow object, for dev-engine testing).
 * ----------------------------------------------------------------------------
 */
import { randomUUID as U } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROD_IDS = {
  followups: '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63',
  appointments: 'b032a675-6237-4436-9783-a1a253855f74',
  clients: '2e86f197-385f-4853-908f-b4cb7237f7d8',
  visits: '372ed642-3753-40b4-9dd7-e8390f91b1f8',
  // Phase 7 downstream models (created by 2026-06-17_sales_os_downstream_models.sql)
  offer_prices: '5a1e0ffe-0000-4000-8000-000000000001',
  reservations: '5a1e0ffe-0000-4000-8000-000000000002',
  financing: '5a1e0ffe-0000-4000-8000-000000000003',
  ownership_transfer: '5a1e0ffe-0000-4000-8000-000000000004',
  group: 'f1e1d1c1-5a1e-4000-8000-000000000001', // Sales Lifecycle
};

// ── shared mapping/action/condition helpers (verbatim shapes from live W3) ────
const mStatic = (target, val) => ({ id: U(), source_type: 'static', static_value: val, target_field_id: target, trigger_field_id: '' });
const mTrigger = (target, from) => ({ id: U(), source_type: 'trigger_field', static_value: '', target_field_id: target, trigger_field_id: from });
const mDate = (target, expr, baseField) => ({ id: U(), source_type: 'date_expression', static_value: '', date_expression: expr, date_base: baseField ? 'trigger_field' : 'current_date', ...(baseField ? { date_base_field_id: baseField } : {}), target_field_id: target, trigger_field_id: '' });
const updateRecord = (modelId, filterTriggerField, maps) => ({ id: U(), type: 'update_record', filter_value: '', field_mappings: maps, filter_field_id: 'id', target_model_id: modelId, filter_value_source: 'trigger_field', filter_trigger_field_id: filterTriggerField });
const createRecord = (modelId, maps) => ({ id: U(), type: 'create_record', field_mappings: maps, skip_if_exists: false, target_model_id: modelId });
const whatsapp = (body) => ({ id: U(), to: { kind: 'lookup', lookup_field_name: 'client_id', target_phone_field_name: 'phone_number' }, type: 'send_whatsapp_message', body_template: body });
const mRecordId = (target) => ({ id: U(), source_type: 'record_id', static_value: '', target_field_id: target, trigger_field_id: '' });

const REMINDER = 'عزيزنا عميل وصل العقارية، نذكّركم بموعد زيارتكم المجدول. نتطلّع لحضوركم، ولأي استفسار يسعدنا تواصلكم معنا.';

// ── W4 — Confirmation Completed ───────────────────────────────────────────────
export function buildW4(ids) {
  const { followups, appointments, clients, group } = ids;
  const updateAppt = (maps) => updateRecord(appointments, 'appointment_id', maps);
  const updateClient = (maps) => updateRecord(clients, 'client_id', maps);
  const createFollowup = (maps) => createRecord(followups, maps);
  // every branch self-contains the global gate + its own call_result value
  const gcond = (cr) => ([
    { id: U(), value: ['appointment_confirmation_call'], field_id: 'followup_type', operator: 'equals' },
    { id: U(), value: '', field_id: 'appointment_id', operator: 'is_not_empty' },
    { id: U(), value: '', field_id: 'actual_datetime', operator: 'is_not_empty' },
    { id: U(), value: cr, field_id: 'call_result', operator: 'equals', only_on_change: true },
  ]);
  const br = (label_en, label_ar, cr, actions) => ({ id: U(), label_en, label_ar, conditions: gcond(cr), condition_mode: 'all', actions });

  const branches = [
    br('Attendance Confirmed', 'تم تأكيد الحضور', 'attendance_confirmed', [
      updateAppt([mStatic('appointment_status', 'confirmed')]),
      updateClient([mStatic('client_stage', 'موعد زيارة'), mStatic('client_status', 'تم تأكيد الحضور')]),
    ]),
    // CORRECTION: no_answer sends a reminder only — it must NOT overwrite the
    // client status with the booking-call value "لا يوجد رد" (would pollute
    // confirmation reporting). The log + appointment carry the signal.
    br('No Answer', 'لا يوجد رد', 'no_answer', [whatsapp(REMINDER)]),
    br('Rescheduled', 'تمت إعادة الجدولة', 'rescheduled', [
      updateAppt([mStatic('appointment_status', 'rescheduled'), mTrigger('appointment_date', 'new_appointment_datetime')]),
      updateClient([mStatic('client_status', 'تمت إعادة الجدولة')]),
      createFollowup([
        mTrigger('client_id', 'client_id'),
        mStatic('followup_type', 'appointment_confirmation_call'),
        mTrigger('appointment_id', 'appointment_id'),
        mDate('scheduled_datetime', '-1d @10:00', 'new_appointment_datetime'),
        mStatic('followup_status', 'open'),
      ]),
    ]),
    br('Cancelled — Rebook', 'إلغاء الموعد - إعادة حجز', 'appointment_cancelled_rebook', [
      updateAppt([mStatic('appointment_status', 'cancelled')]),
      updateClient([mStatic('client_status', 'تم إلغاء الموعد')]),
      createFollowup([
        mTrigger('client_id', 'client_id'),
        mStatic('followup_type', 'appointment_booking_call'),
        mDate('scheduled_datetime', '+0d', ''),
        mStatic('followup_status', 'open'),
        mStatic('followup_number', 1),
      ]),
    ]),
    br('Cancelled — Lost', 'إلغاء الموعد - خسارة', 'appointment_cancelled_lost', [
      updateAppt([mStatic('appointment_status', 'cancelled')]),
      updateClient([mStatic('client_stage', 'غير مؤهل'), mStatic('client_status', 'تم إلغاء الموعد')]),
    ]),
    br('Wrong Time', 'الوقت غير مناسب', 'wrong_time', [
      updateClient([mStatic('client_status', 'الوقت غير مناسب')]),
      createFollowup([
        mTrigger('client_id', 'client_id'),
        mStatic('followup_type', 'appointment_confirmation_call'),
        mTrigger('appointment_id', 'appointment_id'),
        mDate('scheduled_datetime', '+0d', 'reschedule_contact_date'),
        mStatic('followup_status', 'open'),
      ]),
    ]),
    br('Not Interested', 'غير مهتم', 'not_interested', [
      updateClient([mStatic('client_stage', 'غير مؤهل'), mStatic('client_status', 'غير مهتم'), mTrigger('lost_reason', 'lost_reason')]),
    ]),
  ];

  return {
    id: U(),
    label_ar: 'إكمال تأكيد الموعد',
    label_en: 'Confirmation Completed',
    group_id: group,
    trigger_model_id: followups,
    trigger_event: 'update',
    is_active: false, // DISABLED first — enable only after the test passes
    metadata: { managed_by: 'sales_process_studio', sales_stage: 'موعد زيارة', activity_type: 'appointment_confirmation_call', compatibility: 'simple' },
    branches,
    conditions: branches[0].conditions, // legacy flat shape mirrors branch 0
    actions: branches[0].actions,
  };
}

// ── W5 — No-Show → Recovery (on_update appointments) ─────────────────────────
export function buildW5(ids) {
  const { followups, appointments, clients, group } = ids;
  const conditions = [
    { id: U(), value: 'no_show', field_id: 'appointment_status', operator: 'equals', only_on_change: true },
  ];
  const branch = {
    id: U(), label_en: 'No-Show Recovery', label_ar: 'استرجاع بعد عدم الحضور', condition_mode: 'all', conditions,
    actions: [
      updateRecord(clients, 'client_id', [mStatic('client_status', 'لم يحضر الموعد')]),
      createRecord(followups, [
        mTrigger('client_id', 'client_id'),
        mStatic('followup_type', 'no_show_recovery_call'),
        mRecordId('appointment_id'), // the appointment IS the trigger record
        mDate('scheduled_datetime', '+0d', ''),
        mStatic('followup_status', 'open'),
        mTrigger('sales_rep', 'sales_rep'),
      ]),
    ],
  };
  return {
    id: U(), label_ar: 'استرجاع بعد عدم الحضور', label_en: 'No-Show Recovery',
    group_id: group, trigger_model_id: appointments, trigger_event: 'update', is_active: false,
    metadata: { managed_by: 'sales_process_studio', sales_stage: 'موعد زيارة', activity_type: 'no_show_recovery_call', compatibility: 'simple' },
    branches: [branch], conditions: branch.conditions, actions: branch.actions,
  };
}

// ── W6 — Visit → After-Visit (on_create visits) ──────────────────────────────
export function buildW6(ids) {
  const { followups, visits, clients, group } = ids;
  const conditions = [
    { id: U(), value: '', field_id: 'client_id', operator: 'is_not_empty' },
  ];
  const branch = {
    id: U(), label_en: 'After Visit', label_ar: 'بعد الزيارة', condition_mode: 'all', conditions,
    actions: [
      updateRecord(clients, 'client_id', [mStatic('client_stage', 'زيارة')]),
      createRecord(followups, [
        mTrigger('client_id', 'client_id'),
        mStatic('followup_type', 'follow_up_call_after_visit'),
        mRecordId('visit'), // the visit IS the trigger record
        mDate('scheduled_datetime', '+1d @10:00', ''),
        mStatic('followup_status', 'open'),
        mTrigger('sales_rep', 'sales_representative'),
      ]),
    ],
  };
  return {
    id: U(), label_ar: 'متابعة بعد الزيارة', label_en: 'Visit → After-Visit',
    group_id: group, trigger_model_id: visits, trigger_event: 'create', is_active: false,
    metadata: { managed_by: 'sales_process_studio', sales_stage: 'زيارة', activity_type: 'follow_up_call_after_visit', compatibility: 'simple' },
    branches: [branch], conditions: branch.conditions, actions: branch.actions,
  };
}

// ── W7 — After-Visit Completed (on_update followups) ─────────────────────────
export function buildW7(ids) {
  const { followups, clients, group } = ids;
  const updateClient = (maps) => updateRecord(clients, 'client_id', maps);
  const createFollowup = (maps) => createRecord(followups, maps);
  const gcond = (cr) => ([
    { id: U(), value: ['follow_up_call_after_visit'], field_id: 'followup_type', operator: 'equals' },
    { id: U(), value: '', field_id: 'actual_datetime', operator: 'is_not_empty' },
    { id: U(), value: cr, field_id: 'call_result', operator: 'equals', only_on_change: true },
  ]);
  const br = (en, ar, cr, actions) => ({ id: U(), label_en: en, label_ar: ar, conditions: gcond(cr), condition_mode: 'all', actions });
  const nextAfterVisit = (delay, baseField) => createFollowup([
    mTrigger('client_id', 'client_id'),
    mStatic('followup_type', 'follow_up_call_after_visit'),
    mDate('scheduled_datetime', delay, baseField || ''),
    mStatic('followup_status', 'open'),
  ]);
  const branches = [
    // CORRECTION: request_offer is STATUS-ONLY here. The offer_follow_up is created
    // by Phase 7's "Offer Created → Offer Follow-up" (W8) once the Offer model exists.
    br('Request Offer', 'طلب عرض سعر', 'request_offer', [
      updateClient([mStatic('client_stage', 'عرض سعر'), mStatic('client_status', 'تم طلب عرض سعر')]),
    ]),
    br('Still Interested', 'لا يزال مهتمًا', 'still_interested', [
      updateClient([mStatic('client_status', 'مهتم')]),
      nextAfterVisit('+2d @10:00'),
    ]),
    br('Needs Financing Info', 'يحتاج معلومات تمويل', 'needs_financing_info', [
      updateClient([mStatic('client_status', 'يحتاج معلومات تمويل')]),
      nextAfterVisit('+2d @10:00'),
    ]),
    br('Family Discussion', 'نقاش عائلي', 'family_discussion', [
      updateClient([mStatic('client_status', 'نقاش عائلي')]),
      nextAfterVisit('+3d @10:00'),
    ]),
    br('Not Interested', 'غير مهتم', 'not_interested', [
      updateClient([mStatic('client_stage', 'خاسر'), mStatic('client_status', 'غير مهتم'), mTrigger('lost_reason', 'lost_reason')]),
    ]),
    // no_answer / wrong_time: schedule a retry; do NOT overwrite client status with a
    // generic value (same spirit as the W4 no_answer correction).
    br('No Answer', 'لا يوجد رد', 'no_answer', [nextAfterVisit('+1d')]),
    br('Wrong Time', 'الوقت غير مناسب', 'wrong_time', [
      updateClient([mStatic('client_status', 'الوقت غير مناسب')]),
      nextAfterVisit('+0d', 'reschedule_contact_date'),
    ]),
  ];
  return {
    id: U(), label_ar: 'إكمال متابعة بعد الزيارة', label_en: 'After-Visit Completed',
    group_id: group, trigger_model_id: followups, trigger_event: 'update', is_active: false,
    metadata: { managed_by: 'sales_process_studio', sales_stage: 'متابعة بعد الزيارة', activity_type: 'follow_up_call_after_visit', compatibility: 'simple' },
    branches, conditions: branches[0].conditions, actions: branches[0].actions,
  };
}

// ── W8 — Offer Created → Offer Follow-up (on_create offer_prices) ─────────────
// W7's request_offer is status-only; W8 is what creates the offer_follow_up once
// the rep actually drafts an Offer record. Moves the client to "offer sent".
export function buildW8(ids) {
  const { followups, offer_prices, clients, group } = ids;
  const conditions = [{ id: U(), value: '', field_id: 'client_id', operator: 'is_not_empty' }];
  const branch = {
    id: U(), label_en: 'Offer Created', label_ar: 'تم إنشاء العرض', condition_mode: 'all', conditions,
    actions: [
      updateRecord(clients, 'client_id', [
        mStatic('client_stage', 'عرض سعر'), mStatic('client_status', 'تم إرسال عرض السعر'),
      ]),
      createRecord(followups, [
        mTrigger('client_id', 'client_id'),
        mStatic('followup_type', 'offer_follow_up'),
        mDate('scheduled_datetime', '+1d @10:00', ''),
        mStatic('followup_status', 'open'),
        mTrigger('sales_rep', 'sales_rep'),
      ]),
    ],
  };
  return {
    id: U(), label_ar: 'إنشاء العرض ← متابعة العرض', label_en: 'Offer Created → Offer Follow-up',
    group_id: group, trigger_model_id: offer_prices, trigger_event: 'create', is_active: false,
    metadata: { managed_by: 'sales_process_studio', sales_stage: 'عرض سعر', activity_type: 'offer_follow_up', compatibility: 'simple' },
    branches: [branch], conditions: branch.conditions, actions: branch.actions,
  };
}

// ── W9 — Offer Follow-up Completed (on_update followups) ──────────────────────
export function buildW9(ids) {
  const { followups, clients, group } = ids;
  const updateClient = (maps) => updateRecord(clients, 'client_id', maps);
  const nextFollowup = (type, delay, baseField) => createRecord(followups, [
    mTrigger('client_id', 'client_id'),
    mStatic('followup_type', type),
    mDate('scheduled_datetime', delay, baseField || ''),
    mStatic('followup_status', 'open'),
  ]);
  const gcond = (cr) => ([
    { id: U(), value: ['offer_follow_up'], field_id: 'followup_type', operator: 'equals' },
    { id: U(), value: '', field_id: 'actual_datetime', operator: 'is_not_empty' },
    { id: U(), value: cr, field_id: 'call_result', operator: 'equals', only_on_change: true },
  ]);
  const br = (en, ar, cr, actions) => ({ id: U(), label_en: en, label_ar: ar, conditions: gcond(cr), condition_mode: 'all', actions });
  const branches = [
    br('Offer Accepted', 'تم قبول العرض', 'offer_accepted', [
      updateClient([mStatic('client_stage', 'حجز'), mStatic('client_status', 'بانتظار دفعة الحجز')]),
      nextFollowup('reservation_payment_follow_up', '+1d @10:00'),
    ]),
    br('Waiting Decision', 'بانتظار القرار', 'waiting_decision', [
      updateClient([mStatic('client_status', 'بانتظار القرار')]),
      nextFollowup('offer_follow_up', '+2d @10:00'),
    ]),
    br('Needs Financing Info', 'يحتاج معلومات تمويل', 'needs_financing_info', [
      updateClient([mStatic('client_status', 'يحتاج معلومات تمويل')]),
      nextFollowup('offer_follow_up', '+2d @10:00'),
    ]),
    br('Offer Rejected', 'تم رفض العرض', 'offer_rejected', [
      updateClient([mStatic('client_stage', 'خاسر'), mStatic('client_status', 'تم رفض العرض'), mTrigger('lost_reason', 'lost_reason')]),
    ]),
    br('No Answer', 'لا يوجد رد', 'no_answer', [nextFollowup('offer_follow_up', '+1d')]),
    br('Wrong Time', 'الوقت غير مناسب', 'wrong_time', [
      updateClient([mStatic('client_status', 'الوقت غير مناسب')]),
      nextFollowup('offer_follow_up', '+0d', 'reschedule_contact_date'),
    ]),
  ];
  return {
    id: U(), label_ar: 'إكمال متابعة العرض', label_en: 'Offer Follow-up Completed',
    group_id: group, trigger_model_id: followups, trigger_event: 'update', is_active: false,
    metadata: { managed_by: 'sales_process_studio', sales_stage: 'عرض سعر', activity_type: 'offer_follow_up', compatibility: 'simple' },
    branches, conditions: branches[0].conditions, actions: branches[0].actions,
  };
}

// ── W10 — Reservation Created → Financing Follow-up (on_create reservations) ───
export function buildW10(ids) {
  const { followups, reservations, clients, group } = ids;
  const conditions = [{ id: U(), value: '', field_id: 'client_id', operator: 'is_not_empty' }];
  const branch = {
    id: U(), label_en: 'Reservation Created', label_ar: 'تم إنشاء الحجز', condition_mode: 'all', conditions,
    actions: [
      updateRecord(clients, 'client_id', [
        mStatic('client_stage', 'تمويل'), mStatic('client_status', 'تم الحجز'),
      ]),
      createRecord(followups, [
        mTrigger('client_id', 'client_id'),
        mStatic('followup_type', 'financing_follow_up'),
        mDate('scheduled_datetime', '+1d @10:00', ''),
        mStatic('followup_status', 'open'),
        mTrigger('sales_rep', 'sales_rep'),
      ]),
    ],
  };
  return {
    id: U(), label_ar: 'إنشاء الحجز ← متابعة التمويل', label_en: 'Reservation Created → Financing Follow-up',
    group_id: group, trigger_model_id: reservations, trigger_event: 'create', is_active: false,
    metadata: { managed_by: 'sales_process_studio', sales_stage: 'حجز', activity_type: 'financing_follow_up', compatibility: 'simple' },
    branches: [branch], conditions: branch.conditions, actions: branch.actions,
  };
}

// ── W11 — Financing Status Updated (on_update financing) ──────────────────────
// Mirrors each financing_status to the client-visible status; 'completed' moves
// the client into the title-transfer stage and spawns the ownership follow-up.
export function buildW11(ids) {
  const { followups, financing, clients, group } = ids;
  const updateClient = (maps) => updateRecord(clients, 'client_id', maps);
  const gcond = (status) => ([
    { id: U(), value: status, field_id: 'financing_status', operator: 'equals', only_on_change: true },
  ]);
  const br = (en, ar, status, actions) => ({ id: U(), label_en: en, label_ar: ar, conditions: gcond(status), condition_mode: 'all', actions });
  const branches = [
    br('Submitted to Bank', 'تم التقديم للبنك', 'bank_submitted', [updateClient([mStatic('client_status', 'البنك')])]),
    br('Valuation', 'التقييم', 'valuation', [updateClient([mStatic('client_status', 'التقييم')])]),
    br('Financing Completed', 'اكتمل التمويل', 'completed', [
      updateClient([mStatic('client_stage', 'الإفراغ'), mStatic('client_status', 'تم الحجز')]),
      createRecord(followups, [
        mTrigger('client_id', 'client_id'),
        mStatic('followup_type', 'ownership_transfer_follow_up'),
        mDate('scheduled_datetime', '+1d @10:00', ''),
        mStatic('followup_status', 'open'),
        mTrigger('sales_rep', 'sales_rep'),
      ]),
    ]),
  ];
  return {
    id: U(), label_ar: 'تحديث حالة التمويل', label_en: 'Financing Status Updated',
    group_id: group, trigger_model_id: financing, trigger_event: 'update', is_active: false,
    metadata: { managed_by: 'sales_process_studio', sales_stage: 'تمويل', activity_type: 'financing_follow_up', compatibility: 'simple' },
    branches, conditions: branches[0].conditions, actions: branches[0].actions,
  };
}

// ── W12 — Ownership Transfer Completed → Closed Won (on_update ownership) ──────
export function buildW12(ids) {
  const { ownership_transfer, clients, group } = ids;
  const conditions = [
    { id: U(), value: 'completed', field_id: 'transfer_status', operator: 'equals', only_on_change: true },
  ];
  const branch = {
    id: U(), label_en: 'Ownership Transfer Completed', label_ar: 'اكتمل الإفراغ', condition_mode: 'all', conditions,
    actions: [
      updateRecord(clients, 'client_id', [mStatic('client_stage', 'مغلق ناجح'), mStatic('client_status', 'تم الإفراغ')]),
    ],
  };
  return {
    id: U(), label_ar: 'اكتمال الإفراغ ← إغلاق ناجح', label_en: 'Ownership Transfer Completed → Closed Won',
    group_id: group, trigger_model_id: ownership_transfer, trigger_event: 'update', is_active: false,
    metadata: { managed_by: 'sales_process_studio', sales_stage: 'الإفراغ', activity_type: 'ownership_transfer_follow_up', compatibility: 'simple' },
    branches: [branch], conditions: branch.conditions, actions: branch.actions,
  };
}

const BUILDERS = { w4: buildW4, w5: buildW5, w6: buildW6, w7: buildW7, w8: buildW8, w9: buildW9, w10: buildW10, w11: buildW11, w12: buildW12 };

// ── CLI ───────────────────────────────────────────────────────────────────────
const which = process.argv[2];
if (which && BUILDERS[which]) {
  const wf = BUILDERS[which](PROD_IDS);
  mkdirSync('tmp', { recursive: true });
  writeFileSync(`tmp/${which}.json`, JSON.stringify(wf), 'utf8');
  const q = (s) => String(s).replace(/'/g, "''");
  const sql =
    `-- Sales OS — ${wf.label_en} (${which.toUpperCase()}). Created DISABLED; enable only after the dev-engine test passes.\n` +
    `INSERT INTO public.workflows (id, label_ar, label_en, group_id, trigger_model_id, trigger_event, is_active, metadata, branches, conditions, actions)\n` +
    `VALUES (\n` +
    `  '${wf.id}', '${q(wf.label_ar)}', '${q(wf.label_en)}', '${wf.group_id}', '${wf.trigger_model_id}', '${wf.trigger_event}', false,\n` +
    `  '${q(JSON.stringify(wf.metadata))}'::jsonb,\n` +
    `  '${q(JSON.stringify(wf.branches))}'::jsonb,\n` +
    `  '${q(JSON.stringify(wf.conditions))}'::jsonb,\n` +
    `  '${q(JSON.stringify(wf.actions))}'::jsonb\n` +
    `) ON CONFLICT (id) DO NOTHING;\n`;
  writeFileSync(`supabase/migrations/2026-06-17_sales_os_${which}.sql`, sql, 'utf8');
  console.log(`${which.toUpperCase()} id=${wf.id} branches=${wf.branches.length}`);
  console.log('branches:', wf.branches.map((b) => `${b.label_en}(${b.actions.length})`).join(', '));

  // --apply: insert the workflow into Supabase (stays DISABLED — is_active=false).
  if (process.argv.includes('--apply')) {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    for (const p of ['.env.local', '.env']) {
      const fp = resolve(ROOT, p);
      if (!existsSync(fp)) continue;
      for (const line of readFileSync(fp, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!(m[1] in process.env)) process.env[m[1]] = v;
      }
    }
    const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    if (!URL || !KEY) { console.error('apply: missing Supabase env'); process.exit(1); }
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(URL, KEY, { auth: { persistSession: false } });
    const row = {
      id: wf.id, label_ar: wf.label_ar, label_en: wf.label_en, group_id: wf.group_id,
      trigger_model_id: wf.trigger_model_id, trigger_event: wf.trigger_event, is_active: false,
      metadata: wf.metadata, branches: wf.branches, conditions: wf.conditions, actions: wf.actions,
    };
    const { error } = await sb.from('workflows').upsert(row, { onConflict: 'id', ignoreDuplicates: true });
    if (error) { console.error('apply error:', error.message); process.exit(1); }
    console.log(`APPLIED ${which.toUpperCase()} to Supabase (DISABLED).`);
  }
}
