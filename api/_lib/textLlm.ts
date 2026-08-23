/**
 * textLlm — routing layer for WRITING and TRANSLATION tasks.
 *
 * Provider (2026-08-10, user directive "don't use Qwen anywhere — use DeepSeek"):
 * all writing/translation tasks run on DEEPSEEK (`deepseek-chat`, api/_lib/deepseek.ts)
 * as the PRIMARY provider, with CLAUDE (Anthropic) kept as the automatic
 * per-endpoint FALLBACK — if the DeepSeek call fails for ANY reason (quota, rate
 * limit, timeout, bad output) the endpoint logs loudly and runs its unchanged
 * Claude path, so a user request never fails because DeepSeek did.
 *
 * Qwen3 / Cloudflare Workers AI has been REMOVED from this path entirely
 * (cloudflareAi.ts deleted). Do not reintroduce it here.
 *
 * DeepSeek is ON by default whenever DEEPSEEK_API_KEY is set. Kill switch:
 * set TEXT_LLM_PROVIDER=anthropic to force the Claude-only path for EVERY routed
 * endpoint (writing then never touches DeepSeek).
 *
 * Routed endpoints (writing/translation — one-shot text in → text/JSON out):
 *   /api/client-summary, /api/translate, /api/transliterate-name, /api/doc-assist,
 *   /api/project-ai, /api/templates/listing-message, /api/templates/posts-content,
 *   supabase/functions/project-details-ai-v2 (own copy — Deno can't import this).
 *
 * NOT routed (agentic tool-loops, vision, matching — different architecture):
 *   /api/agent, /api/copywriter, /api/builder-agent, /api/workflow-agent,
 *   /api/migrate, /api/analyze-reel, decks. These stay Anthropic.
 */

import { deepseekChat, deepseekJson, deepseekEnabled, logDeepseekFallback } from './deepseek.js';

/**
 * True when writing/translation traffic should try DeepSeek first. DeepSeek is
 * the default whenever DEEPSEEK_API_KEY is present; TEXT_LLM_PROVIDER=anthropic
 * is the kill switch that forces the Claude-only path everywhere.
 */
export function llmRoutingEnabled(): boolean {
  if ((process.env.TEXT_LLM_PROVIDER ?? '').trim().toLowerCase() === 'anthropic') return false;
  return deepseekEnabled();
}

/** One-shot prose generation on DeepSeek. Throws on failure → caller's Claude fallback. */
export const llmText = deepseekChat;

/** One-shot structured (JSON) generation on DeepSeek. Throws on mismatch → caller's Claude fallback. */
export const llmJson = deepseekJson;

/** Standard loud fallback log — call in the catch around the DeepSeek attempt. Never throws. */
export const logLlmFallback = logDeepseekFallback;

export type { DeepseekChatOpts as LlmTextOpts, DeepseekJsonOpts as LlmJsonOpts } from './deepseek.js';
