/**
 * GET /api/ai-chat-review?id=<review id> — what the AI agent DID in one reviewed
 * chat, for the review pop-up's cards (operator, 2026-10-05):
 *
 *   changes  — client_ai_changes for this chat in the review window: places
 *              (kind 'place') and other preferences (kind 'pref'), applied or
 *              heard-but-not-written, with the customer quote each rests on.
 *   portals  — portal steps for the client in the window: the interest events'
 *              portal results (incl. "already registered / covered", which runs
 *              no job) and the portal_registration_jobs that ran.
 *   bookings — appointments and visits created for the client in the window by
 *              the system (created_by_user_id IS NULL — the AI agent's bookVisit
 *              / recordVisit write server-side with no user).
 *
 * Gate: the caller must see the review row under their OWN RLS (its reviewer or
 * an admin); everything else is read with the service role because
 * client_ai_changes and the jobs tables are service-only.
 */
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';

export const config = { runtime: 'edge' };

const SERVICE_NAME = 'api:ai-chat-review';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The AI saves a little after the message it read; keep those in the window. */
const WINDOW_SLACK_MS = 30 * 60_000;

interface ReviewRow {
  id: string; chat_wid: string; client_id: string | null; window_start: string; window_end: string;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return jsonError(405, 'method not allowed');
  return withAuth(req, async () => {
    const id = new URL(req.url).searchParams.get('id') ?? '';
    if (!UUID.test(id)) return jsonError(400, 'id is required');

    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anon) return jsonError(500, 'Supabase env missing');
    const scoped = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: rev, error: rErr } = await scoped.from('ai_chat_reviews')
      .select('id, chat_wid, client_id, window_start, window_end').eq('id', id).maybeSingle();
    if (rErr) return jsonError(500, `review read failed: ${rErr.message}`);
    if (!rev) return jsonError(404, 'review not found or not permitted');
    const review = rev as ReviewRow;

    const svc = makeServiceClient(SERVICE_NAME);
    if (!svc) return jsonError(500, 'Supabase service env not configured');

    const from = review.window_start;
    const to = new Date(Date.parse(review.window_end) + WINDOW_SLACK_MS).toISOString();

    const [notesRes, cardsRes, changesRes] = await Promise.all([
      svc.from('ai_chat_review_notes').select('id, message_ids, note, created_at').eq('review_id', id).order('created_at'),
      svc.from('ai_chat_review_cards').select('card, verdict, reason, corrections, decided_at').eq('review_id', id),
      svc.from('client_ai_changes')
        .select('id, kind, field, before_value, after_value, added, applied, note, quote, label, profile_name, created_at, undone_at')
        .eq('source', 'chat').eq('source_ref', review.chat_wid).in('kind', ['place', 'pref'])
        .gte('created_at', from).lte('created_at', to).order('created_at'),
    ]);
    for (const r of [notesRes, cardsRes, changesRes]) if (r.error) return jsonError(500, r.error.message);

    let portals: unknown[] = [];
    let bookings: unknown[] = [];
    if (review.client_id) {
      const clientId = review.client_id;
      const modelIds = await svc.from('models').select('id, name').in('name', ['appointments', 'visits', 'all_projects', 'our_projects', 'lead_portals']);
      if (modelIds.error) return jsonError(500, modelIds.error.message);
      const mid = (n: string) => ((modelIds.data ?? []) as { id: string; name: string }[]).find((m) => m.name === n)?.id ?? '';

      const [intRes, jobsRes, apptRes, visitRes] = await Promise.all([
        svc.from('client_project_interest').select('id, project_id, source, detected_at, portal_result, portal_done_at')
          .eq('client_id', clientId).gte('portal_done_at', from).lte('portal_done_at', to),
        svc.from('portal_registration_jobs').select('id, portal_record_id, project_record_id, status, phase_ar, phase_en, result, error_message, created_at, finished_at')
          .eq('client_record_id', clientId).gte('created_at', from).lte('created_at', to).order('created_at'),
        svc.from('records').select('id, data, created_at').eq('model_id', mid('appointments'))
          .eq('data->>client_id', clientId).is('created_by_user_id', null).gte('created_at', from).lte('created_at', to),
        svc.from('records').select('id, data, created_at').eq('model_id', mid('visits'))
          .eq('data->>client_id', clientId).is('created_by_user_id', null).gte('created_at', from).lte('created_at', to),
      ]);
      for (const r of [intRes, jobsRes, apptRes, visitRes]) if (r.error) return jsonError(500, r.error.message);

      // Names for the projects and portals these rows point at.
      const ids = new Set<string>();
      for (const i of (intRes.data ?? []) as { project_id: string | null }[]) if (i.project_id) ids.add(i.project_id);
      for (const j of (jobsRes.data ?? []) as { portal_record_id: string | null; project_record_id: string | null }[]) {
        if (j.portal_record_id) ids.add(j.portal_record_id);
        if (j.project_record_id) ids.add(j.project_record_id);
      }
      for (const b of [...(apptRes.data ?? []), ...(visitRes.data ?? [])] as { data: Record<string, unknown> }[]) {
        if (typeof b.data.project_id === 'string') ids.add(b.data.project_id);
      }
      const names = new Map<string, string>();
      if (ids.size) {
        const { data: named, error: nErr } = await svc.from('records').select('id, data').in('id', [...ids]);
        if (nErr) return jsonError(500, nErr.message);
        for (const r of (named ?? []) as { id: string; data: Record<string, unknown> }[]) {
          const n = r.data.project_name ?? r.data.name ?? r.data.project;
          if (typeof n === 'string' && n.trim()) names.set(r.id, n.trim());
        }
      }
      const nameOf = (rid: unknown) => (typeof rid === 'string' ? names.get(rid) ?? null : null);

      portals = [
        ...((intRes.data ?? []) as Array<{ id: string; project_id: string | null; source: string | null; portal_result: unknown; portal_done_at: string }>)
          .map((i) => ({ kind: 'interest', id: i.id, project: nameOf(i.project_id), source: i.source, result: i.portal_result, at: i.portal_done_at })),
        ...((jobsRes.data ?? []) as Array<{ id: string; portal_record_id: string | null; project_record_id: string | null; status: string; phase_ar: string | null; phase_en: string | null; result: unknown; error_message: string | null; created_at: string; finished_at: string | null }>)
          .map((j) => ({
            kind: 'job', id: j.id, portal: nameOf(j.portal_record_id), project: nameOf(j.project_record_id),
            status: j.status, phase_ar: j.phase_ar, phase_en: j.phase_en, result: j.result, error: j.error_message, at: j.finished_at ?? j.created_at,
          })),
      ];
      bookings = [
        ...((apptRes.data ?? []) as Array<{ id: string; data: Record<string, unknown>; created_at: string }>)
          .map((a) => ({ kind: 'appointment', id: a.id, at: a.created_at, project: nameOf(a.data.project_id), data: a.data })),
        ...((visitRes.data ?? []) as Array<{ id: string; data: Record<string, unknown>; created_at: string }>)
          .map((v) => ({ kind: 'visit', id: v.id, at: v.created_at, project: nameOf(v.data.project_id), data: v.data })),
      ];
    }

    return jsonOk({
      review,
      notes: notesRes.data ?? [],
      cards: cardsRes.data ?? [],
      changes: changesRes.data ?? [],
      portals,
      bookings,
    });
  });
}
