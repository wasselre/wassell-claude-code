/**
 * Regression tests for the 1,000-row truncation in the on_due sweeper
 * (fixed 2026-10-03).
 *
 * The sweeper used to load a whole model with a bare `.select()` and search it
 * in memory. PostgREST caps a response at 1,000 rows WITHOUT an error, so on a
 * model past 1,000 rows the `update_record` target was usually not in the list
 * and the action skipped with `no_matching_record`. On `followups` that left
 * WhatsApp tasks open after their no-response escalation had already fired.
 *
 * The fake client below reproduces the one PostgREST behaviour that matters:
 * every select is silently cut at `maxRows`, whatever the caller asked for.
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runOnDueForRecord, type SweeperContext } from '../workflowSweeper';
import {
  loadAllRecordsForModel,
  loadRecordById,
  resolveUpdateTarget,
  WORKFLOW_RECORD_PAGE_SIZE,
} from '../workflowRecordLoad';
import type { AppModel, AppRecord, Workflow } from '../../../src/types';

/* ── a PostgREST-shaped fake ─────────────────────────────────────────────── */

interface Row {
  id: string;
  model_id: string;
  data: Record<string, unknown>;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface QueryResult {
  data: Row[] | null;
  error: { message: string } | null;
}

interface FakeOptions {
  /** The server's silent row cap (PostgREST `db-max-rows`). */
  maxRows?: number;
  /** Every select fails with this message. */
  failSelects?: string;
  /** Selects fail once this many have succeeded (an error mid-walk). */
  failAfterSelects?: number;
  /** A broken server that ignores the keyset cursor (`gt`). */
  ignoreCursor?: boolean;
}

interface SaveCall {
  p_model_id: string;
  p_id: string;
  p_data: Record<string, unknown>;
}

class FakeDb {
  /** Heap order — what an un-ordered select returns. */
  rows: Row[];
  saves: SaveCall[] = [];
  runs: Array<Record<string, unknown>> = [];
  selects = 0;
  readonly maxRows: number;

  constructor(rows: Row[], readonly opts: FakeOptions = {}) {
    this.rows = rows;
    this.maxRows = opts.maxRows ?? 1000;
  }

  client(): SupabaseClient {
    const from = (table: string) => {
      if (table === 'workflow_runs') {
        return {
          insert: async (row: Record<string, unknown>) => {
            this.runs.push(row);
            return { error: null };
          },
        };
      }
      if (table === 'unified_records') return new FakeQuery(this);
      throw new Error(`FakeDb: unexpected table ${table}`);
    };
    const rpc = async (fn: string, args: SaveCall) => {
      if (fn !== 'record_save') throw new Error(`FakeDb: unexpected rpc ${fn}`);
      this.saves.push(args);
      const existing = this.rows.find((r) => r.id === args.p_id);
      if (existing) {
        existing.data = args.p_data;
      } else {
        this.rows.push({
          id: args.p_id,
          model_id: args.p_model_id,
          data: args.p_data,
          created_by_user_id: null,
          created_at: NOW,
          updated_at: NOW,
        });
      }
      return { error: null };
    };
    return { from, rpc } as unknown as SupabaseClient;
  }

  row(id: string): Row {
    const found = this.rows.find((r) => r.id === id);
    if (!found) throw new Error(`FakeDb: no row ${id}`);
    return found;
  }
}

class FakeQuery implements PromiseLike<QueryResult> {
  private filters: Array<(r: Row) => boolean> = [];
  private orderCol: string | null = null;
  private max: number | null = null;

  constructor(private readonly db: FakeDb) {}

  private static col(r: Row, col: string): unknown {
    return (r as unknown as Record<string, unknown>)[col];
  }

  select(_columns: string): this { return this; }

  eq(col: string, value: unknown): this {
    this.filters.push((r) => FakeQuery.col(r, col) === value);
    return this;
  }

  gt(col: string, value: string): this {
    if (!this.db.opts.ignoreCursor) {
      this.filters.push((r) => String(FakeQuery.col(r, col)) > value);
    }
    return this;
  }

  order(col: string, _opts?: { ascending: boolean }): this {
    this.orderCol = col;
    return this;
  }

  limit(n: number): this {
    this.max = n;
    return this;
  }

