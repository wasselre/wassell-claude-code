/**
 * `update_record` target matching in the BROWSER workflow engine.
 *
 * The engine used to finish its search with
 *   targetRecords.find((r) => r.data[filterField] === filterValue)
 * When the filter value was `undefined` — an appointment saved without a
 * client, say — that comparison is TRUE for the first record that merely
 * lacks the field, so the action updated an arbitrary record. For the literal
 * `id` filter every record "lacks the field", so it was always the first one.
 *
 * The server engines closed this on 2026-10-03 (`api/_lib/workflowRecordLoad.ts`);
 * these tests pin the same rules for the browser engine, which shares
 * `findUpdateTarget` / `isEmptyFilterValue` from `workflowEngineCore`.
 */

import { describe, it, expect, vi } from 'vitest';
import { findUpdateTarget, isEmptyFilterValue } from '../workflowEngineCore';
import { executeWorkflows } from '../workflowEngine';
import type { AppModel, AppRecord, Workflow, WorkflowRun } from '@/types';

const NOW = '2026-10-04T09:00:00.000Z';
const CLIENTS = 'model-clients';
const APPOINTMENTS = 'model-appointments';

const rec = (id: string, model_id: string, data: Record<string, unknown>): AppRecord => ({
  id, model_id, data, created_at: NOW, updated_at: NOW,
});

// The first client deliberately has NO `client_code` — it is the record the
// old search would have picked for any empty filter.
const clients = (): AppRecord[] => [
  rec('client-1', CLIENTS, { client_name: 'First in the list', client_stage: 'جديد' }),
  rec('client-2', CLIENTS, { client_name: 'Second', client_stage: 'جديد', client_code: 'C-200' }),
  rec('client-3', CLIENTS, { client_name: 'Third', client_stage: 'جديد', client_code: 'C-300' }),
];

/* ── the pure matcher ────────────────────────────────────────────────────── */

describe('isEmptyFilterValue', () => {
  it.each([undefined, null, ''])('treats %s as empty', (v) => {
    expect(isEmptyFilterValue(v)).toBe(true);
  });
  it.each([0, false, 'x', ' ', []])('treats %s as a real value', (v) => {
    expect(isEmptyFilterValue(v)).toBe(false);
  });
});

describe('findUpdateTarget', () => {
  it.each([undefined, null, ''])('an empty filter value (%s) matches nothing — literal id filter', (empty) => {
    expect(findUpdateTarget(clients(), 'id', empty, false)).toEqual({ target: undefined, matchedByRecordId: false });
  });

  it.each([undefined, null, ''])('an empty filter value (%s) matches nothing — data field filter', (empty) => {
    // client-1 has no client_code: the plain find() returned it for `undefined`.
    expect(findUpdateTarget(clients(), 'client_code', empty, false).target).toBeUndefined();
  });

  it('a literal id filter matches the record id', () => {
    const m = findUpdateTarget(clients(), 'id', 'client-3', false);
    expect(m.target?.id).toBe('client-3');
    expect(m.matchedByRecordId).toBe(true);
  });

  it('a literal id filter that misses matches nothing', () => {
    expect(findUpdateTarget(clients(), 'id', 'client-gone', false).target).toBeUndefined();
  });

  it('a lookup-aware filter matches by id on a non-id field', () => {
    const m = findUpdateTarget(clients(), 'client_id', 'client-2', true);
    expect(m.target?.id).toBe('client-2');
    expect(m.matchedByRecordId).toBe(true);
  });

  it('a lookup-aware filter that misses by id still falls back to the field', () => {
    const list = [...clients(), rec('client-4', CLIENTS, { parent_ref: 'legacy-9' })];
    const m = findUpdateTarget(list, 'parent_ref', 'legacy-9', true);
    expect(m.target?.id).toBe('client-4');
    expect(m.matchedByRecordId).toBe(false);
  });

  it('a business-key filter matches on the data field', () => {
    const m = findUpdateTarget(clients(), 'client_code', 'C-300', false);
    expect(m.target?.id).toBe('client-3');
    expect(m.matchedByRecordId).toBe(false);
  });

  it('0 and false are real filter values, not empty ones', () => {
    const list = [rec('a', CLIENTS, { score: 5 }), rec('b', CLIENTS, { score: 0, vip: false })];
    expect(findUpdateTarget(list, 'score', 0, false).target?.id).toBe('b');
    expect(findUpdateTarget(list, 'vip', false, false).target?.id).toBe('b');
  });
});

/* ── the engine, end to end ──────────────────────────────────────────────── */

const model = (id: string, fields: Array<Record<string, unknown>>): AppModel => ({
  id,
  name: id,
  label_ar: id,
  label_en: id,
  schema: { sections: [{ id: `${id}-s`, label_ar: 's', label_en: 's', order: 0, is_base: true, fields }] },
}) as unknown as AppModel;

