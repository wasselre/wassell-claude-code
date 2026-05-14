/**
 * Claude-driven SVG icon generation for the project_details icon picker.
 *
 * Replaces the earlier fal.ai recraft-v3 approach because recraft's
 * `vector_illustration` style produces busy editorial illustrations
 * rather than the clean minimal flat icons the Wassel brand wants.
 * Claude reliably produces tight Lucide-style monoline SVGs when
 * forced through a tool schema with a single `svg` string field.
 *
 * Reads ANTHROPIC_API_KEY (server-side only) and returns the SVG
 * markup as a UTF-8 string. Caller uploads it to storage.
 *
 * Loud failures only — per CLAUDE.md "Silent Failures": Anthropic
 * errors propagate; SVG-shape validation throws with a useful message.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_TOKENS = 4000;

const SYSTEM_PROMPT = `You are an icon designer for Wassel Real Estate (وصل العقارية).

You produce ONE minimal flat SVG icon that matches the Wassel brand:
- Single line weight, monoline outline style (think Lucide / Phosphor / Heroicons outline).
- Stroke color is exactly Wassel copper: #B8734F.
- Stroke width 1.5 on a 24x24 viewBox.
- stroke-linecap="round" and stroke-linejoin="round".
- fill="none" on every stroke shape (no filled blobs).
- Transparent background (no background rect).
- Centered subject. No text, no labels, no decorative shadows.
- Use only basic shapes (path, circle, rect, line, polyline, polygon). Inline only — no external refs, no <style>, no <script>, no <foreignObject>, no <image>, no <use href>.
- Output ONLY the SVG markup via the tool. Do NOT explain.

The subject of the icon is described in the user message. Translate it visually into one cohesive icon. If the description is in Arabic, design the equivalent universal real-estate icon.`;

const TOOL_SCHEMA = {
  name: 'emit_icon_svg',
  description:
    'Emit the final SVG icon markup. The svg field must be a complete <svg>…</svg> element ready to drop into an <img> via a data URL or saved to disk as a .svg file.',
  input_schema: {
    type: 'object' as const,
    properties: {
      svg: {
        type: 'string' as const,
        description: 'Complete SVG markup starting with <svg and ending with </svg>.',
      },
    },
    required: ['svg'],
    additionalProperties: false,
  },
};

/** Minimal validation — refuses obviously-broken or unsafe SVG payloads. */
function validateSvg(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('<svg') || !trimmed.endsWith('</svg>')) {
    throw new Error('Claude returned malformed SVG (missing <svg>…</svg> envelope)');
  }
  const banned = /<\s*(script|foreignObject|image|iframe|link|style)\b/i;
  if (banned.test(trimmed)) {
    throw new Error('Claude returned SVG with disallowed elements (script/style/image/iframe/foreignObject/link)');
  }
  if (/javascript:/i.test(trimmed) || /\son\w+\s*=/i.test(trimmed)) {
    throw new Error('Claude returned SVG with inline event handlers or javascript: URLs');
  }
  return trimmed;
}

export interface GenerateIconOpts {
  /** User-facing description. Free-form, may be Arabic or English. */
  prompt: string;
  /** Override the default model. */
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
      messages: [{ role: 'user', content: `Subject: ${opts.prompt}` }],
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
