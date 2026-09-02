import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CREATIVE_ROLE_KEYS,
  CREATIVE_DEFAULTS,
  CREATIVE_ROLES_CACHE_TTL_MS,
  RUNNER_KIND_BY_ROLE,
  callCreativeRole,
  createRoleLedger,
  mergeCreativeRoles,
  recordCreativeRoleUse,
  resetCreativeRolesState,
  resolveCreativeRoles,
  type SettingsClient,
} from '../roles';
import type { LlmProvider, RoleConfig } from '../../ai/types';

/** Minimal mos_settings fake — same shape the sibling's roles.test.ts uses. */
function fakeSb(value: unknown, error: { message: string } | null = null): { sb: SettingsClient; reads: () => number } {
  let reads = 0;
  const sb = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            reads += 1;
            return { data: error ? null : { value }, error };
          },
        }),
      }),
    }),
  } as unknown as SettingsClient;
  return { sb, reads: () => reads };
}

function fakeAnthropic(impl?: (role: RoleConfig) => unknown): LlmProvider & { calls: RoleConfig[] } {
  const calls: RoleConfig[] = [];
  return {
    kind: 'anthropic',
    calls,
    async call<T>(role: RoleConfig) {
      calls.push(role);
      return {
        output: (impl ? impl(role) : { ok: true }) as T,
        usage: { in: 10, out: 5 },
        cost_usd: 0.001,
        provider: 'anthropic' as const,
        model: role.model,
        version: role.version ?? null,
        latency_ms: 12,
      };
    },
  };
}

beforeEach(() => resetCreativeRolesState());
afterEach(() => vi.restoreAllMocks());

describe('CREATIVE_ROLE_KEYS / CREATIVE_DEFAULTS', () => {
  it('has exactly the nine contracted keys, each with a default', () => {
    expect(CREATIVE_ROLE_KEYS).toHaveLength(9);
    for (const k of CREATIVE_ROLE_KEYS) {
      expect(CREATIVE_DEFAULTS[k]).toBeDefined();
      expect(CREATIVE_DEFAULTS[k].model).toBeTruthy();
    }
    expect(CREATIVE_ROLE_KEYS).toContain('creative_concepts');
    expect(CREATIVE_ROLE_KEYS).toContain('image_remove_text');
  });
});

describe('mergeCreativeRoles — settings over CREATIVE_DEFAULTS', () => {
  it('returns a deep copy of defaults when settings are absent', () => {
    const r = mergeCreativeRoles(CREATIVE_DEFAULTS, null);
    expect(r).toEqual(CREATIVE_DEFAULTS);
    expect(r.creative_package).not.toBe(CREATIVE_DEFAULTS.creative_package);
    expect(r.creative_package.params).not.toBe(CREATIVE_DEFAULTS.creative_package.params);
  });
  it('overrides model and deep-merges params', () => {
    const r = mergeCreativeRoles(CREATIVE_DEFAULTS, {
      creative_package: { model: 'claude-sonnet-5', params: { effort: 'low' } },
    });
    expect(r.creative_package.model).toBe('claude-sonnet-5');
    expect(r.creative_package.params).toEqual({ max_tokens: 32000, thinking: 'adaptive', effort: 'low' });
    expect(r.creative_concepts).toEqual(CREATIVE_DEFAULTS.creative_concepts);
  });
  it('a null param unsets the knob', () => {
    const r = mergeCreativeRoles(CREATIVE_DEFAULTS, { creative_concepts: { params: { thinking: null, effort: null } } });
    expect(r.creative_concepts.params).toEqual({ max_tokens: 2500 });
  });
  it('accepts the creative-only providers runner + fal', () => {
    const r = mergeCreativeRoles(CREATIVE_DEFAULTS, {
      design_read_slide: { provider: 'runner' },
      image_generate: { provider: 'fal', model: 'fal-ai/other-model' },
    });
    expect(r.design_read_slide.provider).toBe('runner');
    expect(r.image_generate.model).toBe('fal-ai/other-model');
  });
  it('silently ignores the sibling keys that share the ai_roles row (no warn, no error)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = mergeCreativeRoles(CREATIVE_DEFAULTS, { script_writer: { model: 'claude-sonnet-5' }, embed_text: { model: 'x' } });
    expect(r).toEqual(CREATIVE_DEFAULTS);
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
  it('rejects invalid entries loudly and keeps the default', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = mergeCreativeRoles(CREATIVE_DEFAULTS, {
      creative_concepts: { provider: 'gemini', model: 'g' },
      creative_package: { model: '' },
      creative_derivatives: { params: { thinking: 'deep' } },
      design_read_post: 'claude-sonnet-5',
    });
    expect(r.creative_concepts).toEqual(CREATIVE_DEFAULTS.creative_concepts);
    expect(r.creative_package).toEqual(CREATIVE_DEFAULTS.creative_package);
    expect(r.creative_derivatives).toEqual(CREATIVE_DEFAULTS.creative_derivatives);
    expect(r.design_read_post).toEqual(CREATIVE_DEFAULTS.design_read_post);
    expect(err).toHaveBeenCalledTimes(4);
  });
  it('non-object settings value → defaults + error log', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(mergeCreativeRoles(CREATIVE_DEFAULTS, [1, 2])).toEqual(CREATIVE_DEFAULTS);
    expect(mergeCreativeRoles(CREATIVE_DEFAULTS, 'nope')).toEqual(CREATIVE_DEFAULTS);
    expect(err).toHaveBeenCalledTimes(2);
  });
});

