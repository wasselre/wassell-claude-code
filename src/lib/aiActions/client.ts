// aiActions — the operator's half of the AI sales automation.
//
// The AI prepares follow-up messages to clients and notices to project
// officers; each waits in `ai_actions` until the operator approves it in the
// Work Queue's AI tab. This module lists them (RLS: admins see them) and sends
// the decision to /api/ai-actions, which re-checks and queues the message.

import { supabase } from '@/lib/supabase';
import type { AiAction } from '@/types';

const COLUMNS =
  'id, kind, status, client_id, chat_wid, followup_id, project_id, officer_id, phone, ' +
  'body, original_body, context, error, created_at, sent_at';

function normalize(row: Record<string, unknown>): AiAction {
  const c = row.context;
  return {
    ...(row as unknown as AiAction),
    context: c && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : {},
  };
}

/** Pending actions (oldest first) plus the last day's failures, so a failed send is never invisible. */
export async function fetchAiActions(): Promise<AiAction[]> {
  if (!supabase) return [];
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const out: AiAction[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('ai_actions')
      .select(COLUMNS)
      .or(`status.eq.pending,status.eq.sending,and(status.eq.failed,updated_at.gte.${since})`)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error('[aiActions] failed to load:', error.message);
      throw new Error(error.message);
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...rows.map(normalize));
    if (rows.length < 1000) return out;
  }
}

export type AiActionDecisionError =
  | 'already_decided' | 'followup_moved' | 'client_closed' | 'ai_paused' | 'no_operations_line' | string;

/** Approve (optionally with the operator's edited text) or reject one action. */
export async function decideAiAction(
  id: string,
  action: 'approve' | 'reject',
  body?: string,
): Promise<{ ok: true } | { ok: false; error: AiActionDecisionError }> {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const res = await fetch('/api/ai-actions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify({ id, action, ...(body !== undefined ? { body } : {}) }),
  });
  if (res.ok) return { ok: true };
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  const error = payload.error ?? `HTTP ${res.status}`;
  console.error(`[aiActions] ${action} ${id} failed:`, error);
  return { ok: false, error };
}
