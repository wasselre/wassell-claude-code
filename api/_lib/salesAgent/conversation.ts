/**
 * Sales-agent conversation plumbing: the rollout switch, starting a
 * conversation, and enqueueing a (debounced) turn. The turn itself runs on the
 * Fly worker → /api/whatsapp/agent-turn (turn.ts), never inside a webhook.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseZone, type Slots } from './decide.js';
import type { Lang } from './texts.js';
import { uuidV5FromWidSync } from '../chatIngest.js';

export interface AgentSettings {
  is_enabled: boolean;
  agent_mode: 'off' | 'test' | 'on';
  agent_test_phones: string[];
  agent_max_turns: number;
  /** 'llm' = the brain (v2) with v1 as fallback; 'rules' = v1 only. */
  agent_brain?: 'llm' | 'rules';
  agent_model?: string;
  agent_effort?: 'low' | 'medium' | 'high';
  /** 'other_projects' = ad leads asking for other projects; 'all' = any inbound. */
  agent_scope?: 'other_projects' | 'all';
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
    .select('is_enabled, agent_mode, agent_test_phones, agent_max_turns, agent_brain, agent_model, agent_effort, agent_scope')
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
  a: {
    chatWid: string; source: 'ad_other_projects' | 'test' | 'inbound' | 'ad_project'; adProjectId: string | null; text: string; lang: Lang;
    /** false = this message was already answered (e.g. the ad's project was just
     *  sent): only take over from the NEXT message. Default true. */
    answerNow?: boolean;
    /** Projects already sent in this chat by the caller. */
    alreadySent?: string[];
  },
): Promise<void> {
  const { data: prev } = await svc
    .from('wa_agent_conversations').select('sent_project_ids').eq('chat_wid', a.chatWid).maybeSingle();
  const slots: Slots = { city: 'الرياض', zone: parseZone(a.text), lang: a.lang };
  const answerNow = a.answerNow !== false;
  const sent = [...new Set([...((prev as { sent_project_ids?: string[] } | null)?.sent_project_ids ?? []), ...(a.alreadySent ?? [])])];
  const { error } = await svc.from('wa_agent_conversations').upsert({
    chat_wid: a.chatWid,
    status: 'active',
    source: a.source,
    ad_project_id: a.adProjectId,
    slots,
    asked: null,
    sent_project_ids: sent,
    turns: 0,
    // Not answering now → the watermark is NOW, so this message is not re-answered.
    last_turn_at: answerNow ? null : new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'chat_wid' });
  if (error) throw new Error(`sales agent: could not start the conversation: ${error.message}`);
  if (answerNow) await enqueueAgentTurn(svc, a.chatWid);
}

/** Does the agent's reach include every inbound message for this customer?
 *  Test mode: the allowlisted phones always get it. On: `agent_scope='all'`. */
export function agentScopeAll(s: AgentSettings | null): boolean {
  if (!s) return false;
  return s.agent_mode === 'test' || s.agent_scope === 'all';
}

/**
 * May a NEW agent conversation start for this chat (scope 'all')? The agent
 * handles every chat unless a rep pressed «إيقاف المساعد» in it (operator rule,
 * 2026-09-30) — a rep having written in the chat, or an earlier conversation
 * having ended, no longer keeps it out. Fails CLOSED on a read error — the basic
 * bot's own gate then decides, as before.
 */
export async function agentMayStart(svc: SupabaseClient, chatWid: string, _s: AgentSettings): Promise<boolean> {
  const { data, error } = await svc.from('records').select('data->ai_paused').eq('id', uuidV5FromWidSync(chatWid)).maybeSingle();
  if (error) { console.error('[salesAgent] chat read failed (not starting):', error.message); return false; }
  return (data as { ai_paused?: unknown } | null)?.ai_paused !== true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this a CLIENT chat? The agent answers clients only (operator rule,
 * 2026-09-30) — never a saved contact, a project officer, an advertiser, or a
 * number we have no client for. Same definition as the chat list's «العملاء»
 * tab: the chat carries a client link, or its phone matches a client record
 * (`find_client_id_by_phone`, the matcher the rest of the server uses). Fails
 * CLOSED: a read error means the agent does not take the chat.
 */
export async function chatIsClient(svc: SupabaseClient, chatWid: string): Promise<boolean> {
  const { data, error } = await svc.from('records').select('data->client_link').eq('id', uuidV5FromWidSync(chatWid)).maybeSingle();
  if (error) { console.error('[salesAgent] chat read failed (treating as not a client):', error.message); return false; }
  const link = (data as { client_link?: unknown } | null)?.client_link;
  const linked = typeof link === 'string' ? link : Array.isArray(link) && typeof link[0] === 'string' ? link[0] : '';
  if (UUID_RE.test(linked)) return true;
  const digits = chatWid.split('@')[0] ?? '';
  if (!/^\d{8,15}$/.test(digits)) return false;
  const { data: found, error: fErr } = await svc.rpc('find_client_id_by_phone', { p_phone: `+${digits}` });
  if (fErr) { console.error('[salesAgent] client match failed (treating as not a client):', fErr.message); return false; }
  return typeof found === 'string' && UUID_RE.test(found);
}

/** Queue a turn ~8 s out; further messages in the burst push it (≤ 60 s). */
export async function enqueueAgentTurn(svc: SupabaseClient, chatWid: string): Promise<void> {
  const { error } = await svc.rpc('wa_agent_turn_enqueue', { p_chat_wid: chatWid, p_delay_s: 8 });
  if (error) throw new Error(`sales agent: turn enqueue failed: ${error.message}`);
}
