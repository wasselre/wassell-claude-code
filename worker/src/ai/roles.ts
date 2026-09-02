/**
 * AI roles — resolution + dispatch (contracts §4).
 *
 *   resolveRoles(sb)            → Record<RoleKey, RoleConfig>   (mos_settings.ai_roles over CODE_DEFAULTS, cached 60 s)
 *   callRole<T>(role, req, ctx) → CallResult<T>                 (LLM roles → provider by RoleConfig.provider)
 *   embed(role, input, ctx)     → EmbedResult                   (embedding roles → Modal)
 *   embedQuery(text, ctx)       → EmbedQueryResult              (dual-tower search query)
 *   recordRoleUse(ledger, role, result) / createRoleLedger()    (sum costs onto a job / draft / video row)
 *
 * Role configs are DATA: `mos_settings` row key='ai_roles', value = object
 * keyed by RoleKey. An operator can re-point a role at another model without
 * a deploy; a malformed entry is logged with console.error and ignored (the
 * code default stays) — never silently, never a crash of the whole worker.
 *
 * Providers are created lazily and can be injected through `AiContext`
 * (tests) — no network is touched by anything in this file itself.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sumCosts, round6 } from './pricing.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createModalEmbedProvider } from './providers/modalEmbed.js';
import {
  PROVIDER_KINDS,
  ROLE_KEYS,
  hasKindPrefix,
  providerError,
  type CallRequest,
  type CallResult,
  type EmbedInput,
  type EmbedQueryResult,
  type EmbedResult,
  type EmbeddingProvider,
  type LlmProvider,
  type ProviderKind,
  type RoleConfig,
  type RoleKey,
  type RoleParams,
} from './types.js';

export type { RoleKey, RoleConfig, CallRequest, CallResult, EmbedInput, EmbedResult } from './types.js';

// ---------------------------------------------------------------------------
// Defaults (contracts §4 — "non-final"; mos_settings.ai_roles overrides)
// ---------------------------------------------------------------------------

export const CODE_DEFAULTS: Readonly<Record<RoleKey, RoleConfig>> = Object.freeze({
  script_writer: { provider: 'anthropic', model: 'claude-opus-5', params: { max_tokens: 6000, thinking: 'adaptive', effort: 'high' } },
  script_reviewer: { provider: 'anthropic', model: 'claude-sonnet-5', params: { max_tokens: 3000, thinking: 'adaptive', effort: 'medium' } },
  claim_classifier: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', params: { max_tokens: 1200 } },
  frame_describer: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', params: { max_tokens: 1500 } },
  shot_analyzer: { provider: 'anthropic', model: 'claude-sonnet-5', params: { max_tokens: 2500, thinking: 'adaptive', effort: 'medium' } },
  reference_explainer: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', params: { max_tokens: 800 } },
  embed_text: { provider: 'modal', model: 'bge-m3', version: '1' },
  embed_image: { provider: 'modal', model: 'siglip2-base-patch16-256', version: '1' },
});

export const ROLES_CACHE_TTL_MS = 60_000;

/** The only slice of a Supabase client `resolveRoles` needs (tests inject a fake). */
export type SettingsClient = Pick<SupabaseClient, 'from'>;

// ---------------------------------------------------------------------------
// resolveRoles — settings merge with a 60 s cache
// ---------------------------------------------------------------------------

interface RolesCache {
  roles: Record<RoleKey, RoleConfig>;
  fetchedAt: number;
}

let rolesCache: RolesCache | null = null;
let inflight: Promise<Record<RoleKey, RoleConfig>> | null = null;

export interface ResolveOptions {
  /** Bypass the cache (e.g. right after an operator edit). */
  force?: boolean;
  now?: () => number;
}

