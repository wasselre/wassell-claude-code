// Bilingual labels + metric formatting for the Sales Studio surfaces. Inline
// AR/EN pairs (the established pattern for the Sales OS pages — they don't route
// every string through i18n.ts).

import type { MetricResult, FunnelMetricKey } from '@/lib/salesStudio';
import type {
  SalesProcessStatus,
  SalesProcessVersionStatus,
  SalesExperimentStatus,
  SalesPrimaryMetric,
  SalesGuardrailMetric,
  SalesAssignmentStrategy,
} from '@/types';

export type Bi = { ar: string; en: string };
export const pick = (b: Bi, isAr: boolean): string => (isAr ? b.ar : b.en);

export const METRIC_LABELS: Record<FunnelMetricKey, Bi> = {
  lead_count: { ar: 'عدد العملاء', en: 'Lead count' },
  appointment_booking_rate: { ar: 'نسبة حجز المواعيد', en: 'Appointment booking rate' },
  appointment_confirmation_rate: { ar: 'نسبة تأكيد المواعيد', en: 'Appointment confirmation rate' },
  visit_rate: { ar: 'نسبة الزيارة', en: 'Visit rate' },
  offer_request_rate: { ar: 'نسبة طلب العرض', en: 'Offer request rate' },
  reservation_rate: { ar: 'نسبة الحجز', en: 'Reservation rate' },
  financing_started_rate: { ar: 'نسبة بدء التمويل', en: 'Financing started rate' },
  closed_won_rate: { ar: 'نسبة الإغلاق الناجح', en: 'Closed won rate' },
  lost_rate: { ar: 'نسبة الخسارة', en: 'Lost rate' },
  unqualified_rate: { ar: 'نسبة غير المؤهلين', en: 'Unqualified rate' },
  whatsapp_response_rate: { ar: 'نسبة الرد على واتساب', en: 'WhatsApp response rate' },
  no_answer_rate: { ar: 'نسبة عدم الرد', en: 'No-answer rate' },
  touches_per_client: { ar: 'لمسات لكل عميل', en: 'Touches per client' },
  time_to_appointment: { ar: 'الوقت حتى الموعد', en: 'Time to appointment' },
  time_to_offer: { ar: 'الوقت حتى العرض', en: 'Time to offer' },
  time_to_close: { ar: 'الوقت حتى الإغلاق', en: 'Time to close' },
  no_next_action_count: { ar: 'بدون إجراء تالٍ', en: 'No next action' },
  rep_workload: { ar: 'حمل المندوب', en: 'Rep workload' },
};

export const PRIMARY_METRIC_OPTIONS: SalesPrimaryMetric[] = [
  'appointment_booking_rate', 'appointment_attendance_rate', 'visit_rate', 'offer_request_rate',
  'reservation_rate', 'closed_won_rate', 'time_to_appointment', 'time_to_offer', 'time_to_close',
  'whatsapp_response_rate',
];
export const GUARDRAIL_METRIC_OPTIONS: SalesGuardrailMetric[] = [
  'lost_rate', 'unqualified_rate', 'no_answer_rate', 'no_next_action_count', 'rep_workload', 'touches_per_client',
];

export const PRIMARY_METRIC_LABELS: Record<SalesPrimaryMetric, Bi> = {
  appointment_booking_rate: METRIC_LABELS.appointment_booking_rate,
  appointment_attendance_rate: { ar: 'نسبة حضور المواعيد', en: 'Appointment attendance rate' },
  visit_rate: METRIC_LABELS.visit_rate,
  offer_request_rate: METRIC_LABELS.offer_request_rate,
  reservation_rate: METRIC_LABELS.reservation_rate,
  closed_won_rate: METRIC_LABELS.closed_won_rate,
  time_to_appointment: METRIC_LABELS.time_to_appointment,
  time_to_offer: METRIC_LABELS.time_to_offer,
  time_to_close: METRIC_LABELS.time_to_close,
  whatsapp_response_rate: METRIC_LABELS.whatsapp_response_rate,
};
export const GUARDRAIL_METRIC_LABELS: Record<SalesGuardrailMetric, Bi> = {
  lost_rate: METRIC_LABELS.lost_rate,
  unqualified_rate: METRIC_LABELS.unqualified_rate,
  no_answer_rate: METRIC_LABELS.no_answer_rate,
  no_next_action_count: METRIC_LABELS.no_next_action_count,
  rep_workload: METRIC_LABELS.rep_workload,
  touches_per_client: METRIC_LABELS.touches_per_client,
};

