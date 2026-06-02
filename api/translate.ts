/**
 * POST /api/translate
 *
 * Translates a single user-typed label between Arabic and English and derives
 * a snake_case Latin slug. Used by the Builder live-translation system: the
 * user types one side (e.g. "العملاء"), this returns the matching English
 * ("Clients") + a clean slug ("clients") so the saved model never has
 * mismatched / placeholder labels or `item_<timestamp>` slugs.
 *
 * Implementation: Claude Haiku 4.5 with forced tool-use to guarantee a
 * structured response. Haiku is fast (~300-500ms) and cheap — important
 * because this fires on every debounced input change in the Builder.
 *
 * Runtime: `edge`. This endpoint is bursty — a user opens the options editor,
 * translates a handful of labels, then closes it — so a `nodejs` function
 * would go cold between sessions and the first translation each session paid a
 * full Node cold-start (bundling the Anthropic SDK), which is what made the
 * live auto-fill feel "very very slow". Edge cold-starts are near-zero and this
 * matches the other Anthropic endpoints (/api/agent, /api/builder-agent,
 * /api/workflow-agent). Migrated off `nodejs` 2026-06-02.
 *
 * Failure posture: returns 502 with the underlying error message. The
 * client surfaces this as a red toast and blocks the save until the user
 * retries or types a different value — never falls back to gibberish slugs.
 */

import Anthropic from '@anthropic-ai/sdk';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';

export const config = { runtime: 'edge' };

interface RequestBody {
  input?: string;
  source_lang?: 'ar' | 'en' | 'auto';
  kind?: 'model' | 'section' | 'field' | 'option' | 'group' | 'workflow' | 'dashboard' | 'role' | 'profile' | 'generic';
}

const KIND_GUIDANCE: Record<NonNullable<RequestBody['kind']>, string> = {
  model: 'a data model (table) name in a CRM, e.g. "Clients", "Projects", "Follow-ups"',
  section: 'a section header inside a model form, e.g. "General Information", "Contact Details"',
  field: 'a field label inside a form, e.g. "First Name", "Phone Number", "Budget"',
  option: 'a dropdown option, e.g. "New", "In Progress", "Closed Won"',
  group: 'a group / folder name in the sidebar, e.g. "Projects", "Sales", "Operations"',
  workflow: 'a workflow / automation name, e.g. "Send welcome email", "Notify on overdue"',
  dashboard: 'a dashboard or widget name, e.g. "Sales overview", "Pipeline by stage"',
  role: 'a user role name, e.g. "Sales Manager", "Marketing Lead"',
  profile: 'a permission profile name, e.g. "Admin", "Read-only viewer"',
  generic: 'a generic short label',
};

const SYSTEM_PROMPT = `You translate short business labels between Arabic and English for a Saudi Arabian real-estate CRM (Wassel / وصل العقارية), and produce a clean snake_case Latin slug.

Always call the \`translate_label\` tool — never reply in prose.

Rules:

1. **label_ar** — the Arabic version of the input.
   - If the input is already Arabic, copy it through (light cleanup only — fix obvious typos, normalize spacing).
   - If the input is English, translate to natural Saudi/Modern Standard Arabic. Use the form a Saudi real-estate professional would actually use, NOT a literal word-for-word translation.
   - Keep brand / proper-noun loanwords as-is (e.g. "WhatsApp", "PDF", "CRM" stay Latin).

2. **label_en** — the English version of the input.
   - If the input is already English, copy it through (light cleanup only — fix capitalization, fix obvious typos).
   - If the input is Arabic, translate to natural professional English. Title Case for labels.
   - Keep proper nouns as-is.

3. **name** — a snake_case Latin slug derived from the ENGLISH label.
   - Lowercase ASCII letters, digits, and underscores only. Must start with a letter.
   - Strip articles ("the", "a", "an") if doing so reads naturally.
   - Examples: "Clients" → \`clients\`, "Phone Number" → \`phone_number\`, "Budget (SAR)" → \`budget_sar\`, "متابعات" → \`follow_ups\`, "العملاء" → \`clients\`.
   - NEVER produce \`item_<timestamp>\` style placeholders. NEVER produce empty slugs.

4. Translation quality bar: short, natural, what a real CRM in this domain would use. Not literal. Not stilted.

5. If the input is ambiguous or could mean different things, pick the most likely meaning for the given context kind and translate that. Do not ask for clarification.`;

const TOOL_SCHEMA = {
  name: 'translate_label',
  description: 'Return the Arabic + English versions of a short label and a snake_case Latin slug.',
  input_schema: {
    type: 'object' as const,
    properties: {
      label_ar: {
        type: 'string',
        description: 'Arabic label.',
      },
      label_en: {
        type: 'string',
        description: 'English label, Title Case.',
      },
      name: {
        type: 'string',
        description: 'snake_case Latin slug derived from the English label, e.g. "phone_number". Letters, digits, underscores only. Must start with a letter.',
      },
    },
    required: ['label_ar', 'label_en', 'name'],
  },
};

interface ToolInput {
  label_ar: string;
  label_en: string;
  name: string;
}

const VALID_SLUG_RE = /^[a-z][a-z0-9_]*$/;

function sanitizeSlug(raw: string): string {
  const trimmed = (raw ?? '').trim().toLowerCase();
  let slug = trimmed
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!slug) return '';
  if (!/^[a-z]/.test(slug)) slug = `f_${slug}`;
  return slug;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  return withAuth(req, async (_user) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const input = body.input?.trim();
    if (!input) return jsonError(400, 'input is required');
    if (input.length > 200) return jsonError(400, 'input is too long — labels should be under 200 chars');

    const sourceLang = body.source_lang ?? 'auto';
    const kind = body.kind ?? 'generic';
    const kindHint = KIND_GUIDANCE[kind] ?? KIND_GUIDANCE.generic;

    const userMessage = `Context: this is ${kindHint}.\nSource language hint: ${sourceLang}.\nInput: ${input}`;

    const client = new Anthropic({ apiKey });

    let response;
    try {
      response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        tools: [TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'translate_label' },
        messages: [{ role: 'user', content: userMessage }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(502, `Translation failed: ${msg}`);
    }

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      return jsonError(502, 'Translation model did not call the tool');
    }
    const out = toolBlock.input as ToolInput;

    const labelAr = (out.label_ar ?? '').trim();
    const labelEn = (out.label_en ?? '').trim();
    const slugRaw = (out.name ?? '').trim();

    if (!labelAr || !labelEn) {
      return jsonError(502, 'Translation model returned an empty label');
    }

    let slug = slugRaw;
    if (!VALID_SLUG_RE.test(slug)) {
      slug = sanitizeSlug(labelEn);
    }
    if (!slug) {
      return jsonError(502, 'Translation model returned an unusable slug');
    }

    return jsonOk({
      ok: true,
      label_ar: labelAr,
      label_en: labelEn,
      name: slug,
    });
  });
}
