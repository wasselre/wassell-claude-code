import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleMessage, Page } from 'playwright-core';
import { captureJsonInventory, assertSnapshotIsNewer, type SaveJsonStep } from '../jsonInventory';
import { waitForAutomaticCaptcha } from '../captcha';
import { browserbaseSessionOptions, ensurePortalContext } from '../browserbase';
import { parseRecipe, RecipeCancelledError, runSteps, type RecipeRuntime } from '../recipe';
import type { SupabaseClient } from '@supabase/supabase-js';

afterEach(() => vi.restoreAllMocks());

const step: SaveJsonStep = { do: 'save_json', key: 'units', selector: '[data-available-units-url]', attr: 'data-available-units-url', page_size: 2 };
const jsonPage = (ids: (string | number)[], pageNo = 1, totalCount = 3) => ({ data: { items: ids.map((id) => ({ id })), pageNo, pageSize: 2, totalCount } });

function capturePage(responses: unknown[], attr = '/AvailableUnits?projectId=9') {
  const calls: { url: string; timeout: number }[] = [];
  const locator = { first: () => locator, getAttribute: async () => attr };
  const page = {
    url: () => 'https://partners.binghatti.com/Properties',
    locator: () => locator,
    evaluate: vi.fn(async (_fn: unknown, args: { url: string; timeout: number }) => { calls.push(args); return responses.shift(); }),
  } as unknown as Page;
  return { page, calls };
}

const hooks = () => ({ checkCancelled: vi.fn(async () => undefined), heartbeat: vi.fn(async () => undefined), log: vi.fn() });

