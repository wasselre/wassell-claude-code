/**
 * Backfill idempotency + concurrency claim (operational safeguard).
 *
 * A backfill that re-extracts geo-preferences over a large conversation history
 * must never process the same unit twice: not when it is re-run after a crash
 * (idempotency), and not when two workers race the same item (concurrency). Both
 * failures waste paid LLM calls (see llmBudget.ts) and can double-write evidence.
 *
 * The safeguard is a deterministic DEDUP KEY plus an atomic in-memory CLAIM:
 *   - `dedupKey(item)` derives one stable key per unit of work from its identity +
 *     the extraction version, so re-running with the SAME extractor version skips
 *     done work, while a NEW extractor version legitimately re-processes.
 *   - `ClaimLedger.claim(key)` atomically returns the claim to exactly ONE caller;
 *     every other caller (a racing worker, or a re-run over an already-done key)
 *     gets `false` and skips. "Done" state is consulted through an injected port so
 *     it can be backed by the DB (e.g. "does an evidence row already exist for this
 *     conversation+version?") in production and by a Set in tests.
 *
 * PURE of DB/LLM. JS is single-threaded, so "atomic" here means the claim decision
 * completes synchronously within one tick — a claim and its rejection cannot
 * interleave. Nothing here writes to a client record.
 */

// ────────────────────────────────────────────────────────────────────────────
// Work item + dedup key.
// ────────────────────────────────────────────────────────────────────────────
export interface BackfillItem {
  /** Stable identity of the unit of work (chat_wid, phone_calls id, checkpoint id). */
  conversation_id: string;
  /** The extractor version this run uses — a new version re-processes intentionally. */
  extraction_version: string;
  /** Optional channel qualifier, when the same id can appear on two channels. */
  channel?: 'chat' | 'call';
}

/** Deterministic, collision-resistant-enough key for one unit of work. */
export function dedupKey(item: BackfillItem): string {
  const channel = item.channel ? `${item.channel}:` : '';
  return `${channel}${item.conversation_id}@${item.extraction_version}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Done-state port. Production backs this with a DB existence check; tests pass a
// Set. `isDone` is consulted once per key and then cached in the ledger.
// ────────────────────────────────────────────────────────────────────────────
export interface DoneStore {
  /** Has this key already been fully processed by a prior run? */
  isDone(key: string): boolean;
}

/** A Set-backed DoneStore for tests and simple in-process runs. */
export function setDoneStore(done: Set<string> = new Set()): DoneStore {
  return { isDone: (key) => done.has(key) };
}

// ────────────────────────────────────────────────────────────────────────────
// The claim ledger.
// ────────────────────────────────────────────────────────────────────────────
export interface ClaimResult {
  ok: boolean;
  reason?: 'already_done' | 'in_flight' | 'completed';
}

export class ClaimLedger {
  private readonly done: DoneStore;
  /** Keys claimed by an in-flight worker this run. */
  private readonly claimed = new Set<string>();
  /** Keys finished this run (completed after a successful claim). */
  private readonly completed = new Set<string>();

  constructor(done: DoneStore = setDoneStore()) {
    this.done = done;
  }

  /**
   * Atomically claim a key for processing. Returns `{ ok: true }` to EXACTLY ONE
   * caller. Subsequent callers — a racing worker, a re-run over a key a prior run
   * finished, or a re-claim after completion — get `{ ok: false, reason }`.
   */
  claim(key: string): ClaimResult {
    if (this.completed.has(key)) return { ok: false, reason: 'completed' };
    if (this.done.isDone(key)) return { ok: false, reason: 'already_done' };
    if (this.claimed.has(key)) return { ok: false, reason: 'in_flight' };
    this.claimed.add(key);
    return { ok: true };
  }

  /** Mark a claimed key finished. Idempotent; frees the in-flight slot. */
  complete(key: string): void {
    this.claimed.delete(key);
    this.completed.add(key);
  }

  /**
   * Release a claim WITHOUT marking it done (e.g. the item failed and should be
   * retried by a later run). The key becomes claimable again.
   */
  release(key: string): void {
    this.claimed.delete(key);
  }

  /** True if the key is done for this run — from a prior run or completed here. */
  isDone(key: string): boolean {
    return this.completed.has(key) || this.done.isDone(key);
  }

  stats(): { claimed: number; completed: number } {
    return { claimed: this.claimed.size, completed: this.completed.size };
  }
}
