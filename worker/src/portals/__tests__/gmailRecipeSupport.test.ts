import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  parseRecipe,
  RecipeCancelledError,
  RecipeError,
  runSteps,
  type RecipeRuntime,
  type RecipeStep,
} from '../recipe';
import { loadEnv } from '../../env';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ── prepare_email_otp in the recipe engine ──────────────────────────────────

// A page whose every locator is "visible"; every interaction is recorded in
// `events` so tests can assert ORDER (prepare must finish before the click
// that asks the portal to send the OTP — never after).
function recordingPage(events: string[]) {
  const locator = {
    nth: () => locator,
    waitFor: async () => undefined,
    fill: async () => undefined,
    click: async () => { events.push('click'); },
  };
  return { locator: () => locator } as unknown as Page;
}

// The Binghatti sign-in shape: login id filled, the Gmail baseline snapshotted
// IMMEDIATELY BEFORE the send-OTP click, then the code requested.
const signInRecipe = [
  { do: 'fill', selector: '#userId', value: '{{portal.login_id}}' },
  { do: 'prepare_email_otp', key: 'otp' },
  { do: 'click', selector: '#sendOtpBtn' },
] as RecipeStep[];

function runtime(events: string[], overrides: Partial<RecipeRuntime> = {}): RecipeRuntime {
  return {
    page: recordingPage(events),
    scope: { lead: {}, portal: {}, client: {}, project: {}, input: {}, vars: {} },
    log: () => undefined,
    phase: async () => undefined,
    screenshot: async () => undefined,
    requestInput: async () => '',
    checkCancelled: async () => undefined,
    ...overrides,
  };
}

describe('prepare_email_otp', () => {
  it('parses a valid recipe, including one nested in an if_visible branch', () => {
    const nested = [
      {
        do: 'if_visible', selector: '#userId', then: [
          { do: 'fill', selector: '#userId', value: '{{portal.login_id}}' },
          { do: 'prepare_email_otp', key: 'otp' },
          { do: 'click', selector: '#sendOtpBtn' },
        ],
      },
    ] as RecipeStep[];
    const parsed = parseRecipe(nested);
    expect(parsed).toHaveLength(1);
    expect(parseRecipe(signInRecipe)).toHaveLength(3);
  });

  it.each([
    ['missing key', { do: 'prepare_email_otp' }],
    ['empty key', { do: 'prepare_email_otp', key: '' }],
    ['whitespace key', { do: 'prepare_email_otp', key: '   ' }],
    ['non-string key', { do: 'prepare_email_otp', key: 7 }],
  ])('rejects %s at parse time', (_name, step) => {
    expect(() => parseRecipe([step])).toThrow(RecipeError);
  });

  it('invokes the hook with the key and completes it BEFORE the send-OTP click', async () => {
    const events: string[] = [];
    let signalStarted!: () => void;
    let releasePreparation!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const ready = new Promise<void>((resolve) => { releasePreparation = resolve; });
    const prepareEmailOtp = vi.fn(async (key: string) => {
      events.push(`prepare:${key}`);
      signalStarted();
      await ready;
      events.push('prepared');
    });
    const run = runSteps(signInRecipe, runtime(events, { prepareEmailOtp }));
    await started;
    expect(events).toEqual(['prepare:otp']);
    releasePreparation();
    await run;
    expect(prepareEmailOtp).toHaveBeenCalledTimes(1);
    expect(prepareEmailOtp).toHaveBeenCalledWith('otp');
    expect(events).toEqual(['prepare:otp', 'prepared', 'click']);
  });

  it('fails loudly when the runtime has no hook — and never clicks send OTP', async () => {
    const events: string[] = [];
    const err = await runSteps(signInRecipe, runtime(events)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeError);
    expect((err as RecipeError).en).toContain('prepare_email_otp');
    expect(events).toEqual([]);
  });

  it('propagates a hook failure (wrapped, bilingual) and never clicks', async () => {
    const events: string[] = [];
    const prepareEmailOtp = vi.fn(async () => { throw new Error('provider refused'); });
    const err = await runSteps(signInRecipe, runtime(events, { prepareEmailOtp })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeError);
    expect((err as RecipeError).en).toContain('provider refused');
    expect(events).toEqual([]);
  });

  it('keeps a hook-side cancellation unwrapped (its type must survive)', async () => {
    const prepareEmailOtp = vi.fn(async () => { throw new RecipeCancelledError(); });
    const err = await runSteps(signInRecipe, runtime([], { prepareEmailOtp })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeCancelledError);
    expect(err).not.toBeInstanceOf(RecipeError);
  });

  it('a cancellation before the step leaves hook and click untouched', async () => {
    const events: string[] = [];
    const prepareEmailOtp = vi.fn(async () => { events.push('prepare'); });
    // runSteps checks cancellation before every step: the fill passes, the
    // check before prepare_email_otp throws.
    let checks = 0;
    const checkCancelled = async () => {
      checks += 1;
      if (checks >= 2) throw new RecipeCancelledError();
    };
    const err = await runSteps(signInRecipe, runtime(events, { prepareEmailOtp, checkCancelled })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecipeCancelledError);
    expect(prepareEmailOtp).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

// ── env loader: the three optional Gmail OAuth values ───────────────────────

describe('loadEnv BINGHATTI_GMAIL_* (optional)', () => {
  // Required values are synthetic placeholders — loadEnv only checks presence.
  const stubRequired = () => {
    vi.stubEnv('SUPABASE_URL', 'https://synthetic.invalid');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-role');
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-anthropic');
    vi.stubEnv('ANTHROPIC_WASSEL_SKILL_ID', 'synthetic-skill');
    vi.stubEnv('FAL_KEY', 'stub');
  };

  it('loads null for every Gmail value when none is set', () => {
    stubRequired();
    vi.stubEnv('BINGHATTI_GMAIL_CLIENT_ID', undefined);
    vi.stubEnv('BINGHATTI_GMAIL_CLIENT_SECRET', undefined);
    vi.stubEnv('BINGHATTI_GMAIL_REFRESH_TOKEN', undefined);
    const env = loadEnv();
    expect(env.BINGHATTI_GMAIL_CLIENT_ID).toBeNull();
    expect(env.BINGHATTI_GMAIL_CLIENT_SECRET).toBeNull();
    expect(env.BINGHATTI_GMAIL_REFRESH_TOKEN).toBeNull();
  });

  it('loads supplied Gmail values verbatim', () => {
    stubRequired();
    vi.stubEnv('BINGHATTI_GMAIL_CLIENT_ID', 'synthetic-client-id');
    vi.stubEnv('BINGHATTI_GMAIL_CLIENT_SECRET', 'synthetic-client-secret');
    vi.stubEnv('BINGHATTI_GMAIL_REFRESH_TOKEN', 'synthetic-refresh-token');
    const env = loadEnv();
    expect(env.BINGHATTI_GMAIL_CLIENT_ID).toBe('synthetic-client-id');
    expect(env.BINGHATTI_GMAIL_CLIENT_SECRET).toBe('synthetic-client-secret');
    expect(env.BINGHATTI_GMAIL_REFRESH_TOKEN).toBe('synthetic-refresh-token');
  });
});
