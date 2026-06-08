/**
 * POST /api/templates/generate-project-message
 *
 * Composes a ready-to-send WhatsApp message for ONE real-estate project, in
 * BOTH Arabic and English, from pre-resolved project facts. One project per
 * call so the frontend can fan out (parallel) and regenerate a single card.
 *
 * The caller (ProjectMessageGeneratorModal) resolves all facts client-side
 * from our_projects + all_projects + units (see src/lib/projectMessageFacts.ts)
 * and passes them in already bilingual + pre-formatted. The model NEVER
 * resolves or invents data — it only orders the fields into the message
 * structure and adds light natural sales wording. Missing values render a
 * "not available" placeholder, never a hallucinated one.
 *
 * Request:  { project: ProjectFacts, styleHint?: string }
 * Response: { ok: true, body_ar: string, body_en: string }
 *
 * Auth: Supabase JWT via withAuth (same as api/translate.ts). Edge runtime —
 * a short Haiku tool-use call, fast enough for cold starts + bulk fan-out.
 */

import Anthropic from '@anthropic-ai/sdk';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';

export const config = {
  runtime: 'edge',
};

interface Bilingual {
  ar: string;
  en: string;
}
interface NumericRange {
  min: number;
  max: number;
}
interface ProjectFacts {
  name?: string | null;
  city?: Bilingual | null;
  district?: Bilingual | null;
  unitTypes?: Bilingual[];
  bedrooms?: NumericRange | null;
  bathrooms?: NumericRange | null;
  minPrice?: Bilingual | null;
  brochureLink?: string | null;
  locationLink?: string | null;
}

interface RequestBody {
  project?: ProjectFacts;
  styleHint?: string;
}

const SYSTEM_PROMPT = `You compose ready-to-send WhatsApp messages for Wassel Real Estate (وصل العقارية) about a SINGLE real-estate project. You produce TWO messages for the same project — an Arabic version (body_ar) and an English version (body_en). ALWAYS call the \`compose_project_messages\` tool; never write prose outside it.

You receive the project's facts as JSON (dropdown values already resolved to ar/en labels; prices already formatted; links verbatim).

HARD RULES — violating any of these is a failure:
1. Use ONLY the values provided. NEVER invent, guess, infer, or embellish a missing value, link, price, number, district, or feature.
2. For any field whose value is null, empty, or an empty list, render the placeholder on that line — Arabic: "غير متوفر", English: "Not available". Do NOT omit the line, and do NOT make something up.
3. Keep every fact verbatim: prices exactly as given, links exactly as given (no shortening, no relabelling), names exactly as given.
4. Plain WhatsApp text only — no markdown (#, *, backticks), no fake bold. Use line breaks between lines. Emoji are allowed but sparing (0–3).

STRUCTURE (this order, after one short warm greeting/intro line):
- Project name (its own line at the top)
- City
- District
- Unit Types (comma-separate if several)
- Bedrooms (render "min - max", or a single number if min == max)
- Bathrooms (same range rule)
- Starting Price
- Brochure (the link)
- Location (the link)
You MAY add ONE short, natural sales closing line (e.g. an invitation to ask for details). Nothing more.

LABELS to use exactly:
Arabic —  المدينة / الحي / أنواع الوحدات / غرف النوم / دورات المياه / السعر يبدأ من / البروشور / الموقع
English — City / District / Unit Types / Bedrooms / Bathrooms / Starting Price / Brochure / Location

body_ar: natural Saudi-friendly Arabic. body_en: natural English. Keep both concise.`;

const TOOL_SCHEMA = {
  name: 'compose_project_messages',
  description: 'Return the Arabic and English WhatsApp messages for the project.',
  input_schema: {
    type: 'object' as const,
    properties: {
      body_ar: { type: 'string', description: 'The full Arabic WhatsApp message (plain text, line breaks).' },
      body_en: { type: 'string', description: 'The full English WhatsApp message (plain text, line breaks).' },
    },
    required: ['body_ar', 'body_en'],
  },
};

interface ToolOutput {
  body_ar: string;
  body_en: string;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const project = body.project;
    if (!project || typeof project !== 'object') {
      return jsonError(400, 'project facts are required');
    }

    // Hand the model the facts verbatim. Nulls stay null so the placeholder
    // rule fires; we never pre-fill anything.
    const factsJson = JSON.stringify(
      {
        name: project.name ?? null,
        city: project.city ?? null,
        district: project.district ?? null,
        unitTypes: Array.isArray(project.unitTypes) ? project.unitTypes : [],
        bedrooms: project.bedrooms ?? null,
        bathrooms: project.bathrooms ?? null,
        minPrice: project.minPrice ?? null,
        brochureLink: project.brochureLink ?? null,
        locationLink: project.locationLink ?? null,
      },
      null,
      2,
    );
    const styleHint = typeof body.styleHint === 'string' && body.styleHint.trim() ? body.styleHint.trim() : null;
    const userContent =
      `Project facts (JSON):\n${factsJson}` +
      (styleHint ? `\n\nStyle guidance from the user (follow it, but never break the HARD RULES):\n${styleHint}` : '');

    const client = new Anthropic({ apiKey });
    let response;
    try {
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        tools: [TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'compose_project_messages' },
        messages: [{ role: 'user', content: userContent }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(502, `Anthropic call failed: ${msg}`);
    }

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      return jsonError(502, 'Claude did not call the compose_project_messages tool');
    }
    const out = toolBlock.input as ToolOutput;
    if (!out.body_ar || !out.body_en) {
      return jsonError(502, 'Claude returned an incomplete message pair');
    }
    return jsonOk({ ok: true, body_ar: out.body_ar, body_en: out.body_en });
  });
}
