/**
 * PUBLIC, token-authed endpoint for the per-candidate recruitment experience.
 *
 *   GET  ?token=<invite_token>
 *        → { name, phone, decision, status }  (for the confirm screen)
 *   POST { token, action:'confirm'|'interested'|'declined', reason? }
 *        → records the candidate's action against their job_applications row.
 *
 * The link's `invite_token` is the ONLY credential (same posture as /share/:token
 * and /rate/:token). No JWT — the browser never touches the table directly; every
 * read/write here goes through the service role after the token resolves a row.
 * Rate-limited by salted IP hash (fail-open so a real candidate is never blocked
 * by a rate-table hiccup). Never returns anything for an unknown token (404).
 */
import { jsonOk, jsonError } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { clientIp, hashIp } from '../_lib/careers.js';

export const config = { runtime: 'edge' };

// Only a candidate in a live, pre-hire / pre-admin-reject state may decide.
const DECIDABLE = new Set(['interview', 'offer_pending', 'offer_sent', 'offer_accepted', 'offer_rejected']);

/** +9665XXXXXXXX → 05XXXXXXXX for a readable confirmation. */
function displayPhone(canon: string | null | undefined): string {
  if (canon && canon.startsWith('+966')) return `0${canon.slice(4)}`;
  return canon ?? '';
}

async function underLimit(svc: NonNullable<ReturnType<typeof makeServiceClient>>, req: Request, max: number, windowSeconds: number): Promise<boolean> {
  try {
    const ip = await hashIp(clientIp(req));
    const { data } = await svc.rpc('job_application_rate_hit', {
      p_ip_hash: ip, p_kind: 'experience', p_max: max, p_window_seconds: windowSeconds,
    });
    return data !== false; // fail-open: a rate error must not block a real candidate
  } catch {
    return true;
  }
}

export default async function handler(req: Request): Promise<Response> {
  const svc = makeServiceClient('api:careers-experience');
  if (!svc) return jsonError(500, 'service client unavailable');

  if (req.method === 'GET') {
    const token = (new URL(req.url).searchParams.get('token') ?? '').trim();
    if (!token) return jsonError(400, 'token is required');
    if (!(await underLimit(svc, req, 60, 60))) return jsonError(429, 'too many requests');
    const { data, error } = await svc
      .from('job_applications')
      .select('full_name, phone, status, experience_decision')
      .eq('invite_token', token)
      .maybeSingle();
    if (error) return jsonError(500, error.message);
    if (!data) return jsonError(404, 'not found');
    return jsonOk({
      name: data.full_name ?? '',
      phone: displayPhone(data.phone as string | null),
      decision: (data.experience_decision as string | null) ?? null,
      status: data.status,
    });
  }

  if (req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; action?: string; reason?: string };
    const token = (body.token ?? '').trim();
    const action = body.action ?? '';
    if (!token) return jsonError(400, 'token is required');
    if (!['confirm', 'interested', 'declined'].includes(action)) return jsonError(400, 'invalid action');
    if (!(await underLimit(svc, req, 30, 60))) return jsonError(429, 'too many requests');

    const { data: app, error } = await svc
      .from('job_applications')
      .select('id, status, experience_confirmed_at')
      .eq('invite_token', token)
      .maybeSingle();
    if (error) return jsonError(500, error.message);
    if (!app) return jsonError(404, 'not found');

    const now = new Date().toISOString();

    if (action === 'confirm') {
      if (!app.experience_confirmed_at) {
        await svc.from('job_applications').update({ experience_confirmed_at: now }).eq('id', app.id);
      }
      return jsonOk({ ok: true });
    }

    // interested / declined
    if (!DECIDABLE.has(app.status as string)) {
      return jsonError(409, 'a decision is not available for this application');
    }

    if (action === 'interested') {
      const { error: upErr } = await svc.from('job_applications').update({
        status: 'offer_accepted',
        experience_decision: 'interested',
        experience_decided_at: now,
        experience_decline_reason: null,
      }).eq('id', app.id);
      if (upErr) return jsonError(500, upErr.message);
      return jsonOk({ ok: true, decision: 'interested' });
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 2000) : '';
    const { error: upErr } = await svc.from('job_applications').update({
      status: 'offer_rejected',
      experience_decision: 'declined',
      experience_decided_at: now,
      experience_decline_reason: reason || null,
    }).eq('id', app.id);
    if (upErr) return jsonError(500, upErr.message);
    return jsonOk({ ok: true, decision: 'declined' });
  }

  return jsonError(405, `Method ${req.method} not allowed`);
}
