/**
 * Cost + rate-limit controls for the extractor's LLM path (operational safeguard).
 *
 * Stage-A extraction (extractor.ts) calls a paid LLM (DeepSeek primary, Claude
 * fallback). A single live extraction is cheap, but a BACKFILL over a large gold
 * set or a whole conversation history can fan out to thousands of calls — and a
 * runaway loop (a retry storm, a mis-scoped query) can burn credit or hammer the
 * provider's rate limit fast. This module is the throttle the extractor/backfill
 * consult before every LLM call.
 *
 * Two independent controls, both enforced by one `begin()` call:
 *
 *  1. PER-RUN CEILINGS (cost) — a hard cap on total CALLS and total (estimated)
 *     TOKENS for the lifetime of one budget instance. A backfill constructs one
 *     budget for the whole run; when a ceiling is hit, `begin()` throws
 *     `LlmBudgetExceededError` so the loop STOPS LOUDLY (never silently drops
 *     work — CLAUDE.md's silent-failure rule). Reservations are optimistic
 *     (reserve the estimate up front), then reconciled with the actual token
 *     count via the release callback.
 *
 *  2. CONCURRENCY + RATE (throughput) — at most `maxConcurrency` calls in flight,
 *     and call STARTS spaced at least `minIntervalMs` apart. `begin()` awaits both
 *     gates, then returns a `release` you MUST call (in a finally) to free the
 *     concurrency slot and reconcile tokens.
 *
 * The clock and sleep are injectable so the concurrency/rate behaviour is fully
 * unit-testable without real time. PURE of any DB or LLM dependency — it counts
 * and it waits. Nothing here writes to a client record.
 */

// ────────────────────────────────────────────────────────────────────────────
// Config + errors.
// ────────────────────────────────────────────────────────────────────────────
export interface LlmBudgetConfig {
  /** Hard cap on the number of LLM calls for this budget's lifetime. Default: Infinity. */
  maxCalls?: number;
  /** Hard cap on total (estimated) tokens for this budget's lifetime. Default: Infinity. */
  maxTokens?: number;
  /** Max simultaneous in-flight calls. Default: 1 (serial). */
  maxConcurrency?: number;
  /** Minimum gap between call STARTS, in ms (a simple leaky-bucket rate limit). Default: 0. */
  minIntervalMs?: number;
  /** Injectable clock (ms). Default: Date.now. */
  now?: () => number;
  /** Injectable delay. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Which ceiling was hit — carried on the thrown error for the caller/logs. */
export type BudgetCeiling = 'call_ceiling' | 'token_ceiling';

export class LlmBudgetExceededError extends Error {
  readonly ceiling: BudgetCeiling;
  readonly spentCalls: number;
  readonly spentTokens: number;
  constructor(ceiling: BudgetCeiling, spentCalls: number, spentTokens: number) {
    super(`LLM budget exceeded (${ceiling}): calls=${spentCalls}, tokens=${spentTokens}`);
    this.name = 'LlmBudgetExceededError';
    this.ceiling = ceiling;
    this.spentCalls = spentCalls;
    this.spentTokens = spentTokens;
  }
}

/** A snapshot of what has been spent so far (for logging / assertions). */
export interface BudgetUsage {
  calls: number;
  tokens: number;
  inFlight: number;
  maxCalls: number;
  maxTokens: number;
}

/** Release a reserved call slot. `actualTokens` reconciles the optimistic estimate. */
export type BudgetRelease = (actualTokens?: number) => void;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ────────────────────────────────────────────────────────────────────────────
// The budget.
// ────────────────────────────────────────────────────────────────────────────
export class LlmBudget {
  private readonly maxCalls: number;
  private readonly maxTokens: number;
  private readonly maxConcurrency: number;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private calls = 0;
  private tokens = 0;
  private inFlight = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  /** FIFO queue of waiters blocked on a concurrency slot. */
  private waiters: Array<() => void> = [];

  constructor(config: LlmBudgetConfig = {}) {
    this.maxCalls = config.maxCalls ?? Number.POSITIVE_INFINITY;
    this.maxTokens = config.maxTokens ?? Number.POSITIVE_INFINITY;
    this.maxConcurrency = Math.max(1, config.maxConcurrency ?? 1);
    this.minIntervalMs = Math.max(0, config.minIntervalMs ?? 0);
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? defaultSleep;
  }

