import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CODE_DEFAULTS,
  ROLES_CACHE_TTL_MS,
  resolveRoles,
  mergeRoles,
  callRole,
  embed,
  embedQuery,
  createRoleLedger,
  recordRoleUse,
  ledgerToJson,
  resetAiState,
  type SettingsClient,
} from '../roles';
import type { CallResult, EmbedResult, EmbeddingProvider, LlmProvider, RoleConfig } from '../types';

/** Minimal mos_settings fake: `from('mos_settings').select('value').eq('key','ai_roles').maybeSingle()`. */
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

function fakeLlm(kind: 'anthropic' | 'openai_compat', impl?: (role: RoleConfig) => unknown): LlmProvider & { calls: RoleConfig[] } {
  const calls: RoleConfig[] = [];
  return {
    kind,
    calls,
    async call<T>(role: RoleConfig): Promise<CallResult<T>> {
      calls.push(role);
      const output = (impl ? impl(role) : { ok: true }) as T;
      return { output, usage: { in: 10, out: 5 }, cost_usd: 0.001, provider: kind, model: role.model, version: role.version ?? null, latency_ms: 12 };
    },
  };
}

function fakeEmbedder(): EmbeddingProvider & { calls: RoleConfig[] } {
  const calls: RoleConfig[] = [];
  return {
    kind: 'modal',
    calls,
    async embed(role: RoleConfig, input): Promise<EmbedResult> {
      calls.push(role);
      const n = (input.texts ?? input.image_urls ?? []).length;
      return { vectors: Array.from({ length: n }, () => [0, 1]), model: role.model, version: role.version ?? '', dim: 2, cost_usd: null, provider: 'modal', latency_ms: 3 };
    },
    async embedQuery(text: string) {
      return { image_vec: [text.length], text_vec: [1, 2], provider: 'modal', latency_ms: 1, cost_usd: null };
    },
  };
}

beforeEach(() => resetAiState());
afterEach(() => vi.restoreAllMocks());

describe('mergeRoles — settings over CODE_DEFAULTS', () => {
  it('returns a deep copy of defaults when settings are absent', () => {
    const r = mergeRoles(CODE_DEFAULTS, null);
    expect(r).toEqual(CODE_DEFAULTS);
    expect(r.script_writer).not.toBe(CODE_DEFAULTS.script_writer);
    expect(r.script_writer.params).not.toBe(CODE_DEFAULTS.script_writer.params);
  });
  it('overrides model and deep-merges params', () => {
    const r = mergeRoles(CODE_DEFAULTS, { script_writer: { model: 'claude-sonnet-5', params: { effort: 'low' } } });
    expect(r.script_writer.model).toBe('claude-sonnet-5');
    expect(r.script_writer.provider).toBe('anthropic');
    expect(r.script_writer.params).toEqual({ max_tokens: 6000, thinking: 'adaptive', effort: 'low' });
    // untouched roles stay default
    expect(r.claim_classifier).toEqual(CODE_DEFAULTS.claim_classifier);
  });
  it('a null param unsets the knob', () => {
    const r = mergeRoles(CODE_DEFAULTS, { script_writer: { params: { thinking: null, effort: null } } });
    expect(r.script_writer.params).toEqual({ max_tokens: 6000 });
  });
  it('ignores unknown role keys with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = mergeRoles(CODE_DEFAULTS, { not_a_role: { model: 'x' } });
    expect(r).toEqual(CODE_DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('not_a_role');
  });
  it('rejects an invalid provider / model / params entry loudly and keeps the default', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = mergeRoles(CODE_DEFAULTS, {
      script_writer: { provider: 'gemini', model: 'g' },
      script_reviewer: { model: '' },
      claim_classifier: { params: { thinking: 'deep' } },
      frame_describer: 'claude-opus-5',
    });
    expect(r.script_writer).toEqual(CODE_DEFAULTS.script_writer);
    expect(r.script_reviewer).toEqual(CODE_DEFAULTS.script_reviewer);
    expect(r.claim_classifier).toEqual(CODE_DEFAULTS.claim_classifier);
    expect(r.frame_describer).toEqual(CODE_DEFAULTS.frame_describer);
    expect(err).toHaveBeenCalledTimes(4);
  });
  it('non-object settings value → defaults + error log', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(mergeRoles(CODE_DEFAULTS, [1, 2])).toEqual(CODE_DEFAULTS);
    expect(mergeRoles(CODE_DEFAULTS, 'nope')).toEqual(CODE_DEFAULTS);
    expect(err).toHaveBeenCalledTimes(2);
  });
});

