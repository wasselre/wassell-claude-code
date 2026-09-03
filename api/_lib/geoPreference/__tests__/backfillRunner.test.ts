import { describe, it, expect, beforeAll } from 'vitest';
import { extract, type Conversation } from '../extractor.js';
import { runReviewFirst } from '../orchestrator.js';
import type { ProposalStore, ProposalInput, ProposalRecord, RunContext } from '../orchestrator.js';
import type { ResolverDb } from '../resolver.js';
import type { SatUniverse } from '../satisfiability.js';
import type { GateConfig } from '../gate.js';
import {
  processBackfillJob, runBackfillBatch, type BackfillDeps, type BackfillJob,
} from '../backfillRunner.js';

/**
 * Backfill INVOCATION-PATH tests. Uses the REAL Stage-A extractor (stub mode, no
 * LLM) and the REAL review-first orchestrator, wired to in-memory fakes for the
 * queue, the resolver DB, and the proposal store. Proves the four properties the
 * task requires:
 *   (a) re-enqueue creates NO duplicate jobs,
 *   (b) a failing client is ISOLATED (siblings still process),
 *   (c) a re-run SKIPS done jobs,
 *   (d) NO duplicate proposals for the same (client, checkpoint) across re-runs.
 */

beforeAll(() => {
  process.env.WA_EXTRACT_STUB = '1'; // deterministic, offline extraction
});

// ── fake queue: models geo_pref_backfill_jobs incl. UNIQUE(run_id, client_id) ──
interface Row { id: string; runId: string; clientId: string; status: 'pending' | 'running' | 'done' | 'failed'; attempts: number; lastError?: string }
class FakeQueue {
  rows: Row[] = [];
  private seq = 0;
  /** ON CONFLICT (run_id, client_id) DO NOTHING — returns counts. */
  enqueue(runId: string, clientIds: string[]): { inserted: number; skipped: number; total: number } {
    let inserted = 0;
    const uniq = Array.from(new Set(clientIds));
    for (const clientId of uniq) {
      if (this.rows.some((r) => r.runId === runId && r.clientId === clientId)) continue;
      this.rows.push({ id: `job-${++this.seq}`, runId, clientId, status: 'pending', attempts: 0 });
      inserted += 1;
    }
    return { inserted, skipped: uniq.length - inserted, total: uniq.length };
  }
  claimNext(runId: string, maxAttempts = 3): BackfillJob | null {
    // Pending-first, then retryable failed (mirrors the claim RPC's ORDER BY).
    const row =
      this.rows.find((r) => r.runId === runId && r.status === 'pending') ??
      this.rows.find((r) => r.runId === runId && r.status === 'failed' && r.attempts < maxAttempts);
    if (!row) return null;
    row.status = 'running';
    row.attempts += 1;
    return { jobId: row.id, runId: row.runId, clientId: row.clientId, attempts: row.attempts };
  }
  complete(jobId: string): void {
    const r = this.rows.find((x) => x.id === jobId);
    if (r && r.status === 'running') r.status = 'done';
  }
  fail(jobId: string, err: string): void {
    const r = this.rows.find((x) => x.id === jobId);
    if (r && r.status === 'running') { r.status = 'failed'; r.lastError = err; }
  }
  byStatus(): Record<string, number> {
    const out: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const r of this.rows) out[r.status] += 1;
    return out;
  }
}

// ── fake proposal store: dedup on (client_id, checkpoint_id) among 'pending' ──
class FakeProposalStore implements ProposalStore {
  rows: Array<{ id: string; client_id: string; checkpoint_id: string | null; status: 'pending' }> = [];
  inserts = 0;
  private seq = 0;
  async createProposal(input: ProposalInput): Promise<ProposalRecord> {
    const existing = this.rows.find(
      (r) => r.client_id === input.client_id && r.checkpoint_id === (input.checkpoint_id ?? null),
    );
    if (existing) {
      return { ...existing, proposed_action: input.proposed_action, proposed_expression: input.proposed_expression, gate_signals: input.gate_signals };
    }
    this.inserts += 1;
    const row = { id: `prop-${++this.seq}`, client_id: input.client_id, checkpoint_id: input.checkpoint_id ?? null, status: 'pending' as const };
    this.rows.push(row);
    return { ...row, proposed_action: input.proposed_action, proposed_expression: input.proposed_expression, gate_signals: input.gate_signals };
  }
}

// ── inert resolver / universe / config (real orchestrator, no DB) ──
const fakeResolverDb: ResolverDb = {
  findDistricts: async () => [], findCities: async () => [], findRegions: async () => [],
  findElements: async () => [], zoneDistricts: async () => [], districtForPoint: async () => null,
};
const inertUniverse: SatUniverse = { universe: [], cellsOf: () => [], inventoryIn: () => 0 };
const config: GateConfig = {
  auto_write_enabled: false, t_lexical_margin: 0.9, t_geo_margin: 0.9, t_source_quality: 0.9,
  min_action_assurance: { write_soft: 0.9, write_hard: 0.98, supersede: 0.99 },
};

/** A GOOD client's history contains a stub token so extraction yields evidence. */
function goodHistory(clientId: string): Conversation {
  return { channel: 'chat', id: `client:${clientId}`, turns: [{ speaker: 'client', text: 'أبي المهدية', timestamp: '2026-09-03T10:00:00Z' }] };
}

