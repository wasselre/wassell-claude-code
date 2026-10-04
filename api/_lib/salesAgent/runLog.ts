/**
 * Saves one WhatsApp agent turn to `wa_agent_runs` — what the AI read,
 * searched, found, did and said — for the chat's AI activity cards and the
 * client's AI timeline (/api/chat-ai-activity). A failed insert is logged and
 * never fails the turn: the customer's reply matters more than the record.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface AgentRunRow {
  chat_wid: string;
  client_id: string | null;
  kind: 'brain' | 'rules' | 'holding';
  model?: string | null;
  ms?: number | null;
  customer_text?: string | null;
  reading?: unknown;
  searches?: unknown[];
  actions?: Record<string, unknown>;
  reply?: string | null;
  reply_sent?: boolean | null;
  reply_failed?: boolean;
  guard_problems?: string[];
  tool_trace?: string[];
}

export async function recordAgentRun(svc: SupabaseClient, row: AgentRunRow): Promise<void> {
  const { error } = await svc.from('wa_agent_runs').insert({
    chat_wid: row.chat_wid, client_id: row.client_id, kind: row.kind, model: row.model ?? null, ms: row.ms ?? null,
    customer_text: row.customer_text ? row.customer_text.slice(0, 2000) : null, reading: row.reading ?? null,
    searches: row.searches ?? [], actions: row.actions ?? {}, reply: row.reply ?? null, reply_sent: row.reply_sent ?? null,
    reply_failed: row.reply_failed ?? false, guard_problems: row.guard_problems ?? [], tool_trace: row.tool_trace ?? [],
  });
  if (error) console.error(`[salesAgent] run record failed chat=${row.chat_wid}:`, error.message);
}
