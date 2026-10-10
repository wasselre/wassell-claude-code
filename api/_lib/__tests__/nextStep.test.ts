/**
 * The agent owns the next step (2026-10-10) — the pure rules.
 */
import { describe, it, expect } from 'vitest';
import { planOfTask, defaultNextAfterResult, applyPlanToTask, riyadhClock } from '../nextStep.js';
import { buildAutoCompletion } from '../outcomeAutoApply.js';

describe('planOfTask — how a task reaches the client', () => {
  it('a WhatsApp task is written by the AI unless the agent took it', () => {
    expect(planOfTask({ followup_type: ['whatsapp_follow_up'], scheduled_datetime: '2026-10-11T07:00:00Z' }))
      .toEqual({ channel: 'ai_whatsapp', at: '2026-10-11T07:00:00Z' });
    expect(planOfTask({ followup_type: 'whatsapp_follow_up', writer: 'agent', scheduled_datetime: '2026-10-11T07:00:00Z' }))
      .toEqual({ channel: 'agent_whatsapp', at: '2026-10-11T07:00:00Z' });
  });
  it('anything else is a call; no time → no plan', () => {
    expect(planOfTask({ followup_type: ['appointment_booking_call'], scheduled_datetime: '2026-10-12T07:00:00Z' })?.channel).toBe('call');
    expect(planOfTask({ followup_type: ['appointment_booking_call'] })).toBeNull();
  });
});

describe('defaultNextAfterResult — mirrors the WhatsApp-result workflow', () => {
  const now = new Date('2026-10-10T09:00:00Z');
  it('interested → WhatsApp by the AI in 5 days', () => {
    expect(defaultNextAfterResult('interested', {}, now)).toEqual({ channel: 'ai_whatsapp', at: '2026-10-15T09:00:00.000Z' });
  });
  it('call back later → on the client’s date; no date → nothing', () => {
    expect(defaultNextAfterResult('recontact_later', { reschedule_contact_date: '2026-10-20T07:00:00Z' }, now))
      .toEqual({ channel: 'ai_whatsapp', at: '2026-10-20T07:00:00Z' });
    expect(defaultNextAfterResult('recontact_later', {}, now)).toBeNull();
  });
  it('results that end the path have no next contact', () => {
    for (const r of ['not_interested', 'request_offer', 'unanswered_request', null]) expect(defaultNextAfterResult(r, {}, now)).toBeNull();
  });
});

describe('applyPlanToTask — the decision on the planned task', () => {
  const wa = { followup_type: ['whatsapp_follow_up'], scheduled_datetime: 'x', whatsapp_attempt_number: 1, whatsapp_state: null, sales_rep: 'u1' };
  it('agreeing only records who decided', () => {
    const out = applyPlanToTask(wa, undefined, 'u1', 'agent');
    expect(out).toEqual({ ...wa, next_step_decision: 'agent', next_step_decided_by: 'u1' });
  });
  it('a call instead of the AI message: type, time, WhatsApp fields dropped', () => {
    const out = applyPlanToTask(wa, { channel: 'call', at: '2026-10-15T07:00:00Z' }, 'u1', 'agent');
    expect(out.followup_type).toEqual(['appointment_booking_call']);
    expect(out.scheduled_datetime).toBe('2026-10-15T07:00:00Z');
    expect(out).not.toHaveProperty('whatsapp_attempt_number');
    expect(out).not.toHaveProperty('writer');
    expect(out.sales_rep).toBe('u1');
  });
  it('the agent writes the WhatsApp themselves → writer=agent (the AI writer skips it)', () => {
    const out = applyPlanToTask(wa, { channel: 'agent_whatsapp', at: '2026-10-13T07:00:00Z' }, 'u1', 'agent');
    expect(out.writer).toBe('agent');
    expect(out.followup_type).toEqual(['whatsapp_follow_up']);
  });
  it('a call turned into an AI message starts at attempt 1, and AI again clears writer', () => {
    const call = { followup_type: ['appointment_booking_call'], scheduled_datetime: 'x' };
    const out = applyPlanToTask(call, { channel: 'ai_whatsapp', at: '2026-10-13T07:00:00Z' }, null, 'default');
    expect(out.whatsapp_attempt_number).toBe(1);
    expect(out.next_step_decision).toBe('default');
    const back = applyPlanToTask({ ...wa, writer: 'agent' }, { channel: 'ai_whatsapp', at: 'y' }, 'u1', 'agent');
    expect(back).not.toHaveProperty('writer');
  });
});

describe('riyadhClock — the 9 pm default', () => {
  it('converts to Riyadh day and hour', () => {
    expect(riyadhClock(new Date('2026-10-10T17:59:00Z'))).toEqual({ day: '2026-10-10', hour: 20 });
    expect(riyadhClock(new Date('2026-10-10T18:00:00Z'))).toEqual({ day: '2026-10-10', hour: 21 });
    expect(riyadhClock(new Date('2026-10-10T21:30:00Z'))).toEqual({ day: '2026-10-11', hour: 0 });
  });
});

describe('buildAutoCompletion — a decision taken on a card', () => {
  it('carries who agreed and marks it reviewed (so no second card opens)', () => {
    const d = buildAutoCompletion({ followup_type: ['whatsapp_follow_up'] },
      { suggested_outcome: 'interested', suggested_fields: {}, chat_record_id: 'c1' }, { stage: null, status: null },
      '2026-10-10T09:00:00Z', { userId: 'u1', reviewed: true });
    expect(d.completed_by_user).toBe('u1');
    expect(d.next_step_reviewed).toBe(true);
  });
  it('the AI path is unchanged', () => {
    const d = buildAutoCompletion({}, { suggested_outcome: 'interested', suggested_fields: {}, chat_record_id: null },
      { stage: null, status: null }, '2026-10-10T09:00:00Z');
    expect(d.completed_by_user).toBeNull();
    expect(d).not.toHaveProperty('next_step_reviewed');
  });
});
