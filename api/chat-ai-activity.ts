/**
 * GET /api/chat-ai-activity?clientId=<uuid>[&chatWid=<wid>]
 *
 * Everything the AI did for a client — for the chat's AI activity cards
 * (chatWid given: runs of THAT chat) and the client profile's AI timeline (no
 * chatWid: every chat of the client, plus the conversation messages so the
 * timeline can interleave customer and AI).
 *
 *   runs          wa_agent_runs — what each agent turn read, searched, found, did, said
 *   stats         message counts in the chat(s): customer / AI / rep
 *   messages      (client mode) the newest 80 messages of the client's chats
 *   changes       client_ai_changes — what the AI wrote onto the client
 *   outcomes      chat_outcome_suggestions — follow-up results read / applied
 *   portal        portal registration jobs + the per-portal registration state
 *   actions       ai_actions — follow-up drafts and officer notices
 *   questions     wa_agent_questions — what the agent asked a rep
 *   handoffs      ai_notifications for the chat(s)
 *   bookings      appointments + visits on the client
 *   interest      v_client_project_interest — the top projects by score
 *
 * Service role behind `assertCanAccessRecord` (the caller must be able to see
 * the client under their own RLS) — the same gate the review endpoints use.
 * Every read error is returned as a 500, never an empty list.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk, assertCanAccessRecord } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';

export const config = { runtime: 'edge' };

const SERVICE_NAME = 'api:chat-ai-activity';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ReadError extends Error {}

async function rows<T>(p: PromiseLike<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await p;
  if (error) throw new ReadError(`${what}: ${error.message}`);
  return data ?? [];
}

async function modelId(sb: SupabaseClient, name: string): Promise<string | null> {
  const { data, error } = await sb.from('models').select('id').eq('name', name).maybeSingle();
  if (error) throw new ReadError(`model ${name}: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/** Record id → a display name (project / portal records). */
