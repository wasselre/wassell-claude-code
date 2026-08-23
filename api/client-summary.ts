/**
 * POST /api/client-summary
 *
 * Writes a short, sales-ready Arabic "who is this client and where are we with
 * them" summary from the client's FULL history — preferences, follow-ups,
 * appointments, visits, phone calls (with their AI summaries / transcripts) and
 * WhatsApp messages.
 *
 * Same boundary as /api/project-ai: the CALLER resolves the facts (client-side,
 * under its own RLS — the rep only ever summarizes a client they can see) and
 * sends them here; the model receives ONLY those facts, never queries the DB,
 * and must never invent one. A missing signal is simply omitted, not guessed.
 *
 * Body: { facts, language?: 'ar'|'en' }
 * Returns: { result: string }
 */

import Anthropic from '@anthropic-ai/sdk';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { llmRoutingEnabled, llmText, logLlmFallback } from './_lib/textLlm.js';

export const config = { runtime: 'edge' };

const MODEL = 'claude-sonnet-4-6';
const MAX_FACTS_CHARS = 24_000;

const SYSTEM_PROMPT = `You are a sales assistant inside Wassel CRM (وصل العقارية), a Saudi Arabian real-estate company. A salesperson is about to contact a client and needs a fast, accurate briefing built from that client's real history.

ABSOLUTE RULES — never violate:
- Use ONLY the facts supplied in this request (preferences, follow-ups, appointments, visits, phone calls with their summaries/transcripts, and WhatsApp messages). You have no other knowledge of this client.
- NEVER invent a fact — no name, budget, location, date, intent, or objection that the facts do not support. If something is unknown, leave it out; do not guess or hedge with filler.
- Read the WhatsApp and call history to capture what the CLIENT actually said — their intent, budget signals, objections, and any commitments — not just the CRM stage labels.
- Currency is the Saudi Riyal (ر.س).

WRITE (Arabic unless English is requested):
- A tight briefing of 3–6 sentences (or short bullets) covering, in this order and only where supported: who the client is + what they're looking for; where they are in the pipeline; the most important signals from recent calls/WhatsApp (intent, budget, objections); and the single most sensible NEXT STEP for this contact.
- No preamble like "Here is a summary". Output the briefing directly. Be concise and practical — the rep reads this in seconds before dialing.`;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    let body: { facts?: unknown; language?: 'ar' | 'en' };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    if (body.facts == null) return jsonError(400, 'facts is required');

    let factsJson: string;
    try {
      factsJson = JSON.stringify(body.facts);
    } catch {
      return jsonError(400, 'facts is not serializable');
    }
    if (factsJson.length > MAX_FACTS_CHARS) {
      return jsonError(400, `facts too large (${factsJson.length} chars; max ${MAX_FACTS_CHARS})`);
    }

    const lang = body.language === 'en' ? 'English' : 'Arabic';
    const userContent = [
      `Write the client briefing described in the system prompt.`,
      `Output language: ${lang}.`,
      `Client history (the ONLY data you may use — JSON):`,
      '```json',
      factsJson,
      '```',
    ].join('\n');

    // ── Primary: DeepSeek (writing routing) ──
    if (llmRoutingEnabled()) {
      try {
        const out = await llmText({
          system: SYSTEM_PROMPT,
          user: userContent,
          maxTokens: 1_200,
          timeoutMs: 55_000,
        });
        return jsonOk({ result: out });
      } catch (err) {
        logLlmFallback('/api/client-summary', err);
      }
    }

    // ── Fallback: Claude ───────────────────────────────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');
    const client = new Anthropic({ apiKey });
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1_200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
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
      return jsonError(502, `client-summary failed: ${msg}`);
    }
  });
}
