import { describe, it, expect } from 'vitest';
import { buildAutoCompletion } from '../outcomeAutoApply.js';
import { validateFollowUpCompletion } from '../../../src/lib/salesProcess/validators.js';

describe('buildAutoCompletion — the popup\'s completion, done by the AI', () => {
  const now = '2026-10-04T12:00:00.000Z';
  it('completes the task with the reading\'s outcome and fields, no rep stamped', () => {
    const d = buildAutoCompletion(
      { followup_type: 'whatsapp_follow_up', followup_status: 'open', whatsapp_state: 'waiting_reply' },
      { suggested_outcome: 'interested', suggested_fields: { outcome_notes: 'مهتم بيمام 17' }, chat_record_id: 'chat-1' },
      { stage: 'تواصل', status: 'نشط' }, now,
    );
    expect(d).toMatchObject({
      call_result: 'interested', followup_status: 'completed', actual_datetime: now, completed_by_user: null,
      completed_by_chat_id: 'chat-1', whatsapp_state: null, outcome_notes: 'مهتم بيمام 17',
      source_stage_snapshot: 'تواصل', source_status_snapshot: 'نشط',
    });
  });
  it('the same validation as the popup blocks an under-specified result', () => {
    const d = buildAutoCompletion({ followup_type: 'whatsapp_follow_up' }, { suggested_outcome: 'not_interested', suggested_fields: {}, chat_record_id: null }, { stage: null, status: null }, now);
    const r = validateFollowUpCompletion({ followupType: 'whatsapp_follow_up', selectedOutcome: 'not_interested', draft: d });
    expect(r.ok).toBe(false);
    const ok = buildAutoCompletion({ followup_type: 'whatsapp_follow_up' }, { suggested_outcome: 'interested', suggested_fields: {}, chat_record_id: null }, { stage: null, status: null }, now);
    expect(validateFollowUpCompletion({ followupType: 'whatsapp_follow_up', selectedOutcome: 'interested', draft: ok }).ok).toBe(true);
  });
});
