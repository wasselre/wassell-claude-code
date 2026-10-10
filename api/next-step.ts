/**
 * POST /api/next-step — the agent's review cards (api/_lib/nextStep.ts).
 *
 *   { action: 'list' }                         → my cards: pending, plus those
 *        applied automatically in the last 36 h (still changeable for after_call),
 *        each with the client's name / phone / chat and the planned next task.
 *   { action: 'for_followup', followup_id }    → the after_call card the follow-up
 *        I just completed opened (the popup polls this right after a save).
 *   { action: 'decide', id, input }            → agree / change / ack.
 *
 * Who may see or decide a card: RLS on next_step_reviews (its owner, admins) —
 * checked with the caller's own token before the service client writes.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonOk, jsonError } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';
import {
  decideReview, DecideError, plannedTask, planOfTask,
  type DecideInput, type NextPlan, type ReviewRow,
} from './_lib/nextStep.js';

export const config = { runtime: 'edge' };

const SERVICE_NAME = 'api:next-step';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS = new Set(['call', 'ai_whatsapp', 'agent_whatsapp']);

function scopedClient(req: Request): SupabaseClient | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createClient(url, anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}

function parsePlan(v: unknown): NextPlan | undefined | null {
  if (v === undefined || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.channel !== 'string' || !CHANNELS.has(o.channel)) return null;
  if (typeof o.at !== 'string' || Number.isNaN(Date.parse(o.at))) return null;
  return { channel: o.channel as NextPlan['channel'], at: new Date(o.at).toISOString() };
}

/** Cards with what the UI needs to show them. */
async function enrich(svc: SupabaseClient, rows: ReviewRow[]): Promise<Array<Record<string, unknown>>> {
  const clientIds = [...new Set(rows.map((r) => r.client_id))];
  const apptIds = rows.map((r) => r.appointment_id).filter((x): x is string => !!x);
  const [clients, chats, appts] = await Promise.all([
    clientIds.length ? svc.from('records').select('id, data').in('id', clientIds) : Promise.resolve({ data: [], error: null }),
    clientIds.length
      ? svc.from('records').select('id, data, updated_at').in('data->>client_link', clientIds).order('updated_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    apptIds.length ? svc.from('records').select('id, data').in('id', apptIds) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [clients, chats, appts]) if (r.error) throw new Error(`card details read failed: ${r.error.message}`);
  const clientOf = new Map(((clients.data ?? []) as Array<{ id: string; data: Record<string, unknown> }>).map((c) => [c.id, c.data ?? {}]));
  const chatOf = new Map<string, string>();
  for (const c of (chats.data ?? []) as Array<{ id: string; data: Record<string, unknown> }>) {
    const link = String(c.data?.client_link ?? '');
    if (link && !chatOf.has(link)) chatOf.set(link, c.id);
  }
  const apptOf = new Map(((appts.data ?? []) as Array<{ id: string; data: Record<string, unknown> }>).map((a) => [a.id, a.data ?? {}]));

  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const c = clientOf.get(r.client_id) ?? {};
    let planned: NextPlan | null = null;
    let plannedId: string | null = null;
    if (r.kind === 'after_call') {
      const t = r.followup_id
        ? await svc.from('records').select('id, data').eq('id', r.followup_id).maybeSingle()
        : null;
      if (t?.error) throw new Error(`planned task read failed: ${t.error.message}`);
      const task = (t?.data as { id: string; data: Record<string, unknown> } | null)
        ?? await plannedTask(svc, r.client_id, r.created_at, r.source_followup_id);
      if (task) { planned = planOfTask(task.data); plannedId = task.id; }
    }
    const a = r.appointment_id ? apptOf.get(r.appointment_id) ?? null : null;
    out.push({
      ...r,
      client_name: c.client_name ?? null,
      client_phone: c.phone_number ?? null,
      chat_record_id: chatOf.get(r.client_id) ?? null,
      planned_next: planned,
      planned_task_id: plannedId,
      appointment: a ? { date: a.appointment_date ?? null, status: a.appointment_status ?? null } : null,
    });
  }
  return out;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');
  return withAuth(req, async (user) => {
    const svc = makeServiceClient(SERVICE_NAME);
    const scoped = scopedClient(req);
    if (!svc || !scoped) return jsonError(500, 'Supabase env not configured');
    let body: { action?: unknown; id?: unknown; followup_id?: unknown; input?: unknown };
    try { body = (await req.json()) as typeof body; }
    catch { return jsonError(400, 'invalid JSON body'); }

    const { data: appUser, error: uErr } = await svc.from('users').select('id').eq('auth_uid', user.userId).maybeSingle();
    if (uErr) return jsonError(500, `user lookup failed: ${uErr.message}`);
    const me = (appUser as { id?: string } | null)?.id ?? null;

    if (body.action === 'list') {
      const since = new Date(Date.now() - 36 * 3_600_000).toISOString();
      // RLS decides whose cards these are (owner / admins).
      const { data, error } = await scoped.from('next_step_reviews').select('*')
        .or(`status.eq.pending,and(status.eq.auto_applied,decided_at.gte.${since})`)
        .order('created_at', { ascending: false }).limit(200);
      if (error) return jsonError(500, `cards read failed: ${error.message}`);
      return jsonOk({ me, cards: await enrich(svc, (data ?? []) as ReviewRow[]) });
    }

    if (body.action === 'for_followup') {
      const fid = typeof body.followup_id === 'string' ? body.followup_id : '';
      if (!UUID.test(fid)) return jsonError(400, 'followup_id is required');
      const { data, error } = await scoped.from('next_step_reviews').select('*')
        .eq('kind', 'after_call').eq('source_followup_id', fid).maybeSingle();
      if (error) return jsonError(500, `card read failed: ${error.message}`);
      if (!data) return jsonOk({ card: null });
      const [card] = await enrich(svc, [data as ReviewRow]);
      return jsonOk({ card });
    }

    if (body.action === 'decide') {
      const id = typeof body.id === 'string' ? body.id : '';
      if (!UUID.test(id)) return jsonError(400, 'id is required');
      const raw = (body.input ?? {}) as Record<string, unknown>;
      const next = parsePlan(raw.next);
      if (next === null) return jsonError(400, 'next must be { channel: call|ai_whatsapp|agent_whatsapp, at: date }');
      let input: DecideInput;
      if (raw.action === 'agree') input = { action: 'agree', ...(next ? { next } : {}) };
      else if (raw.action === 'change' && next) input = { action: 'change', next };
      else if (raw.action === 'ack') input = { action: 'ack' };
      else return jsonError(400, 'input.action must be agree, change (with next) or ack');

      const { data, error } = await scoped.from('next_step_reviews').select('*').eq('id', id).maybeSingle();
      if (error) return jsonError(500, `card read failed: ${error.message}`);
      if (!data) return jsonError(403, 'not found or not permitted');
      try {
        const status = await decideReview(svc, data as ReviewRow, input, me);
        console.log(`[next-step] card=${id} ${input.action} by=${me}`);
        return jsonOk({ status });
      } catch (err) {
        if (err instanceof DecideError) return jsonError(err.status, err.message);
        throw err;
      }
    }

    return jsonError(400, "action must be 'list', 'for_followup' or 'decide'");
  });
}