  then<A = QueryResult, B = never>(
    onFulfilled?: ((value: QueryResult) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }

  private run(): QueryResult {
    const { failSelects, failAfterSelects } = this.db.opts;
    if (failSelects) return { data: null, error: { message: failSelects } };
    if (failAfterSelects !== undefined && this.db.selects >= failAfterSelects) {
      return { data: null, error: { message: 'connection reset' } };
    }
    this.db.selects += 1;
    let out = this.db.rows.filter((r) => this.filters.every((f) => f(r)));
    const orderCol = this.orderCol;
    if (orderCol) {
      // Plain code-unit order — the same comparison `gt` uses above, and (for
      // lowercase uuids) the order Postgres sorts uuid values in.
      out = [...out].sort((a, b) => {
        const x = String(FakeQuery.col(a, orderCol));
        const y = String(FakeQuery.col(b, orderCol));
        return x < y ? -1 : x > y ? 1 : 0;
      });
    }
    if (this.max !== null) out = out.slice(0, this.max);
    // The behaviour under test: a silent cap, no error, no hint it happened.
    out = out.slice(0, this.db.maxRows);
    return { data: out.map((r) => ({ ...r, data: { ...r.data } })), error: null };
  }
}

/* ── fixtures ────────────────────────────────────────────────────────────── */

const NOW = '2026-10-03T09:00:00.000Z';
const FOLLOWUPS = '764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63';
const CLIENT = '6c9e0c10-7af3-4547-b004-d1b813549317';

/** Deterministic uuid whose string order is its index order. */
function uid(i: number): string {
  return `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
}

function followup(i: number, data: Record<string, unknown> = {}): Row {
  return {
    id: uid(i),
    model_id: FOLLOWUPS,
    data: { followup_status: 'completed', client_id: uid(900000 + i), ...data },
    created_by_user_id: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** `count` follow-ups; the row at `index` is replaced by `special`. */
function followups(count: number, special: Record<number, Record<string, unknown>> = {}): Row[] {
  return Array.from({ length: count }, (_, i) => followup(i, special[i]));
}

const waitingWaTask = (id: string): Record<string, unknown> => ({
  client_id: CLIENT,
  sales_rep: 'rep-1',
  followup_type: ['whatsapp_follow_up'],
  followup_status: 'in_progress',
  whatsapp_state: 'message_sent_waiting_response',
  whatsapp_attempt_number: 2,
  source_followup_id: id,
  sent_at: '2026-10-02T08:00:00Z',
  fired_at: NOW,
});

const FOLLOWUPS_MODEL = {
  id: FOLLOWUPS,
  name: 'followups',
  label_ar: 'المتابعات',
  label_en: 'Follow-ups',
  schema: {
    sections: [{
      id: 's1',
      label_ar: 'أساسي',
      label_en: 'Base',
      order: 0,
      is_base: true,
      fields: [
        { id: 'f1', name: 'source_followup_id', type: 'lookup', lookup_model_id: FOLLOWUPS },
        { id: 'f2', name: 'client_id', type: 'lookup', lookup_model_id: 'clients-model' },
        { id: 'f3', name: 'external_ref', type: 'text' },
      ],
    }],
  },
} as unknown as AppModel;

const closeWaitingTask = (filter: Record<string, unknown>) => ({
  id: 'act-update',
  type: 'update_record',
  target_model_id: FOLLOWUPS,
  field_mappings: [
    { id: 'm1', target_field_id: 'call_result', source_type: 'static', static_value: 'no_response' },
    { id: 'm2', target_field_id: 'whatsapp_state', source_type: 'static', static_value: 'no_response_expired' },
    { id: 'm3', target_field_id: 'followup_status', source_type: 'static', static_value: 'completed' },
  ],
  ...filter,
});

const BY_SOURCE_ID = {
  filter_field_id: 'id',
  filter_value_source: 'trigger_field',
  filter_trigger_field_id: 'source_followup_id',
  filter_value: '',
};

const createBookingCall = (extra: Record<string, unknown> = {}) => ({
  id: 'act-create',
  type: 'create_record',
  target_model_id: FOLLOWUPS,
  field_mappings: [
    { id: 'c1', target_field_id: 'client_id', source_type: 'trigger_field', trigger_field_id: 'client_id' },
    { id: 'c2', target_field_id: 'followup_type', source_type: 'static', static_value: 'appointment_booking_call' },
    { id: 'c3', target_field_id: 'followup_status', source_type: 'static', static_value: 'open' },
    { id: 'c4', target_field_id: 'escalation_reason', source_type: 'static', static_value: 'whatsapp_no_response_5d' },
    { id: 'c5', target_field_id: 'previous_followup_id', source_type: 'record_id' },
  ],
  ...extra,
});

/** The live "WhatsApp No-Response Escalation" day-5 branch, in miniature. */
function escalation(actions: Array<Record<string, unknown>>): Workflow {
  return {
    id: '918b2540-1e07-42b9-8988-ddcfa02b9e8a',
    label_ar: 'تصعيد عدم رد الواتساب',
    label_en: 'WhatsApp No-Response Escalation',
    trigger_model_id: FOLLOWUPS,
    trigger_event: 'on_due',
    is_active: true,
    conditions: [],
    actions: [],
    branches: [{
      id: 'branch-5d',
      conditions: [
        { id: 'k1', field_id: 'followup_type', operator: 'equals', value: 'whatsapp_follow_up' },
        { id: 'k2', field_id: 'whatsapp_state', operator: 'equals', value: 'message_sent_waiting_response' },
        { id: 'k3', field_id: 'whatsapp_attempt_number', operator: 'equals', value: 2 },
      ],
      actions,
    }],
    created_at: NOW,
    updated_at: NOW,
  } as unknown as Workflow;
}

function sweep(db: FakeDb, workflow: Workflow): SweeperContext {
  return { supabase: db.client(), models: [FOLLOWUPS_MODEL], workflows: [workflow], recordsByModel: new Map() };
}

function asTrigger(row: Row): AppRecord {
  return { id: row.id, model_id: row.model_id, data: { ...row.data }, created_at: row.created_at, updated_at: row.updated_at };
}

/* ── the sweeper ─────────────────────────────────────────────────────────── */

describe('on_due sweeper — update_record on a model past 1,000 rows', () => {
  const TOTAL = 2500;
  const LAST = TOTAL - 1;

  it('the fixture reproduces the bug: a bare select is cut at 1,000 and misses the target', async () => {
    const db = new FakeDb(followups(TOTAL, { [LAST]: waitingWaTask(uid(LAST)) }));
    const { data } = await db.client()
      .from('unified_records')
      .select('id, model_id, data')
      .eq('model_id', FOLLOWUPS);
    expect(data).toHaveLength(1000);
    expect((data ?? []).some((r) => r.id === uid(LAST))).toBe(false);
  });

  it('closes the waiting WhatsApp task when it sits beyond the first page', async () => {
    const db = new FakeDb(followups(TOTAL, { [LAST]: waitingWaTask(uid(LAST)) }));
    const workflow = escalation([closeWaitingTask(BY_SOURCE_ID), createBookingCall()]);

    const [summary] = await runOnDueForRecord(asTrigger(db.row(uid(LAST))), sweep(db, workflow));

    expect(summary?.selected_branch_id).toBe('branch-5d');
    expect(summary?.actions[0]).toMatchObject({
      type: 'update_record',
      status: 'executed',
      detail: { matched_record_id: uid(LAST) },
    });
    // The task is closed, and nothing it already carried was dropped.
    expect(db.row(uid(LAST)).data).toMatchObject({
      call_result: 'no_response',
      whatsapp_state: 'no_response_expired',
      followup_status: 'completed',
      fired_at: NOW,
      client_id: CLIENT,
      source_followup_id: uid(LAST),
    });
    // The booking call still follows it.
    expect(summary?.actions[1]).toMatchObject({ type: 'create_record', status: 'executed' });
    const created = db.rows.filter((r) => r.data.escalation_reason === 'whatsapp_no_response_5d');
    expect(created).toHaveLength(1);
    expect(created[0]?.data.previous_followup_id).toBe(uid(LAST));
    expect(summary?.status).toBe('success');
    // And the run log says "executed", not "skipped".
    const trace = (db.runs[0]?.actions_trace ?? []) as Array<Record<string, unknown>>;
    expect(trace[0]).toMatchObject({ type: 'update_record', status: 'executed', matched_record_id: uid(LAST) });
  });

  it('reads the target by id — it does not pull the whole model to find one row', async () => {
    const db = new FakeDb(followups(TOTAL, { [LAST]: waitingWaTask(uid(LAST)) }));
    const workflow = escalation([closeWaitingTask(BY_SOURCE_ID)]);

    await runOnDueForRecord(asTrigger(db.row(uid(LAST))), sweep(db, workflow));

    expect(db.selects).toBe(1);
  });

  it('a field-equality filter scans every page, not just the first', async () => {
    const TARGET = 2300;
    const db = new FakeDb(followups(TOTAL, {
      [TARGET]: { external_ref: 'REF-77', followup_status: 'open' },
      [LAST]: waitingWaTask(uid(LAST)),
    }));
    const workflow = escalation([
      closeWaitingTask({ filter_field_id: 'external_ref', filter_value_source: 'static', filter_value: 'REF-77' }),
    ]);

    const [summary] = await runOnDueForRecord(asTrigger(db.row(uid(LAST))), sweep(db, workflow));

    expect(summary?.actions[0]).toMatchObject({ status: 'executed', detail: { matched_record_id: uid(TARGET) } });
    expect(db.row(uid(TARGET)).data.followup_status).toBe('completed');
  });

  it('skip_if_exists sees a duplicate that sits beyond the first page', async () => {
    const DUP = 2200;
    const db = new FakeDb(followups(TOTAL, {
      [DUP]: { client_id: CLIENT, followup_status: 'open', escalation_reason: 'whatsapp_no_response_5d' },
      [LAST]: waitingWaTask(uid(LAST)),
    }));
    const workflow = escalation([createBookingCall({ skip_if_exists: true, dedup_target_field_id: 'escalation_reason' })]);

    const [summary] = await runOnDueForRecord(asTrigger(db.row(uid(LAST))), sweep(db, workflow));

    expect(summary?.actions[0]).toMatchObject({
      type: 'create_record',
      status: 'skipped',
      reason: 'duplicate_exists',
      detail: { matched_record_id: uid(DUP) },
    });
    expect(db.saves).toHaveLength(0);
  });

  it('a failed read is a FAILED action with the error — never a quiet no_matching_record', async () => {
    const db = new FakeDb(
      followups(TOTAL, { [LAST]: waitingWaTask(uid(LAST)) }),
      { failSelects: 'canceling statement due to statement timeout' },
    );
    const workflow = escalation([closeWaitingTask(BY_SOURCE_ID)]);

    const [summary] = await runOnDueForRecord(asTrigger(db.row(uid(LAST))), sweep(db, workflow));

    expect(summary?.actions[0]).toMatchObject({ type: 'update_record', status: 'failed', reason: 'exception' });
    expect(String(summary?.actions[0]?.detail?.message)).toContain('statement timeout');
    expect(summary?.status).toBe('failed');
    expect(db.saves).toHaveLength(0);
  });

  it('an empty filter value updates nothing (it used to match the first record lacking the field)', async () => {
    const task = waitingWaTask(uid(LAST));
    delete task.source_followup_id;
    const db = new FakeDb(followups(TOTAL, { [LAST]: task }));
    const workflow = escalation([closeWaitingTask(BY_SOURCE_ID)]);

    const [summary] = await runOnDueForRecord(asTrigger(db.row(uid(LAST))), sweep(db, workflow));

    expect(summary?.actions[0]).toMatchObject({ status: 'skipped', reason: 'no_matching_record' });
    expect(db.saves).toHaveLength(0);
  });
});

/* ── the shared loaders ──────────────────────────────────────────────────── */

describe('loadAllRecordsForModel', () => {
  it('returns every row of a model past the cap, in id order', async () => {
    const db = new FakeDb(followups(3755));
    const rows = await loadAllRecordsForModel(db.client(), FOLLOWUPS);
    expect(rows).toHaveLength(3755);
    expect(rows[0]?.id).toBe(uid(0));
    expect(rows[3754]?.id).toBe(uid(3754));
    expect(new Set(rows.map((r) => r.id)).size).toBe(3755);
  });

  it('terminates on a model that is an exact multiple of the page size', async () => {
    const db = new FakeDb(followups(WORKFLOW_RECORD_PAGE_SIZE * 2));
    const rows = await loadAllRecordsForModel(db.client(), FOLLOWUPS);
    expect(rows).toHaveLength(WORKFLOW_RECORD_PAGE_SIZE * 2);
    expect(db.selects).toBe(3); // two full pages + the empty page that ends the walk
  });

  it('still returns everything when the server cap is LOWER than the page size', async () => {
    // A "short page ends the walk" rule would stop after the first 500 here.
    const db = new FakeDb(followups(1750), { maxRows: 500 });
    const rows = await loadAllRecordsForModel(db.client(), FOLLOWUPS);
    expect(rows).toHaveLength(1750);
  });

  it('only returns the requested model', async () => {
    const other: Row = { ...followup(5000), model_id: 'another-model' };
    const db = new FakeDb([...followups(1200), other]);
    const rows = await loadAllRecordsForModel(db.client(), FOLLOWUPS);
    expect(rows).toHaveLength(1200);
  });

  it('throws when a page fails mid-walk — a partial list is never returned', async () => {
    const db = new FakeDb(followups(2500), { failAfterSelects: 1 });
    await expect(loadAllRecordsForModel(db.client(), FOLLOWUPS)).rejects.toThrow(/after 1000 rows: connection reset/);
  });

  it('throws instead of looping forever when the cursor does not advance', async () => {
    const db = new FakeDb(followups(1500), { ignoreCursor: true });
    await expect(loadAllRecordsForModel(db.client(), FOLLOWUPS)).rejects.toThrow(/cursor did not advance/);
  });
});

describe('loadRecordById', () => {
  it('finds a row far past the first page with one query', async () => {
    const db = new FakeDb(followups(3755));
    const rec = await loadRecordById(db.client(), FOLLOWUPS, uid(3700));
    expect(rec?.id).toBe(uid(3700));
    expect(db.selects).toBe(1);
  });

  it('returns null for an id in another model', async () => {
    const db = new FakeDb(followups(10));
    expect(await loadRecordById(db.client(), 'another-model', uid(3))).toBeNull();
  });

  it('returns null for a value that is not a uuid, without a round trip', async () => {
    const db = new FakeDb(followups(10));
    expect(await loadRecordById(db.client(), FOLLOWUPS, 'REF-77')).toBeNull();
    expect(db.selects).toBe(0);
  });

  it('throws on a query error', async () => {
    const db = new FakeDb(followups(10), { failSelects: 'permission denied' });
    await expect(loadRecordById(db.client(), FOLLOWUPS, uid(3))).rejects.toThrow(/permission denied/);
  });
});

describe('resolveUpdateTarget', () => {
  const base = (db: FakeDb) => ({
    supabase: db.client(),
    targetModelId: FOLLOWUPS,
    loadAll: () => loadAllRecordsForModel(db.client(), FOLLOWUPS),
  });

  it('matches by id for a lookup-aware filter on a non-id field', async () => {
    const db = new FakeDb(followups(2500));
    const target = await resolveUpdateTarget({
      ...base(db), filterFieldId: 'client_id', filterValue: uid(2400), matchById: true,
    });
    expect(target?.id).toBe(uid(2400));
    expect(db.selects).toBe(1);
  });

  it('falls back to the field scan when the id lookup misses', async () => {
    const db = new FakeDb(followups(2500, { 2100: { client_id: CLIENT } }));
    const target = await resolveUpdateTarget({
      ...base(db), filterFieldId: 'client_id', filterValue: CLIENT, matchById: true,
    });
    expect(target?.id).toBe(uid(2100));
  });

  it('an id filter that misses does not scan the model', async () => {
    const db = new FakeDb(followups(2500));
    const target = await resolveUpdateTarget({
      ...base(db), filterFieldId: 'id', filterValue: uid(999999), matchById: false,
    });
    expect(target).toBeUndefined();
    expect(db.selects).toBe(1);
  });

  it.each([undefined, null, ''])('an empty filter value (%s) matches nothing and reads nothing', async (empty) => {
    const db = new FakeDb(followups(50));
    const target = await resolveUpdateTarget({
      ...base(db), filterFieldId: 'external_ref', filterValue: empty, matchById: false,
    });
    expect(target).toBeUndefined();
    expect(db.selects).toBe(0);
  });
});