async function names(sb: SupabaseClient, ids: string[]): Promise<Record<string, string>> {
  const uniq = [...new Set(ids.filter((x) => UUID.test(x)))];
  if (!uniq.length) return {};
  const data = await rows<{ id: string; data: Record<string, unknown> | null }>(
    sb.from('records').select('id, data').in('id', uniq), 'names');
  const out: Record<string, string> = {};
  for (const r of data) {
    const d = r.data ?? {};
    const n = [d.project_name, d.name, d.portal_name, d.title, d.label_ar].find((v) => typeof v === 'string' && v.trim());
    if (n) out[r.id] = String(n);
  }
  return out;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return jsonError(405, 'method not allowed');
  return withAuth(req, async () => {
    const url = new URL(req.url);
    const clientId = url.searchParams.get('clientId') ?? '';
    const chatWid = (url.searchParams.get('chatWid') ?? '').trim();
    if (!UUID.test(clientId)) return jsonError(400, 'clientId is required');
    await assertCanAccessRecord(req, clientId, SERVICE_NAME);
    const sb = makeServiceClient(SERVICE_NAME);
    if (!sb) return jsonError(500, 'Supabase service env not configured');

    try {
      // The chat(s) in scope: this chat, or every chat linked to the client.
      let wids: string[] = [];
      if (chatWid) wids = [chatWid];
      else {
        const chatsModel = await modelId(sb, 'chats');
        if (chatsModel) {
          const chats = await rows<{ data: Record<string, unknown> | null }>(
            sb.from('records').select('data').eq('model_id', chatsModel).eq('data->>client_link', clientId), 'chats');
          wids = chats.map((c) => String(c.data?.wid ?? '')).filter(Boolean);
        }
        // A chat matched to the client by phone only (no stored client_link) is
        // still known to the chat reader, which keys its state by client.
        const read = await rows<{ chat_wid: string }>(
          sb.from('chat_read_state').select('chat_wid').eq('client_id', clientId), 'chat read state');
        wids = [...new Set([...wids, ...read.map((r) => r.chat_wid)])].filter((w) => !w.startsWith('call:'));
      }

      const runsQ = sb.from('wa_agent_runs').select('*').order('created_at', { ascending: false }).limit(40);
      const runs = await rows<Record<string, unknown>>(
        chatWid ? runsQ.eq('chat_wid', chatWid) : runsQ.eq('client_id', clientId), 'runs');

      const msgs = wids.length
        ? await rows<{ chat_wid: string; date: string; flow: string; send_source: string | null; body: string | null; transcript: string | null; kind: string | null }>(
          sb.from('chat_messages').select('chat_wid, date, flow, send_source, body, transcript, kind').in('chat_wid', wids)
            .not('kind', 'in', '(reaction,call_log,e2e_notification,notification,notification_template,gp2,protocol,ciphertext,revoked)')
            .order('date', { ascending: false }).limit(chatWid ? 400 : 80), 'messages')
        : [];
      const by = (m: { flow: string; send_source: string | null }) => (m.flow === 'in' ? 'customer' : m.send_source === 'ai' ? 'ai' : 'rep');
      const stats = {
        customer: msgs.filter((m) => by(m) === 'customer').length,
        ai: msgs.filter((m) => by(m) === 'ai').length,
        rep: msgs.filter((m) => by(m) === 'rep').length,
        last_ai_at: msgs.find((m) => by(m) === 'ai')?.date ?? null,
        last_customer_at: msgs.find((m) => by(m) === 'customer')?.date ?? null,
        sampled: msgs.length,
      };

      const [changes, outcomes, portalJobs, portalRegs, actions, questions, handoffs, interest] = await Promise.all([
        rows<Record<string, unknown>>(sb.from('client_ai_changes').select('*').eq('client_id', clientId).order('created_at', { ascending: false }).limit(60), 'changes'),
        rows<Record<string, unknown>>(sb.from('chat_outcome_suggestions')
          .select('id, chat_wid, status, suggested_outcome, confidence, summary, quoted_phrase, auto_applied, confirmed_outcome, confirmed_at, finished_at, created_at, suggested_main_project_name, main_project_decision')
          .eq('client_id', clientId).order('created_at', { ascending: false }).limit(20), 'outcomes'),
        rows<Record<string, unknown>>(sb.from('portal_registration_jobs')
          .select('id, portal_record_id, project_record_id, status, origin, kind, error_message, created_at, finished_at')
          .eq('client_record_id', clientId).order('created_at', { ascending: false }).limit(15), 'portal jobs'),
        rows<Record<string, unknown>>(sb.from('client_portal_registrations')
          .select('portal_record_id, our_status, portal_status, registered_at, registered_via, updated_at').eq('client_record_id', clientId), 'portal registrations'),
        rows<Record<string, unknown>>(sb.from('ai_actions').select('id, kind, status, project_id, body, error, created_at, sent_at, decided_at')
          .eq('client_id', clientId).order('created_at', { ascending: false }).limit(20), 'ai actions'),
        wids.length
          ? rows<Record<string, unknown>>(sb.from('wa_agent_questions').select('id, chat_wid, question, status, answer, created_at, answered_at, relayed_at')
            .in('chat_wid', wids).order('created_at', { ascending: false }).limit(20), 'questions')
          : Promise.resolve([]),
        wids.length
          ? rows<Record<string, unknown>>(sb.from('ai_notifications').select('id, chat_wid, title, body, severity, created_at')
            .in('chat_wid', wids).order('created_at', { ascending: false }).limit(20), 'handoffs')
          : Promise.resolve([]),
        rows<Record<string, unknown>>(sb.from('v_client_project_interest').select('*').eq('client_id', clientId).order('score', { ascending: false }).limit(8), 'interest'),
      ]);

      const apptModel = await modelId(sb, 'appointments');
      const visitModel = await modelId(sb, 'visits');
      const bookings: Array<Record<string, unknown>> = [];
      for (const [kind, mid] of [['appointment', apptModel], ['visit', visitModel]] as const) {
        if (!mid) continue;
        const recs = await rows<{ id: string; data: Record<string, unknown> | null; created_at: string }>(
          sb.from('records').select('id, data, created_at').eq('model_id', mid).eq('data->>client_id', clientId)
            .order('created_at', { ascending: false }).limit(10), `${kind}s`);
        for (const r of recs) {
          const d = r.data ?? {};
          bookings.push({
            id: r.id, kind, created_at: r.created_at,
            when: d.appointment_date ?? d.scheduled_datetime ?? d.visit_date ?? null,
            status: d.appointment_status ?? d.visit_status ?? null,
            project_id: d.project_id ?? d.project ?? null,
          });
        }
      }

      const nameMap = await names(sb, [
        ...portalJobs.map((j) => String(j.portal_record_id ?? '')), ...portalJobs.map((j) => String(j.project_record_id ?? '')),
        ...portalRegs.map((r) => String(r.portal_record_id ?? '')), ...actions.map((a) => String(a.project_id ?? '')),
        ...interest.map((i) => String(i.project_id ?? '')), ...bookings.map((b) => String(b.project_id ?? '')),
        ...runs.map((r) => String(((r.actions as { booked?: { projectId?: string } } | null)?.booked?.projectId) ?? '')),
      ]);

      return jsonOk({
        scope: chatWid ? 'chat' : 'client', chat_wids: wids, runs, stats,
        messages: chatWid ? [] : msgs.map((m) => ({ chat_wid: m.chat_wid, date: m.date, by: by(m), text: (m.body || (m.transcript ? `🎤 ${m.transcript}` : '') || '').slice(0, 300) })),
        changes, outcomes, portal: { jobs: portalJobs, registrations: portalRegs }, actions, questions, handoffs, bookings, interest,
        names: nameMap,
      });
    } catch (err) {
      if (err instanceof ReadError) {
        console.error('[chat-ai-activity] read failed:', err.message);
        return jsonError(500, err.message);
      }
      throw err;
    }
  });
}
