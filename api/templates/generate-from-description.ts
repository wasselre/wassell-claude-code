/**
 * POST /api/templates/generate-from-description
 *
 * Takes a free-form template description (e.g. the structured prompt
 * doc the team writes for each new layout) and returns a parsed
 * design_templates record-data shape:
 *
 *   { name, cleanup_prompt, editing_prompt, design_prompt,
 *     variables: [{ name, label_ar, label_en, type }], notes? }
 *
 * The frontend creates the record with this data and uploads the
 * reference_image separately (the agent never invents image URLs).
 *
 * Implementation: Claude tool-use with `force_tool` so the response
 * is guaranteed to match the schema. Sonnet 4.5 — small enough to
 * be fast, big enough to parse the structured Arabic/English prompts
 * without hallucinating placeholders.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

interface RequestBody {
  description?: string;
}

async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(nodeReq);
  return new Request(url.toString(), { method, headers, body });
}

async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  const buf = Buffer.from(await webResp.arrayBuffer());
  nodeRes.end(buf);
}

const SYSTEM_PROMPT = `You are a structured-data extractor for the Wassel Real Estate (وصل العقارية) design template library. The user gives you a free-form description of a design template — usually with three phase prompts (cleanup, editing/angle generation, design composition), a variables list, and notes about when to use it.

Your job: extract the data that goes into a design_templates record and call \`create_design_template\` with it. NEVER write prose; ALWAYS call the tool.

Rules:

1. **cleanup_prompt** — the Phase 1 prompt verbatim (cleanup-only retouching of the raw building photo). Strip any markdown fences but keep the prompt body unchanged.
2. **editing_prompt** — the Phase 2 prompt verbatim (new angle generation). Same fence-stripping rule.
3. **design_prompt** — the Phase 3 prompt with EVERY user-supplied value replaced by a \`{{PLACEHOLDER}}\` token. The substituteTemplate function later replaces these at generate time.
   - If the user already wrote \`{{VAR}}\` placeholders, keep them.
   - If the user wrote literal values (e.g. \`PROJECT_NAME_AR = "مينا 52"\`), convert to \`PROJECT_NAME_AR = "{{PROJECT_NAME_AR}}"\`.
   - Every reference to a variable later in the prompt body (e.g. "Project name Arabic: PROJECT_NAME_AR") must also become \`{{PROJECT_NAME_AR}}\`.
4. **variables** — every placeholder used in design_prompt must appear in this list. Each variable has:
   - \`name\` — the slug used inside the braces, exactly as written
   - \`label_ar\` — a clear Arabic label for the marketer who fills the form
   - \`label_en\` — a clear English label
   - \`type\` — one of \`text\`, \`number\`, \`currency\`. Use \`number\` for clean integers (area in m², bedroom counts), \`currency\` for prices, \`text\` for everything else (names, taglines, social handles, even formatted numbers like "1.200.000")
5. **name** — the template's name, like "RSM 12" or "Wassel Social Post — قالب أساسي"
6. **notes** — optional. Use it for "when to use this template" guidance from the description, or leave empty.

Common variables (suggested labels — use these when applicable):
- PROJECT_NAME_AR → label_ar: "اسم المشروع (عربي)", label_en: "Project Name (Arabic)", type: text
- PROJECT_NAME_EN → label_ar: "اسم المشروع (إنجليزي)", label_en: "Project Name (English)", type: text
- PROJECT_TYPE_AR → label_ar: "نوع المشروع", label_en: "Project Type", type: text
- LOCATION_AR → label_ar: "الموقع", label_en: "Location", type: text
- TAGLINE_AR → label_ar: "الشعار الترويجي", label_en: "Tagline", type: text
- AREA_NUMBER → label_ar: "المساحة (م²)", label_en: "Area (m²)", type: number
- PRICE_NUMBER → label_ar: "السعر (ر.س)", label_en: "Price (SAR)", type: text
- FEATURE_N_AR → label_ar: "الميزة (الأولى/الثانية/...)", label_en: "Feature N", type: text
- PHONE → label_ar: "رقم التواصل", label_en: "Phone", type: text
- WEB → label_ar: "الموقع الإلكتروني", label_en: "Website", type: text
- SOCIAL → label_ar: "حساب التواصل", label_en: "Social Handle", type: text

Hard rule: the variables array length MUST match the number of distinct \`{{...}}\` placeholders in design_prompt. No more, no less.`;

const TOOL_SCHEMA = {
  name: 'create_design_template',
  description: 'Create a Wassel design template from the user\'s description.',
  input_schema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Template name like "RSM 12" or "Wassel Social Post — قالب أساسي".' },
      cleanup_prompt: { type: 'string', description: 'PHASE 1 prompt verbatim.' },
      editing_prompt: { type: 'string', description: 'PHASE 2 prompt verbatim.' },
      design_prompt: { type: 'string', description: 'PHASE 3 prompt with all user-supplied values replaced by {{PLACEHOLDER}} tokens.' },
      variables: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Placeholder slug, exactly as it appears inside {{...}} in the design_prompt.' },
            label_ar: { type: 'string' },
            label_en: { type: 'string' },
            type: { type: 'string', enum: ['text', 'number', 'currency'] },
          },
          required: ['name', 'label_ar', 'label_en', 'type'],
        },
      },
      notes: { type: 'string', description: 'Optional. When-to-use guidance or a one-liner summary.' },
    },
    required: ['name', 'cleanup_prompt', 'editing_prompt', 'design_prompt', 'variables'],
  },
};

interface VariableOut {
  name: string;
  label_ar: string;
  label_en: string;
  type: 'text' | 'number' | 'currency';
}

interface ToolInput {
  name: string;
  cleanup_prompt: string;
  editing_prompt: string;
  design_prompt: string;
  variables: VariableOut[];
  notes?: string;
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const req = await nodeToWebRequest(nodeReq);
  const resp = await withAuth(req, async (_user) => {
    if (req.method !== 'POST') return jsonError(405, 'Method not allowed');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const description = body.description?.trim();
    if (!description) return jsonError(400, 'description is required');
    if (description.length < 20) return jsonError(400, 'description is too short — paste the full template spec');
    if (description.length > 60_000) return jsonError(400, 'description is too long — keep it under 60k chars');

    const client = new Anthropic({ apiKey });

    let response;
    try {
      response = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 16_000,
        system: SYSTEM_PROMPT,
        tools: [TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'create_design_template' },
        messages: [{ role: 'user', content: description }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(502, `Anthropic call failed: ${msg}`);
    }

    // Force-tool mode → response.content[0] is a tool_use block.
    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      return jsonError(502, 'Claude did not call the create_design_template tool');
    }
    const out = toolBlock.input as ToolInput;

    // Sanity-check the tool output before returning.
    if (!out.name || !out.cleanup_prompt || !out.editing_prompt || !out.design_prompt) {
      return jsonError(502, 'Claude returned incomplete template data');
    }
    if (!Array.isArray(out.variables)) {
      return jsonError(502, 'Claude returned non-array variables');
    }

    return jsonOk({
      ok: true,
      template: {
        name: out.name,
        cleanup_prompt: out.cleanup_prompt,
        editing_prompt: out.editing_prompt,
        design_prompt: out.design_prompt,
        variables: out.variables,
        notes: out.notes ?? '',
      },
    });
  });
  await writeWebResponseToNode(resp, nodeRes);
}
