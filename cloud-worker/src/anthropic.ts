import Anthropic from '@anthropic-ai/sdk';
import type { WorkerEnv } from './env.ts';

/**
 * The model the worker calls during runs. Phase 0 uses one fixed model for
 * all jobs; Phase 1+ will let templates declare per-step model overrides.
 *
 * Default is Claude Opus 4.7 (1M context). If a template needs to drop to
 * Sonnet or Haiku for cost/latency reasons, that's a per-template choice
 * we'll surface in the Template Builder.
 */
export const DEFAULT_MODEL = 'claude-opus-4-7' as const;

export function createAnthropicClient(env: WorkerEnv): Anthropic {
  return new Anthropic({ apiKey: env.anthropicApiKey });
}
