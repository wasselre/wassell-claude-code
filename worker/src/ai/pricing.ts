/**
 * Anthropic model pricing — USD per 1M tokens.
 *
 * Source: the `claude-api` skill's "Current Models" table (cached 2026-06-24)
 * + its prompt-caching economics (cache reads 0.1× input, 0.025× on Claude
 * Fable 5.1; cache writes 1.25× for the 5-minute TTL, 2× for 1-hour).
 *
 * Rule (contracts §4): an UNKNOWN model id yields `null` — never a guessed
 * number. Models the skill lists without a price (Opus 4.5, Sonnet 4.5, the
 * deprecated 4.0/4.1 family) are deliberately absent. Add a row only from a
 * documented price; do not extrapolate.
 *
 * Aliases and dated snapshots share a row (`claude-haiku-4-5` ==
 * `claude-haiku-4-5-20251001`).
 */

export interface ModelPrice {
  input_per_m: number;
  output_per_m: number;
  cache_read_per_m: number;
  cache_write_5m_per_m: number;
  cache_write_1h_per_m: number;
}

function tier(input: number, output: number, cacheReadMultiplier = 0.1): ModelPrice {
  return {
    input_per_m: input,
    output_per_m: output,
    cache_read_per_m: round6(input * cacheReadMultiplier),
    cache_write_5m_per_m: round6(input * 1.25),
    cache_write_1h_per_m: round6(input * 2),
  };
}

const OPUS_TIER = tier(5, 25);
const HAIKU_45 = tier(1, 5);

export const PRICING: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // Fable / Mythos tier — $10 / $50. Fable 5.1 cache reads are 0.025× ($0.25/MTok).
  'claude-fable-5-1': tier(10, 50, 0.025),
  'claude-fable-5': tier(10, 50),
  'claude-mythos-5-1': tier(10, 50),
  'claude-mythos-5': tier(10, 50),
  // Opus tier — $5 / $25.
  'claude-opus-5': OPUS_TIER,
  'claude-opus-4-8': OPUS_TIER,
  'claude-opus-4-7': OPUS_TIER,
  'claude-opus-4-6': OPUS_TIER,
  // Sonnet.
  'claude-sonnet-5': tier(2, 10),
  'claude-sonnet-4-6': tier(3, 15),
  // Haiku 4.5 (alias + dated snapshot).
  'claude-haiku-4-5': HAIKU_45,
  'claude-haiku-4-5-20251001': HAIKU_45,
});

/** Price row for a model id, or null when unknown. */
export function priceFor(model: string): ModelPrice | null {
  const row = PRICING[model.trim()];
  return row ?? null;
}

export interface TokenUsage {
  input: number;
  output: number;
  cache_read?: number;
  /** Cache-creation tokens on the default 5-minute TTL. */
  cache_write_5m?: number;
  /** Cache-creation tokens on the 1-hour TTL. */
  cache_write_1h?: number;
}

/**
 * USD cost of one call, rounded to 6 decimals. Returns null for an unknown
 * model — callers must propagate the null (it means "unknown", not "free").
 */
export function computeCostUsd(model: string, usage: TokenUsage): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const m = 1_000_000;
  const cost =
    (nz(usage.input) * p.input_per_m) / m +
    (nz(usage.output) * p.output_per_m) / m +
    (nz(usage.cache_read) * p.cache_read_per_m) / m +
    (nz(usage.cache_write_5m) * p.cache_write_5m_per_m) / m +
    (nz(usage.cache_write_1h) * p.cache_write_1h_per_m) / m;
  return round6(cost);
}

/** Sum a list of per-call costs; null if ANY is null (an unknown part makes the total unknown). */
export function sumCosts(costs: ReadonlyArray<number | null | undefined>): number | null {
  let total = 0;
  for (const c of costs) {
    if (c === null || c === undefined) return null;
    total += c;
  }
  return round6(total);
}

function nz(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

export function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
