/**
 * POST /api/transliterate-name
 *
 * Transliterate an Arabic real-estate PROJECT NAME into English (Latin script)
 * for marketing messages — phonetic, NOT a meaning translation. The general
 * /api/translate endpoint translates meaning (مينا → "Marina"), which is wrong
 * for a project brand; this one writes how the name sounds (مينا 52 → "Mena 52").
 *
 * Request:  { name: string }
 * Response: { ok: true, name_en: string }
 *
 * Auth: Supabase JWT via withAuth (same as api/translate.ts). Edge runtime.
 * Qwen on Cloudflare Workers AI first (writing/translation routing — see
 * api/_lib/textLlm.ts), Claude Haiku force-tool as fallback.
 */

import Anthropic from '@anthropic-ai/sdk';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { qwenRoutingEnabled, qwenJson, logQwenFallback } from './_lib/textLlm.js';

export const config = {
  runtime: 'edge',
};

const SYSTEM_PROMPT = `You transliterate Arabic real-estate PROJECT NAMES into English (Latin script) for marketing messages. Always call the \`transliterate\` tool.

RULES:
1. TRANSLITERATE phonetically — write how the Arabic name SOUNDS in English letters. Do NOT translate the meaning (e.g. "مينا" is a brand name → "Mena", NOT "Marina"/"Port").
2. Keep any digits and already-Latin characters EXACTLY as-is.
3. Render a leading article "ال" attached to the word (e.g. "الماجدية" → "Almajdiya"), Title Case.
4. Output ONLY the transliterated name.

EXAMPLES:
"مينا 52" → "Mena 52"
"الماجدية" → "Almajdiya"
"الماجدية 178" → "Almajdiya 178"
"178" → "178"
"حي الياسمين" → "Hay Al Yasmin"
"برج الرياض" → "Burj Al Riyadh"`;

const TOOL_SCHEMA = {
  name: 'transliterate',
  description: 'Return the English (Latin-script) transliteration of the project name.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name_en: { type: 'string', description: 'The transliterated name in English/Latin script.' },
    },
    required: ['name_en'],
  },
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    let body: { name?: string };
    try {
      body = (await req.json()) as { name?: string };
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return jsonError(400, 'name is required');

    // ── Primary: Qwen on Cloudflare Workers AI ─────────────────────────
    if (qwenRoutingEnabled()) {
      try {
        const out = await qwenJson<{ name_en: string }>({
          system: SYSTEM_PROMPT.replace(' Always call the `transliterate` tool.', ''),
          user: name,
          shape: '{"name_en": string}',
          requiredKeys: ['name_en'],
          maxTokens: 800,
          timeoutMs: 25_000,
        });
        return jsonOk({ ok: true, name_en: out.name_en.trim() });
      } catch (err) {
        logQwenFallback('/api/transliterate-name', err);
      }
    }

    // ── Fallback: Claude Haiku force-tool (original path, unchanged) ───
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');
    const client = new Anthropic({ apiKey });
    let response;
    try {
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        tools: [TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'transliterate' },
        messages: [{ role: 'user', content: name }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(502, `Anthropic call failed: ${msg}`);
    }

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      return jsonError(502, 'Claude did not call the transliterate tool');
    }
    const out = toolBlock.input as { name_en?: string };
    const nameEn = (out.name_en ?? '').trim();
    if (!nameEn) return jsonError(502, 'Claude returned an empty transliteration');
    return jsonOk({ ok: true, name_en: nameEn });
  });
}
