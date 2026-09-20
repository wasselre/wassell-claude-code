/**
 * PUBLIC, token-authed endpoint for the per-candidate recruitment experience.
 *
 *   GET  ?token=<invite_token>
 *        → { name, phone, decision, status }  (for the confirm screen)
 *   POST { token, action:'confirm'|'interested'|'declined'|'stage', reason?, stage? }
 *        → records the candidate's action against their job_applications row.
 *        `stage` (video|task|offer) is first-reach page telemetry.
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

/**
 * Global expiry: one cutoff in careers_settings for the whole cohort. Past it,
 * the link is dead — the page shows «لقد انتهت صلاحية الدعوة» and no action is
 * accepted. NULL = never expires. Fail-open on a read error (a settings hiccup
 * must not silently kill every live link).
 */
async function isExpired(svc: NonNullable<ReturnType<typeof makeServiceClient>>): Promise<boolean> {
  try {
    const { data } = await svc.from('careers_settings').select('experience_expires_at').eq('id', 1).maybeSingle();
    const at = data?.experience_expires_at as string | null | undefined;
    return !!at && Date.now() > new Date(at).getTime();
  } catch {
    return false;
  }
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
      expired: await isExpired(svc),
    });
  }

  if (req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { token?: string; action?: string; reason?: string; category?: string; stage?: string };
    const token = (body.token ?? '').trim();
    const action = body.action ?? '';
    if (!token) return jsonError(400, 'token is required');
    if (!['confirm', 'interested', 'declined', 'stage'].includes(action)) return jsonError(400, 'invalid action');
    if (!(await underLimit(svc, req, 60, 60))) return jsonError(429, 'too many requests');

    const { data: app, error } = await svc
      .from('job_applications')
      .select('id, status, experience_confirmed_at')
      .eq('invite_token', token)
      .maybeSingle();
    if (error) return jsonError(500, error.message);
    if (!app) return jsonError(404, 'not found');

    const now = new Date().toISOString();

    // Stage reach: which page the candidate got to (video / task / offer). Pure
    // telemetry — first-reach wins (stamp only a NULL column), and it records
    // even near the cutoff, so it runs BEFORE the expiry gate below.
    if (action === 'stage') {
      const col = body.stage === 'video' ? 'experience_video_at'
        : body.stage === 'task' ? 'experience_task_at'
        : body.stage === 'offer' ? 'experience_offer_at'
        : null;
      if (!col) return jsonError(400, 'invalid stage');
      await svc.from('job_applications').update({ [col]: now }).eq('id', app.id).is(col, null);
      return jsonOk({ ok: true });
    }

    // The link is dead past the global cutoff — accept no confirm/decision.
    if (await isExpired(svc)) return jsonError(403, 'expired');

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
    const category = ['salary', 'commission', 'other'].includes(body.category ?? '') ? body.category : null;
    const { error: upErr } = await svc.from('job_applications').update({
      status: 'offer_rejected',
      experience_decision: 'declined',
      experience_decided_at: now,
      experience_decline_category: category,
      experience_decline_reason: reason || null,
    }).eq('id', app.id);
    if (upErr) return jsonError(500, upErr.message);
    return jsonOk({ ok: true, decision: 'declined' });
  }

  return jsonError(405, `Method ${req.method} not allowed`);
}
