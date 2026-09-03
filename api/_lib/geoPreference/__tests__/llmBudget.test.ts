import { describe, it, expect } from 'vitest';
import {
  LlmBudget,
  LlmBudgetExceededError,
  createLlmBudget,
  estimateExtractionTokens,
} from '../llmBudget';

/**
 * LLM cost + rate-limit controls for the extractor/backfill path. Uses an injected
 * clock + sleep so concurrency/rate behaviour is deterministic without real time.
 */

/** A fake clock whose sleep() advances the clock — deterministic rate-limit tests. */
function fakeClock(start = 1000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
    sleeps,
    advance: (ms: number) => { t += ms; },
  };
}

describe('LlmBudget — per-run CALL ceiling', () => {
  it('throws LlmBudgetExceededError with call_ceiling once maxCalls is spent', async () => {
    const b = new LlmBudget({ maxCalls: 2 });
    (await b.begin())();
    (await b.begin())();
    await expect(b.begin()).rejects.toBeInstanceOf(LlmBudgetExceededError);
    try {
      await b.begin();
    } catch (err) {
      expect((err as LlmBudgetExceededError).ceiling).toBe('call_ceiling');
      expect((err as LlmBudgetExceededError).spentCalls).toBe(2);
    }
  });
});

describe('LlmBudget — per-run TOKEN ceiling', () => {
  it('throws token_ceiling when the estimate would exceed maxTokens', async () => {
    const b = new LlmBudget({ maxTokens: 100 });
    (await b.begin(60))();
    await expect(b.begin(60)).rejects.toMatchObject({ ceiling: 'token_ceiling' });
    expect(b.usage().tokens).toBe(60); // the rejected reservation did not count
  });

  it('canSpend previews both ceilings without reserving', async () => {
    const b = new LlmBudget({ maxCalls: 1, maxTokens: 100 });
    expect(b.canSpend(50)).toEqual({ ok: true }); // pure preview — reserves nothing
    expect(b.usage().calls).toBe(0);
    const r = await b.begin(50);
    // after one reserved call: the call ceiling is now the binding constraint
    expect(b.canSpend(10)).toEqual({ ok: false, ceiling: 'call_ceiling' });
    r();
  });
});

describe('LlmBudget — token reconciliation via release/run', () => {
  it('release(actualTokens) reconciles the optimistic estimate', async () => {
    const b = new LlmBudget();
    const release = await b.begin(100);
    expect(b.usage().tokens).toBe(100);
    release(30); // actual was smaller
    expect(b.usage().tokens).toBe(30);
  });

  it('run() reconciles from a {value, tokens} result and frees the slot', async () => {
    const b = new LlmBudget({ maxConcurrency: 1 });
    const value = await b.run(100, async () => ({ value: 'ok', tokens: 25 }));
    expect(value).toBe('ok');
    expect(b.usage().tokens).toBe(25);
    expect(b.usage().inFlight).toBe(0);
  });

  it('run() frees the slot even when fn throws, then re-throws', async () => {
    const b = new LlmBudget({ maxConcurrency: 1 });
    await expect(b.run(10, async () => { throw new Error('provider 500'); })).rejects.toThrow('provider 500');
    expect(b.usage().inFlight).toBe(0);
    // slot is free — a subsequent call proceeds
    await b.run(10, async () => 'again');
    expect(b.usage().inFlight).toBe(0);
  });
});

describe('LlmBudget — CONCURRENCY gate', () => {
  it('a second begin() blocks until the first releases (maxConcurrency=1)', async () => {
    const b = new LlmBudget({ maxConcurrency: 1 });
    const release1 = await b.begin();
    expect(b.usage().inFlight).toBe(1);

    let secondAcquired = false;
    const second = b.begin().then((r) => { secondAcquired = true; return r; });

    // Let the microtask queue flush; the second must still be blocked.
    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    expect(b.usage().inFlight).toBe(1);

    release1();
    const release2 = await second;
    expect(secondAcquired).toBe(true);
    expect(b.usage().inFlight).toBe(1);
    release2();
    expect(b.usage().inFlight).toBe(0);
  });

  it('idempotent release — double-release does not leak or double-free a slot', async () => {
    const b = new LlmBudget({ maxConcurrency: 2 });
    const r = await b.begin();
    expect(b.usage().inFlight).toBe(1);
    r();
    r(); // no-op
    expect(b.usage().inFlight).toBe(0);
  });
});

describe('LlmBudget — RATE limit (min interval between call starts)', () => {
  it('spaces call starts at least minIntervalMs apart using the injected clock', async () => {
    const clock = fakeClock(1000);
    const b = createLlmBudget({ minIntervalMs: 100, maxConcurrency: 1, now: clock.now, sleep: clock.sleep });

    (await b.begin())();          // first start: no wait
    (await b.begin())();          // second start: must wait ~100ms
    (await b.begin())();          // third start: must wait ~100ms again

    // First had no sleep; the next two each slept the full interval.
    expect(clock.sleeps).toEqual([100, 100]);
  });

  it('no wait when enough time has already elapsed', async () => {
    const clock = fakeClock(1000);
    const b = createLlmBudget({ minIntervalMs: 100, now: clock.now, sleep: clock.sleep });
    (await b.begin())();
    clock.advance(500); // plenty of time passes on its own
    (await b.begin())();
    expect(clock.sleeps).toEqual([]); // never had to sleep
  });
});

describe('estimateExtractionTokens', () => {
  it('over-estimates (chars/3 + output) so the ceiling errs toward stopping early', () => {
    const est = estimateExtractionTokens(3000, 600);
    // (3000 + 600 + 2000) / 3 = 1866.67 -> ceil 1867
    expect(est).toBe(1867);
  });
});
