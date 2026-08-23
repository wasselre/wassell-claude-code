// Type-specific context resolution for the Follow-up Workspace ContextPanel.
//
// Each FollowUpTypeConfig lists `context_blocks`; the Workspace passes a
// ContextInput (client / appointment / project / latest interaction facts) and
// renders resolveContext(block, ctx) for each. Pure — the Workspace owns the
// data gathering. Missing values resolve to `value: undefined` so the UI renders
// a dash rather than guessing.

import type { ContextBlockId } from './types';

export interface ContextInput {
  client?: Record<string, unknown> | null;
  appointment?: Record<string, unknown> | null;
  /** The resolved project RECORD (so we render its name, never a raw id). */
  project?: Record<string, unknown> | null;
  followup?: Record<string, unknown> | null;
  latestCallSummary?: string | null;
  latestWhatsApp?: string | null;
  attemptNumber?: number | null;
  previousConfirmations?: number | null;
  suggestedTemplate?: string | null;
  /** Resolve a user id to a display name (so reps never see a raw UUID). */
  resolveUser?: (id: unknown) => string | undefined;
  /** Locale for date formatting. */
  isAr?: boolean;
}

export interface ContextValue {
  id: ContextBlockId;
  label_ar: string;
  label_en: string;
  /** Display value (already stringified); undefined ⇒ render as "—". */
  value?: string;
}

function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return v.length ? v.map(String).join('، ') : undefined;
  if (typeof v === 'object') {
    // Range fields (budget / area) store { min, max } — format as "min – max".
    const r = v as { min?: unknown; max?: unknown };
    if ('min' in r || 'max' in r) {
      const min = r.min != null ? String(r.min) : '';
      const max = r.max != null ? String(r.max) : '';
      return min || max ? `${min || '…'} – ${max || '…'}` : undefined;
    }
    return undefined; // other objects have no sensible inline display
  }
  const s = String(v).trim();
  return s.length ? s : undefined;
}

const LABELS: Record<ContextBlockId, { ar: string; en: string }> = {
  lead_source: { ar: 'مصدر العميل', en: 'Lead Source' },
  campaign: { ar: 'الحملة', en: 'Campaign' },
  preferred_project: { ar: 'المشروع المفضل', en: 'Preferred Project' },
  budget: { ar: 'الميزانية', en: 'Budget' },
  preferred_area: { ar: 'المساحة المفضلة', en: 'Preferred Area' },
  preferred_unit_type: { ar: 'نوع الوحدة', en: 'Unit Type' },
  previous_attempts: { ar: 'المحاولات السابقة', en: 'Previous Attempts' },
  latest_call_summary: { ar: 'ملخص آخر مكالمة', en: 'Latest Call Summary' },
  latest_whatsapp: { ar: 'آخر رسالة واتساب', en: 'Latest WhatsApp' },
  whatsapp_status: { ar: 'حالة الواتساب', en: 'WhatsApp' },
  appointment: { ar: 'الموعد', en: 'Appointment' },
  project_location: { ar: 'موقع المشروع', en: 'Project Location' },
  appointment_status: { ar: 'حالة الموعد', en: 'Appointment Status' },
  sales_rep: { ar: 'مندوب المبيعات', en: 'Sales Rep' },
  previous_confirmations: { ar: 'تأكيدات سابقة', en: 'Previous Confirmations' },
  suggested_template: { ar: 'القالب المقترح', en: 'Suggested Template' },
  preference_summary: { ar: 'ملخص التفضيلات', en: 'Preferences' },
  next_recommended: { ar: 'الإجراء الموصى به', en: 'Next Recommended' },
  visited_project: { ar: 'المشروع المزار', en: 'Visited Project' },
  visit_date: { ar: 'تاريخ الزيارة', en: 'Visit Date' },
  visited_units: { ar: 'الوحدات المزارة', en: 'Visited Units' },
  customer_feedback: { ar: 'ملاحظات العميل', en: 'Customer Feedback' },
  objections: { ar: 'الاعتراضات', en: 'Objections' },
  offer_readiness: { ar: 'جاهزية العرض', en: 'Offer Readiness' },
  missed_appointment_date: { ar: 'تاريخ الموعد الفائت', en: 'Missed Appointment' },
  reschedule_suggestion: { ar: 'اقتراح إعادة الجدولة', en: 'Reschedule Suggestion' },
  offer_details: { ar: 'تفاصيل العرض', en: 'Offer Details' },
};

export function resolveContext(blockId: ContextBlockId, ctx: ContextInput): ContextValue {
  const label = LABELS[blockId];
  const base: ContextValue = { id: blockId, label_ar: label.ar, label_en: label.en };
  const client = ctx.client ?? {};
  const appt = ctx.appointment ?? {};
  const project = ctx.project ?? {};
  const fmtDate = (v: unknown): string | undefined => {
    if (typeof v !== 'string' || !v.trim()) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? str(v) : d.toLocaleString(ctx.isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
  };

  switch (blockId) {
    case 'lead_source':
      return { ...base, value: str(client.client_sources) };
    // Resolve the project lookup to its name — never the raw id.
    case 'preferred_project':
    case 'visited_project':
      return { ...base, value: str(project.project_name) };
    case 'budget':
      return { ...base, value: str(client.budget) };
    case 'preferred_area':
      return { ...base, value: str(client.preferred_area) };
    case 'preferred_unit_type':
      return { ...base, value: str(client.preferred_unit_type) };
    case 'previous_attempts':
      return { ...base, value: ctx.attemptNumber != null ? String(ctx.attemptNumber) : undefined };
    case 'latest_call_summary':
      return { ...base, value: str(ctx.latestCallSummary) };
    case 'latest_whatsapp':
      return { ...base, value: str(ctx.latestWhatsApp) };
    // Reply-checkpoint state for a WhatsApp follow-up, read straight off the
    // follow-up record (no async fetch). Only the waiting state is meaningful to
    // surface; anything else resolves to undefined so the row hides.
    case 'whatsapp_status':
      return {
        ...base,
        value: ctx.followup?.whatsapp_state === 'message_sent_waiting_response'
          ? (ctx.isAr ? 'رسالة مُرسلة — بانتظار رد العميل' : 'Message sent — awaiting reply')
          : undefined,
      };
    case 'appointment':
    case 'missed_appointment_date':
      return { ...base, value: fmtDate(appt.appointment_date) };
    case 'appointment_status':
      return { ...base, value: str(appt.appointment_status) };
    case 'project_location':
      return { ...base, value: str(project.location ?? project.project_location) };
    // Resolve the user id to a name — never the raw UUID.
    case 'sales_rep':
      return { ...base, value: ctx.resolveUser?.(appt.sales_rep ?? client.client_owner) };
    case 'previous_confirmations':
      return { ...base, value: ctx.previousConfirmations != null ? String(ctx.previousConfirmations) : undefined };
    case 'suggested_template':
      return { ...base, value: str(ctx.suggestedTemplate) };
    default:
      // Blocks without a direct field (campaign, preference_summary, objections,
      // offer_details, etc.) are rendered by the Workspace from richer sources.
      return base;
  }
}
