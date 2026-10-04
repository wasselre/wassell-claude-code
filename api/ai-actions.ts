/**
 * POST /api/ai-actions — the operator approves or rejects something the AI
 * prepared (ai_actions): a follow-up message to a client, or a notice to a
 * project's officer. Nothing the AI writes is sent until this is called
 * (operator, 2026-10-04).
 *
 * Body: { id, action: 'approve' | 'reject', body? }
 *   approve → re-checks the action is still right to send, then queues it:
 *     · followup_message: to the client's chat on the line the client last
 *       wrote from (else the sales line), reference 'ai:followup:<id>:<round>'
 *       — tagged as the assistant's message, so the client's call tasks are
 *       never cancelled; on delivery the follow-up is marked «waiting for
 *       reply» (tg_ai_actions_job_sync).
 *     · officer_notice: from the OPERATIONS line only (409 if none — never the
 *       sales line), reference 'officer_notice:<id>'.
 *     `body` replaces the AI's text (the operator's edit).
 *   reject → closes it; nothing is sent and it is never redrafted.
 *
 * Gate: only a caller who can SEE ai_actions (RLS: admins) may decide. Only a
 * PENDING action can be decided, flipped with one conditional update, so two
 * clicks queue one message.
 */
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonOk, jsonError } from './_lib/auth.js';
import { getServiceSupabase } from './_lib/supabaseServer.js';
import { enqueueAiReply } from './_lib/aiSend.js';
import { resolveOperationsDeviceId } from './_lib/whatsappGateway.js';

