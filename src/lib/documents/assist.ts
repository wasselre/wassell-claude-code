/**
 * Client for /api/doc-assist — AI transforms on selected document text.
 *
 * The CRM context block is built from the SAME resolved variable groups the
 * CRM-variables feature computes (document links → records → formatted
 * values), so the assistant knows the linked project/client facts without
 * any server-side record fetching.
 */

import { supabase } from '@/lib/supabase';
import type { DocVariableGroup } from './variables';

export type AssistAction = 'rewrite' | 'improve' | 'translate' | 'summarize' | 'expand' | 'shorten';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface DocAssistInput {
  action: AssistAction;
  text: string;
  docTitle?: string;
  context?: string;
  targetLang?: 'ar' | 'en';
}

export async function requestDocAssist(input: DocAssistInput): Promise<string> {
  const res = await fetch('/api/doc-assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: string; error?: string };
  if (!res.ok || !body.result) {
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return body.result;
}

/** Compact, capped context block from the document's linked records. */
export function buildAssistContext(groups: DocVariableGroup[]): string {
  const lines: string[] = [];
  for (const g of groups.slice(0, 3)) {
    lines.push(`${g.modelLabel}: ${g.recordTitle}`);
    for (const v of g.variables.slice(0, 12)) {
      lines.push(`  - ${v.label}: ${v.value}`);
    }
  }
  return lines.join('\n').slice(0, 2_400);
}