describe('resolveRoles — DB read + 60 s cache', () => {
  it('reads mos_settings.ai_roles once and serves the cache within the TTL', async () => {
    const { sb, reads } = fakeSb({ shot_analyzer: { model: 'claude-opus-5' } });
    let t = 1_000_000;
    const now = () => t;
    const a = await resolveRoles(sb, { now });
    expect(a.shot_analyzer.model).toBe('claude-opus-5');
    t += ROLES_CACHE_TTL_MS - 1;
    const b = await resolveRoles(sb, { now });
    expect(b).toBe(a);
    expect(reads()).toBe(1);
    t += 2;
    const c = await resolveRoles(sb, { now });
    expect(c).not.toBe(a);
    expect(reads()).toBe(2);
  });
  it('force bypasses the cache', async () => {
    const { sb, reads } = fakeSb({});
    await resolveRoles(sb);
    await resolveRoles(sb, { force: true });
    expect(reads()).toBe(2);
  });
  it('coalesces concurrent reads into one query', async () => {
    const { sb, reads } = fakeSb({});
    await Promise.all([resolveRoles(sb), resolveRoles(sb), resolveRoles(sb)]);
    expect(reads()).toBe(1);
  });
  it('missing row → code defaults', async () => {
    const { sb } = fakeSb(undefined);
    const r = await resolveRoles(sb);
    expect(r).toEqual(CODE_DEFAULTS);
  });
  it('DB error with no cache → provider:settings error', async () => {
    const { sb } = fakeSb(null, { message: 'permission denied' });
    await expect(resolveRoles(sb)).rejects.toThrow(/^provider:settings .*permission denied/);
  });
  it('DB error with a warm cache → serves stale + console.error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const good = fakeSb({ script_writer: { model: 'claude-sonnet-5' } });
    let t = 0;
    const first = await resolveRoles(good.sb, { now: () => t });
    t += ROLES_CACHE_TTL_MS + 1;
    const bad = fakeSb(null, { message: 'boom' });
    const again = await resolveRoles(bad.sb, { now: () => t });
    expect(again).toBe(first);
    expect(err).toHaveBeenCalledTimes(1);
  });
});

describe('callRole — provider selection', () => {
  it('routes an anthropic role to the anthropic provider with the resolved config', async () => {
    const anthropic = fakeLlm('anthropic');
    const { sb } = fakeSb({ script_writer: { model: 'claude-sonnet-5' } });
    const res = await callRole<{ ok: boolean }>('script_writer', { system: 's', user: 'u', schema: {} }, { sb, providers: { llm: { anthropic } } });
    expect(res.output).toEqual({ ok: true });
    expect(res.model).toBe('claude-sonnet-5');
    expect(anthropic.calls[0].params?.effort).toBe('high');
    expect(res.provider).toBe('anthropic');
    expect(res.latency_ms).toBe(12);
  });
  it('honours ctx.roles over the DB', async () => {
    const anthropic = fakeLlm('anthropic');
    const { sb, reads } = fakeSb({ script_writer: { model: 'from-db' } });
    await callRole('script_writer', { system: 's', user: 'u', schema: {} }, { sb, roles: { script_writer: { provider: 'anthropic', model: 'injected' } }, providers: { llm: { anthropic } } });
    expect(anthropic.calls[0].model).toBe('injected');
    expect(reads()).toBe(0);
  });
  it('accepts an explicit RoleConfig', async () => {
    const openai = fakeLlm('openai_compat');
    const res = await callRole({ provider: 'openai_compat', model: 'qwen' }, { system: 's', user: 'u', schema: {} }, { providers: { llm: { openai_compat: openai } } });
    expect(res.provider).toBe('openai_compat');
  });
  it('falls back to CODE_DEFAULTS (with one warning) when no settings source is given', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const anthropic = fakeLlm('anthropic');
    await callRole('claim_classifier', { system: 's', user: 'u', schema: {} }, { providers: { llm: { anthropic } } });
    await callRole('claim_classifier', { system: 's', user: 'u', schema: {} }, { providers: { llm: { anthropic } } });
    expect(anthropic.calls[0].model).toBe(CODE_DEFAULTS.claim_classifier.model);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it('refuses to call an embedding role', async () => {
    await expect(callRole('embed_text', { system: 's', user: 'u', schema: {} }, { roles: CODE_DEFAULTS })).rejects.toThrow(/^provider:modal .*use embed\(\)/);
  });
  it('unregistered provider → provider: error', async () => {
    await expect(callRole({ provider: 'openai_compat', model: 'x' }, { system: 's', user: 'u', schema: {} }, { providers: { llm: {} } }))
      .rejects.toThrow(/^provider:openai_compat .*not implemented/);
  });
});

describe('error prefixing', () => {
  it('re-wraps an unprefixed provider throw as provider:<kind>', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad: LlmProvider = { kind: 'anthropic', async call() { throw new TypeError('fetch failed'); } };
    await expect(callRole('script_writer', { system: 's', user: 'u', schema: {} }, { roles: CODE_DEFAULTS, providers: { llm: { anthropic: bad } } }))
      .rejects.toThrow(/^provider:anthropic callRole\(script_writer\): fetch failed/);
    expect(err).toHaveBeenCalledTimes(1);
  });
  it('keeps an already-prefixed error untouched', async () => {
    const original = new Error('provider:anthropic refusal (category=cyber)');
    const bad: LlmProvider = { kind: 'anthropic', async call() { throw original; } };
    await expect(callRole('script_writer', { system: 's', user: 'u', schema: {} }, { roles: CODE_DEFAULTS, providers: { llm: { anthropic: bad } } }))
      .rejects.toBe(original);
  });
  it('keeps budget_exceeded: / facts_insufficient: prefixes', async () => {
    const original = new Error('budget_exceeded: daily cap');
    const bad: LlmProvider = { kind: 'anthropic', async call() { throw original; } };
    await expect(callRole('script_writer', { system: 's', user: 'u', schema: {} }, { roles: CODE_DEFAULTS, providers: { llm: { anthropic: bad } } }))
      .rejects.toBe(original);
  });
});