export async function resolveRoles(sb: SettingsClient, opts: ResolveOptions = {}): Promise<Record<RoleKey, RoleConfig>> {
  const now = opts.now ?? (() => Date.now());
  if (!opts.force && rolesCache && now() - rolesCache.fetchedAt < ROLES_CACHE_TTL_MS) return rolesCache.roles;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'ai_roles').maybeSingle();
      if (error) {
        if (rolesCache) {
          // Stale-but-known beats a dead lane; the read error is still loud.
          console.error(`[ai/roles] mos_settings.ai_roles read failed (${error.message}) — serving cached roles from ${new Date(rolesCache.fetchedAt).toISOString()}`);
          return rolesCache.roles;
        }
        throw providerError('settings', `mos_settings.ai_roles read failed: ${error.message}`, error);
      }
      const roles = mergeRoles(CODE_DEFAULTS, (data as { value?: unknown } | null)?.value);
      rolesCache = { roles, fetchedAt: now() };
      return roles;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Pure merge: settings object (unknown shape) over defaults. Exported for tests. */
export function mergeRoles(defaults: Readonly<Record<RoleKey, RoleConfig>>, settings: unknown): Record<RoleKey, RoleConfig> {
  const out = {} as Record<RoleKey, RoleConfig>;
  for (const k of ROLE_KEYS) out[k] = cloneConfig(defaults[k]);
  if (settings === null || settings === undefined) return out;
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    console.error(`[ai/roles] mos_settings.ai_roles is not an object (got ${Array.isArray(settings) ? 'array' : typeof settings}) — using code defaults`);
    return out;
  }
  for (const [key, raw] of Object.entries(settings as Record<string, unknown>)) {
    if (!isRoleKey(key)) {
      console.warn(`[ai/roles] mos_settings.ai_roles has unknown role '${key}' — ignored`);
      continue;
    }
    const problem = validateOverride(raw);
    if (problem) {
      console.error(`[ai/roles] mos_settings.ai_roles.${key} invalid (${problem}) — keeping code default ${out[key].provider}/${out[key].model}`);
      continue;
    }
    const o = raw as Partial<RoleConfig>;
    const base = out[key];
    const merged: RoleConfig = {
      provider: o.provider ?? base.provider,
      model: o.model ?? base.model,
    };
    const version = o.version ?? base.version;
    if (version !== undefined) merged.version = String(version);
    const params = mergeParams(base.params, o.params);
    if (params) merged.params = params;
    out[key] = merged;
  }
  return out;
}

function validateOverride(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
  const o = raw as Record<string, unknown>;
  if (o.provider !== undefined && !(PROVIDER_KINDS as readonly string[]).includes(String(o.provider))) return `provider '${String(o.provider)}' not in ${PROVIDER_KINDS.join('|')}`;
  if (o.model !== undefined && (typeof o.model !== 'string' || !o.model.trim())) return 'model must be a non-empty string';
  if (o.params !== undefined && (o.params === null || typeof o.params !== 'object' || Array.isArray(o.params))) return 'params must be an object';
  if (o.params && typeof o.params === 'object') {
    // `null` is allowed for any knob — it means "unset the code default" (see mergeParams).
    const p = o.params as Record<string, unknown>;
    const set = (v: unknown): boolean => v !== undefined && v !== null;
    if (set(p.max_tokens) && !(typeof p.max_tokens === 'number' && p.max_tokens > 0)) return 'params.max_tokens must be a positive number';
    if (set(p.thinking) && p.thinking !== 'adaptive' && p.thinking !== 'off') return "params.thinking must be 'adaptive'|'off'";
    if (set(p.effort) && !['low', 'medium', 'high'].includes(String(p.effort))) return "params.effort must be 'low'|'medium'|'high'";
    if (set(p.temperature) && typeof p.temperature !== 'number') return 'params.temperature must be a number';
  }
  return null;
}

