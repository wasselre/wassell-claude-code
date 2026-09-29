import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  runSteps,
  RecipeCancelledError,
  RecipeError,
  RecipeInterrupt,
  type RecipeRuntime,
  type RecipeStep,
  jsonPath,
  toCollectedRow,
  withPage,
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

describe('collect_rows helpers (portal status checks)', () => {
  // Shape copied from Al Ramz's Inertia `data-page` (props.clients paginator).
  const alRamzStep = {
    fields: { ref: 'id', name: 'name', phone: 'phone', status: 'status' },
    ref_prefix: '#',
    status_labels: { new: 'جديد', open: 'مفتوح', lost: 'خسارة' },
  };

  it('walks a dot path through the page JSON', () => {
    const page = { props: { clients: { data: [{ id: 1 }], last_page: 3 } } };
    expect(jsonPath(page, 'props.clients.last_page')).toBe(3);
    expect(jsonPath(page, 'props.clients.data')).toEqual([{ id: 1 }]);
    expect(jsonPath(page, 'props.missing.x')).toBeUndefined();
  });

  it('maps a portal row: numeric id gets the prefix, code gets the portal label', () => {
    expect(toCollectedRow({ id: 14157, name: 'Fahad', phone: '575126007', status: 'new' }, alRamzStep)).toEqual({
      ref: '#14157', name: 'Fahad', phone: '575126007', status_code: 'new', status_label: 'جديد',
    });
  });

  it('keeps an unknown status code as its own label instead of dropping it', () => {
    expect(toCollectedRow({ id: 2, status: 'won' }, alRamzStep).status_label).toBe('won');
  });

  it('missing fields come back null, never "undefined" strings', () => {
    expect(toCollectedRow({}, alRamzStep)).toEqual({ ref: null, name: null, phone: null, status_code: null, status_label: null });
  });
});

describe('withPage (collect_rows page URLs)', () => {
  // Regression 2026-09-29: the template renderer ran first, treated {{page}}
  // as an unknown path and blanked it — every request went to "?page=".
  it('puts the page number in before templating can blank it', () => {
    expect(withPage('https://riva.sa/broker/leads?page={{page}}', 2)).toBe('https://riva.sa/broker/leads?page=2');
    expect(withPage('https://x/y?page={{ page }}&s=1', 3)).toBe('https://x/y?page=3&s=1');
  });
});

