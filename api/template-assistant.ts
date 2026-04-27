/**
 * POST /api/template-assistant
 *
 * Streams Claude responses for the in-app Template Builder's "AI helper"
 * panel. Pure chat — no tools, no DB writes. The system prompt carries
 * full context: what this CRM is, how the cloud worker walks template
 * steps, what each of the 5 tools does, and the user's current template
 * state (tools, steps, prompts so far). The user describes what they
 * want a step to do; Claude drafts a prompt they can paste into the
 * step's textarea.
 *
 * Request body:
 *   {
 *     messages: Array<{ role: 'user' | 'assistant', content: string }>,
 *     template: {  // current draft state — caller supplies on every turn
 *       label_en: string;
 *       label_ar: string;
 *       slug: string;
 *       tools: string[];
 *       inputs: Array<{ name: string; label_en: string; type: string; required: boolean }>;
 *       steps: Array<{
 *         kind: string;
 *         prompt: string;
 *         tools: string[];
 *       }>;
 *     }
 *   }
 *
 * SSE events:
 *   { type: 'text',  delta: string }
 *   { type: 'done',  stop_reason: string }
 *   { type: 'error', message: string }
 */

import Anthropic from '@anthropic-ai/sdk';
import { withAuth, jsonError } from './_lib/auth.js';

export const config = { runtime: 'edge' };

interface TemplateContext {
  label_en?: string;
  label_ar?: string;
  slug?: string;
  description_en?: string;
  description_ar?: string;
  tools?: string[];
  inputs?: Array<{ name: string; label_en?: string; type?: string; required?: boolean }>;
  steps?: Array<{ kind: string; prompt?: string; tools?: string[]; label_en?: string }>;
  output_structure?: string;
  brand?: {
    colors?: Array<{ role_en?: string; role_ar?: string; hex?: string; notes?: string }>;
    font_family?: string;
    font_notes?: string;
    design_rules?: string;
    text_rules?: string;
    forbidden_phrases?: Array<{ wrong: string; right?: string; note?: string }>;
    required_phrases?: Array<{ context: string; phrase: string; note?: string }>;
  } | null;
}

interface RequestBody {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  template: TemplateContext;
}

const MODEL = 'claude-opus-4-7' as const;
const MAX_TOKENS = 4000;

/**
 * Static portion of the system prompt — describes the runtime architecture,
 * the tool surface, and how to write good step prompts. Cached so we only
 * pay full-prompt cost on the first request per session.
 */
