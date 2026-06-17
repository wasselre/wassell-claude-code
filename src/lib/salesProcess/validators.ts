// Follow-up completion validation + the shared field-visibility predicate.
//
// The OutcomePanel (UI) and validateFollowUpCompletion (guard) use the SAME
// predicate so a revealed-and-required field that's empty blocks the save, and a
// hidden field never blocks it (same fail-open posture as fieldVisibility.ts).

import type { SalesProcessConfig, FollowUpOutcomeConfig, OutcomeRequires } from './types';
import { getFollowUpTypeConfig, getOutcomeConfig, DEFAULT_SALES_PROCESS } from './config';

export interface ValidationProblem {
  /** Follow-up field slug the problem concerns (for focus), if any. */
  field?: string;
  message_ar: string;
  message_en: string;
}

export interface ValidationResult {
  ok: boolean; // no hard errors
  hardErrors: ValidationProblem[];
  warnings: ValidationProblem[];
}

export interface ValidationContext {
  /** True if saving this terminal/no-next outcome would leave an active client with no task. */
  leavesClientWithoutNextAction?: boolean;
}

/** Each required-key → the follow-up field slug that satisfies it. */
const REQUIRE_FIELD: Record<keyof OutcomeRequires, string> = {
  actual_datetime: 'actual_datetime',
  appointment_id: 'appointment_id',
  appointment_created: 'appointment_id', // satisfied once an appointment is created + linked
  visit: 'visit',
  reschedule_contact_date: 'reschedule_contact_date',
  new_appointment_datetime: 'new_appointment_datetime',
  lost_reason: 'lost_reason',
  outcome_notes: 'outcome_notes',
};

/** Mirror of fieldVisibility's "meaningful value" test (kept local to avoid coupling). */
function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true; // number, boolean
}

/** A slug → bilingual label map (so required-field messages name the field in
 *  the user's language instead of its raw API slug). */
export type FieldLabelMap = Record<string, { label_ar: string; label_en: string }>;

/** Build a {@link FieldLabelMap} from a model's fields. */
export function buildFieldLabels(
  fields: { name: string; label_ar: string; label_en: string }[],
): FieldLabelMap {
  const out: FieldLabelMap = {};
  for (const f of fields) out[f.name] = { label_ar: f.label_ar, label_en: f.label_en };
  return out;
}

/** The follow-up field slugs an outcome hard-requires. */
export function requiredFieldSlugs(outcome: FollowUpOutcomeConfig): string[] {
  const r = outcome.requires ?? {};
  const out: string[] = [];
  (Object.keys(r) as (keyof OutcomeRequires)[]).forEach((key) => {
    if (r[key]) out.push(REQUIRE_FIELD[key]);
  });
  return [...new Set(out)];
}

/**
 * Fields the OutcomePanel should REVEAL for a (type, outcome): every required
 * field, plus outcome notes and the channel-appropriate evidence link.
 */
export function revealedFieldSlugs(
  followupType: string,
  outcomeValue: string,
  config: SalesProcessConfig = DEFAULT_SALES_PROCESS,
): string[] {
  const type = getFollowUpTypeConfig(followupType, config);
  const outcome = getOutcomeConfig(followupType, outcomeValue, config);
  if (!outcome) return [];
  const set = new Set<string>(requiredFieldSlugs(outcome));
  set.add('outcome_notes');
  set.add(type?.primary_channel === 'whatsapp' ? 'completed_by_chat_id' : 'completed_by_call_id');
  return [...set];
}

/** Shared visibility predicate used by the panel AND the validator. */
export function isOutcomeFieldVisible(
  fieldSlug: string,
  followupType: string,
  outcomeValue: string,
  config: SalesProcessConfig = DEFAULT_SALES_PROCESS,
): boolean {
  return revealedFieldSlugs(followupType, outcomeValue, config).includes(fieldSlug);
}

export interface ValidateFollowUpCompletionInput {
  followupType: string;
  selectedOutcome: string;
  /** The follow-up draft data (record.data clone). */
  draft: Record<string, unknown>;
  context?: ValidationContext;
  config?: SalesProcessConfig;
  /** slug → bilingual label, so a missing-required message names the field in
   *  the user's language instead of the raw API slug. */
  fieldLabels?: FieldLabelMap;
}

/**
 * Hard blocks the save when a required field is missing; returns overridable
 * warnings (no evidence attached, or an active client left with no next action).
 */
export function validateFollowUpCompletion(input: ValidateFollowUpCompletionInput): ValidationResult {
  const config = input.config ?? DEFAULT_SALES_PROCESS;
  const hardErrors: ValidationProblem[] = [];
  const warnings: ValidationProblem[] = [];

  if (!input.selectedOutcome) {
    hardErrors.push({ field: 'call_result', message_ar: 'يجب اختيار نتيجة المتابعة', message_en: 'An outcome is required' });
    return { ok: false, hardErrors, warnings };
  }

  const outcome = getOutcomeConfig(input.followupType, input.selectedOutcome, config);
  if (!outcome) {
    hardErrors.push({ field: 'call_result', message_ar: 'النتيجة غير مسموحة لهذا النوع', message_en: 'This outcome is not allowed for this follow-up type' });
    return { ok: false, hardErrors, warnings };
  }

  // actual_datetime is always required to complete a follow-up.
  if (!hasValue(input.draft.actual_datetime)) {
    hardErrors.push({ field: 'actual_datetime', message_ar: 'يجب تحديد وقت الإكمال', message_en: 'Completed-at time is required' });
  }

  for (const slug of requiredFieldSlugs(outcome)) {
    if (!hasValue(input.draft[slug])) {
      const isAppt = slug === 'appointment_id' && outcome.requires?.appointment_created;
      const lbl = input.fieldLabels?.[slug];
      const nameAr = lbl?.label_ar || slug;
      const nameEn = lbl?.label_en || slug;
      hardErrors.push({
        field: slug,
        message_ar: isAppt ? 'يجب إنشاء موعد وربطه' : `الحقل المطلوب فارغ: ${nameAr}`,
        message_en: isAppt ? 'An appointment must be created and linked' : `Required field is empty: ${nameEn}`,
      });
    }
  }

  // Soft warnings: missing evidence for the channel.
  for (const warnField of outcome.warn ?? []) {
    if (!hasValue(input.draft[warnField])) {
      warnings.push({
        field: warnField,
        message_ar: warnField === 'completed_by_chat_id' ? 'لم يتم إرفاق محادثة واتساب' : 'لم يتم إرفاق مكالمة',
        message_en: warnField === 'completed_by_chat_id' ? 'No WhatsApp conversation attached' : 'No call attached',
      });
    }
  }

  // "Active client must have a next action" — warn on a dead-end outcome.
  const deadEnd = !outcome.is_terminal && (outcome.next_action_preview?.kind ?? 'none') === 'none';
  if (deadEnd && input.context?.leavesClientWithoutNextAction) {
    warnings.push({
      message_ar: 'سيبقى العميل نشطًا بدون إجراء تالٍ',
      message_en: 'The client will be left active with no next action',
    });
  }

  return { ok: hardErrors.length === 0, hardErrors, warnings };
}
