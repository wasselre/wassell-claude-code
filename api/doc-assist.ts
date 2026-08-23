/**
 * POST /api/doc-assist
 *
 * AI actions on SELECTED TEXT inside a Wassel document: rewrite, improve,
 * translate, summarize, expand, shorten. One-shot request → transformed text
 * (no SSE — selections are paragraphs, not decks; the call returns in
 * seconds, same posture as /api/translate).
 *
 * Body: {
 *   action: 'rewrite'|'improve'|'translate'|'summarize'|'expand'|'shorten',
 *   text: string,                 // the selection (≤ ~8k chars)
 *   docTitle?: string,            // current document title
 *   context?: string,             // compact linked-records context block,
 *                                 // built CLIENT-side from the same resolved
 *                                 // variables the CRM-variables feature uses
 *   targetLang?: 'ar' | 'en'      // translate only
 * }
 *
 * Returns { result: string } — the transformed text ONLY (no preamble), so
 * the editor can offer replace-in-place.
 */

import Anthropic from '@anthropic-ai/sdk';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { llmRoutingEnabled, llmText, logLlmFallback } from './_lib/textLlm.js';

export const config = { runtime: 'edge' };

const MODEL = 'claude-sonnet-4-6';
const MAX_INPUT_CHARS = 8_000;
const MAX_CONTEXT_CHARS = 2_500;

type AssistAction = 'rewrite' | 'improve' | 'translate' | 'summarize' | 'expand' | 'shorten';

const ACTION_INSTRUCTIONS: Record<AssistAction, string> = {
  rewrite:
    'Rewrite the text with fresh wording while preserving its exact meaning, tone and language. Same approximate length.',
  improve:
    'Improve the text: fix grammar, spelling and awkward phrasing; tighten flow; raise it to polished professional business writing. Keep the language, meaning and approximate length.',
  translate:
    'Translate the text to the requested target language. Natural, professional translation — what a Saudi real-estate professional would actually write — not literal word-for-word. Keep formatting (line breaks, lists as dashes).',
  summarize:
    'Summarize the text into its essential points — significantly shorter, same language. Prefer flowing prose for short inputs; use dash bullets only if the input is long and list-like.',
  expand:
    'Expand the text with relevant elaboration, detail and supporting points. Same language and tone, roughly 2-3x the length. Stay grounded — never invent specific facts, numbers or commitments that are not in the text or the context.',
  shorten:
    'Shorten the text to roughly half its length while keeping every essential point. Same language and tone.',
};

const SYSTEM_PROMPT = `You are the writing assistant inside Wassel CRM (وصل العقارية) — a Saudi Arabian real-estate marketing & sales company. Users select text in a business document and ask for one transformation.

Hard rules:
- Output ONLY the transformed text. No preamble, no explanation, no quotes around it, no "Here is...".
- Preserve the input's language unless the action is translate.
- Arabic output must be natural professional Saudi/Modern Standard Arabic.
- Preserve {{variable_tokens}} and @mentions EXACTLY as written — never translate, expand or remove them.
- Keep the input's paragraph/line structure unless the action inherently changes it (summarize/expand).
- If CRM context is provided, use it ONLY to keep facts consistent — never inject context facts the text didn't ask for.`;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    let body: {
      action?: AssistAction;
      text?: string;
      docTitle?: string;
      context?: string;
      targetLang?: 'ar' | 'en';
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const action = body.action;
    if (!action || !(action in ACTION_INSTRUCTIONS)) {
      return jsonError(400, 'action must be one of rewrite|improve|translate|summarize|expand|shorten');
    }
    const text = (body.text ?? '').trim();
    if (!text) return jsonError(400, 'text is required');
    if (text.length > MAX_INPUT_CHARS) {
      return jsonError(400, `selection too long (${text.length} chars; max ${MAX_INPUT_CHARS})`);
    }

    const parts: string[] = [];
    parts.push(`Action: ${ACTION_INSTRUCTIONS[action]}`);
    if (action === 'translate') {
      parts.push(`Target language: ${body.targetLang === 'en' ? 'English' : 'Arabic'}`);
    }
    if (body.docTitle) parts.push(`Document title: ${body.docTitle.slice(0, 200)}`);
    if (body.context) {
      parts.push(`CRM context (linked records — background facts only):\n${body.context.slice(0, MAX_CONTEXT_CHARS)}`);
    }
    parts.push(`Text to transform:\n<<<\n${text}\n>>>`);

    // ── Primary: DeepSeek (writing/translation routing) ──
    if (llmRoutingEnabled()) {
      try {
        const out = await llmText({
          system: SYSTEM_PROMPT,
          user: parts.join('\n\n'),
          maxTokens: Math.min(8_000, Math.max(2_000, Math.ceil(text.length / 2) + 1_000)),
          timeoutMs: 55_000,
        });
        return jsonOk({ result: out });
      } catch (err) {
        logLlmFallback('/api/doc-assist', err);
      }
    }

    // ── Fallback: Claude (original path, unchanged) ────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');
    const client = new Anthropic({ apiKey });
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: Math.min(8_000, Math.max(1_000, Math.ceil(text.length / 2))),
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: parts.join('\n\n') }],
      });
      const out = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!out) return jsonError(502, 'empty response from model');
      return jsonOk({ result: out });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(502, `assist failed: ${msg}`);
    }
  });
}