describe('resolveCreativeRoles — DB read + 60 s cache', () => {
  it('reads mos_settings.ai_roles once and serves the cache within the TTL', async () => {
    const { sb, reads } = fakeSb({ creative_concepts: { model: 'claude-opus-5' } });
    let t = 1_000_000;
    const now = () => t;
    const a = await resolveCreativeRoles(sb, { now });
    expect(a.creative_concepts.model).toBe('claude-opus-5');
    t += CREATIVE_ROLES_CACHE_TTL_MS - 1;
    const b = await resolveCreativeRoles(sb, { now });
    expect(b).toBe(a);
    expect(reads()).toBe(1);
    t += 2;
    const c = await resolveCreativeRoles(sb, { now });
    expect(c).not.toBe(a);
    expect(reads()).toBe(2);
  });
  it('force bypasses the cache', async () => {
    const { sb, reads } = fakeSb({});
    await resolveCreativeRoles(sb);
    await resolveCreativeRoles(sb, { force: true });
    expect(reads()).toBe(2);
  });
  it('coalesces concurrent reads into one query', async () => {
    const { sb, reads } = fakeSb({});
    await Promise.all([resolveCreativeRoles(sb), resolveCreativeRoles(sb), resolveCreativeRoles(sb)]);
    expect(reads()).toBe(1);
  });
  it('missing row → code defaults', async () => {
    const { sb } = fakeSb(undefined);
    const r = await resolveCreativeRoles(sb);
    expect(r).toEqual(CREATIVE_DEFAULTS);
  });
  it('DB error with no cache → provider:settings error', async () => {
    const { sb } = fakeSb(null, { message: 'permission denied' });
    await expect(resolveCreativeRoles(sb)).rejects.toThrow(/^provider:settings .*permission denied/);
  });
  it('DB error with a warm cache → serves stale + console.error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = fakeSb({ creative_concepts: { model: 'claude-sonnet-5' } });
    let t = 0;
    const first = await resolveCreativeRoles(good.sb, { now: () => t });
    t += CREATIVE_ROLES_CACHE_TTL_MS + 1;
    const bad = fakeSb(null, { message: 'boom' });
    const again = await resolveCreativeRoles(bad.sb, { now: () => t });
    expect(again).toBe(first);
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe('callCreativeRole — dispatch', () => {
  const req = { system: 's', user: 'u', schema: {} };

  it('routes an anthropic role through the sibling callRole with the resolved config', async () => {
    const anthropic = fakeAnthropic();
    const { sb } = fakeSb({ creative_package: { model: 'claude-sonnet-5' } });
    const res = await callCreativeRole<{ ok: boolean }>('creative_package', req, { sb, providers: { llm: { anthropic } } });
    expect(res.output).toEqual({ ok: true });
    expect(res.provider).toBe('anthropic');
    expect(res.model).toBe('claude-sonnet-5');
    // deep-merged params prove the creative defaults flowed through
    expect(anthropic.calls[0].params?.effort).toBe('high');
    expect(anthropic.calls[0].params?.max_tokens).toBe(32000);
  });
  it('honours ctx.creativeRoles over the DB', async () => {
    const anthropic = fakeAnthropic();
    const { sb, reads } = fakeSb({ creative_concepts: { model: 'from-db' } });
    await callCreativeRole('creative_concepts', req, {
      sb,
      creativeRoles: { creative_concepts: { provider: 'anthropic', model: 'injected' } },
      providers: { llm: { anthropic } },
    });
    expect(anthropic.calls[0].model).toBe('injected');
    expect(reads()).toBe(0);
  });
  it('throws provider:fal for an image role — imageProvider owns those', async () => {
    await expect(callCreativeRole('image_generate', req, { creativeRoles: CREATIVE_DEFAULTS })).rejects.toThrow(
      /^provider:fal role 'image_generate' is an image role — use imageProvider/,
    );
  });
  it('also throws provider:fal when a TEXT role is re-pointed at fal (no LLM to call)', async () => {
    await expect(
      callCreativeRole('creative_concepts', req, {
        creativeRoles: { creative_concepts: { provider: 'fal', model: 'fal-ai/x' } },
      }),
    ).rejects.toThrow(/^provider:fal/);
  });
  it('throws provider:modal for an embedding-pointed role', async () => {
    await expect(
      callCreativeRole('asset_enrich_v2', req, {
        creativeRoles: { asset_enrich_v2: { provider: 'modal', model: 'bge-m3' } },
      }),
    ).rejects.toThrow(/^provider:modal .*use embed\(\)/);
  });
  it('design_read roles map to their contracted claude_jobs kinds', () => {
    expect(RUNNER_KIND_BY_ROLE.design_read_slide).toBe('mkt_visual_design_slide');
    expect(RUNNER_KIND_BY_ROLE.design_read_post).toBe('mkt_visual_design_post');
  });
  it('runner role without ctx.sb → provider:runner error (cannot enqueue)', async () => {
    await expect(
      callCreativeRole('design_read_slide', req, {
        creativeRoles: { design_read_slide: { provider: 'runner', model: 'claude-runner' } },
      }),
    ).rejects.toThrow(/^provider:runner .*no settings client/);
  });
  it('runner provider on a non-design-read role → provider:runner mapping error', async () => {
    const { sb } = fakeSb({});
    await expect(
      callCreativeRole('creative_concepts', req, {
        sb,
        creativeRoles: { creative_concepts: { provider: 'runner', model: 'claude-runner' } },
      }),
    ).rejects.toThrow(/^provider:runner .*no claude_jobs kind mapping/);
  });
  it('falls back to CREATIVE_DEFAULTS (with one warning) when no settings source is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const anthropic = fakeAnthropic();
    await callCreativeRole('creative_derivatives', req, { providers: { llm: { anthropic } } });
    await callCreativeRole('creative_derivatives', req, { providers: { llm: { anthropic } } });
    expect(anthropic.calls[0].model).toBe(CREATIVE_DEFAULTS.creative_derivatives.model);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('ledger helpers', () => {
  it('recordCreativeRoleUse folds a runner result into the sibling ledger', () => {
    const l = createRoleLedger();
    recordCreativeRoleUse(l, 'design_read_slide', {
      output: {},
      usage: { in: 0, out: 0 },
      cost_usd: 0,
      provider: 'runner',
      model: 'claude-runner:mkt_visual_design_slide',
      version: null,
      latency_ms: 42,
    });
    expect(l.calls).toBe(1);
    expect(l.cost_usd).toBe(0);
    expect(l.roles.design_read_slide?.provider).toBe('runner');
    expect(l.latency_ms).toBe(42);
  });
});
