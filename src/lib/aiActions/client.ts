// aiActions — the operator's half of the AI sales automation.
//
// The AI prepares follow-up messages to clients and notices to project
// officers in `ai_actions`. Since 2026-10-07 the cron sends both itself; what is
// still pending can be decided in the Work Queue's AI tab. This module lists them (RLS: admins see them) and sends
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

/**
 * Pending actions (oldest first) plus the last day's failures, so a failed send
 * is never invisible. An approved message (`sending`) is NOT listed — it is the
 * operator's decision already made, and it leaves the list the moment they
 * approve (operator, 2026-10-05); if the send then fails it comes back as failed.
 */
export async function fetchAiActions(): Promise<AiAction[]> {
  if (!supabase) return [];
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const out: AiAction[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('ai_actions')
      .select(COLUMNS)
      .or(`status.eq.pending,and(status.eq.failed,updated_at.gte.${since})`)
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

/** Approve (optionally with the operator's edited text) or reject one action (a reject needs `note`). */
export async function decideAiAction(
  id: string,
  action: 'approve' | 'reject',
  body?: string,
  note?: string,
): Promise<{ ok: true } | { ok: false; error: AiActionDecisionError }> {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const res = await fetch('/api/ai-actions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: JSON.stringify({ id, action, ...(body !== undefined ? { body } : {}), ...(note !== undefined ? { note } : {}) }),
  });
  if (res.ok) return { ok: true };
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  const error = payload.error ?? `HTTP ${res.status}`;
  console.error(`[aiActions] ${action} ${id} failed:`, error);
  return { ok: false, error };
}

/** How many AI follow-up messages went out in a period (the Sales overview). */
export interface AiFollowupSends {
  /** Delivered in the period. */
  sent: number;
  /** …of which old-lead (campaign) messages. */
  campaign: number;
  /** Queued now, waiting for their paced slot (any period). */
  queued: number;
  /** Failed to send in the period. */
  failed: number;
}

/**
 * Counts ai_actions kind='followup_message' by status for [fromIso, toIso):
 * sent by `sent_at`, failed by `updated_at`, queued = everything still sending.
 * Paged past 1,000 rows; an error throws (never a silent 0).
 */
export async function fetchAiFollowupSends(fromIso: string, toIso: string): Promise<AiFollowupSends> {
  const out: AiFollowupSends = { sent: 0, campaign: 0, queued: 0, failed: 0 };
  if (!supabase) return out;
  const client = supabase;
  const page = async (build: (from: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>) => {
    const rows: Record<string, unknown>[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build(from);
      if (error) {
        console.error('[aiActions] follow-up send counts failed:', error.message);
        throw new Error(error.message);
      }
      const batch = (data ?? []) as Record<string, unknown>[];
      rows.push(...batch);
      if (batch.length < 1000) return rows;
    }
  };
  const [sent, queued, failed] = await Promise.all([
    page((from) => client.from('ai_actions').select('id, context').eq('kind', 'followup_message').eq('status', 'sent')
      .gte('sent_at', fromIso).lt('sent_at', toIso).order('id').range(from, from + 999)),
    page((from) => client.from('ai_actions').select('id').eq('kind', 'followup_message').eq('status', 'sending')
      .order('id').range(from, from + 999)),
    page((from) => client.from('ai_actions').select('id').eq('kind', 'followup_message').eq('status', 'failed')
      .gte('updated_at', fromIso).lt('updated_at', toIso).order('id').range(from, from + 999)),
  ]);
  out.sent = sent.length;
  out.campaign = sent.filter((r) => {
    const c = r.context;
    return !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).campaign === 'string';
  }).length;
  out.queued = queued.length;
  out.failed = failed.length;
  return out;
}
