import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  runSteps,
  RecipeCancelledError,
  RecipeError,
  RecipeInterrupt,
  type RecipeRuntime,
  type RecipeStep,
} from '../recipe';

// Every locator is "visible" so an if_visible takes its `then` branch — the
// shape of Al Ramz's sign-in, where request_input sits inside if_visible.
const visibleLocator = { nth: () => visibleLocator, waitFor: async () => undefined };
const page = { locator: () => visibleLocator } as unknown as Page;

function runtime(requestInput: RecipeRuntime['requestInput']): RecipeRuntime {
  return {
    page,
    scope: { lead: {}, portal: {}, client: {}, project: {}, input: {}, vars: {} },
    log: () => undefined,
    phase: async () => undefined,
    screenshot: async () => undefined,
    requestInput,
    checkCancelled: async () => undefined,
  };
}

const signIn: RecipeStep[] = [
  { do: 'if_visible', selector: "input[type='tel']", then: [
    { do: 'request_input', key: 'otp', kind: 'otp', length: 6 },
  ] },
] as RecipeStep[];

class CodeWaitTimedOut extends RecipeInterrupt {}

describe('runSteps error wrapping', () => {
  it('passes a RecipeInterrupt through unwrapped, even from a nested branch', async () => {
    // Regression 2026-09-29: the OTP-relay timeout came back as
    // "Step 4 (request_input) failed: otp relay wait timed out", lost its type,
    // and the run was FAILED instead of PARKED — so a late reply restarted nothing.
    const err = await runSteps(signIn, runtime(async () => { throw new CodeWaitTimedOut('otp relay wait timed out'); }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodeWaitTimedOut);
    expect(err).not.toBeInstanceOf(RecipeError);
  });

  it('still passes a cancel through unwrapped', async () => {
    const err = await runSteps(signIn, runtime(async () => { throw new RecipeCancelledError(); })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeCancelledError);
  });

  it('still wraps an ordinary failure into a bilingual step error', async () => {
    const err = await runSteps(signIn, runtime(async () => { throw new Error('boom'); })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeError);
    expect((err as RecipeError).en).toContain('request_input');
  });

  it('a fail step with outcome carries it on the RecipeError (already registered)', async () => {
    const steps = [{ do: 'fail', ar: 'مسجّل لدى وسيط آخر', en: 'already registered', outcome: 'already_registered' }] as RecipeStep[];
    const err = await runSteps(steps, runtime(async () => '')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeError);
    expect((err as RecipeError).outcome).toBe('already_registered');
  });

  it('a fail step without outcome stays a plain failure', async () => {
    const steps = [{ do: 'fail', ar: 'x', en: 'x' }] as RecipeStep[];
    const err = await runSteps(steps, runtime(async () => '')).catch((e: unknown) => e);
    expect((err as RecipeError).outcome).toBeUndefined();
  });
});