/** Map a primary metric to the funnel key it compares (attendance → confirmation). */
export function primaryToFunnelKey(m: SalesPrimaryMetric): FunnelMetricKey {
  return m === 'appointment_attendance_rate' ? 'appointment_confirmation_rate' : (m as FunnelMetricKey);
}

export const PROCESS_STATUS_LABELS: Record<SalesProcessStatus, Bi> = {
  draft: { ar: 'مسودة', en: 'Draft' },
  active: { ar: 'نشط', en: 'Active' },
  archived: { ar: 'مؤرشف', en: 'Archived' },
};
export const VERSION_STATUS_LABELS: Record<SalesProcessVersionStatus, Bi> = {
  draft: { ar: 'مسودة', en: 'Draft' },
  active: { ar: 'نشط', en: 'Active' },
  archived: { ar: 'مؤرشف', en: 'Archived' },
};
export const EXPERIMENT_STATUS_LABELS: Record<SalesExperimentStatus, Bi> = {
  draft: { ar: 'مسودة', en: 'Draft' },
  active: { ar: 'نشط', en: 'Active' },
  paused: { ar: 'متوقف مؤقتًا', en: 'Paused' },
  completed: { ar: 'مكتمل', en: 'Completed' },
  archived: { ar: 'مؤرشف', en: 'Archived' },
};

export const ASSIGNMENT_STRATEGY_LABELS: Record<SalesAssignmentStrategy, Bi> = {
  same_sales_rep: { ar: 'نفس المندوب', en: 'Same sales rep' },
  current_user: { ar: 'المستخدم الحالي', en: 'Current user' },
  fixed_user: { ar: 'مستخدم محدد', en: 'Fixed user' },
  role_least_workload: { ar: 'الأقل حِملًا حسب الدور', en: 'Least workload (role)' },
};

const STATUS_COLORS: Record<string, string> = {
  draft: '#C09B5F', active: '#10B981', archived: '#6B7280',
  paused: '#C09B5F', completed: '#3B82F6',
};
export const statusColor = (s: string): string => STATUS_COLORS[s] ?? '#6B7280';

/** Render a MetricResult for display. Unavailable → '—'. */
export function formatMetric(m: MetricResult | undefined, isAr: boolean): string {
  if (!m || !m.available || m.value == null) return '—';
  if (m.unit === 'rate') return `${Math.round(m.value * 100)}%`;
  if (m.unit === 'days') return isAr ? `${m.value.toFixed(1)} يوم` : `${m.value.toFixed(1)}d`;
  // count
  return Number.isInteger(m.value) ? String(m.value) : m.value.toFixed(1);
}

/** Reason text for an unavailable metric (tooltip). */
export function unavailableReason(m: MetricResult | undefined, isAr: boolean): string {
  if (!m || m.available) return '';
  const map: Record<string, Bi> = {
    no_leads: { ar: 'لا يوجد عملاء في هذه المجموعة', en: 'No leads in this cohort' },
    no_whatsapp_followups: { ar: 'لا توجد متابعات واتساب', en: 'No WhatsApp follow-ups' },
    no_booking_calls: { ar: 'لا توجد مكالمات حجز مكتملة', en: 'No completed booking calls' },
    no_event_records: { ar: 'لا يوجد نموذج/سجلات لهذا الحدث', en: 'No records for this event model' },
    no_dated_events: { ar: 'لا توجد طوابع زمنية صالحة', en: 'No dated events' },
    no_reps: { ar: 'لا يوجد مندوبون', en: 'No reps' },
  };
  const r = m.reason ? map[m.reason] : undefined;
  return r ? pick(r, isAr) : (isAr ? 'غير متاح' : 'Unavailable');
}
