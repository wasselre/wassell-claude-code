import { describe, expect, it, vi } from 'vitest';
import { applyResult, patchRecord } from '../projectUpdates/apply';
import { reconcile } from '../projectUpdates/reconcile';
import type { SupabaseClient } from '@supabase/supabase-js';

const CTX = { projectId: 'project', developerId: 'developer', projectName: 'Synthetic project', sourceLabel: 'test', today: '2026-10-05' };
const tuple = { total_price: 1_021_103, source_price: 1_000_000, source_currency: 'AED', source_fx_rate: 1.021103 };

function clientFor(data: Record<string, unknown>) {
  const changes: Record<string, unknown>[] = [];
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) => table === 'project_update_changes' ? {
    insert: async (change: Record<string, unknown>) => { changes.push(change); return { error: null }; },
  } : {
    select: () => ({ eq: () => ({ single: async () => ({ data: { model_id: 'units-model', version: 1, created_by_user_id: null, data }, error: null }) }) }),
  });
  return { client: { from, rpc } as unknown as SupabaseClient, changes, rpc };
}

describe('project update foreign-price audit and final write boundary', () => {
  it('logs every price tuple part before and after when only AED changed', async () => {
    const before = { developer_unit_code: 'EXAMPLE', unit_status: 'available', ...tuple, source_price: 999_999.99 };
    const { client, changes, rpc } = clientFor(before);
    const result = reconcile([{ id: 'unit', data: before }], [{ sourceId: 'portal-unit', unitModel: 'EXAMPLE', unitCode: 'EXAMPLE',
      price: tuple.total_price, sourcePrice: tuple.source_price, sourceCurrency: 'AED', sourceFxRate: tuple.source_fx_rate }],
    { absentAvailable: 'leave', createMissing: false, updatePrices: true }, CTX);
    const outcome = await applyResult(client, { runId: 'run', projectId: 'project', projectName: 'test', sourceLabel: 'test', result });
    expect(outcome.updated).toBe(1);
    expect(rpc.mock.calls[0]?.[1].p_data).toMatchObject(tuple);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.before).toEqual({ ...tuple, source_price: 999_999.99 });
    expect(changes[0]?.after).toEqual(tuple);
  });
  it('logs only changed keys for a normal patch, including a stale status value', async () => {
    const { client, changes } = clientFor({ unit_status: 'sold', total_price: 100 });
    const result = reconcile([{ id: 'unit', data: { unit_model: 'EXAMPLE', unit_status: 'available', total_price: 100 } }],
      [{ sourceId: 'portal', unitModel: 'EXAMPLE', price: 200, status: 'sold' }],
      { absentAvailable: 'leave', createMissing: false, updatePrices: true }, CTX);
    await applyResult(client, { runId: 'run', projectId: 'project', projectName: 'test', sourceLabel: 'test', result });
    expect(changes[0]?.before).toEqual({ total_price: 100 });
    expect(changes[0]?.after).toEqual({ total_price: 200 });
  });
  it('refuses partial or inconsistent foreign-price writes at the save boundary', async () => {
    const { client, rpc } = clientFor({});
    await expect(patchRecord(client, 'unit', { source_price: 1_000_000 })).rejects.toThrow(/provenance/);
    await expect(patchRecord(client, 'unit', { ...tuple, total_price: 1 })).rejects.toThrow(/provenance/);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('skips an already applied complete tuple without a write or audit', async () => {
    const { client, rpc } = clientFor(tuple);
    expect(await patchRecord(client, 'unit', tuple)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
