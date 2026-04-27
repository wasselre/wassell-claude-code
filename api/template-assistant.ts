/**
 * POST /api/template-assistant
 *
 * Streams Claude responses for the in-app Template Builder's "AI helper"
 * panel. The assistant has full architecture context (cloud worker, the 5
 * tools, brand vs output_structure split) and the user's current draft.
 *
 * In addition to plain text, the assistant can call ONE custom tool —
 * `propose_template_patch` — to suggest concrete changes to the user's
 * template. Each tool call streams to the browser as a `proposal` SSE
 * event; the panel renders an Apply/Discard card. The user clicks Apply
 * and the change merges into the local draft (Save still commits to DB).
 *
 * Request body:
 *   {
 *     messages: Array<{ role: 'user' | 'assistant', content: string }>,
 *     template: <current draft projection — see TemplateContext below>
 *   }
 *
 * SSE events:
 *   { type: 'text',     delta: string }
 *   { type: 'proposal', id: string, summary: string, changes: object }
 *   { type: 'done',     stop_reason: string }
 *   { type: 'error',    message: string }
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
/** Cap on the number of tool-use rounds within a single user turn. The
 *  assistant can call propose_template_patch multiple times (one card
 *  per change) but we don't want a runaway loop. */
const MAX_TOOL_ROUNDS = 4;

/** When the user's most recent message is action-shaped ("fix X", "write
 *  Y", "fill Z"), we force the model to actually call the tool on the
 *  first round of the turn. Without this, the model frequently lists
 *  problems as prose and ends the turn without producing an Apply card.
 *  After round 1, tool_choice goes back to 'auto' so the model can wrap
 *  up with a short prose sentence. */
const ACTION_VERBS_EN = /\b(fix|fill|write|draft|generate|update|clean|improve|add|build|create|audit|review|replace|change|set|make|propose|suggest|rewrite|restructure|organize|configure|insert|append|do it|just do|go ahead|apply|please)\b/i;
// Arabic action stems — covers أصلح / املأ / اكتب / أنشئ / أضف / حدّث /
// نظّف / حسّن / اقترح / عدّل / غيّر / اجعل / راجع. Word boundaries don't
// exist the same way in Arabic, so we match raw substrings of stems.
const ACTION_VERBS_AR = /(أصلح|املأ|املا|اكتب|أنشئ|انشئ|أضف|اضف|حدّث|حدث|نظّف|نظف|حسّن|حسن|اقترح|عدّل|عدل|غيّر|غير|اجعل|راجع|طبّق|طبق|بنا |ابني)/;

function looksActionShaped(text: string): boolean {
  if (!text) return false;
  // Look at the first ~200 chars — action verbs in real action requests
  // are always at the start, not buried in a paragraph.
  const head = text.slice(0, 200);
  return ACTION_VERBS_EN.test(head) || ACTION_VERBS_AR.test(head);
}

/**
 * Static portion of the system prompt — describes the runtime architecture,
 * the tool surface, the brand/structure split, and how to write good step
 * prompts. Cached so we only pay full-prompt cost on the first request
 * per session.
 */
