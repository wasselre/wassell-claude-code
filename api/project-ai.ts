/**
 * POST /api/project-ai
 *
 * Fact-grounded AI actions for the Projects + Units experience. The caller
 * resolves the project/unit FACTS client-side (from projectView/unitView) and
 * sends them in the request. The model receives ONLY those facts — it never
 * queries the database and is instructed, hard, to never invent a fact: any
 * field that is null/absent is reported as "غير متوفر" (not available).
 *
 * This is the "AI explains, deterministic code decides" boundary:
 *   - Project MATCHING is NOT here — it runs on /api/project-finder
 *     (deterministic, boundary-verified). The match UI may pass that endpoint's
 *     returned facts here only to NARRATE them.
 *   - clean / brief / whatsapp / compare_units / audit all operate purely on the
 *     supplied facts.
 *
 * Body: { action, facts, language?: 'ar'|'en' }
 * Returns: { result: string }
 */

import Anthropic from '@anthropic-ai/sdk';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { qwenRoutingEnabled, qwenText, logQwenFallback } from './_lib/textLlm.js';

export const config = { runtime: 'edge' };

const MODEL = 'claude-sonnet-4-6';
const MAX_FACTS_CHARS = 16_000;

type ProjectAiAction = 'clean' | 'brief' | 'whatsapp' | 'compare_units' | 'audit' | 'match_explain';

const ACTION_INSTRUCTIONS: Record<ProjectAiAction, string> = {
  clean:
    'You are auditing ONE project record for data quality. From the supplied facts and the "detected_issues" list, produce a SHORT, prioritized, actionable checklist of fixes (most important first): missing important fields, inconsistent values, invalid price/area ranges, missing geo, missing media. One line per issue, each starting with a verb. Do NOT invent problems that the facts do not support. If there are no issues, say so plainly.',
  brief:
    'Write a concise salesperson-ready brief for this ONE project, in Arabic, from the supplied facts ONLY. Cover: what the project is, location, developer, available inventory, price range, standout unit types/amenities. 4–7 short sentences or bullet points. Any fact that is null/absent must be written as "غير متوفر" — never guess, never fill gaps.',
  whatsapp:
    'Write ONE concise, friendly, professional Arabic WhatsApp sales message about the supplied project/units, using ONLY the supplied facts. Keep it short (a customer reads it on a phone). Include price and a call to action if those facts are present. Never invent a price, location, availability or amenity. Omit anything not provided rather than guessing.',
  compare_units:
    'Compare the supplied units (price, area, price/m², floor, bedrooms, bathrooms, status) and recommend the single best option WITH concrete reasons drawn ONLY from the supplied numbers. If a unit is missing a value, treat it as unknown — do not assume. Output a short comparison then a clear recommendation. Arabic.',
  audit:
    'Summarize the data-quality state of this ONE project from the supplied facts + the "required_missing" / "optional_missing" / "blocking" lists. State the score (given in facts), then briefly: what is missing and required, what blocks website publishing, what blocks matching. Do not invent. Arabic.',
  match_explain:
    'You are given DETERMINISTIC match results (candidates with scores, bands, and per-factor breakdowns already computed by the system) plus the client requirements. Explain, in Arabic, why the TOP candidates fit or do not fit — strictly from the supplied breakdown and facts (location fit, budget fit, bedrooms/bathrooms, unit type, availability, distance). You may NOT re-rank, NOT add candidates, and NOT invent facts. If a candidate has data gaps, say so.',
};

const SYSTEM_PROMPT = `You are the Projects analyst inside Wassel CRM (وصل العقارية), a Saudi Arabian real-estate company. You help salespeople understand and present REAL project/unit data.

ABSOLUTE RULES — never violate:
- Use ONLY the facts supplied in this request. You have no other knowledge of these projects.
- NEVER invent or estimate a price, location, area, availability, amenity, developer, or date. If a fact is null/absent, write "غير متوفر" (or "غير مؤكد" when data may be stale) — do not guess.
- Never choose projects or units freely; only reason over what is supplied.
- Currency is the Saudi Riyal (ر.س). Output Arabic unless explicitly asked for English.
- Be concise and sales-practical. No preamble like "Here is...". Output the content directly.`;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    let body: { action?: ProjectAiAction; facts?: unknown; language?: 'ar' | 'en' };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const action = body.action;
    if (!action || !(action in ACTION_INSTRUCTIONS)) {
      return jsonError(400, `action must be one of ${Object.keys(ACTION_INSTRUCTIONS).join('|')}`);
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
      `Action: ${ACTION_INSTRUCTIONS[action]}`,
      `Output language: ${lang}.`,
      `Facts (the ONLY data you may use — JSON):`,
      '```json',
      factsJson,
      '```',
    ].join('\n');

    // ── Primary: Qwen on Cloudflare Workers AI (writing/translation routing) ──
    if (qwenRoutingEnabled()) {
      try {
        const out = await qwenText({
          system: SYSTEM_PROMPT,
          user: userContent,
          maxTokens: 3_000,
          timeoutMs: 55_000,
        });
        return jsonOk({ result: out });
      } catch (err) {
        logQwenFallback('/api/project-ai', err);
      }
    }

    // ── Fallback: Claude (original path, unchanged) ────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');
    const client = new Anthropic({ apiKey });
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 1_500,
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
      return jsonError(502, `project-ai failed: ${msg}`);
    }
  });
}
