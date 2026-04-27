/**
 * Browser-side helper for streaming chat turns from `/api/template-assistant`.
 *
 * Two channels in the SSE stream:
 *   - `text`     — token deltas of assistant prose (rendered in chat bubble)
 *   - `proposal` — a structured patch the assistant wants to apply to the
 *                  template draft. Each proposal renders as an Apply card.
 *
 * The server runs a small agent loop so the assistant can call
 * `propose_template_patch` multiple times within one user turn, optionally
 * with prose between calls. The browser stitches everything onto the
 * single in-flight assistant message.
 */

import { supabase } from '@/lib/supabase';
import type { PresentationTemplate } from '@/types';

/** A patch the assistant wants to apply to the user's template draft.
 *  The shape mirrors the `propose_template_patch` JSON-schema on the
 *  server (without `summary`, which is metadata). All fields optional —
 *  the assistant patches only what it wants to change. */
export interface TemplateProposalChanges {
  label_en?: string;
  label_ar?: string;
  slug?: string;
  description_en?: string;
  description_ar?: string;
  icon?: string;
  tools?: string[];
  input_schema?: Array<Record<string, unknown>>;
  steps?: Array<Record<string, unknown>>;
  output_structure?: string;
}

export interface TemplateProposal {
  /** Server-side tool_use id — stable for this proposal across the SSE
   *  stream. The UI uses it to dedupe and to mark cards as applied. */
  id: string;
  /** One-sentence description shown on the Apply card. */
  summary: string;
  /** The patch the user can apply. */
  changes: TemplateProposalChanges;
}

export type TemplateAssistantEvent =
  | { type: 'text'; delta: string }
  | { type: 'proposal'; id: string; summary: string; changes: TemplateProposalChanges }
  | { type: 'done'; stop_reason: string }
  | { type: 'error'; message: string };

export interface TemplateAssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Compact projection of the template's current draft. The server formats
 *  it into a "Current template state" block and appends to the system
 *  prompt so the assistant always sees what the user has so far. */
export function buildTemplateContext(template: PresentationTemplate): {
  label_en: string;
  label_ar: string;
  slug: string;
  description_en?: string;
  description_ar?: string;
  tools: string[];
  inputs: Array<{ name: string; label_en?: string; type?: string; required?: boolean }>;
  steps: Array<{ kind: string; prompt?: string; tools?: string[]; label_en?: string }>;
  output_structure: string;
  brand: {
    colors?: Array<{ role_en?: string; role_ar?: string; hex?: string; notes?: string }>;
    font_family?: string;
    font_notes?: string;
    design_rules?: string;
    text_rules?: string;
    forbidden_phrases?: Array<{ wrong: string; right?: string; note?: string }>;
    required_phrases?: Array<{ context: string; phrase: string; note?: string }>;
  } | null;
} {
  return {
    label_en: template.label_en,
    label_ar: template.label_ar,
    slug: template.slug,
    description_en: template.description_en,
    description_ar: template.description_ar,
    tools: [...template.tools],
    inputs: template.input_schema.map((i) => ({
      name: i.name,
      label_en: i.label_en,
      type: i.type,
      required: i.required,
    })),
    steps: template.steps.map((s) => ({
      kind: s.kind,
      prompt: s.prompt,
      tools: s.tools,
      label_en: s.label_en,
    })),
    output_structure: template.output_structure,
    brand: template.brand
      ? {
          colors: template.brand.colors.map((c) => ({
            role_en: c.role_en,
            role_ar: c.role_ar,
            hex: c.hex,
            notes: c.notes,
          })),
          font_family: template.brand.font_family,
          font_notes: template.brand.font_notes,
          design_rules: template.brand.design_rules,
          text_rules: template.brand.text_rules,
          forbidden_phrases: template.brand.forbidden_phrases.map((p) => ({
            wrong: p.wrong,
            right: p.right,
            note: p.note,
          })),
          required_phrases: template.brand.required_phrases.map((p) => ({
            context: p.context,
            phrase: p.phrase,
            note: p.note,
          })),
        }
      : null,
  };
}

export async function streamTemplateAssistant(
  messages: TemplateAssistantMessage[],
  template: PresentationTemplate,
  onEvent: (event: TemplateAssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/template-assistant', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify({ messages, template: buildTemplateContext(template) }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `POST /api/template-assistant failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const raw of chunks) {
      const line = raw.replace(/^data:\s?/, '').trim();
      if (!line) continue;
      let parsed: TemplateAssistantEvent;
      try {
        parsed = JSON.parse(line) as TemplateAssistantEvent;
      } catch {
        continue;
      }
      onEvent(parsed);
    }
  }
}