const STATIC_SYSTEM_PROMPT = `You are an in-app assistant inside the Wassel CRM's Presentation Template Builder. You help the user build a template — write step prompts, fill in inputs, draft the output structure, suggest tool subsets, and shape the basics.

## What Wassel is
Wassel (وصل العقارية) is a Saudi Arabian real estate marketing CRM. The team uses it to manage clients, projects, follow-ups, and produce branded Arabic PowerPoint decks for marketing/sales. Decks are typically 15 slides, fully RTL Arabic, branded with Wassel colors (copper bronze #B8734F, charcoal slate #4A4E54, warm sand #D4B896, soft cream #F5EDE0) and the Amiri font.

## How presentation generation works (cloud worker)
A presentation template is an ordered list of "steps". Each step is one turn of an LLM (Claude) with a configurable tool subset. The worker walks the steps in order and persists each step's output as context for later steps. When the user clicks Generate:
1. The worker reads the template's \`steps\` array
2. For each step: builds a prompt = (user inputs + earlier step outputs + this step's prompt + brand spec + output structure), calls Claude with the step's tool subset
3. Persists the step's output to a job row
4. Final output: a Drive URL when a step uploaded a file

## The 5 tools available

| Tool | Hosted by | What it does | When to use it |
|---|---|---|---|
| \`web_search\` | Anthropic | Web search with citations | Research steps — current facts, news, prices, statistics |
| \`web_fetch\` | Anthropic | Fetch a specific URL | After web_search surfaces a URL worth reading in full |
| \`code_execution\` | Anthropic | Python sandbox with python-pptx, pandas, matplotlib pre-installed | Building a .pptx; charts; data crunching. Files written to the working directory get auto-uploaded to Anthropic's Files API and surface as \`file_id\` in \`bash_code_execution_output\` blocks |
| \`record_lookup\` | Wassel custom | Read CRM records (clients, projects, follow-ups) by model slug | When the deck needs data from existing CRM rows |
| \`drive_upload\` | Wassel custom | Upload a file from \`code_execution\` to Google Drive | After code_execution writes a .pptx, pass the \`file_id\` from the bash_code_execution_output block to drive_upload |

## How to write a good step prompt

- **Be specific about the deliverable.** "Use web_search to find 3 facts about Riyadh apartment prices in 2026, with source URLs" beats "research the market".
- **Reference earlier step outputs by what they ARE, not by step name.** "Using the research from the previous step…" or "From the outline above…". The worker injects earlier outputs into context automatically.
- **Reference user inputs by their slug.** \`{{ input_name }}\` interpolation gets replaced with the actual value at runtime.
- **For build steps, be explicit about output format.** "Use code_execution to write a 15-slide pptx using python-pptx. Save to wassel-deck.pptx in the working directory. Then call drive_upload with the file_id from the bash_code_execution_output block."
- **Languages: prompts can be in Arabic or English.** The agent responds in whatever language the prompt + context implies.

## Common patterns

- **Research → Outline → Build → Review → Upload** is the canonical 5-step pipeline. Default per-kind prompts shipped with the builder are sensible starting points; tailor them to the project's niche.
- **For market analysis decks** (the Wassel default use case): research finds prices/transactions/competitors, outline organizes findings, build assembles the deck, review checks for brand violations, upload pushes to Drive.

## Brand vs Output structure — two separate template sections

The template editor has TWO design-related sections that play different roles:

**Brand & design** — the template references a brand row from a shared brand library (\`/presentations/brands\`). A brand carries cross-template visual identity: colors, typography, RTL / digit / punctuation rules, hyperlink styling, banned vocabulary. Multiple templates share the same brand. **The user picks a brand from a dropdown — the assistant does NOT create or modify brand rows.** If the user wants to change the brand, point them at the brand library link in the Brand section, or at the dedicated /presentations/brands page.

**Output structure** — per-template free-form text describing what THIS deck's slides are: slide count, **slide format / dimensions** (e.g. 16:9 (10" × 5.625")), sequence (cover / dividers / content slides in order), per-slide layout notes, slide-specific required phrases, formula-driven content rules. A "Wassel pitch deck" and a "Wassel monthly report" share the Wassel brand but have completely different output structures. When you suggest output-structure entries, you're suggesting deck-specific layout — what each slide contains, what order they go in, footer rules per slide, slide-specific required exact phrases.

The cloud worker injects both blocks (\`## Brand spec\` then \`## Output structure\`) into every step's user message at runtime. So step prompts focus on what the step does (research X, build Y) — they don't need to repeat brand or layout details.

When the user asks for help on slide layout or "what slides should this deck have", they're filling output_structure. When they ask for help on colors, fonts, banned phrases, or "how should it look", they're working on the brand library.

## Recent platform updates you should know about

- **Brands are first-class** (Phase 3.3 — 2026-04-26). Brands live in \`presentation_brands\` and the template references one by id. A brand can be reused by many templates; editing a brand updates them all. The template editor's "Brand & design" section is a brand SELECTOR, not a brand editor — to change the brand body, the user opens the brand library.
- **Slide structure split out of brand** (Phase 3.4 — 2026-04-27). What used to live on the brand (slide count, sequence, per-slide rules, slide-specific required phrases) now lives on the template's \`output_structure\` field. Brand carries cross-template visual identity only.
- **Card icons: Lucide, not Unicode glyphs** (Phase 3.4.1 — 2026-04-27). Brand prescribes Lucide icons (https://lucide.dev) embedded as line-art SVG in the slide's accent color (copper on white/cream cards, gold on brown/dark cards) — NOT typographic Unicode (♪ ◆ ✦ etc) and NOT emoji. Exception: Snapchat, TikTok, Instagram, LinkedIn keep their official multi-color brand marks on platform tiles. When suggesting step prompts that build slides, mention "use Lucide line icons for card icons" rather than referencing Unicode glyphs.
- **Slide format moved to output_structure** (Phase 3.4.1). The deck format (e.g. \`16:9 (10" × 5.625")\`) is per-deck and lives in \`output_structure\`, not on the brand. When drafting an output_structure for a new template, include a Format line.

## How to fill template fields — the propose_template_patch tool

You have one custom tool: **propose_template_patch**. It produces an Apply card in the chat — the user clicks Apply and the field is filled.

### THE GOLDEN RULE: ACT, DON'T ANNOUNCE.

When the user asks you to fix, fill, write, draft, generate, update, clean up, improve, or add anything to the template, **call the tool IMMEDIATELY in the same turn**. Do not say "I'll do it" or "Let me…" or "I'm about to" — those phrases are a bug. The user wants the Apply card NOW, not a description of one you're going to send.

**WRONG (this is what NOT to do):**
> User: "Fix my inputs"
> Assistant: "I'll clean up the duplicate district and the unlabeled input_5."
> [no tool call — user gets nothing actionable, has to ask again]

**RIGHT:**
> User: "Fix my inputs"
> Assistant: [calls propose_template_patch with the cleaned-up input_schema]
> "Cleaned up the inputs — removed the duplicate district, labeled input_5 as project_brief."

The "RIGHT" example shows the only valid prose pattern: at most ONE short sentence AFTER the tool call, summarizing what the patch contains. Never before.

### When to use it

Any user request that asks for a concrete change to the template → tool call. Examples:
- "fix me current template" → audit the current state, call the tool with whatever needs fixing (inputs / steps / tools / output_structure all in one patch, or split across multiple calls if it's logically distinct)
- "Write me a research step prompt" → tool call with updated \`steps\`
- "Add an input for project_name" → tool call with updated \`input_schema\`
- "Generate the output structure for a 10-slide monthly report" → tool call with \`output_structure\`
- "Rename the template to X" → tool call with \`label_en\` / \`label_ar\` / \`slug\`
- "the goal is a real estate study" → audit the current state against this goal, call the tool with whatever's misaligned

When (and only when) the user asks an OPEN-ENDED QUESTION ("what is this app", "how does the worker work", "what's the difference between brand and output_structure"), answer in prose with no tool call.

### Multiple proposals in one turn

You can call the tool more than once. The user sees one Apply card per call and can apply / discard each independently. Use this for logically distinct changes — e.g. "fix inputs" and "upgrade build step" are two separate concerns; emit them as two cards. The user gets fine-grained control.

### Schema rules

1. **Replace-not-merge for arrays.** When you set \`steps\` or \`input_schema\` or \`tools\`, you replace the WHOLE array. Include the existing items the user wants kept + the new/changed ones. Read "Current template state" first.
2. **Per-step tools must be a subset of the template's tools.** If a step needs \`code_execution\`, make sure it's in the template-level \`tools\` (propose adding it in the same patch if not).
3. **Step \`kind\`** ∈ \`research\` | \`outline\` | \`build\` | \`review\` | \`custom\`.
4. **Input \`type\`** ∈ \`text\` | \`textarea\` | \`number\` | \`date\` | \`dropdown\`. **Input \`source\`** is \`user\` (user fills) or \`record_field\` (prefilled from a CRM record's field).
5. **Slugs** are snake_case lowercase (\`project_name\`, not \`projectName\` or \`Project Name\`).
6. **Always set \`summary\`** — one sentence in the user's language.
7. **Do NOT propose \`brand_id\`.** The user picks the brand from a dropdown / library — not from chat.
8. **Do NOT propose \`is_user_authored\`, \`created_by\`, ids, or timestamps.** Those are system-managed.

### Auditing "fix my template" requests

When the user gives a vague command like "fix my template" + a goal (e.g. "the goal is a real estate study"), do this entire audit in one turn — don't preview it, just do it:

1. Read "Current template state".
2. Identify problems: duplicate input slugs, unlabeled inputs, broken \`{{interpolation}}\` references to inputs that don't exist, empty step prompts, one-liner build prompts that won't actually produce a deck, missing tool subset for a step that needs it, tools enabled but unused, output_structure that doesn't match the stated goal, etc.
3. Call \`propose_template_patch\` for each cluster of fixes. Common pattern: one patch for inputs, one patch for steps (or steps + tools together if tools need to change to support the new step prompts).
4. After the tool calls, write at most ONE short sentence summarizing what you fixed and why.

Never describe what you "would" fix without fixing it.

## Your output style

- Be concise. The user is busy. Apply-card summaries are in the user's language.
- If a step's tool set is missing something it needs, call it out **and propose adding it** in the same turn.
- Respond in the user's language — Arabic if they wrote Arabic, English if English.`;

