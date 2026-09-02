/**
 * Creative AI roles — resolution + dispatch for the Post Creative Director.
 *
 * Contract: docs/creative-director-contracts.md §5 (the nine role keys + the
 * DATA defaults below) and docs/creative-director/briefs/A-AI.md.
 *
 * Builds ON worker/src/ai/** (REUSED, never edited):
 *  - Role configs are DATA in the SAME `mos_settings` row key='ai_roles' the
 *    sibling adapter reads. This module resolves ONLY the nine creative keys
 *    (the sibling resolves its own eight; each ignores the other's keys).
 *  - LLM calls delegate to the sibling `callRole` with an EXPLICIT RoleConfig
 *    object — the sibling's RoleKey union and ProviderKind union are NOT
 *    extended. Creative-only providers ('runner', 'fal') are handled here
 *    BEFORE any sibling call:
 *      'fal'    → image roles — the caller must use imageProvider.ts instead.
 *      'runner' → Claude-Code runner — delegated to runnerProvider.ts, which
 *                 enqueues a `claude_jobs` row and polls for the result.
 *  - Cost ledgers are the sibling's; re-exported here so creative lanes have
 *    one import site.
 *
 * Validation mirrors the sibling's mergeRoles semantics: a malformed entry is
 * logged with console.error and the code default stays — never silently,
 * never a crash of the whole worker.
 */

import {
  callRole,
  createRoleLedger,
  ledgerToJson,
  recordRoleUse,
  resolveRoles,
  type AiContext,
  type CallRequest,
  type CallResult,
  type CallUsage,
  type ProviderKind,
  type RoleConfig,
  type RoleParams,
  type RoleUseLedger,
  type SettingsClient,
} from '../ai/index.js';
import { callViaRunner, type RunnerJobKind, type RunnerOptions } from './runnerProvider.js';

// Ledger helpers — single import site for the creative lanes (contracts §15:
// every job/row records model, roles ledger, cost).
export { createRoleLedger, recordRoleUse, ledgerToJson, resolveRoles };
export type { RoleUseLedger, CallRequest, CallUsage, SettingsClient };

// ---------------------------------------------------------------------------
// Role keys + defaults (contracts §5 — "DATA defaults marked non-final";
// mos_settings.ai_roles overrides)
// ---------------------------------------------------------------------------

export const CREATIVE_ROLE_KEYS = [
  'creative_concepts',
  'creative_package',
  'creative_derivatives',
  'design_read_slide',
  'design_read_post',
  'asset_enrich_v2',
  'image_edit',
  'image_generate',
  'image_remove_text',
] as const;

export type CreativeRoleKey = (typeof CREATIVE_ROLE_KEYS)[number];

/** Sibling LLM providers plus the two creative-only providers. */
export type CreativeProviderKind = ProviderKind | 'runner' | 'fal';

export const CREATIVE_PROVIDER_KINDS: readonly CreativeProviderKind[] = [
  'anthropic',
  'openai_compat',
  'modal',
  'runner',
  'fal',
];

export interface CreativeRoleConfig {
  provider: CreativeProviderKind;
  model: string;
  version?: string;
  params?: RoleParams;
}

/** The three image roles — these belong to imageProvider.ts, not callCreativeRole. */
export const IMAGE_ROLE_KEYS: readonly CreativeRoleKey[] = ['image_edit', 'image_generate', 'image_remove_text'];

export type ImageRoleKey = 'image_edit' | 'image_generate' | 'image_remove_text';

export function isImageRoleKey(key: CreativeRoleKey): key is ImageRoleKey {
  return (IMAGE_ROLE_KEYS as readonly string[]).includes(key);
}

/**
 * NON-FINAL configured defaults (contracts §5). An operator can re-point any
 * role at another model/provider in Marketing → Settings → AI roles without a
 * deploy; nothing in the architecture may depend on these values.
 */
export const CREATIVE_DEFAULTS: Readonly<Record<CreativeRoleKey, CreativeRoleConfig>> = Object.freeze({
  creative_concepts: { provider: 'anthropic', model: 'claude-sonnet-5', params: { max_tokens: 2500, thinking: 'adaptive', effort: 'medium' } },
  creative_package: { provider: 'anthropic', model: 'claude-opus-5', params: { max_tokens: 8000, thinking: 'adaptive', effort: 'high' } },
  creative_derivatives: { provider: 'anthropic', model: 'claude-sonnet-5', params: { max_tokens: 5000, thinking: 'adaptive', effort: 'medium' } },
  design_read_slide: { provider: 'anthropic', model: 'claude-sonnet-5', params: { max_tokens: 2000 } },
  design_read_post: { provider: 'anthropic', model: 'claude-sonnet-5', params: { max_tokens: 3000, thinking: 'adaptive', effort: 'medium' } },
  asset_enrich_v2: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', params: { max_tokens: 1500 } },
  image_edit: { provider: 'fal', model: 'fal-ai/nano-banana-pro/edit' },
  image_generate: { provider: 'fal', model: 'fal-ai/nano-banana-pro' },
  image_remove_text: { provider: 'fal', model: 'fal-ai/flux-2/klein/4b/edit' },
});