  usage(): BudgetUsage {
    return {
      calls: this.calls,
      tokens: this.tokens,
      inFlight: this.inFlight,
      maxCalls: this.maxCalls,
      maxTokens: this.maxTokens,
    };
  }

  /**
   * Would a call costing `estTokens` fit under BOTH ceilings right now? Pure check,
   * no reservation. Callers that prefer to degrade (fall back to stub) rather than
   * throw can consult this first.
   */
  canSpend(estTokens = 0): { ok: boolean; ceiling?: BudgetCeiling } {
    if (this.calls + 1 > this.maxCalls) return { ok: false, ceiling: 'call_ceiling' };
    if (this.tokens + Math.max(0, estTokens) > this.maxTokens) return { ok: false, ceiling: 'token_ceiling' };
    return { ok: true };
  }

  /**
   * Reserve one call for `estTokens`, wait for a concurrency slot AND the rate
   * interval, and return a `release` that frees the slot and reconciles the actual
   * token count. Throws {@link LlmBudgetExceededError} (BEFORE awaiting anything)
   * when a ceiling is hit, so a backfill loop halts loudly.
   *
   * Always call the returned `release` in a `finally`, or the concurrency slot
   * leaks and later calls block forever.
   */
  async begin(estTokens = 0): Promise<BudgetRelease> {
    const est = Math.max(0, estTokens);

    // 1. Cost ceilings — checked and reserved synchronously, before any await, so
    //    two concurrent begins can't both slip past the same remaining budget.
    const fit = this.canSpend(est);
    if (!fit.ok) {
      throw new LlmBudgetExceededError(fit.ceiling!, this.calls, this.tokens);
    }
    this.calls += 1;
    this.tokens += est;

    // 2. Concurrency gate — wait for a free slot (FIFO).
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight += 1;

    // 3. Rate gate — space call STARTS at least minIntervalMs apart.
    if (this.minIntervalMs > 0) {
      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
    }
    this.lastStart = this.now();

    let released = false;
    return (actualTokens?: number) => {
      if (released) return; // idempotent — double-release is a no-op, not a leak.
      released = true;
      if (typeof actualTokens === 'number' && Number.isFinite(actualTokens)) {
        // Reconcile the optimistic estimate with the measured usage.
        this.tokens += Math.max(0, actualTokens) - est;
      }
      this.inFlight -= 1;
      const next = this.waiters.shift();
      if (next) next();
    };
  }

  /**
   * Convenience wrapper: reserve, run `fn`, reconcile tokens (from `fn`'s reported
   * actual usage, if it returns one), and release — even if `fn` throws. A ceiling
   * hit throws before `fn` runs; a provider error from `fn` propagates after the
   * slot is freed.
   */
  async run<T>(
    estTokens: number,
    fn: () => Promise<{ value: T; tokens?: number }> | Promise<T>,
  ): Promise<T> {
    const release = await this.begin(estTokens);
    try {
      const out = await fn();
      if (out && typeof out === 'object' && 'value' in (out as Record<string, unknown>)) {
        const wrapped = out as { value: T; tokens?: number };
        release(wrapped.tokens);
        return wrapped.value;
      }
      release();
      return out as T;
    } catch (err) {
      release();
      throw err;
    }
  }
}

/** Factory mirror of `new LlmBudget(config)` for call-site symmetry. */
export function createLlmBudget(config: LlmBudgetConfig = {}): LlmBudget {
  return new LlmBudget(config);
}

/**
 * A rough token estimate for one extraction call: the system prompt is fixed and
 * large, plus the conversation text, plus the JSON output. This is deliberately an
 * OVER-estimate (chars/3, not /4) so the cost ceiling errs toward stopping early
 * rather than overspending. Used by the extractor when no explicit estimate is
 * supplied.
 */
export function estimateExtractionTokens(promptChars: number, conversationChars: number): number {
  const inputChars = promptChars + conversationChars;
  const outputChars = 2000; // a full evidence+relations JSON blob, generously.
  return Math.ceil((inputChars + outputChars) / 3);
}
