/**
 * Browser-side helper for the project WhatsApp AI-rewrite.
 *
 *   generateProjectMessageAi → POST /api/templates/project-message-ai
 *     Sends the WHOLE all_projects record to the LLM and returns a fresh
 *     bilingual WhatsApp message built from the project's CURRENT data. The
 *     server gates the output (geography + invented-price guards); a rejected
 *     rewrite throws so the caller can keep the saved template instead.
 */

import { supabase } from '@/lib/supabase';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface ProjectMessageAiResult {
  body_ar: string;
  body_en: string;
  facts?: Record<string, unknown>;
  generated_by?: string;
}

/** provider is for testing/bake-off; production omits it (server env decides). */
export async function generateProjectMessageAi(
  projectId: string,
  provider?: 'anthropic' | 'kimi',
): Promise<ProjectMessageAiResult> {
  const res = await fetch('/api/templates/project-message-ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ project_id: projectId, ...(provider ? { provider } : {}) }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(b?.error ?? `AI message generation failed (${res.status})`);
  }
  const j = (await res.json()) as { body_ar?: string; body_en?: string; facts?: Record<string, unknown>; generated_by?: string };
  return { body_ar: j.body_ar ?? '', body_en: j.body_en ?? '', facts: j.facts, generated_by: j.generated_by };
}
