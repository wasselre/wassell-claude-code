import { nowDateTimeValue } from './nowDateTime';

/**
 * Follow-ups convenience rule: the moment a call result (نتيجة المكالمة /
 * `call_result`) is recorded, stamp the actual follow-up time
 * (موعد المتابعة الفعلي / `actual_datetime`) with "now" — but only when it's
 * still empty, so a hand-entered or previously-stamped time is never
 * overwritten.
 *
 * Mutates `next` in place (the freshly-spread draft of formData). Pure
 * aside from that, and entry-point-agnostic so the full record form
 * (`RecordFormPage`) and the inline create/edit modal (`RecordFormModal`)
 * apply identical behavior.
 *
 * Call this ONLY from a user-driven field-change handler, never on load or
 * from an effect that watches formData: stamping when a record that already
 * carries a `call_result` is merely opened would record when the form was
 * viewed, not when the call actually happened.
 */
export function applyFollowupAutoStamp(
  modelName: string | undefined,
  fieldName: string,
  value: unknown,
  next: Record<string, unknown>,
): void {
  if (
    modelName === 'followups' &&
    fieldName === 'call_result' &&
    value && // a result was picked, not cleared
    !next.actual_datetime // don't clobber an existing time
  ) {
    next.actual_datetime = nowDateTimeValue('datetime');
  }
}
