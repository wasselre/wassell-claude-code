// completeFollowUp — the ONE way a follow-up gets completed.
//
// WHY THIS EXISTS
//   Completing a follow-up writes `call_result`, which is what the sales
//   workflows trigger on: they move the client's stage/status and create the
//   next task. Two code paths doing that write with slightly different data is
//   how a client gets advanced twice, or advanced with a missing field that a
//   workflow branch silently fails to match.
//
//   There are now three surfaces that complete a follow-up — the Follow-up
//   Workspace, the chat Log-interaction / Done modals, and the AI call-result
//   confirmation popup. They all funnel through here.
//
// WHAT IT DOES NOT DO
//   No toasts, no navigation, no store reads. Callers own their own UX. This
//   returns a discriminated result and lets the surface decide what to say.

import type { AppModel, AppRecord, SaveRecordOpts, SaveResult } from '@/types';
import { buildFieldLabels, validateFollowUpCompletion } from '@/lib/salesProcess';

export type SaveRecordFn = (record: AppRecord, opts?: SaveRecordOpts) => Promise<SaveResult>;

export interface CompleteFollowUpArgs {
  /** The follow-up record being completed. */
  record: AppRecord;
  /** Its model — used for field labels in validation messages. */
  model: AppModel;
  /** Working draft (everything the rep edited), before the completion stamp. */
  draft: Record<string, unknown>;
  /** The chosen outcome value, e.g. `recontact_later`. */
  outcomeKey: string;
  /** Follow-up type key, for the per-type outcome rules. */
  typeKey: string | null;
  currentUserId: string | null;
  /** Client stage/status at completion time — snapshotted for reporting. */
  clientStage?: string | null;
  clientStatus?: string | null;
  /** Version the caller loaded with, for optimistic concurrency. */
  expectedVersion: number | null;
  saveRecord: SaveRecordFn;
  /** All phone_calls records, so the reverse evidence link can be stamped. */
  phoneCallsRecords?: readonly AppRecord[];
}

export type CompleteFollowUpResult =
  | { ok: false; reason: 'validation'; message_ar: string; message_en: string }
  | { ok: false; reason: 'conflict' }
  | { ok: true; queued: boolean; data: Record<string, unknown> };

export async function completeFollowUp(args: CompleteFollowUpArgs): Promise<CompleteFollowUpResult> {
  const {
    record, model, draft, outcomeKey, typeKey, currentUserId,
    clientStage, clientStatus, expectedVersion, saveRecord, phoneCallsRecords = [],
  } = args;

  const finalData: Record<string, unknown> = {
    ...draft,
    call_result: outcomeKey,
    actual_datetime: draft.actual_datetime ?? new Date().toISOString(),
    followup_status: 'completed',
    // A completed row must never keep `message_sent_waiting_response`, or the
    // on_due WhatsApp escalation can still match it and spawn a ghost attempt-2.
    whatsapp_state: null,
    completed_by_user: currentUserId ?? draft.completed_by_user ?? null,
    source_stage_snapshot: draft.source_stage_snapshot ?? clientStage ?? null,
    source_status_snapshot: draft.source_status_snapshot ?? clientStatus ?? null,
  };

  const validation = validateFollowUpCompletion({
    followupType: typeKey ?? '',
    selectedOutcome: outcomeKey,
    draft: finalData,
    fieldLabels: buildFieldLabels(model.schema.sections.flatMap((s) => s.fields)),
  });
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'validation',
      message_ar: validation.hardErrors[0]?.message_ar ?? 'حقول مطلوبة ناقصة',
      message_en: validation.hardErrors[0]?.message_en ?? 'Required fields missing',
    };
  }

  const toSave: AppRecord = { ...record, data: finalData, updated_at: new Date().toISOString() };
  const saveResult = await saveRecord(toSave, { expectedVersion });
  if (saveResult.status === 'conflict') return { ok: false, reason: 'conflict' };

  // Bidirectional evidence: stamp the phone_call with this follow-up id. Its
  // own version + opts; a conflict here does NOT undo the completion (the
  // pending-sync queue retries a queued write).
  const callId = finalData.completed_by_call_id;
  if (typeof callId === 'string' && callId) {
    const callRec = phoneCallsRecords.find((r) => r.id === callId);
    if (callRec && callRec.data.linked_followup_id !== record.id) {
      void saveRecord(
        { ...callRec, data: { ...callRec.data, linked_followup_id: record.id }, updated_at: new Date().toISOString() },
        { expectedVersion: callRec.version ?? null },
      );
    }
  }

  return { ok: true, queued: saveResult.status === 'queued', data: finalData };
}