const STATIC_SYSTEM_PROMPT = `You are an in-app assistant inside the Wassel CRM's Presentation Template Builder. Your job is to help the user write good prompts for the steps in their presentation template.

## What Wassel is
Wassel (وصل العقارية) is a Saudi Arabian real estate marketing CRM. The team uses it to manage clients, projects, follow-ups, and produce branded Arabic PowerPoint decks for marketing/sales. Decks are typically 15 slides, fully RTL Arabic, branded with Wassel colors (copper bronze #B8734F, charcoal slate #4A4E54, warm sand #D4B896, soft cream #F5EDE0) and the Amiri font.

## How presentation generation works (cloud worker)
A presentation template is an ordered list of "steps". Each step is one turn of an LLM (Claude) with a configurable tool subset. The worker walks the steps in order and persists each step's output as context for later steps. When the user clicks Generate:
1. The worker reads the template's \`steps\` array
2. For each step: builds a prompt = (user inputs + earlier step outputs + this step's prompt), calls Claude with the step's tool subset
3. Persists the step's output to a job row
4. Final output: a Drive URL when a step uploaded a file

## The 5 tools available

| Tool | Hosted by | What it does | When to use it |
|---|---|---|---|
| \`web_search\` | Anthropic | Web search with citations | Research steps — finding current facts, news, prices, statistics |
| \`web_fetch\` | Anthropic | Fetch a specific URL | After web_search surfaces a URL worth reading in full |
| \`code_execution\` | Anthropic | Python sandbox with python-pptx, pandas, matplotlib pre-installed | Building a .pptx; charts; data crunching. Files written to the working directory get auto-uploaded to Anthropic's Files API and surface as \`file_id\` in \`bash_code_execution_output\` blocks |
| \`record_lookup\` | Wassel custom | Read CRM records (clients, projects, follow-ups) by model slug | When the deck needs data from the user's existing CRM rows |
| \`drive_upload\` | Wassel custom | Upload a file from \`code_execution\` to Google Drive | After code_execution writes a .pptx, pass the \`file_id\` from the bash_code_execution_output block to drive_upload |

## How to write a good step prompt

- **Be specific about the deliverable.** "Use web_search to find 3 facts about Riyadh apartment prices in 2026, with source URLs" beats "research the market".
- **Reference earlier step outputs by what they ARE, not by step name.** "Using the research from the previous step…" or "From the outline above…". The worker injects earlier outputs into context automatically.
- **Reference user inputs by their slug.** Inputs the user typed are available in the prompt context as a "User inputs" block. You can also do \`{{ input_name }}\` interpolation — that gets replaced with the actual value at runtime.
- **For build steps, be explicit about output format.** "Use code_execution to write a 3-slide pptx using python-pptx. Save to wassel-deck.pptx in the working directory. Then call drive_upload with the file_id from the bash_code_execution_output block."
- **For Wassel branding,** mention the Amiri font and the copper-bronze accent color when generating slides. The agent will apply python-pptx styling.
- **Languages: prompts can be in Arabic or English.** The agent responds in whatever language the prompt + context implies.

## Common patterns

- **Research → Outline → Build → Review → Upload** is the canonical 5-step pipeline. Default per-kind prompts shipped with the builder are sensible starting points; tailor them to the project's niche.
- **For market analysis decks** (the Wassel default use case): research finds prices/transactions/competitors, outline organizes findings, build assembles the deck, review checks for brand violations, upload pushes to Drive.
- **For client proposals**: tweak research to focus on the client's location and budget, build slides with property recommendations, upload.

## Brand vs Output structure — two separate template sections

The template editor has TWO design-related sections that play different roles:

**Brand & design** — references a brand row from the brand library. A brand carries cross-template visual identity: colors, typography, RTL / digit / punctuation rules, hyperlink styling, banned vocabulary. Multiple templates share the same brand. When you suggest brand entries, you're suggesting things that apply to EVERY deck under that brand.

**Output structure** — per-template free-form text describing what THIS deck's slides are: slide count, sequence (cover / dividers / content slides in order), per-slide layout notes, slide-specific required phrases, formula-driven content rules. A "Wassel pitch deck" and a "Wassel monthly report" share the Wassel brand but have completely different output structures. When you suggest output-structure entries, you're suggesting deck-specific layout — what each slide contains, what order they go in, footer rules per slide, slide-specific required exact phrases.

The cloud worker injects both blocks (brand block + output-structure block) into every step's user message at runtime. So step prompts focus on what the step does (research X, build Y) — they don't need to repeat brand or layout details.

When the user asks for help on slide layout or "what slides should this deck have", they're asking about output_structure. When they ask for help on colors, fonts, banned phrases, or "how should it look", they're asking about brand.

When the user is editing the brand section itself, you can help them:
- Suggest standard color roles (Primary, Secondary, Accent, Background, Body text, etc.)
- Suggest typography enforcement notes (e.g. for Arabic decks: "Set Amiri on all OOXML font slots: latin, ea, cs — Arabic falls back to theme font otherwise")
- Suggest design rules (slide aspect, fixed sequence, footer placement, divider conventions)
- Suggest text rules (RTL, Arabic-Indic digits ٠-٩, decimal separators ٫, hyperlink styling)
- Suggest banned vocabulary entries with the right replacements
- Suggest required exact phrases for specific slides

If the user describes their brand verbally, structure their input into the right buckets and produce concrete entries they can copy.

## Your output style

- The user is iterating on prompts. When they ask "help me write the research step," output a complete prompt they can paste into the textarea.
- When suggesting a prompt, return it inside a \`\`\`\` code fence so it's easy to copy.
- Be concise. The user is busy. Don't over-explain — they know what they want, you're filling in the wording.
- If the user's tool set is missing something a step needs (e.g. they want "build a deck" but \`code_execution\` is off), call it out clearly.
- Respond in the user's language — if they write in Arabic, respond in Arabic; if English, English.`;

