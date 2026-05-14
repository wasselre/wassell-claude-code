/**
 * Claude-driven SVG icon generation for the "Generate" tab of the
 * project_details icon picker.
 *
 * Why Claude and not fal.ai recraft-v3:
 *   recraft-v3 is an editorial-illustration model — its `vector_illustration`
 *   substyles (line_art, thin, marker_outline, …) all return 60–200 KB
 *   SVGs full of gradients and detail. Even forced through the cleanest
 *   substyle, the output never matches the website's hand-coded
 *   ~250-byte Lucide-class monoline icons. Claude can — when you show it
 *   the target style as in-context examples.
 *
 * How the prompt is constructed:
 *   - The system prompt fixes the technical spec (24×24 viewBox, stroke
 *     1.8 copper #B8734F, monoline, fill="none", no scripts/iframes).
 *   - The user message includes three reference SVGs from
 *     `Wassel Website/js/project-icons.js` (home, pool, bed) so Claude
 *     can copy the path-complexity and shape language the website uses.
 *   - Claude returns the SVG via a `emit_icon_svg` tool with a single
 *     `svg` string field. No prose, no markdown.
 *
 * Loud failures only — per CLAUDE.md "Silent Failures":
 *   - Anthropic non-2xx → throws.
 *   - SVG envelope wrong / banned elements / inline JS → throws.
 *   - Caller (api/icons/generate.ts) maps to a 502 with the message.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;

const SYSTEM_PROMPT = `You design ONE flat monoline SVG icon for Wassel Real Estate (وصل العقارية).

Hard rules — match these or the icon is rejected:
- Output a single complete <svg>…</svg> element. Nothing else.
- viewBox="0 0 24 24".
- fill="none" stroke="#B8734F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" on the root <svg>.
- Built from only these elements: <path>, <circle>, <rect>, <line>, <polyline>, <polygon>. Inline only.
- ZERO fills on any child element. ZERO gradients. ZERO filters. ZERO <defs>, <style>, <script>, <foreignObject>, <image>, <use>, <linearGradient>, <radialGradient>.
- Transparent background (no background rect).
- 3–8 path/shape elements total. Each path under ~40 characters of "d" data. KEEP IT SIMPLE — fewer strokes is better. Match the path-complexity of Lucide icons.
- Centered subject within 0–24. No text. No labels. No shadows. No dashed/dotted strokes.

If the description is in Arabic, design the universal real-estate icon equivalent — do not write Arabic text into the SVG.

Emit ONLY via the emit_icon_svg tool.`;

// Reference icons copied verbatim from Wassel Website/js/project-icons.js
// — these set Claude's expectation of stroke density, shape language,
// and overall path complexity. Without these, Claude tends to over-detail.
const FEW_SHOT_USER_MESSAGE = `Here are three reference icons from our library so you match the style exactly:

Subject "home": <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#B8734F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>

Subject "pool": <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#B8734F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 22a8 8 0 0 1 16 0"/><path d="M2 18a8 8 0 0 1 16 0"/><path d="M2 14a8 8 0 0 1 16 0"/></svg>

Subject "bed": <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#B8734F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v6"/><path d="M2 18h20"/><path d="M2 22v-4"/><path d="M22 22v-4"/><path d="M2 12h20"/></svg>

Now produce the icon for: `;

const TOOL_SCHEMA = {
  name: 'emit_icon_svg',
  description: 'Emit the final SVG icon markup. Must be a complete <svg>…</svg> element.',
  input_schema: {
    type: 'object' as const,
    properties: {
      svg: { type: 'string' as const, description: 'Complete SVG markup.' },
    },
    required: ['svg'],
    additionalProperties: false,
  },
};

function validateSvg(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('<svg') || !trimmed.endsWith('</svg>')) {
    throw new Error('Claude returned malformed SVG (missing <svg>…</svg> envelope)');
  }
  if (/<\s*(script|foreignObject|image|iframe|link|style|defs|linearGradient|radialGradient|filter|use)\b/i.test(trimmed)) {
    throw new Error('Claude returned SVG with disallowed elements');
  }
  if (/javascript:/i.test(trimmed) || /\son\w+\s*=/i.test(trimmed)) {
    throw new Error('Claude returned SVG with inline JS / event handlers');
  }
  return trimmed;
}

export interface GenerateIconOpts {
  /** User-facing description. Free-form, may be Arabic or English. */
  prompt: string;
  modelId?: string;
  signal?: AbortSignal;
}

export async function generateIconSvg(opts: GenerateIconOpts): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create(
    {
      model: opts.modelId ?? MODEL_ID,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: TOOL_SCHEMA.name },
      messages: [{ role: 'user', content: `${FEW_SHOT_USER_MESSAGE}${opts.prompt}` }],
    },
    opts.signal ? { signal: opts.signal } : undefined,
  );

  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock || toolBlock.type !== 'tool_use') {
    throw new Error('Claude did not call the emit_icon_svg tool');
  }
  const out = toolBlock.input as { svg?: string };
  if (typeof out.svg !== 'string' || !out.svg) {
    throw new Error('Claude tool output is missing the svg field');
  }
  return validateSvg(out.svg);
}
