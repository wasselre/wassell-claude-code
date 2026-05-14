// One-time (re-runnable) script that generates the 27 curated
// project_details icons as clean monoline SVGs via Claude (Sonnet 4.6)
// and uploads them to `marketing-assets/icons/library/<slug>.svg`.
//
// Re-runs upsert (overwrite) — handy when you tweak the prompts or the
// brand spec and want a fresh library.
//
// Required env:
//   ANTHROPIC_API_KEY            Claude API key
//   SUPABASE_URL                 project URL (e.g. https://abc.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY    service-role key (write access to storage)
//
// Optional env:
//   ICON_MODEL_ID                Claude model (default: claude-sonnet-4-6)
//   ONLY                         comma-separated slug subset
//
// Usage:
//   node scripts/seed-icon-library.mjs
//   node scripts/seed-icon-library.mjs --only=building,metro

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const MODEL_ID = process.env.ICON_MODEL_ID ?? 'claude-sonnet-4-6';

// Slug → human noun. Keep in sync with FEATURE_ICONS / LANDMARK_ICONS in
// src/data/iconLibrary.ts and the AI drafter's curated lists in
// supabase/functions/project-details-ai-v2/index.ts.
const SLUG_PROMPTS = {
  // Features
  building:   'a modern multi-story residential building',
  home:       'a single-family villa house with a roof',
  car:        'a car under a parking shade / covered parking',
  smart_home: 'a smart-home icon (house with a wifi or signal mark)',
  ac:         'a wall-mounted air conditioner unit',
  camera:     'a security CCTV camera on a wall mount',
  key:        'a door key',
  facade:     'a building facade with a grid of windows',
  bed:        'a double bed seen from the side',
  box:        'a stack of storage boxes',
  sparkle:    'a sparkle / shine mark indicating premium finish',
  elevator:   'an elevator door between up and down arrows',
  shield:     'a security shield with a check mark',
  wifi:       'a wifi signal symbol',
  pool:       'a swimming pool with a ladder',
  gym:        'a dumbbell representing a gym',
  // Landmarks
  metro:      'a metro train',
  road:       'a highway road with lane markings',
  shop:       'a shopping bag with a handle',
  school:     'a school building with a flag',
  hospital:   'a hospital building with a cross symbol',
  park:       'a single tree representing a park',
  mosque:     'a mosque with a dome and a minaret',
  airport:    'an airplane taking off',
  restaurant: 'a fork and knife crossed for a restaurant',
  gas:        'a fuel pump for a gas station',
  pin:        'a map pin marking a generic location',
};

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

The subject of the icon is described in the user message. Translate it visually into one cohesive icon.`;

const TOOL_SCHEMA = {
  name: 'emit_icon_svg',
  description: 'Emit the final SVG icon markup.',
  input_schema: {
    type: 'object',
    properties: {
      svg: { type: 'string', description: 'Complete SVG markup starting with <svg and ending with </svg>.' },
    },
    required: ['svg'],
    additionalProperties: false,
  },
};

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.replace(/^--/, '').split('='))
    .map(([k, v]) => [k, v ?? true]),
);
const onlyFilter = typeof args.only === 'string'
  ? new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean))
  : null;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function validateSvg(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('<svg') || !trimmed.endsWith('</svg>')) {
    throw new Error('malformed SVG envelope');
  }
  if (/<\s*(script|foreignObject|image|iframe|link|style)\b/i.test(trimmed)) {
    throw new Error('SVG contains disallowed element');
  }
  if (/javascript:/i.test(trimmed) || /\son\w+\s*=/i.test(trimmed)) {
    throw new Error('SVG contains inline JS / event handlers');
  }
  return trimmed;
}

async function generateSvg(subject) {
  const response = await anthropic.messages.create({
    model: MODEL_ID,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools: [TOOL_SCHEMA],
    tool_choice: { type: 'tool', name: TOOL_SCHEMA.name },
    messages: [{ role: 'user', content: `Subject: ${subject}` }],
  });
  const toolBlock = response.content.find((b) => b.type === 'tool_use');
  if (!toolBlock) throw new Error('Claude did not call the tool');
  const svg = toolBlock.input?.svg;
  if (typeof svg !== 'string' || !svg) throw new Error('missing svg field');
  return validateSvg(svg);
}

async function uploadSvg(slug, svg) {
  const { error } = await supabase.storage
    .from('marketing-assets')
    .upload(`icons/library/${slug}.svg`, Buffer.from(svg, 'utf-8'), {
      contentType: 'image/svg+xml',
      upsert: true,
    });
  if (error) throw new Error(`upload ${slug}: ${error.message}`);
}

async function processSlug(slug, subject) {
  console.log(`[${slug}] generating…`);
  const svg = await generateSvg(subject);
  await uploadSvg(slug, svg);
  console.log(`[${slug}] uploaded to icons/library/${slug}.svg (${svg.length} bytes)`);
}

(async () => {
  const slugs = Object.entries(SLUG_PROMPTS).filter(([slug]) =>
    onlyFilter ? onlyFilter.has(slug) : true,
  );
  if (onlyFilter && slugs.length === 0) {
    console.error(`No slugs matched --only=${args.only}`);
    process.exit(1);
  }
  let failed = 0;
  for (const [slug, subject] of slugs) {
    try {
      await processSlug(slug, subject);
    } catch (err) {
      failed += 1;
      console.error(`[${slug}] FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nDone. ${slugs.length - failed}/${slugs.length} succeeded.`);
  if (failed > 0) process.exit(2);
})();
