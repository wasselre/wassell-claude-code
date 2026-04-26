/**
 * Browser-side helper for streaming chat turns from `/api/template-assistant`.
 * Same SSE wire format as `/api/agent`, but no tool events — this assistant
 * is pure chat (it drafts step prompts, doesn't execute anything).
 */

import { supabase } from '@/lib/supabase';
import type { PresentationTemplate } from '@/types';

export type TemplateAssistantEvent =
  | { type: 'text'; delta: string }
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
