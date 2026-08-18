import { describe, it, expect } from 'vitest';
import {
  buildPreferencePatch, preferencesDirty, saveClientPreferences, type SaveRecordFn,
} from '../preferences';
import type { AppRecord, SaveResult } from '@/types';

const SLUGS = ['budget', 'preferred_area'] as const;

function client(data: Record<string, unknown>, version: number | null = 3): AppRecord {
  return {
    id: 'c1',
    model_id: 'm1',
    data,
    version,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  } as unknown as AppRecord;
}

const stubSave = (result: SaveResult) => {
  const calls: { record: AppRecord; expectedVersion?: number | null }[] = [];
  const fn: SaveRecordFn = async (record, opts) => {
    calls.push({ record, expectedVersion: opts?.expectedVersion });
    return result;
  };
  return { fn, calls };
};

describe('buildPreferencePatch', () => {
  it('writes every slug, including cleared ones', () => {
    const patch = buildPreferencePatch({ budget: { min: 1, max: 2 } }, SLUGS);
    expect(patch).toEqual({ budget: { min: 1, max: 2 }, preferred_area: undefined });
  });

  it('carries sidecar keys ONLY when the draft has them', () => {
    expect(buildPreferencePatch({ location_items: [{ id: 'x' }] }, SLUGS).location_items).toEqual([{ id: 'x' }]);
    expect('location_items' in buildPreferencePatch({}, SLUGS)).toBe(false);
    expect('preference_constraints' in buildPreferencePatch({}, SLUGS)).toBe(false);
  });
});

describe('preferencesDirty', () => {
  const saved = { budget: { min: 1, max: 2 }, preferred_area: null, other: 'untouched' };

  it('is false for an untouched draft', () => {
    expect(preferencesDirty(saved, { ...saved }, SLUGS)).toBe(false);
  });

  it('is true when a tracked slug changed', () => {
    expect(preferencesDirty(saved, { ...saved, budget: { min: 1, max: 9 } }, SLUGS)).toBe(true);
  });

  it('ignores fields outside the tracked set', () => {
    expect(preferencesDirty(saved, { ...saved, other: 'changed' }, SLUGS)).toBe(false);
  });

  it('is true when a sidecar key the draft carries changed, and never when it is absent', () => {
    expect(preferencesDirty(saved, { ...saved, location_items: [{ id: 'x' }] }, SLUGS)).toBe(true);
    expect(preferencesDirty({ ...saved, location_items: [{ id: 'x' }] }, { ...saved }, SLUGS)).toBe(false);
  });
});

describe('saveClientPreferences', () => {
  it('patches ONLY the preference keys onto the record and sends the pinned version', async () => {
    const { fn, calls } = stubSave({ status: 'saved' });
    const res = await saveClientPreferences({
      client: client({ budget: { min: 1, max: 2 }, client_name: 'سعد' }),
      draft: { budget: { min: 5, max: 9 }, client_name: 'OVERWRITE ME NOT' },
      slugs: SLUGS,
      saveRecord: fn,
      expectedVersion: 3,
      isAr: false,
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('saved');
    expect(res.nextVersion).toBe(4);
    expect(calls[0].expectedVersion).toBe(3);
    expect(calls[0].record.data.budget).toEqual({ min: 5, max: 9 });
    // Non-preference fields keep the SAVED value, never the draft's.
    expect(calls[0].record.data.client_name).toBe('سعد');
  });

  it('surfaces a conflict as a failure and does not advance the version', async () => {
    const { fn } = stubSave({ status: 'conflict', message: 'version_mismatch', kind: 'version_mismatch' });
    const res = await saveClientPreferences({
      client: client({}), draft: {}, slugs: SLUGS, saveRecord: fn, expectedVersion: 3, isAr: true,
    });
    expect(res.ok).toBe(false);
    expect(res.tone).toBe('error');
    expect(res.nextVersion).toBe(3);
    expect(res.message).toContain('مكان آخر');
  });

  it('reports a queued write as a non-error and keeps the loaded version', async () => {
    const { fn } = stubSave({ status: 'queued', reason: 'offline' });
    const res = await saveClientPreferences({
      client: client({}), draft: {}, slugs: SLUGS, saveRecord: fn, expectedVersion: 3, isAr: false,
    });
    expect(res.ok).toBe(true);
    expect(res.tone).toBe('info');
    expect(res.nextVersion).toBe(3);
  });

  it('defaults expectedVersion to the record version when omitted', async () => {
    const { fn, calls } = stubSave({ status: 'saved' });
    await saveClientPreferences({ client: client({}, 7), draft: {}, slugs: SLUGS, saveRecord: fn, isAr: false });
    expect(calls[0].expectedVersion).toBe(7);
  });
});
