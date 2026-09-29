/**
 * Sales-agent conversation plumbing: the rollout switch, starting a
 * conversation, and enqueueing a (debounced) turn. The turn itself runs on the
 * Fly worker → /api/whatsapp/agent-turn (turn.ts), never inside a webhook.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseZone, type Slots } from './decide.js';
import type { Lang } from './texts.js';

export interface AgentSettings {
  is_enabled: boolean;
  agent_mode: 'off' | 'test' | 'on';
  agent_test_phones: string[];
  agent_max_turns: number;
}

export interface AgentConversation {
  chat_wid: string;
  status: 'active' | 'done' | 'handed_off';
  source: string;
  ad_project_id: string | null;
  slots: Slots;
  asked: string | null;
  sent_project_ids: string[];
  turns: number;
  last_turn_at: string | null;
  created_at: string;
}

export async function loadAgentSettings(svc: SupabaseClient): Promise<AgentSettings | null> {
  const { data, error } = await svc
    .from('whatsapp_ai_settings')
    .select('is_enabled, agent_mode, agent_test_phones, agent_max_turns')
    .limit(1)
    .maybeSingle();
  if (error) {
    // Fail CLOSED for the agent (the basic bot still answers) — and say so.
    console.error('[salesAgent] settings read failed — agent treated as off:', error.message);
    return null;
  }
  return (data as AgentSettings | null) ?? null;
}

/** Compare phones on their last 9 digits (KSA mobile) so +9665…, 9665… and 05… agree. */
function phoneKey(p: string | null | undefined): string {
  const d = (p ?? '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}

/** May the agent talk to this customer? off → never; test → only allowlisted
 *  phones; on → every eligible lead. The global kill switch always wins. */
export function agentAllowedFor(s: AgentSettings | null, phone: string | null | undefined): boolean {
  if (!s || !s.is_enabled) return false;
  if (s.agent_mode === 'on') return true;
  if (s.agent_mode === 'test') {
    const k = phoneKey(phone);
    return !!k && (s.agent_test_phones ?? []).some((p) => phoneKey(p) === k);
  }
  return false;
}

export async function activeAgentConversation(svc: SupabaseClient, chatWid: string): Promise<AgentConversation | null> {
  const { data, error } = await svc
    .from('wa_agent_conversations').select('*').eq('chat_wid', chatWid).eq('status', 'active').maybeSingle();
  if (error) {
    console.error('[salesAgent] conversation read failed:', error.message);
    return null;
  }
  return (data as AgentConversation | null) ?? null;
}

/**
 * Start (or restart) the qualifying conversation. A returning lead who taps the
 * "other projects" button again starts a fresh script, but keeps the list of
 * projects we already sent so none is sent twice.
 */
export async function startAgentConversation(
  svc: SupabaseClient,
  a: { chatWid: string; source: 'ad_other_projects' | 'test'; adProjectId: string | null; text: string; lang: Lang },
): Promise<void> {
  const { data: prev } = await svc
    .from('wa_agent_conversations').select('sent_project_ids').eq('chat_wid', a.chatWid).maybeSingle();
  const slots: Slots = { city: 'الرياض', zone: parseZone(a.text), lang: a.lang };
  const { error } = await svc.from('wa_agent_conversations').upsert({
    chat_wid: a.chatWid,
    status: 'active',
    source: a.source,
    ad_project_id: a.adProjectId,
    slots,
    asked: null,
    sent_project_ids: (prev as { sent_project_ids?: string[] } | null)?.sent_project_ids ?? [],
    turns: 0,
    last_turn_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'chat_wid' });
  if (error) throw new Error(`sales agent: could not start the conversation: ${error.message}`);
  await enqueueAgentTurn(svc, a.chatWid);
}

/** Queue a turn ~8 s out; further messages in the burst push it (≤ 60 s). */
export async function enqueueAgentTurn(svc: SupabaseClient, chatWid: string): Promise<void> {
  const { error } = await svc.rpc('wa_agent_turn_enqueue', { p_chat_wid: chatWid, p_delay_s: 8 });
  if (error) throw new Error(`sales agent: turn enqueue failed: ${error.message}`);
}