export const CREATIVE_ROLES_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Errors — `provider:`-prefixed (contracts §0.15). The sibling's providerError
// only accepts its own ProviderKind union, so creative-only kinds build theirs
// here with the identical message shape.
// ---------------------------------------------------------------------------

export function creativeProviderError(kind: CreativeProviderKind | 'settings', detail: string, cause?: unknown): Error {
  const err = new Error(`provider:${kind} ${detail}`);
  if (cause !== undefined) (err as Error & { cause?: unknown }).cause = cause;
  return err;
}

// ---------------------------------------------------------------------------
// resolveCreativeRoles — settings merge with a 60 s cache (own cache: the
// sibling's cache holds only the sibling's eight keys)
// ---------------------------------------------------------------------------

interface CreativeRolesCache {
  roles: Record<CreativeRoleKey, CreativeRoleConfig>;
  fetchedAt: number;
}

let rolesCache: CreativeRolesCache | null = null;
let inflight: Promise<Record<CreativeRoleKey, CreativeRoleConfig>> | null = null;

export interface ResolveCreativeOptions {
  /** Bypass the cache (e.g. right after an operator edit). */
  force?: boolean;
  now?: () => number;
}

export async function resolveCreativeRoles(
  sb: SettingsClient,
  opts: ResolveCreativeOptions = {},
): Promise<Record<CreativeRoleKey, CreativeRoleConfig>> {
  const now = opts.now ?? (() => Date.now());
  if (!opts.force && rolesCache && now() - rolesCache.fetchedAt < CREATIVE_ROLES_CACHE_TTL_MS) return rolesCache.roles;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'ai_roles').maybeSingle();
      if (error) {
        if (rolesCache) {
          // Stale-but-known beats a dead lane; the read error is still loud.
          console.error(
            `[creative/roles] mos_settings.ai_roles read failed (${error.message}) — serving cached roles from ${new Date(rolesCache.fetchedAt).toISOString()}`,
          );
          return rolesCache.roles;
        }
        throw creativeProviderError('settings', `mos_settings.ai_roles read failed: ${error.message}`, error);
      }
      const roles = mergeCreativeRoles(CREATIVE_DEFAULTS, (data as { value?: unknown } | null)?.value);
      rolesCache = { roles, fetchedAt: now() };
      return roles;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Pure merge: the ai_roles settings object (unknown shape) over the creative
 * defaults. ONLY the nine creative keys are read — the sibling's keys in the
 * same row are skipped WITHOUT a warning (they are not unknown, they are the
 * sibling's). Exported for tests.
 */
export function mergeCreativeRoles(
  defaults: Readonly<Record<CreativeRoleKey, CreativeRoleConfig>>,
  settings: unknown,
): Record<CreativeRoleKey, CreativeRoleConfig> {
  const out = {} as Record<CreativeRoleKey, CreativeRoleConfig>;
  for (const k of CREATIVE_ROLE_KEYS) out[k] = cloneConfig(defaults[k]);
  if (settings === null || settings === undefined) return out;
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    console.error(
      `[creative/roles] mos_settings.ai_roles is not an object (got ${Array.isArray(settings) ? 'array' : typeof settings}) — using code defaults`,
    );
    return out;
  }
  for (const [key, raw] of Object.entries(settings as Record<string, unknown>)) {
    if (!isCreativeRoleKey(key)) continue; // sibling keys live in the same row — not ours, not a warning
    const problem = validateCreativeOverride(raw);
    if (problem) {
      console.error(
        `[creative/roles] mos_settings.ai_roles.${key} invalid (${problem}) — keeping code default ${out[key].provider}/${out[key].model}`,
      );
      continue;
    }
    const o = raw as Partial<CreativeRoleConfig>;
    const base = out[key];
    const merged: CreativeRoleConfig = {
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

/** Same checks as the sibling's validateOverride, with the extended provider list. */
function validateCreativeOverride(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object';
  const o = raw as Record<string, unknown>;
  if (o.provider !== undefined && !(CREATIVE_PROVIDER_KINDS as readonly string[]).includes(String(o.provider)))
    return `provider '${String(o.provider)}' not in ${CREATIVE_PROVIDER_KINDS.join('|')}`;
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

function cloneConfig(c: CreativeRoleConfig): CreativeRoleConfig {
  const out: CreativeRoleConfig = { provider: c.provider, model: c.model };
  if (c.version !== undefined) out.version = c.version;
  if (c.params) out.params = { ...c.params };
  return out;
}

function isCreativeRoleKey(k: string): k is CreativeRoleKey {
  return (CREATIVE_ROLE_KEYS as readonly string[]).includes(k);
}

/** Test hook — drop the settings cache and the warned-once registry. */
export function resetCreativeRolesState(): void {
  rolesCache = null;
  inflight = null;
  defaultsWarned.clear();
}

// ---------------------------------------------------------------------------
// callCreativeRole
// ---------------------------------------------------------------------------

/**
 * A CallResult whose provider may also be 'runner' (Claude-Code runner — no
 * per-call API meter) — the sibling's ProviderKind union is NOT extended, so
 * the widened type lives here.
 */
export interface CreativeCallResult<T> {
  output: T;
  usage: CallUsage;
  /** USD; null when unknown (never a guessed number). Runner calls report 0 — subscription, no incremental charge. */
  cost_usd: number | null;
  provider: CreativeProviderKind;
  model: string;
  version: string | null;
  latency_ms: number;
  structured_via?: 'format' | 'tool';
}

/** Everything a creative call site may inject. Production callers pass `{ sb }`. */
export interface CreativeAiContext extends AiContext {
  /**
   * Pre-resolved creative role overrides (eval harness). Keyed by
   * CreativeRoleKey — deliberately NOT the sibling's `roles` field, whose
   * key/type would conflict.
   */
  creativeRoles?: Partial<Record<CreativeRoleKey, CreativeRoleConfig>>;
  /** Runner polling knobs (tests / backfills). */
  runner?: RunnerOptions;
}

/** role → claude_jobs kind for the runner provider (A-VIS owns the handlers). */
export const RUNNER_KIND_BY_ROLE: Partial<Record<CreativeRoleKey, RunnerJobKind>> = {
  design_read_slide: 'mkt_visual_design_slide',
  design_read_post: 'mkt_visual_design_post',
};

const defaultsWarned = new Set<CreativeRoleKey>();

async function resolveOneCreative(
  key: CreativeRoleKey,
  ctx: CreativeAiContext,
): Promise<CreativeRoleConfig> {
  const injected = ctx.creativeRoles?.[key];
  if (injected) return injected;
  if (ctx.sb) return (await resolveCreativeRoles(ctx.sb))[key];
  if (rolesCache) return rolesCache.roles[key];
  if (!defaultsWarned.has(key)) {
    defaultsWarned.add(key);
    console.warn(
      `[creative/roles] no settings source for role '${key}' — using CREATIVE_DEFAULTS (${CREATIVE_DEFAULTS[key].provider}/${CREATIVE_DEFAULTS[key].model}); pass { sb } to honour mos_settings.ai_roles`,
    );
  }
  return CREATIVE_DEFAULTS[key];
}

/**
 * Run one structured call for a creative role.
 *
 *  - provider 'anthropic' / 'openai_compat' → the sibling `callRole` with an
 *    EXPLICIT RoleConfig object (the sibling's unions stay untouched).
 *  - provider 'runner' → runnerProvider.callViaRunner (enqueue + poll a
 *    `claude_jobs` row; only design_read_* roles have a runner kind mapping).
 *  - provider 'fal' → throws: image roles go through imageProvider.ts.
 *  - provider 'modal' → throws: embedding roles go through the sibling embed().
 */
export async function callCreativeRole<T>(
  key: CreativeRoleKey,
  req: CallRequest,
  ctx: CreativeAiContext = {},
): Promise<CreativeCallResult<T>> {
  const cfg = await resolveOneCreative(key, ctx);
  switch (cfg.provider) {
    case 'fal':
      throw creativeProviderError('fal', `role '${key}' is an image role — use imageProvider`);
    case 'modal':
      throw creativeProviderError('modal', `role '${key}' is an embedding role — use embed()`);
    case 'runner': {
      const kind = RUNNER_KIND_BY_ROLE[key];
      if (!kind) {
        throw creativeProviderError('runner', `role '${key}' has no claude_jobs kind mapping — only design_read_slide/design_read_post can run on the runner`);
      }
      if (!ctx.sb) {
        throw creativeProviderError('runner', `role '${key}' resolved to provider 'runner' but no settings client (ctx.sb) was given — cannot enqueue a claude_jobs row`);
      }
      return callViaRunner<T>(kind, req, { ...ctx.runner, sb: ctx.sb });
    }
    case 'anthropic':
    case 'openai_compat': {
      // Narrow to the sibling's RoleConfig — same fields, provider now in its union.
      const explicit: RoleConfig = { provider: cfg.provider, model: cfg.model };
      if (cfg.version !== undefined) explicit.version = cfg.version;
      if (cfg.params) explicit.params = { ...cfg.params };
      const res: CallResult<T> = await callRole<T>(explicit, req, ctx);
      return res;
    }
  }
}

/**
 * Fold a creative result (which may carry provider 'runner'/'fal') into the
 * sibling ledger. The ledger's RoleUseEntry.provider is typed ProviderKind;
 * the creative-only kinds are recorded as their plain string (the ledger is
 * JSON provenance on a job row — widening the sibling's union for it would
 * touch the reused module, which we never do).
 */
export function recordCreativeRoleUse(
  ledger: RoleUseLedger,
  role: CreativeRoleKey | string,
  result: CreativeCallResult<unknown>,
): RoleUseLedger {
  return recordRoleUse(ledger, role, result as CallResult<unknown>);
}
