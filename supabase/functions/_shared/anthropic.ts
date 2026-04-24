// Claude API client + shared constants for the marketing edge functions.
// Matches the pattern in haberchat-webhook/claude.ts.

import Anthropic from "npm:@anthropic-ai/sdk@0.35.0";

export const CLAUDE_MODEL = "claude-sonnet-4-6";
export const MAX_TOKENS = 8000;

let cached: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (cached) return cached;
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY missing from env");
  cached = new Anthropic({ apiKey: key });
  return cached;
}

// deno-lint-ignore no-explicit-any
export type ContentBlock = any;
// deno-lint-ignore no-explicit-any
export type MessageParam = any;

/**
 * Extract the final text block from a Claude response. Skips tool_use blocks.
 */
// deno-lint-ignore no-explicit-any
export function extractFinalText(content: any[]): string {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (block.type === "text") return String(block.text ?? "").trim();
  }
  return "";
}

/**
 * Parse JSON from Claude's text response. Handles pure JSON, ```json fences,
 * and loose text with an embedded { ... } block.
 */
// deno-lint-ignore no-explicit-any
export function extractJson<T = any>(text: string): T {
  const trimmed = text.trim();

  // Try 1: pure JSON
  try {
    return JSON.parse(trimmed) as T;
  } catch { /* fall through */ }

  // Try 2: ```json ... ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch { /* fall through */ }
  }

  // Try 3: first balanced { ... } block
  const start = trimmed.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      else if (trimmed[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as T;
          } catch { /* fall through */ }
          break;
        }
      }
    }
  }

  throw new Error(`Could not extract JSON from response. First 300 chars: ${trimmed.slice(0, 300)}`);
}
