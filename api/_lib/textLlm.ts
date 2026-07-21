/**
 * textLlm — routing layer for WRITING and TRANSLATION tasks.
 *
 * FINAL decision (2026-07-21): all writing/translation tasks run on CLAUDE
 * (Anthropic). A measured cost comparison (60-listing Qwen run) confirmed the
 * spend is trivial at production volume and Claude's writing quality + latency
 * win, so Anthropic is the DEFAULT provider in code — writing never silently
 * reverts to Qwen if an env var is dropped.
 *
 * Qwen3 30B on Cloudflare Workers AI (api/_lib/cloudflareAi.ts) remains wired as
 * an OPT-IN, for the one case where it earns its ~30× cost advantage: bulk /
 * background generation across the whole catalogue. It is enabled ONLY when
 * TEXT_LLM_PROVIDER=qwen is set explicitly AND the CLOUDFLARE_* env is present.
 * Even then, every routed endpoint keeps its Anthropic implementation as the
 * FALLBACK: if the Qwen call fails for ANY reason (quota exhausted on the free
 * plan, rate limit, timeout, bad output), the endpoint logs loudly and runs the
 * unchanged Claude path — a user request never fails because Qwen did.
 *
 * Routed endpoints (writing/translation — one-shot text in → text/JSON out):
 *   /api/translate, /api/transliterate-name, /api/doc-assist, /api/project-ai,
 *   /api/templates/listing-message, /api/templates/generate-from-description,
 *   supabase/functions/project-details-ai-v2 (own copy — Deno can't import this)
 *
 * NOT routed (agentic tool-loops, vision, matching — different architecture):
 *   /api/agent (sales agent), /api/copywriter (tool loop over the reel KB),
 *   /api/builder-agent, /api/workflow-agent, /api/migrate, /api/analyze-reel,
 *   decks. These stay Anthropic until separately approved.
 *
 * Provider switch: default (unset TEXT_LLM_PROVIDER) is Claude for ALL routed
 * endpoints. Set TEXT_LLM_PROVIDER=qwen to opt bulk/background traffic onto Qwen
 * (requires CLOUDFLARE_* env). Any other value, or unset, stays on Claude.
 *
 * Qwen3 is a thinking model — completions may open with a <think>…</think>
 * block. stripThink() removes it; qwenJson() parses the first JSON object in
 * what remains and validates required keys, throwing (→ fallback) on garbage.
 */

import { cloudflareChatCompletion } from './cloudflareAi.js';

/** Default max_tokens for Qwen calls — thinking tokens count, so be generous. */
const DEFAULT_QWEN_MAX_TOKENS = 2_000;

/**
 * True when writing/translation traffic should try Qwen first. Claude is the
 * default: Qwen is opt-in ONLY via TEXT_LLM_PROVIDER=qwen (and needs the
 * CLOUDFLARE_* env). Unset — or any other value — stays on Claude.
 */
export function qwenRoutingEnabled(): boolean {
  if ((process.env.TEXT_LLM_PROVIDER ?? '').trim().toLowerCase() !== 'qwen') return false;
  return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID?.trim() && process.env.CLOUDFLARE_API_TOKEN?.trim());
}

/** Remove Qwen3 <think>…</think> reasoning blocks (incl. an unclosed one). */
export function stripThink(content: string): string {
  return content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .trim();
}

export interface QwenTextOpts {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/** One-shot prose generation. Returns the visible (think-stripped) text. */
export async function qwenText(opts: QwenTextOpts): Promise<string> {
  const r = await cloudflareChatCompletion({
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    maxTokens: opts.maxTokens ?? DEFAULT_QWEN_MAX_TOKENS,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
  });
  const text = stripThink(r.content);
  if (!text) throw new Error('qwen returned an empty completion');
  return text;
}

export interface QwenJsonOpts extends QwenTextOpts {
  /**
   * Human-readable shape description embedded in the prompt, e.g.
   * '{"label_ar": string, "label_en": string, "name": string}'.
   */
  shape: string;
  /** Keys that must be present (and non-empty when strings) in the parsed object. */
  requiredKeys: string[];
}

/**
 * One-shot structured generation: instructs Qwen to answer with ONLY a JSON
 * object of the given shape, parses the first JSON object in the reply, and
 * validates the required keys. Throws on any mismatch — the caller falls back
 * to its Anthropic path.
 */
export async function qwenJson<T extends object>(opts: QwenJsonOpts): Promise<T> {
  const system = `${opts.system}\n\nOUTPUT FORMAT (hard requirement): respond with ONLY one JSON object of exactly this shape — no prose before or after it, no markdown fences:\n${opts.shape}`;
  const raw = await qwenText({ ...opts, system });

  // Tolerate markdown fences / stray prose: parse the outermost {...} span.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('qwen reply contained no JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('qwen reply was not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('qwen reply was not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of opts.requiredKeys) {
    const v = obj[key];
    if (v == null || (typeof v === 'string' && !v.trim())) {
      throw new Error(`qwen reply missing required key "${key}"`);
    }
  }
  return obj as unknown as T;
}

/**
 * Standard loud fallback log. Call from an endpoint's catch around the Qwen
 * attempt, then run the Anthropic path. Never throws.
 */
export function logQwenFallback(endpoint: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[textLlm] qwen failed for ${endpoint} — falling back to Anthropic: ${msg}`);
}