function mergeParams(base: RoleParams | undefined, over: RoleParams | undefined): RoleParams | undefined {
  if (!base && !over) return undefined;
  const merged: RoleParams = { ...(base ?? {}), ...(over ?? {}) };
  // A `null` in the settings JSON means "unset this knob" — drop it rather than forward null.
  for (const k of Object.keys(merged) as (keyof RoleParams)[]) {
    if ((merged as Record<string, unknown>)[k] === null || merged[k] === undefined) delete merged[k];
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function cloneConfig(c: RoleConfig): RoleConfig {
  const out: RoleConfig = { provider: c.provider, model: c.model };
  if (c.version !== undefined) out.version = c.version;
  if (c.params) out.params = { ...c.params };
  return out;
}

function isRoleKey(k: string): k is RoleKey {
  return (ROLE_KEYS as readonly string[]).includes(k);
}

/** Test hook — drop the settings cache and lazily-built providers. */
export function resetAiState(): void {
  rolesCache = null;
  inflight = null;
  providers = null;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export interface ProviderRegistry {
  llm: Partial<Record<ProviderKind, LlmProvider>>;
  embedding: Partial<Record<ProviderKind, EmbeddingProvider>>;
}

let providers: ProviderRegistry | null = null;

function defaultProviders(): ProviderRegistry {
  if (providers) return providers;
  const modal = createModalEmbedProvider();
  providers = {
    llm: { anthropic: createAnthropicProvider() },
    embedding: { modal },
  };
  return providers;
}

/** Everything a call site may inject. All optional; production callers pass `{ sb }`. */
export interface AiContext {
  /** Settings source for resolveRoles. */
  sb?: SettingsClient;
  /** Pre-resolved roles (skips the settings read). */
  roles?: Partial<Record<RoleKey, RoleConfig>>;
  /** Provider overrides (tests). */
  providers?: Partial<ProviderRegistry>;
}

const defaultsWarned = new Set<RoleKey>();

async function resolveOne(role: RoleKey | RoleConfig, ctx: AiContext): Promise<{ key: RoleKey | null; cfg: RoleConfig }> {
  if (typeof role !== 'string') return { key: null, cfg: role };
  const injected = ctx.roles?.[role];
  if (injected) return { key: role, cfg: injected };
  if (ctx.sb) return { key: role, cfg: (await resolveRoles(ctx.sb))[role] };
  if (rolesCache) return { key: role, cfg: rolesCache.roles[role] };
  if (!defaultsWarned.has(role)) {
    defaultsWarned.add(role);
    console.warn(`[ai/roles] no settings source for role '${role}' — using CODE_DEFAULTS (${CODE_DEFAULTS[role].provider}/${CODE_DEFAULTS[role].model}); pass { sb } to honour mos_settings.ai_roles`);
  }
  return { key: role, cfg: CODE_DEFAULTS[role] };
}

function llmFor(kind: ProviderKind, ctx: AiContext): LlmProvider {
  const p = ctx.providers?.llm?.[kind] ?? defaultProviders().llm[kind];
  if (!p) throw providerError(kind, `no LLM provider registered for '${kind}'${kind === 'openai_compat' ? ' (not implemented yet)' : ''}`);
  return p;
}

function embedderFor(kind: ProviderKind, ctx: AiContext): EmbeddingProvider {
  const p = ctx.providers?.embedding?.[kind] ?? defaultProviders().embedding[kind];
  if (!p) throw providerError(kind, `no embedding provider registered for '${kind}'`);
  return p;
}

// ---------------------------------------------------------------------------
// callRole / embed / embedQuery
// ---------------------------------------------------------------------------

/**
 * Run one structured LLM call for a role. `role` may be a RoleKey (resolved
 * through ctx.roles → ctx.sb → cache → CODE_DEFAULTS) or an explicit RoleConfig.
 * Throws `provider:`-prefixed errors only (any other throw from a provider is
 * re-wrapped so lanes can map it to error_kind).
 */
export async function callRole<T>(role: RoleKey | RoleConfig, req: CallRequest, ctx: AiContext = {}): Promise<CallResult<T>> {
  const { key, cfg } = await resolveOne(role, ctx);
  if (cfg.provider === 'modal') throw providerError('modal', `role '${key ?? cfg.model}' is an embedding role — use embed()`);
  const provider = llmFor(cfg.provider, ctx);
  try {
    return await provider.call<T>(cfg, req);
  } catch (err) {
    throw ensurePrefixed(cfg.provider, err, `callRole(${key ?? cfg.model})`);
  }
}

/** Embed texts OR image_urls through the role's embedding provider (Modal). */
export async function embed(role: RoleKey | RoleConfig, input: EmbedInput, ctx: AiContext = {}): Promise<EmbedResult> {
  const { key, cfg } = await resolveOne(role, ctx);
  if (cfg.provider !== 'modal') throw providerError(cfg.provider, `role '${key ?? cfg.model}' is not an embedding role (provider=${cfg.provider})`);
  const provider = embedderFor(cfg.provider, ctx);
  try {
    return await provider.embed(cfg, input);
  } catch (err) {
    throw ensurePrefixed(cfg.provider, err, `embed(${key ?? cfg.model})`);
  }
}

/** Dual-tower query embedding for `mkt_cv_search` (SigLIP-2 text 768-d + bge-m3 1024-d). */
export async function embedQuery(text: string, ctx: AiContext = {}): Promise<EmbedQueryResult> {
  const provider = embedderFor('modal', ctx);
  if (!provider.embedQuery) throw providerError('modal', 'embedding provider has no embedQuery()');
  try {
    return await provider.embedQuery(text);
  } catch (err) {
    throw ensurePrefixed('modal', err, 'embedQuery');
  }
}

function ensurePrefixed(kind: ProviderKind, err: unknown, where: string): Error {
  if (err instanceof Error && hasKindPrefix(err)) return err;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[ai/roles] ${where}: unprefixed ${kind} failure — ${msg}`);
  return providerError(kind, `${where}: ${msg}`, err);
}

// ---------------------------------------------------------------------------
// Cost ledger — sum onto job / draft / video rows (contracts §12)
// ---------------------------------------------------------------------------

export interface RoleUseEntry {
  provider: ProviderKind;
  model: string;
  version: string | null;
  calls: number;
  /** null once ANY call for this role had an unknown cost. */
  cost_usd: number | null;
  in: number;
  out: number;
  latency_ms: number;
}

export interface RoleUseLedger {
  calls: number;
  /** null once ANY recorded call had an unknown cost (unknown ≠ free). */
  cost_usd: number | null;
  /** How many calls contributed null — surfaces "we don't know the price of X" loudly. */
  unknown_cost_calls: number;
  in: number;
  out: number;
  latency_ms: number;
  roles: Partial<Record<RoleKey | string, RoleUseEntry>>;
}

export function createRoleLedger(): RoleUseLedger {
  return { calls: 0, cost_usd: 0, unknown_cost_calls: 0, in: 0, out: 0, latency_ms: 0, roles: {} };
}

type Recordable = CallResult<unknown> | EmbedResult | EmbedQueryResult;

/**
 * Fold one result into a ledger (mutates + returns it). `role` is the key the
 * call was made under; results from callRole / embed / embedQuery all fit.
 */
export function recordRoleUse(ledger: RoleUseLedger, role: RoleKey | string, result: Recordable): RoleUseLedger {
  const usage = 'usage' in result ? result.usage : null;
  const inTok = usage?.in ?? 0;
  const outTok = usage?.out ?? 0;
  const model = 'model' in result ? result.model : 'embed_query';
  const version = 'version' in result ? (result.version ?? null) : null;

  ledger.calls += 1;
  ledger.in += inTok;
  ledger.out += outTok;
  ledger.latency_ms += result.latency_ms;
  if (result.cost_usd === null) {
    ledger.unknown_cost_calls += 1;
    ledger.cost_usd = null;
  } else if (ledger.cost_usd !== null) {
    ledger.cost_usd = round6(ledger.cost_usd + result.cost_usd);
  }

  const entry: RoleUseEntry = ledger.roles[role] ?? {
    provider: result.provider,
    model,
    version,
    calls: 0,
    cost_usd: 0,
    in: 0,
    out: 0,
    latency_ms: 0,
  };
  entry.calls += 1;
  entry.in += inTok;
  entry.out += outTok;
  entry.latency_ms += result.latency_ms;
  entry.cost_usd = sumCosts([entry.cost_usd, result.cost_usd]);
  // Last call wins for provenance (a role re-pointed mid-job shows its latest model).
  entry.provider = result.provider;
  entry.model = model;
  entry.version = version;
  ledger.roles[role] = entry;
  return ledger;
}

/** Plain JSON for `*.roles jsonb` columns (drafts / jobs / videos). */
export function ledgerToJson(ledger: RoleUseLedger): Record<string, unknown> {
  return {
    calls: ledger.calls,
    cost_usd: ledger.cost_usd,
    unknown_cost_calls: ledger.unknown_cost_calls,
    tokens: { in: ledger.in, out: ledger.out },
    latency_ms: ledger.latency_ms,
    roles: ledger.roles,
  };
}
