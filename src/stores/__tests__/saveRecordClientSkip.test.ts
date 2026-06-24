import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Client-skip proof (the UI Save path) -----------------------------------
// The browser "Save" button calls the store's `saveRecord` action. After the
// save settles, saveRecord schedules the client workflow engine in a
// queueMicrotask. The server-authoritative guard (appStore.ts) must SKIP that
// engine when the record's model is enrolled in workflow_capture_models — the
// Fly worker is then the sole executor, so running the client engine too would
// double-fire (duplicate follow-ups). This test drives the REAL saveRecord
// action (supabase is null in the test env → offline path) and asserts the
// guard skips for an enrolled model and still fires for a non-enrolled control.
// ----------------------------------------------------------------------------

// In-memory localStorage shim — saveLocal() writes the offline mirror.
const mem = new Map<string, string>();
// @ts-expect-error minimal Storage shim for the node test env
globalThis.localStorage = {
  getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
  clear: () => mem.clear(),
  key: () => null,
  get length() {
    return mem.size;
  },
};

// Spy on the client workflow engine — the thing the guard must (not) call.
vi.mock('@/lib/workflowEngine', () => ({
  executeWorkflows: vi.fn(() => Promise.resolve()),
  executeWebhookWorkflows: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from '@/stores/appStore';
import { executeWorkflows } from '@/lib/workflowEngine';

// queueMicrotask + the engine's promise resolve on the microtask/macrotask
// queue; a setTimeout(0) flush lets both settle before we assert.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const model = (id: string) =>
  ({
    id,
    name: id,
    label_ar: id,
    label_en: id,
    group_id: null,
    order: 0,
    is_system: false,
    schema: { sections: [], section_selector_field_id: null },
  }) as never;

const record = (id: string, model_id: string) =>
  ({
    id,
    model_id,
    data: {},
    created_at: '2026-06-24T00:00:00.000Z',
    updated_at: '2026-06-24T00:00:00.000Z',
  }) as never;

describe('saveRecord client-skip for server-enrolled models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mem.clear();
    useAppStore.setState({
      models: [model('M_ENROLLED'), model('M_FREE')],
      records: {},
      workflows: [],
      users: [],
      roles: [],
      serverEnrolledModelIds: new Set<string>(['M_ENROLLED']),
    } as never);
  });

  it('SKIPS the client engine when the model is server-enrolled', async () => {
    await useAppStore.getState().saveRecord(record('r-enrolled', 'M_ENROLLED'));
    await flush();
    expect(executeWorkflows).not.toHaveBeenCalled();
  });

  it('FIRES the client engine when the model is NOT enrolled (control)', async () => {
    await useAppStore.getState().saveRecord(record('r-free', 'M_FREE'));
    await flush();
    expect(executeWorkflows).toHaveBeenCalledTimes(1);
  });

  it('FIRES once enrollment is removed (unenroll restores client behavior)', async () => {
    useAppStore.setState({ serverEnrolledModelIds: new Set<string>() } as never);
    await useAppStore.getState().saveRecord(record('r-unenrolled', 'M_ENROLLED'));
    await flush();
    expect(executeWorkflows).toHaveBeenCalledTimes(1);
  });
});