describe('complete JSON inventory capture', () => {
  it('fetches sequential pages and saves exactly the advertised unique count', async () => {
    const { page, calls } = capturePage([jsonPage([1, 2]), jsonPage([3], 2)]);
    const snapshot = await captureJsonInventory(page, step, hooks());
    expect(snapshot).toMatchObject({ complete: true, totalCount: 3, items: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    expect(calls.map((x) => new URL(x.url).searchParams.get('pageNo'))).toEqual(['1', '2']);
    expect(calls.every((x) => new URL(x.url).searchParams.get('projectId') === '9')).toBe(true);
  });

  it.each([
    ['count changed', [jsonPage([1, 2]), jsonPage([3], 2, 4)]],
    ['duplicate', [jsonPage([1, 2]), jsonPage([2], 2)]],
    ['clamped page', [jsonPage([1, 2]), jsonPage([3], 1)]],
    ['partial page', [jsonPage([1]), jsonPage([3], 2)]],
    ['HTML/login-shaped reply', [{ html: '<form id="loginForm">' }]],
    ['missing identifier', [{ data: { items: [{ code: 'BWRT-208' }], pageNo: 1, pageSize: 2, totalCount: 1 } }]],
    ['numeric-string count', [{ data: { items: [], pageNo: 1, pageSize: 2, totalCount: '0' } }]],
  ])('rejects %s before returning a snapshot', async (_name, responses) => {
    const { page } = capturePage(responses as unknown[]);
    await expect(captureJsonInventory(page, step, hooks())).rejects.toThrow();
  });

  it('rejects cross-origin endpoint attributes before fetching', async () => {
    const { page, calls } = capturePage([], 'https://attacker.example/inventory');
    await expect(captureJsonInventory(page, step, hooks())).rejects.toThrow('origin');
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty list by default and a truncated max_pages capture', async () => {
    const empty = capturePage([jsonPage([], 1, 0)]).page;
    await expect(captureJsonInventory(empty, step, hooks())).rejects.toThrow('Empty');
    const incomplete = capturePage([jsonPage([1, 2])]).page;
    await expect(captureJsonInventory(incomplete, { ...step, max_pages: 1 }, hooks())).rejects.toThrow('incomplete');
  });

  it('only a literal allow_empty:true can permit an empty snapshot', async () => {
    const malformed = { ...step, allow_empty: 'false' } as unknown as SaveJsonStep;
    await expect(captureJsonInventory(capturePage([jsonPage([], 1, 0)]).page, malformed, hooks())).rejects.toThrow('Empty');
    await expect(captureJsonInventory(capturePage([jsonPage([], 1, 0)]).page, { ...step, allow_empty: true }, hooks())).resolves.toMatchObject({ totalCount: 0, items: [] });
  });

  it('does not overwrite storage on a partial result', async () => {
    const { page } = capturePage([jsonPage([1])]);
    const saveItems = vi.fn(async () => undefined);
    const rt: RecipeRuntime = { ...hooks(), page, scope: { input: {}, vars: {} }, phase: async () => undefined, screenshot: async () => undefined, requestInput: async () => '', saveItems };
    await expect(runSteps([step], rt)).rejects.toThrow();
    expect(saveItems).not.toHaveBeenCalled();
  });

  it('records a successful capture without pretending client rows were read', async () => {
    const { page } = capturePage([jsonPage([1, 2]), jsonPage([3], 2)]);
    const rt: RecipeRuntime = { ...hooks(), page, scope: { input: {}, vars: {} }, phase: async () => undefined, screenshot: async () => undefined, requestInput: async () => '', saveItems: async () => undefined };
    await runSteps([step], rt);
    expect(rt.savedInventories).toEqual([{ key: 'units', totalCount: 3 }]);
    expect(rt.didCollectRows).toBeUndefined();
  });

  it('rejects a stale capture and malformed stored freshness metadata', () => {
    expect(() => assertSnapshotIsNewer('2026-10-05T10:00:00Z', { saved_at: '2026-10-05T11:00:00Z' })).toThrow('Stale');
    expect(() => assertSnapshotIsNewer('2026-10-05T10:00:00Z', {})).toThrow('timestamp');
    expect(() => assertSnapshotIsNewer('2026-10-05T12:00:00Z', { saved_at: '2026-10-05T11:00:00Z' })).not.toThrow();
  });
});

function captchaPage(tokens: boolean[], advanced = false) {
  let clock = 0;
  let listener: ((msg: ConsoleMessage) => void) | undefined;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const locator = { first: () => locator, isVisible: async () => advanced };
  const page = {
    on: (_event: string, fn: typeof listener) => { listener = fn; },
    off: vi.fn(),
    url: () => 'https://partners.binghatti.com/Properties',
    locator: () => locator,
    evaluate: vi.fn(async () => {
      listener?.({ text: () => 'browserbase-solving-finished' } as ConsoleMessage);
      return tokens.shift() ?? false;
    }),
    waitForTimeout: async (ms: number) => { clock += ms; },
  } as unknown as Page;
  return page;
}

describe('Browserbase automatic CAPTCHA verification', () => {
  it('waits for a real token and heartbeats without requesting human input', async () => {
    const page = captchaPage([false, false, true]);
    const h = { ...hooks(), screenshot: vi.fn(async () => undefined) };
    await waitForAutomaticCaptcha(page, { do: 'wait_captcha', timeout_s: 5 }, h);
    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(h.heartbeat).toHaveBeenCalled();
    expect(h.screenshot).not.toHaveBeenCalled();
  });

  it('accepts positive page advancement for invisible reCAPTCHA v3', async () => {
    const page = captchaPage([], true);
    await waitForAutomaticCaptcha(page, { do: 'wait_captcha', success_selector: '#password:not(.d-none)' }, { ...hooks(), screenshot: async () => undefined });
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('a finished event, missing token or unknown CAPTCHA cannot silently advance', async () => {
    const page = captchaPage([]);
    const h = { ...hooks(), screenshot: vi.fn(async () => undefined) };
    await expect(waitForAutomaticCaptcha(page, { do: 'wait_captcha', timeout_s: 2 }, h)).rejects.toThrow('timed out');
    expect(h.screenshot).toHaveBeenCalledWith('captcha-timeout');
    expect(page.off).toHaveBeenCalled();
  });

  it('preserves cancellation and releases its event listener', async () => {
    const page = captchaPage([false]);
    const h = { ...hooks(), screenshot: async () => undefined, checkCancelled: async () => { throw new RecipeCancelledError(); } };
    await expect(waitForAutomaticCaptcha(page, { do: 'wait_captcha' }, h)).rejects.toBeInstanceOf(RecipeCancelledError);
    expect(page.off).toHaveBeenCalled();
  });
});

describe('persistent Browserbase contexts remain opt-in', () => {
  it('explicitly enables automatic solving while preserving fresh sessions for other portals', () => {
    expect(browserbaseSessionOptions('project')).toMatchObject({ browserSettings: { solveCaptchas: true } });
    expect((browserbaseSessionOptions('project').browserSettings as Record<string, unknown>).context).toBeUndefined();
    expect(browserbaseSessionOptions('project', 'context')).toMatchObject({ browserSettings: { context: { id: 'context', persist: true } } });
  });

  it('does not call Browserbase for a disabled context or an existing context', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const supabase = {} as SupabaseClient;
    const env = { BROWSERBASE_API_KEY: 'test', BROWSERBASE_PROJECT_ID: 'test' };
    expect(await ensurePortalContext(supabase, env, 'portal', { browserbase_context_id: 'old' })).toBeNull();
    expect(await ensurePortalContext(supabase, env, 'portal', { browserbase_persist_context: true, browserbase_context_id: 'old' })).toBe('old');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('creates one context and saves its chosen ID using the atomic RPC', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'new-context' }), { status: 201 }));
    const rpc = vi.fn(async () => ({ data: 'new-context', error: null }));
    const chosen = await ensurePortalContext({ rpc } as unknown as SupabaseClient, { BROWSERBASE_API_KEY: 'test', BROWSERBASE_PROJECT_ID: 'test' }, 'portal', { browserbase_persist_context: true });
    expect(chosen).toBe('new-context');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('portal_browserbase_context_set', { p_portal_record_id: 'portal', p_context_id: 'new-context' });
  });

  it('parses the closed named steps and rejects incomplete definitions', () => {
    expect(parseRecipe([{ do: 'wait_captcha' }, { do: 'auth_state', reused: true }, step])).toHaveLength(3);
    expect(() => parseRecipe([{ do: 'save_json', key: 'units' }])).toThrow('needs');
    expect(() => parseRecipe([{ do: 'auth_state' }])).toThrow('needs');
  });
});