interface WireOpts { queue: FakeQueue; store: FakeProposalStore; throwFor?: Set<string>; history?: Record<string, Conversation | null> }
function wireDeps({ queue, store, throwFor = new Set(), history = {} }: WireOpts): BackfillDeps {
  return {
    claimNext: async (runId) => queue.claimNext(runId),
    completeJob: async (jobId) => queue.complete(jobId),
    failJob: async (jobId, err) => queue.fail(jobId, err),
    gatherConversation: async (clientId) => {
      if (throwFor.has(clientId)) throw new Error(`gather failed for ${clientId}`);
      return clientId in history ? history[clientId]! : goodHistory(clientId);
    },
    extract,
    buildRunContext: async (clientId, evidenceCount): Promise<RunContext> => ({
      client_id: clientId,
      checkpoint_id: null,
      maximum_safe_action: evidenceCount > 0 ? 'propose' : 'ignore',
      resolution: { db: fakeResolverDb, preferCountry: 'SA' },
      universe: inertUniverse,
      config,
    }),
    runReviewFirst,
    proposals: store,
  };
}

describe('geo backfill — enqueue idempotency', () => {
  it('(a) re-enqueue creates no duplicate jobs', () => {
    const q = new FakeQueue();
    const first = q.enqueue('run-1', ['c1', 'c2']);
    expect(first).toEqual({ inserted: 2, skipped: 0, total: 2 });

    const second = q.enqueue('run-1', ['c1', 'c2', 'c3']);
    expect(second).toEqual({ inserted: 1, skipped: 2, total: 3 });

    // Exactly one job per (run, client).
    expect(q.rows.filter((r) => r.runId === 'run-1').length).toBe(3);
    expect(q.rows.filter((r) => r.clientId === 'c1').length).toBe(1);
  });
});

describe('geo backfill — processing', () => {
  it('(b) a failing client is isolated; siblings still process', async () => {
    const queue = new FakeQueue();
    const store = new FakeProposalStore();
    queue.enqueue('run-b', ['good1', 'BAD', 'good2']);
    const deps = wireDeps({ queue, store, throwFor: new Set(['BAD']) });

    const result = await runBackfillBatch(deps, { runId: 'run-b' });

    // Isolation: both good clients reach 'done' regardless of the bad one, which
    // retries to the cap (2 good + 3 BAD attempts = 5 processed) and ends failed.
    expect(result.done).toBe(2);
    expect(result.failed).toBe(3); // 3 failed attempts on the one bad client
    expect(result.drained).toBe(true);
    expect(queue.byStatus()).toMatchObject({ done: 2, failed: 1, pending: 0, running: 0 });
    // The two good clients each produced a proposal; the failed one did not.
    expect(store.rows.map((r) => r.client_id).sort()).toEqual(['good1', 'good2']);
    const bad = queue.rows.find((r) => r.clientId === 'BAD')!;
    expect(bad.status).toBe('failed');
    expect(bad.attempts).toBe(3); // retried to the max-attempts cap
    expect(bad.lastError).toContain('gather failed');
  });

  it('processBackfillJob never throws (isolation) even when failJob throws', async () => {
    const queue = new FakeQueue();
    const store = new FakeProposalStore();
    queue.enqueue('run-x', ['c1']);
    const job = queue.claimNext('run-x')!;
    const deps: BackfillDeps = {
      ...wireDeps({ queue, store, throwFor: new Set(['c1']) }),
      failJob: async () => { throw new Error('failJob exploded'); },
    };
    const outcome = await processBackfillJob(deps, job);
    expect(outcome.status).toBe('failed'); // captured, not thrown
  });

  it('(c) a re-run skips done jobs', async () => {
    const queue = new FakeQueue();
    const store = new FakeProposalStore();
    queue.enqueue('run-c', ['c1', 'c2']);
    const deps = wireDeps({ queue, store });

    const first = await runBackfillBatch(deps, { runId: 'run-c' });
    expect(first.processed).toBe(2);
    expect(queue.byStatus().done).toBe(2);
    const attemptsAfterFirst = queue.rows.map((r) => r.attempts);
    const insertsAfterFirst = store.inserts;

    // Re-run the SAME run: nothing is claimable (all done), so no work happens.
    const second = await runBackfillBatch(deps, { runId: 'run-c' });
    expect(second).toMatchObject({ processed: 0, done: 0, failed: 0, drained: true });
    expect(queue.rows.map((r) => r.attempts)).toEqual(attemptsAfterFirst); // no re-claim
    expect(store.inserts).toBe(insertsAfterFirst); // no extra proposals
  });

  it('(d) no duplicate proposals for the same client+checkpoint across re-runs', async () => {
    const queue = new FakeQueue();
    const store = new FakeProposalStore();
    const deps = wireDeps({ queue, store });

    // Run 1 over client c1 → one proposal.
    queue.enqueue('run-d1', ['c1']);
    await runBackfillBatch(deps, { runId: 'run-d1' });
    expect(store.rows.filter((r) => r.client_id === 'c1')).toHaveLength(1);
    expect(store.inserts).toBe(1);

    // Run 2 (a fresh run) over the SAME client → dedup, still exactly one.
    queue.enqueue('run-d2', ['c1']);
    const r2 = await runBackfillBatch(deps, { runId: 'run-d2' });
    expect(r2.processed).toBe(1);
    expect(r2.done).toBe(1);
    expect(store.rows.filter((r) => r.client_id === 'c1')).toHaveLength(1);
    expect(store.inserts).toBe(1); // no second insert — deduped
  });

  it('a client with no history completes without a proposal', async () => {
    const queue = new FakeQueue();
    const store = new FakeProposalStore();
    queue.enqueue('run-e', ['empty']);
    const deps = wireDeps({ queue, store, history: { empty: null } });

    const result = await runBackfillBatch(deps, { runId: 'run-e' });
    expect(result).toMatchObject({ processed: 1, done: 1, failed: 0, proposals: 0 });
    expect(store.rows).toHaveLength(0);
  });
});
