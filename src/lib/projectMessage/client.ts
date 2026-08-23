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
    // Never surface an EMPTY message: a non-JSON body (edge/CDN error page) or an
    // HTTP/2 response (empty statusText) must still yield a readable error, or the
    // UI paints a blank red box. Fall back to the status code.
    const b = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const serverMsg = typeof b?.error === 'string' ? b.error.trim() : '';
    throw new Error(serverMsg || `AI message generation failed (HTTP ${res.status})`);
  }
  const j = (await res.json()) as { body_ar?: string; body_en?: string; facts?: Record<string, unknown>; generated_by?: string };
  return { body_ar: j.body_ar ?? '', body_en: j.body_en ?? '', facts: j.facts, generated_by: j.generated_by };
}
