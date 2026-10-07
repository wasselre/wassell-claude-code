/**
 * POST /api/ai-actions — the operator approves or rejects something the AI
 * prepared (ai_actions): a follow-up message to a client, or a notice to a
 * project's officer. Since 2026-10-07 the cron sends both on its own (no
 * approval — api/_lib/salesAgent/followupSend.ts, officerNoticeSend.ts); this is
 * the manual path for anything still pending, and for rejecting.
 *
 * Body: { id, action: 'approve' | 'reject', body?, note? } — a reject needs a note
 *   (why the draft was wrong; operator, 2026-10-05), stored in reject_note.
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
import { sendFollowupAction } from './_lib/salesAgent/followupSend.js';
import { resolveOperationsDeviceId } from './_lib/whatsappGateway.js';

export const config = { runtime: 'edge' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ActionRow {
  id: string; kind: 'followup_message' | 'officer_notice'; status: string; client_id: string;
  chat_wid: string | null; followup_id: string | null; round_key: string | null; phone: string | null;
  body: string; reference: string | null; context: Record<string, unknown>;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let input: { id?: string; action?: string; body?: string; note?: string };
    try { input = (await req.json()) as typeof input; }
    catch { return jsonError(400, 'invalid JSON body'); }
    const id = input.id ?? '';
    if (!UUID_RE.test(id)) return jsonError(400, 'id is required');
    if (input.action !== 'approve' && input.action !== 'reject') return jsonError(400, 'action must be approve or reject');
    const edited = typeof input.body === 'string' ? input.body.trim() : null;
    if (edited !== null && (edited.length === 0 || edited.length > 2000)) return jsonError(400, 'body must be 1–2000 characters');
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    if (input.action === 'reject' && (note.length === 0 || note.length > 1000)) return jsonError(400, 'note_required');

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
        .update({ status: 'rejected', decided_by: me, decided_at: now, updated_at: now, reject_note: note })
        .eq('id', id).eq('status', 'pending').select('id');
      if (uErr) return jsonError(500, `could not save: ${uErr.message}`);
      if (!upd?.length) return jsonError(409, 'already_decided');
      return jsonOk({ status: 'rejected' });
    }

    // A follow-up to a client goes through the ONE send path the cron also uses.
    const { data: kindRow, error: kErr } = await svc.from('ai_actions').select('kind').eq('id', id).maybeSingle();
    if (kErr) return jsonError(500, `lookup failed: ${kErr.message}`);
    if ((kindRow as { kind?: string } | null)?.kind === 'followup_message') {
      try {
        const r = await sendFollowupAction(svc, id, { decidedBy: me, editedBody: edited, auto: false });
        if (r.ok) return jsonOk({ status: 'sending', job_id: r.job_id, send_at: r.send_at });
        const http = r.code === 'already_decided' || r.code === 'followup_moved' || r.code === 'client_closed' || r.code === 'ai_paused' ? 409
          : r.code === 'queue_failed' ? 502 : 500;
        return jsonError(http, r.code === 'queue_failed' || r.code === 'incomplete' ? r.message : r.code);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[ai-actions] approve ${id} failed:`, msg);
        return jsonError(500, msg);
      }
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