const MODELS = [
  model(CLIENTS, [
    { id: 'cf1', name: 'client_stage', type: 'text' },
    { id: 'cf2', name: 'client_code', type: 'text' },
  ]),
  model(APPOINTMENTS, [
    { id: 'af1', name: 'client_id', type: 'lookup', lookup_model_id: CLIENTS },
    { id: 'af2', name: 'client_code', type: 'text' },
  ]),
];

/** "When an appointment is created, move its client to the appointment stage." */
const workflow = (filter: Record<string, unknown>): Workflow => ({
  id: 'wf-1',
  label_ar: 'موعد',
  label_en: 'Appointment booked',
  trigger_model_id: APPOINTMENTS,
  trigger_event: 'create',
  is_active: true,
  conditions: [],
  actions: [],
  branches: [{
    id: 'b1',
    conditions: [],
    actions: [{
      id: 'a1',
      type: 'update_record',
      target_model_id: CLIENTS,
      filter_value: '',
      field_mappings: [
        { id: 'm1', target_field_id: 'client_stage', source_type: 'static', static_value: 'موعد' },
      ],
      ...filter,
    }],
  }],
  created_at: NOW,
  updated_at: NOW,
}) as unknown as Workflow;

const BY_CLIENT_ID = { filter_field_id: 'id', filter_value_source: 'trigger_field', filter_trigger_field_id: 'client_id' };

async function run(wf: Workflow, appointmentData: Record<string, unknown>) {
  const saved: AppRecord[] = [];
  const runs: WorkflowRun[] = [];
  await executeWorkflows(
    'create',
    rec('appt-1', APPOINTMENTS, appointmentData),
    undefined,
    [wf],
    MODELS,
    { [CLIENTS]: clients(), [APPOINTMENTS]: [] },
    [],
    [],
    (record) => { saved.push(record); },
    vi.fn(),
    null,
    0,
    (r) => { runs.push(r); },
  );
  return { saved, action: runs[0]?.actions_trace?.[0] as Record<string, unknown> | undefined };
}

describe('browser engine — update_record', () => {
  it('an appointment with NO client updates nobody (it used to update the first client)', async () => {
    const { saved, action } = await run(workflow(BY_CLIENT_ID), { appointment_date: NOW });
    expect(saved).toHaveLength(0);
    expect(action).toMatchObject({ type: 'update_record', status: 'skipped', skip_reason: 'no_matching_record' });
  });

  it('an appointment with an EMPTY-STRING client updates nobody', async () => {
    const { saved, action } = await run(workflow(BY_CLIENT_ID), { client_id: '' });
    expect(saved).toHaveLength(0);
    expect(action).toMatchObject({ status: 'skipped', skip_reason: 'no_matching_record' });
  });

  it('an appointment with a client updates exactly that client', async () => {
    const { saved, action } = await run(workflow(BY_CLIENT_ID), { client_id: 'client-3' });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.id).toBe('client-3');
    expect(saved[0]?.data).toMatchObject({ client_stage: 'موعد', client_code: 'C-300' });
    expect(action).toMatchObject({ status: 'executed', matched_record_id: 'client-3', matched_by_record_id: true });
  });

  it('a lookup-aware filter on a non-id field still matches the client by id', async () => {
    const wf = workflow({ filter_field_id: 'client_id', filter_value_source: 'trigger_field', filter_trigger_field_id: 'client_id' });
    const { saved, action } = await run(wf, { client_id: 'client-2' });
    expect(saved.map((r) => r.id)).toEqual(['client-2']);
    expect(action).toMatchObject({ status: 'executed', matched_by_record_id: true });
  });

  it('a business-key filter with a missing trigger value updates nobody', async () => {
    // client-1 has no client_code, so `undefined === undefined` used to pick it.
    const wf = workflow({ filter_field_id: 'client_code', filter_value_source: 'trigger_field', filter_trigger_field_id: 'client_code' });
    const { saved, action } = await run(wf, { client_id: 'client-2' });
    expect(saved).toHaveLength(0);
    expect(action).toMatchObject({ status: 'skipped', skip_reason: 'no_matching_record' });
  });

  it('a business-key filter with a value still matches on the field', async () => {
    const wf = workflow({ filter_field_id: 'client_code', filter_value_source: 'trigger_field', filter_trigger_field_id: 'client_code' });
    const { saved, action } = await run(wf, { client_code: 'C-200' });
    expect(saved.map((r) => r.id)).toEqual(['client-2']);
    expect(action).toMatchObject({ status: 'executed', matched_record_id: 'client-2', matched_by_record_id: false });
  });
});
