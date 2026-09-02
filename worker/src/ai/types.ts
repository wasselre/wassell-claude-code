/**
 * AI role adapter — shared types.
 *
 * Contract: docs/marketing-script-visual-contracts.md §4 (role keys, RoleConfig,
 * callRole / embed result shapes) and §12 (every result carries provider /
 * model / version / cost_usd / latency_ms; cost_usd is null when the model is
 * not in the pricing table — never a guessed number).
 *
 * Nothing in this file touches the network. Providers live in
 * `./providers/*`, dispatch lives in `./roles.ts`.
 */

/** Every configurable AI role in the script writer + visual system. */
export type RoleKey =
  | 'script_writer'
  | 'script_reviewer'
  | 'claim_classifier'
  | 'frame_describer'
  | 'shot_analyzer'
  | 'reference_explainer'
  | 'embed_text'
  | 'embed_image';

export const ROLE_KEYS: readonly RoleKey[] = [
  'script_writer',
  'script_reviewer',
  'claim_classifier',
  'frame_describer',
  'shot_analyzer',
  'reference_explainer',
  'embed_text',
  'embed_image',
];

export type ProviderKind = 'anthropic' | 'openai_compat' | 'modal';

export const PROVIDER_KINDS: readonly ProviderKind[] = ['anthropic', 'openai_compat', 'modal'];

/** Per-role generation knobs. All optional; providers apply their own defaults. */
export interface RoleParams {
  max_tokens?: number;
  /** 'adaptive' → adaptive thinking on; 'off' → thinking disabled; unset → omit the param (model default). */
  thinking?: 'adaptive' | 'off';
  effort?: 'low' | 'medium' | 'high';
  /** Only forwarded when thinking is not adaptive (sampling params + thinking are mutually exclusive). */
  temperature?: number;
}

export interface RoleConfig {
  provider: ProviderKind;
  model: string;
  /** Free-form version tag (e.g. embedding model version '1'). Recorded on every result. */
  version?: string;
  params?: RoleParams;
}

/** A JSON Schema object (draft 2020-12 subset the API accepts). */
export type JSONSchema = Record<string, unknown>;

/** One image attached to a role call — exactly one of `url` / `base64`. */
export type RoleImage =
  | { url: string; base64?: undefined; mime?: string }
  | { base64: string; url?: undefined; mime: string };

export interface CallRequest {
  /** Stable prefix — gets `cache_control` when `cache !== false`. */
  system: string;
  user: string;
  images?: RoleImage[];
  /** JSON schema the output must satisfy; the provider returns the parsed object. */
  schema: JSONSchema;
  /** Default true. Set false for one-off prompts that would only pay the cache-write premium. */
  cache?: boolean;
}

export interface CallUsage {
  /** Uncached input tokens billed at full price. */
  in: number;
  out: number;
  /** Input tokens served from the prompt cache (when the provider reports them). */
  cache_read?: number;
  /** Input tokens written to the prompt cache (when the provider reports them). */
  cache_write?: number;
}

export interface CallResult<T> {
  output: T;
  usage: CallUsage;
  /** USD; null when the model is not in `pricing.ts` (unknown ≠ zero). */
  cost_usd: number | null;
  provider: ProviderKind;
  /** The model id that was REQUESTED (what the pricing table is keyed by). */
  model: string;
  /** `RoleConfig.version` when set, else the resolved model id the API reported (snapshot provenance). */
  version: string | null;
  latency_ms: number;
  /** How structured output was obtained — `format` (output_config) or `tool` (forced-tool fallback). */
  structured_via?: 'format' | 'tool';
}

export interface EmbedInput {
  texts?: string[];
  image_urls?: string[];
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  version: string;
  dim: number;
  /** Modal is compute-billed per container-second, not per call → null (unknown), never 0. */
  cost_usd: number | null;
  provider: ProviderKind;
  latency_ms: number;
}

/** `/embed_query` — one text → both towers (SigLIP-2 text 768-d + bge-m3 1024-d). */
export interface EmbedQueryResult {
  image_vec: number[];
  text_vec: number[];
  provider: ProviderKind;
  latency_ms: number;
  cost_usd: number | null;
}

export interface LlmProvider {
  readonly kind: ProviderKind;
  call<T>(role: RoleConfig, req: CallRequest): Promise<CallResult<T>>;
}

export interface EmbeddingProvider {
  readonly kind: ProviderKind;
  embed(role: RoleConfig, input: EmbedInput): Promise<EmbedResult>;
  /** Optional — only the Modal provider implements the dual-tower query endpoint. */
  embedQuery?(text: string): Promise<EmbedQueryResult>;
}

/** Stable error prefix per contracts §12 — lanes map it to `error_kind`. */
export const PROVIDER_ERROR_PREFIX = 'provider:';

/** Build a `provider:`-prefixed Error, preserving the original as `cause`. */
export function providerError(kind: ProviderKind | 'settings', detail: string, cause?: unknown): Error {
  const err = new Error(`${PROVIDER_ERROR_PREFIX}${kind} ${detail}`);
  if (cause !== undefined) (err as Error & { cause?: unknown }).cause = cause;
  return err;
}

/** True when an error already carries one of the contract's stable kind prefixes. */
export function hasKindPrefix(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /^(provider|facts_insufficient|budget_exceeded|validation_unrepaired):/.test(msg);
}