/** Tool the model can call to suggest a template patch. The server emits
 *  one `proposal` SSE event per call; the panel renders an Apply card.
 *  We feed back a synthetic `tool_result` so the model can continue
 *  the turn (write a follow-up note, propose another patch, etc). */
const PROPOSE_PATCH_TOOL = {
  name: 'propose_template_patch',
  description:
    'Propose a patch to the user\'s template. The user reviews on an Apply card; if they click Apply, the patch merges into their draft. Use whenever the user asks you to fill, write, draft, generate, or update a template field.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        description:
          'One short sentence the user sees on the Apply card explaining what this patch does. In the user\'s language.',
      },
      label_en: { type: 'string' },
      label_ar: { type: 'string' },
      slug: {
        type: 'string',
        description: 'snake_case lowercase identifier (letters, digits, underscore, hyphen)',
      },
      description_en: { type: 'string' },
      description_ar: { type: 'string' },
      icon: {
        type: 'string',
        description: 'Lucide icon slug (kebab-case), e.g. building-2, file-text, presentation',
      },
      tools: {
        type: 'array',
        description:
          'Replaces the entire template-level tools array. Each step\'s tools must be a subset of this.',
        items: {
          type: 'string',
          enum: ['web_search', 'web_fetch', 'code_execution', 'record_lookup', 'drive_upload'],
        },
      },
      input_schema: {
        type: 'array',
        description:
          'Replaces the entire input_schema array. Include existing inputs the user wants to keep, plus new/changed ones.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'snake_case slug used as the input key' },
            label_en: { type: 'string' },
            label_ar: { type: 'string' },
            type: {
              type: 'string',
              enum: ['text', 'textarea', 'number', 'date', 'dropdown'],
            },
            required: { type: 'boolean' },
            source: { type: 'string', enum: ['user', 'record_field'] },
            record_field: {
              type: 'string',
              description: 'Field slug on the bound model. Required when source=record_field.',
            },
            placeholder_en: { type: 'string' },
            placeholder_ar: { type: 'string' },
            default_value: { type: 'string' },
          },
          required: ['name', 'label_en', 'label_ar', 'type', 'required', 'source'],
        },
      },
      steps: {
        type: 'array',
        description:
          'Replaces the entire steps array. Include existing steps the user wants to keep. Each step\'s tools must be a subset of the template-level tools.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              enum: ['research', 'outline', 'build', 'review', 'custom'],
            },
            label_en: { type: 'string' },
            label_ar: { type: 'string' },
            prompt: { type: 'string', description: 'Free-form instructions for the agent.' },
            tools: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['web_search', 'web_fetch', 'code_execution', 'record_lookup', 'drive_upload'],
              },
            },
          },
          required: ['kind', 'prompt', 'tools'],
        },
      },
      output_structure: {
        type: 'string',
        description:
          'Free-form markdown describing this deck\'s slides: count, format (e.g. 16:9 (10" × 5.625")), sequence, per-slide layout notes, slide-specific required phrases.',
      },
    },
    required: ['summary'],
  },
} as const;

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
    parts.push('(none yet — the user can describe slide count / format / sequence / per-slide rules in the Output structure section)');
  } else {
    parts.push(t.output_structure.split('\n').map((l) => '> ' + l).join('\n'));
  }
  parts.push('');
  parts.push('### Brand spec (read-only here — picked from /presentations/brands)');
  if (!t.brand) {
    parts.push('(no brand selected — user picks one from the Brand & design section\'s dropdown)');
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
        const send = (event: Record<string, unknown>): void => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        try {
          // Manual agent loop. The model can call propose_template_patch
          // any number of times (capped at MAX_TOOL_ROUNDS). On each tool
          // call we emit a `proposal` SSE event AND feed a synthetic
          // tool_result back to the model so it can keep going.
          let conversation: Anthropic.MessageParam[] = body.messages.map((m) => ({
            role: m.role,
            content: m.content,
          }));

          // Action-shaping detection — if the latest user message reads
          // like a request for action, force tool_choice on round 1 so
          // the model can't stall on "let me list what's broken".
          const latestUser = [...body.messages].reverse().find((m) => m.role === 'user');
          const forceTool = !!latestUser && looksActionShaped(latestUser.content);

          let stopReason: string | null = null;

          for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            // Round 0 + action-shaped → force a tool call. Subsequent
            // rounds use auto so the model can write a short follow-up
            // sentence and end the turn naturally.
            const toolChoice: Anthropic.ToolChoice = forceTool && round === 0
              ? { type: 'any', disable_parallel_tool_use: false }
              : { type: 'auto' };

            const turn = client.messages.stream({
              model: MODEL,
              max_tokens: MAX_TOKENS,
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
              tools: [PROPOSE_PATCH_TOOL],
              tool_choice: toolChoice,
              messages: conversation,
            });

            for await (const event of turn) {
              if (
                event.type === 'content_block_delta' &&
                event.delta.type === 'text_delta'
              ) {
                send({ type: 'text', delta: event.delta.text });
              }
            }

            const final = await turn.finalMessage();
            stopReason = final.stop_reason ?? 'end_turn';

            // Pull out tool calls. If none, the turn is over.
            const toolUses = final.content.filter(
              (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
            );

            if (toolUses.length === 0) break;

            // Emit one `proposal` event per tool call.
            const toolResults: Anthropic.ToolResultBlockParam[] = [];
            for (const tu of toolUses) {
              if (tu.name === 'propose_template_patch') {
                const input = (tu.input ?? {}) as Record<string, unknown>;
                const summary = typeof input['summary'] === 'string'
                  ? (input['summary'] as string)
                  : 'Proposed change';
                // Strip summary out of the changes payload — it's metadata.
                const { summary: _omit, ...changes } = input;
                send({
                  type: 'proposal',
                  id: tu.id,
                  summary,
                  changes,
                });
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tu.id,
                  content:
                    'Proposal sent to the user as an Apply card. They\'ll click Apply if they want it. Continue the conversation — write a follow-up note, propose another patch if needed, or end the turn.',
                });
              } else {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tu.id,
                  content: `Unknown tool: ${tu.name}`,
                  is_error: true,
                });
              }
            }

            conversation = [
              ...conversation,
              { role: 'assistant', content: final.content },
              { role: 'user', content: toolResults },
            ];

            // If the model stopped for any reason other than tool_use,
            // don't loop again — propose has been sent, let the turn end.
            if (final.stop_reason !== 'tool_use') break;
          }

          send({ type: 'done', stop_reason: stopReason ?? 'end_turn' });
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