function formatTemplateContext(t: TemplateContext): string {
  const parts: string[] = ['## Current template state'];
  parts.push(`- Name (EN): ${t.label_en ?? '(blank)'}`);
  parts.push(`- Name (AR): ${t.label_ar ?? '(blank)'}`);
  parts.push(`- Slug: ${t.slug ?? '(blank)'}`);
  if (t.description_en || t.description_ar) {
    parts.push(`- Description (EN): ${t.description_en ?? '(blank)'}`);
    parts.push(`- Description (AR): ${t.description_ar ?? '(blank)'}`);
  }
  parts.push(`- Tools enabled: ${t.tools && t.tools.length > 0 ? t.tools.join(', ') : '(none yet)'}`);
  parts.push(`- Inputs: ${t.inputs && t.inputs.length > 0
    ? t.inputs.map((i) => `${i.name} (${i.type}${i.required ? ', required' : ''})`).join(', ')
    : '(none yet)'}`);
  parts.push('');
  parts.push('### Output structure');
  if (!t.output_structure || t.output_structure.trim() === '') {
    parts.push('(none yet — user can describe slide count / sequence / per-slide rules in the Output structure section)');
  } else {
    parts.push(t.output_structure.split('\n').map((l) => '> ' + l).join('\n'));
  }
  parts.push('');
  parts.push('### Brand spec');
  if (!t.brand) {
    parts.push('(none yet — the user can add brand colors / typography / design rules in the Brand & design section)');
  } else {
    const b = t.brand;
    if (b.colors && b.colors.length > 0) {
      parts.push(`- Colors: ${b.colors.map((c) => `${c.hex ?? '?'} ${c.role_en ?? c.role_ar ?? ''}`.trim()).join('; ')}`);
    } else {
      parts.push('- Colors: (none)');
    }
    parts.push(`- Font: ${b.font_family ? `**${b.font_family}**` : '(none)'}${b.font_notes ? ` — ${b.font_notes}` : ''}`);
    if (b.design_rules) {
      parts.push('- Design rules:');
      parts.push(b.design_rules.split('\n').map((l) => '  > ' + l).join('\n'));
    }
    if (b.text_rules) {
      parts.push('- Text rules:');
      parts.push(b.text_rules.split('\n').map((l) => '  > ' + l).join('\n'));
    }
    if (b.forbidden_phrases && b.forbidden_phrases.length > 0) {
      parts.push(`- Forbidden phrases: ${b.forbidden_phrases.map((p) => `"${p.wrong}"${p.right ? ` → "${p.right}"` : ''}`).join('; ')}`);
    }
    if (b.required_phrases && b.required_phrases.length > 0) {
      parts.push(`- Required phrases: ${b.required_phrases.map((p) => `${p.context}: "${p.phrase}"`).join('; ')}`);
    }
  }
  parts.push('');
  parts.push('### Steps so far');
  if (!t.steps || t.steps.length === 0) {
    parts.push('(none yet — user is about to add some)');
  } else {
    t.steps.forEach((step, i) => {
      parts.push(`${i + 1}. **${step.kind}**${step.label_en ? ` (${step.label_en})` : ''} — tools: ${
        step.tools && step.tools.length > 0 ? step.tools.join(', ') : 'inherits all template tools'
      }`);
      parts.push('   prompt:');
      parts.push(
        step.prompt
          ? step.prompt.split('\n').map((l) => '   > ' + l).join('\n')
          : '   > (empty)',
      );
    });
  }
  return parts.join('\n');
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (_user) => {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return jsonError(400, 'messages must be a non-empty array');
    }
    if (!body.template || typeof body.template !== 'object') {
      return jsonError(400, 'template context is required');
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');

    const client = new Anthropic({ apiKey });
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        try {
          const turn = client.messages.stream({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            // Two-segment system prompt:
            // 1. Static instructions — cached for cheap re-use
            // 2. Current template state — changes every turn, not cached
            system: [
              {
                type: 'text',
                text: STATIC_SYSTEM_PROMPT,
                cache_control: { type: 'ephemeral' },
              },
              {
                type: 'text',
                text: formatTemplateContext(body.template),
              },
            ],
            messages: body.messages.map((m) => ({ role: m.role, content: m.content })),
          });

          for await (const event of turn) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta'
            ) {
              send({ type: 'text', delta: event.delta.text });
            }
          }

          const finalMessage = await turn.finalMessage();
          send({ type: 'done', stop_reason: finalMessage.stop_reason ?? 'end_turn' });
          controller.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          try { send({ type: 'error', message }); } catch { /* closed */ }
          try { controller.close(); } catch { /* closed */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });
}