describe('embed / embedQuery', () => {
  it('routes embed_text to the modal provider', async () => {
    const modal = fakeEmbedder();
    const res = await embed('embed_text', { texts: ['a', 'b'] }, { roles: CODE_DEFAULTS, providers: { embedding: { modal } } });
    expect(res.vectors).toHaveLength(2);
    expect(res.model).toBe('bge-m3');
    expect(res.version).toBe('1');
    expect(res.cost_usd).toBeNull();
    expect(modal.calls[0].model).toBe('bge-m3');
  });
  it('refuses a non-embedding role', async () => {
    await expect(embed('script_writer', { texts: ['a'] }, { roles: CODE_DEFAULTS })).rejects.toThrow(/^provider:anthropic .*not an embedding role/);
  });
  it('embedQuery returns both towers', async () => {
    const modal = fakeEmbedder();
    const q = await embedQuery('حي الياسمين', { providers: { embedding: { modal } } });
    expect(q.image_vec).toEqual([11]);
    expect(q.text_vec).toEqual([1, 2]);
  });
});

describe('recordRoleUse ledger', () => {
  const r = (over: Partial<CallResult<unknown>> = {}): CallResult<unknown> => ({
    output: {}, usage: { in: 100, out: 50 }, cost_usd: 0.01, provider: 'anthropic', model: 'claude-opus-5', version: 'claude-opus-5', latency_ms: 200, ...over,
  });
  it('sums calls, tokens, latency and cost per role and overall', () => {
    const l = createRoleLedger();
    recordRoleUse(l, 'script_writer', r());
    recordRoleUse(l, 'script_writer', r({ cost_usd: 0.02 }));
    recordRoleUse(l, 'script_reviewer', r({ model: 'claude-sonnet-5', cost_usd: 0.005 }));
    expect(l.calls).toBe(3);
    expect(l.cost_usd).toBe(0.035);
    expect(l.in).toBe(300);
    expect(l.out).toBe(150);
    expect(l.latency_ms).toBe(600);
    expect(l.roles.script_writer?.calls).toBe(2);
    expect(l.roles.script_writer?.cost_usd).toBe(0.03);
    expect(l.roles.script_reviewer?.model).toBe('claude-sonnet-5');
  });
  it('an unknown cost poisons the total to null and is counted', () => {
    const l = createRoleLedger();
    recordRoleUse(l, 'script_writer', r());
    recordRoleUse(l, 'claim_classifier', r({ model: 'mystery', cost_usd: null }));
    recordRoleUse(l, 'script_writer', r());
    expect(l.cost_usd).toBeNull();
    expect(l.unknown_cost_calls).toBe(1);
    expect(l.roles.script_writer?.cost_usd).toBe(0.02);
    expect(l.roles.claim_classifier?.cost_usd).toBeNull();
  });
  it('accepts embed results (no usage) and serialises to JSON', () => {
    const l = createRoleLedger();
    const e: EmbedResult = { vectors: [], model: 'bge-m3', version: '1', dim: 1024, cost_usd: null, provider: 'modal', latency_ms: 40 };
    recordRoleUse(l, 'embed_text', e);
    const j = ledgerToJson(l);
    expect(j).toMatchObject({ calls: 1, cost_usd: null, unknown_cost_calls: 1, tokens: { in: 0, out: 0 }, latency_ms: 40 });
    expect((j.roles as Record<string, unknown>).embed_text).toMatchObject({ provider: 'modal', model: 'bge-m3', version: '1' });
  });
});