export const config = { runtime: 'edge' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_STAGES = new Set(['خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار', 'طلب غير مجاب']);

interface ActionRow {
  id: string; kind: 'followup_message' | 'officer_notice'; status: string; client_id: string;
  chat_wid: string | null; followup_id: string | null; round_key: string | null; phone: string | null;
  body: string; reference: string | null; context: Record<string, unknown>;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let input: { id?: string; action?: string; body?: string };
    try { input = (await req.json()) as typeof input; }
    catch { return jsonError(400, 'invalid JSON body'); }
    const id = input.id ?? '';
    if (!UUID_RE.test(id)) return jsonError(400, 'id is required');
    if (input.action !== 'approve' && input.action !== 'reject') return jsonError(400, 'action must be approve or reject');
    const edited = typeof input.body === 'string' ? input.body.trim() : null;
    if (edited !== null && (edited.length === 0 || edited.length > 2000)) return jsonError(400, 'body must be 1–2000 characters');

    // Who may decide: whoever RLS lets see the row (admins).
    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anon) return jsonError(500, 'Supabase env missing');
    const scoped = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: visible, error: vErr } = await scoped.from('ai_actions').select('id').eq('id', id).maybeSingle();
    if (vErr) return jsonError(500, `lookup failed: ${vErr.message}`);
    if (!visible) return jsonError(403, 'not found or not permitted');

    const svc = getServiceSupabase();
    const { data: appUser } = await svc.from('users').select('id').eq('auth_uid', user.userId).maybeSingle();
    const me = (appUser as { id?: string } | null)?.id ?? null;
    const now = new Date().toISOString();

    if (input.action === 'reject') {
      const { data: upd, error: uErr } = await svc.from('ai_actions')
        .update({ status: 'rejected', decided_by: me, decided_at: now, updated_at: now })
        .eq('id', id).eq('status', 'pending').select('id');
      if (uErr) return jsonError(500, `could not save: ${uErr.message}`);
      if (!upd?.length) return jsonError(409, 'already_decided');
      return jsonOk({ status: 'rejected' });
    }

    // Claim: pending → sending, once.
    const patch: Record<string, unknown> = { status: 'sending', decided_by: me, decided_at: now, updated_at: now, error: null };
    if (edited !== null) patch.body = edited;
    const { data: claimed, error: cErr } = await svc.from('ai_actions').update(patch)
      .eq('id', id).eq('status', 'pending').select('*');
    if (cErr) return jsonError(500, `could not save: ${cErr.message}`);
    const a = (claimed?.[0] ?? null) as ActionRow | null;
    if (!a) return jsonError(409, 'already_decided');

    const giveBack = async (status: 'pending' | 'expired' | 'failed', error: string) => {
      const { error: gErr } = await svc.from('ai_actions')
        .update({ status, error, updated_at: new Date().toISOString(), ...(status === 'pending' ? { decided_by: null, decided_at: null } : {}) })
        .eq('id', id).eq('status', 'sending');
      if (gErr) console.error(`[ai-actions] could not move ${id} to ${status}: ${gErr.message}`);
    };

    try {
      if (!a.reference || !a.chat_wid) { await giveBack('failed', 'the action has no reference or chat'); return jsonError(500, 'action incomplete'); }

      if (a.kind === 'followup_message') {
        // Still right to send? The task, the client's stage and the chat switch.
        const [fRes, cRes, chRes] = await Promise.all([
          a.followup_id ? svc.from('records').select('data').eq('id', a.followup_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
          svc.from('records').select('data').eq('id', a.client_id).maybeSingle(),
          typeof a.context.chat_record_id === 'string'
            ? svc.from('records').select('data').eq('id', a.context.chat_record_id).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
        for (const r of [fRes, cRes, chRes]) if (r.error) throw new Error(r.error.message);
        const f = (fRes.data as { data?: Record<string, unknown> } | null)?.data ?? null;
        const stillOpen = !!f && (String(f.followup_status ?? '') || 'open') === 'open' && !f.whatsapp_state && !f.sent_at;
        if (!stillOpen) { await giveBack('expired', 'the follow-up is no longer open and unsent'); return jsonError(409, 'followup_moved'); }
        const stage = String(((cRes.data as { data?: Record<string, unknown> } | null)?.data ?? {}).client_stage ?? '');
        if (TERMINAL_STAGES.has(stage)) { await giveBack('expired', `the client is now «${stage}»`); return jsonError(409, 'client_closed'); }
        if (((chRes.data as { data?: Record<string, unknown> } | null)?.data ?? {}).ai_paused === true) {
          await giveBack('pending', 'the assistant is paused in this chat — resume it, or send the message yourself');
          return jsonError(409, 'ai_paused');
        }

        // The line the client last wrote from (enqueueAiReply falls back to the default line)
        // — but never an INTERNAL line. The operations and office-outreach lines are
        // kept out of the sales funnel; a client follow-up sent from the office line
        // is exactly the unsolicited traffic that gets that line restricted. On
        // 2026-10-04 a test message from the operations number into the (not yet
        // office) bridge line made the approved follow-up go out from it.
        const internal = await internalDeviceIds(svc);
        let lastInQ = svc.from('chat_messages').select('device_id')
          .eq('chat_wid', a.chat_wid).eq('flow', 'in');
        if (internal.length > 0) lastInQ = lastInQ.not('device_id', 'in', `(${internal.join(',')})`);
        const { data: lastIn } = await lastInQ.order('date', { ascending: false }).limit(1).maybeSingle();
        const r = await enqueueAiReply(svc, {
          chatWid: a.chat_wid, text: a.body, deviceId: (lastIn as { device_id?: string | null } | null)?.device_id ?? null,
          jobId: 'followup', force: true, reference: a.reference,
        });
        if (!r.queued) {
          await giveBack('failed', r.error ?? r.reason ?? 'could not queue');
          return jsonError(502, r.error ?? 'could not queue');
        }
        const jobId = r.wid?.startsWith('sched:') ? r.wid.slice(6) : null;
        const { error: sErr } = await svc.from('ai_actions').update({ scheduled_job_id: jobId, updated_at: new Date().toISOString() }).eq('id', id);
        if (sErr) console.error(`[ai-actions] queued ${id} but could not store its job id: ${sErr.message}`);
        return jsonOk({ status: 'sending', job_id: jobId });
      }

      // officer_notice — operations line only.
      const ops = await resolveOperationsDeviceId();
      if (!ops) {
        await giveBack('pending', 'no operations WhatsApp line is configured');
        return jsonError(409, 'no_operations_line');
      }
      const phone = a.phone ?? `+${a.chat_wid.split('@')[0]}`;
      const { data: jobId, error: qErr } = await svc.rpc('scheduled_whatsapp_enqueue', {
        p_device_id: ops, p_chat_wid: a.chat_wid, p_phone: phone, p_body: a.body, p_media: null,
        p_reference: a.reference, p_deliver_at: new Date().toISOString(), p_user_id: me,
      });
      if (qErr) {
        // 23505 = this notice is already queued (a double click that raced the claim).
        if (qErr.code === '23505') return jsonOk({ status: 'sending' });
        await giveBack('failed', `could not queue: ${qErr.message}`);
        return jsonError(502, qErr.message);
      }
      const { error: sErr } = await svc.from('ai_actions').update({ scheduled_job_id: jobId as string, device_id: ops, updated_at: new Date().toISOString() }).eq('id', id);
      if (sErr) console.error(`[ai-actions] queued ${id} but could not store its job id: ${sErr.message}`);
      return jsonOk({ status: 'sending', job_id: jobId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ai-actions] approve ${id} failed:`, msg);
      await giveBack('failed', msg);
      return jsonError(500, msg);
    }
  });
}

/**
 * Device ids of the lines that must never carry a client follow-up: every
 * operations line and the office-outreach line. A failed lookup returns what it
 * could read and logs — the caller then falls back to the default (sales) line
 * only if the client's last line was internal, never the other way round.
 */
async function internalDeviceIds(svc: ReturnType<typeof getServiceSupabase>): Promise<string[]> {
  const ids = new Set<string>();
  const [ops, office] = await Promise.all([
    svc.from('whatsapp_numbers').select('device_id').eq('is_operations', true),
    svc.from('office_outreach_settings').select('device_id').eq('id', 1).maybeSingle(),
  ]);
  if (ops.error) console.error('[ai-actions] could not read operations lines', ops.error);
  if (office.error) console.error('[ai-actions] could not read the office-outreach line', office.error);
  for (const r of (ops.data ?? []) as { device_id?: string | null }[]) if (r.device_id) ids.add(r.device_id);
  const officeId = (office.data as { device_id?: string | null } | null)?.device_id;
  if (officeId) ids.add(officeId);
  return [...ids];
}
