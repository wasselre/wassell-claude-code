/**
 * High interest → make sure the project's company has the client in its broker
 * portal. The ONE automatic action of the AI sales automation (operator,
 * 2026-10-04: "everything else goes to the AI tab, except registering in
 * portals").
 *
 * For every covering portal whose `auto_register` switch is on:
 *   · the client is already registered in that portal (any project) → COVERED.
 *     A registration with a company covers ALL its projects, and the portals
 *     refuse a phone they already hold, so there is nothing more to send;
 *   · a run for the pair is already live → IN PROGRESS;
 *   · an earlier INTEREST run for the pair exists → not tried again, UNLESS it
 *     failed because the portal or the browser misbehaved (a timeout…): then
 *     it is retried ≥ 20 min later, up to 3 interest attempts (interestRetry);
 *   · otherwise a run is queued exactly like the ad sweep's (origin 'auto' so
 *     the OTP relay works, owner = the client's owner), tagged with interest_id.
 *
 * STRICT PROJECT (unless the field says `allow_unlisted`): the portal's
 * project field must match this project. A
 * project missing from the portal's list is NOT sent under the portal's
 * default project (how seven «ريا النخيل» clients reached Al Ramz as
 * «تل الربوة 1»); a failed row names the gap instead.
 *
 * Shares resolvePortals / prefillField with the button and the ad sweep, so
 * coverage and prefill stay identical. Never raises; returns one outcome per
 * portal for the event's portal_result.
 */
import {
  type Rec, type Svc, idList, str, loadRecord, resolvePortals, prefillField, wakeWorker, isAlreadyRegisteredError,
} from './leadPortals.js';

export type PortalOutcome =
  | { portal_id: string; portal: string; status: 'queued'; job_id: string; parked: boolean }
  | { portal_id: string; portal: string; status: 'covered' | 'in_progress' | 'interest_attempt_used' | 'retry_later' | 'skipped' | 'failed'; reason?: string };

export interface InterestRegistration {
  status: 'done' | 'no_portal' | 'missing_record';
  portals: PortalOutcome[];
}

const LIVE = ['queued', 'running', 'awaiting_input'];

interface JobRow { id: string; status: string; interest_id: string | null; error_message: string | null; finished_at: string | null }

/** Interest attempts per client × portal, counting the first. */
export const MAX_INTEREST_ATTEMPTS = 3;
/** A failed attempt is retried no sooner than this. */
export const RETRY_AFTER_MS = 20 * 60_000;

/**
 * The portal or the browser misbehaved — not something about the client or the
 * project. 2026-10-04: Riva's new-client form did not open within 30 s for one
 * client, and the same recipe registered the next client 4 minutes later; the
 * first client was never tried again. A missing project / missing fields row
 * (written by this file, «لم يُسجَّل…») is NOT transient.
 */
export function isTransientPortalFailure(message: string | null): boolean {
  const m = message ?? '';
  if (!m || m.startsWith('لم يُسجَّل')) return false;
  return /timeout|timed out|net::err|target (page|closed)|browser has been closed|session (closed|expired)|econnreset|socket hang up|navigation failed/i.test(m);
}

/**
 * May an interest registration run again for this client × portal?
 *   'go'    — no interest attempt yet, or only transient failures, the last one
 *             long enough ago, and fewer than MAX_INTEREST_ATTEMPTS;
 *   'later' — the last transient failure is too recent;
 *   'used'  — an attempt finished (any non-failed status), a failure was NOT
 *             transient, or the attempts are used up.
 */
export function interestRetry(interestJobs: readonly JobRow[], now = Date.now()): 'go' | 'later' | 'used' {
  if (interestJobs.length === 0) return 'go';
  if (interestJobs.length >= MAX_INTEREST_ATTEMPTS) return 'used';
  if (interestJobs.some((j) => j.status !== 'failed' || !isTransientPortalFailure(j.error_message))) return 'used';
  const last = Math.max(...interestJobs.map((j) => (j.finished_at ? Date.parse(j.finished_at) : now)));
  return now - last < RETRY_AFTER_MS ? 'later' : 'go';
}

export async function registerOnInterest(
  svc: Svc,
  args: { interestId: string; clientId: string; projectId: string; autoPortalRows: Rec[] },
): Promise<InterestRegistration> {
  const [client, project] = await Promise.all([loadRecord(svc, args.clientId), loadRecord(svc, args.projectId)]);
  if (!client || !project) return { status: 'missing_record', portals: [] };

  // Owner = the client's owner, as if they had pressed the button.
  const ownerUsersId = idList(client.data?.client_owner)[0] ?? null;
  let owner: { auth_uid: string; name: string; email: string; phone: string } | null = null;
  if (ownerUsersId) {
    const { data: u, error: uErr } = await svc
      .from('users').select('auth_uid, name_ar, name_en, email, phone').eq('id', ownerUsersId).maybeSingle();
    if (uErr) throw new Error(`owner lookup failed: ${uErr.message}`);
    const row = u as { auth_uid?: string | null; name_ar?: unknown; name_en?: unknown; email?: unknown; phone?: unknown } | null;
    if (row?.auth_uid) owner = { auth_uid: row.auth_uid, name: str(row.name_ar) || str(row.name_en), email: str(row.email), phone: str(row.phone) };
  }
  const user = { email: owner?.email ?? '', name: owner?.name ?? '', phone: owner?.phone ?? '' };

  const portals = (await resolvePortals(svc, client, project, user)).filter((p) => p.auto_register);
  if (portals.length === 0) return { status: 'no_portal', portals: [] };

  const out: PortalOutcome[] = [];
  for (const portal of portals) {
    const base = { portal_id: portal.id, portal: portal.name };

    const { data: reg, error: regErr } = await svc
      .from('client_portal_registrations')
      .select('our_status')
      .eq('client_record_id', args.clientId)
      .eq('portal_record_id', portal.id)
      .maybeSingle();
    if (regErr) throw new Error(`registration lookup failed: ${regErr.message}`);
    const ourStatus = str((reg as { our_status?: unknown } | null)?.our_status);
    if (ourStatus === 'registered' || ourStatus === 'already_registered') {
      out.push({ ...base, status: 'covered' });
      continue;
    }

    const { data: jobs, error: jobsErr } = await svc
      .from('portal_registration_jobs')
      .select('id, status, interest_id, error_message, finished_at')
      .eq('client_record_id', args.clientId)
      .eq('portal_record_id', portal.id);
    if (jobsErr) throw new Error(`existing-job check failed: ${jobsErr.message}`);
    const rows = (jobs ?? []) as JobRow[];
    if (rows.some((j) => LIVE.includes(j.status))) { out.push({ ...base, status: 'in_progress' }); continue; }
    const again = interestRetry(rows.filter((j) => j.interest_id));
    if (again === 'used') { out.push({ ...base, status: 'interest_attempt_used' }); continue; }
    if (again === 'later') { out.push({ ...base, status: 'retry_later' }); continue; }

    if (portal.otp_channel && portal.otp_channel !== 'none' && !portal.otp_whatsapp_relay) {
      const reason = `portal "${portal.name}" needs a ${portal.otp_channel} code and has no WhatsApp code relay`;
      console.error(`[portal-interest] ${reason}`);
      out.push({ ...base, status: 'skipped', reason });
      continue;
    }
    if (!portal.recipe_ok) {
      const reason = `portal "${portal.name}" recipe is not runnable: ${portal.recipe_error ?? 'unknown'}`;
      console.error(`[portal-interest] ${reason}`);
      out.push({ ...base, status: 'skipped', reason });
      continue;
    }

    let jobOwner = owner?.auth_uid ?? null;
    const loginEmail = str(args.autoPortalRows.find((p) => p.id === portal.id)?.data?.login_email).trim();
    if (!jobOwner && loginEmail) {
      const { data: u, error: lErr } = await svc.from('users').select('auth_uid').eq('email', loginEmail).maybeSingle();
      if (lErr) throw new Error(`portal sign-in user lookup failed: ${lErr.message}`);
      jobOwner = (u as { auth_uid?: string | null } | null)?.auth_uid ?? null;
    }
    if (!jobOwner) {
      const reason = 'the client has no owner and the portal signs in as no CRM user';
      console.error(`[portal-interest] client=${args.clientId} portal=${portal.id}: ${reason}`);
      out.push({ ...base, status: 'skipped', reason });
      continue;
    }

    // The lead, exactly as the modal would prefill it — except that a project
    // field never falls back to the portal's default project, unless the
    // portal says it accepts a stand-in (`allow_unlisted`).
    const lead: Record<string, string> = {};
    const missing: string[] = [];
    let projectGap = false;
    const ctx = { client: client.data ?? {}, project: project.data ?? {}, user };
    for (const f of portal.fields) {
      const isProjectField = (f.source ?? '').startsWith('project.');
      // allow_unlisted (Al Ramz, 2026-10-05): the portal takes its default
      // project and the notes carry the real one — the operator's rule.
      const strict = isProjectField && !f.allow_unlisted;
      const v = (strict ? prefillField({ ...f, default: undefined }, ctx) : (portal.prefill[f.key] ?? '')).trim();
      if (v) lead[f.key] = v;
      else if (f.required) { missing.push(f.key); if (strict) projectGap = true; }
    }
    const projectName = str(project.data?.project_name);
    if (projectName) lead.project_name = projectName;

    if (missing.length > 0) {
      const labels = portal.fields.filter((f) => missing.includes(f.key));
      const errAr = projectGap
        ? `لم يُسجَّل العميل — المشروع «${projectName || '—'}» غير موجود في قائمة مشاريع بوابة ${portal.name}`
        : `لم يُسجَّل العميل تلقائياً — حقول ناقصة: ${labels.map((f) => f.label_ar).join('، ')}`;
      const errEn = projectGap
        ? `Not registered — project "${projectName || '—'}" is not on the ${portal.name} project list`
        : `Automatic registration skipped — missing fields: ${labels.map((f) => f.label_en).join(', ')}`;
      const { error: insErr } = await svc.from('portal_registration_jobs').insert({
        portal_record_id: portal.id,
        client_record_id: args.clientId,
        project_record_id: args.projectId,
        user_id: jobOwner,
        status: 'failed',
        lead_data: lead,
        error_message: `${errAr}\n${errEn}`,
        origin: 'auto',
        interest_id: args.interestId,
        finished_at: new Date().toISOString(),
      });
      if (insErr) throw new Error(`failed-row insert failed: ${insErr.message}`);
      console.error(`[portal-interest] client=${args.clientId} portal=${portal.id}: ${errEn}`);
      out.push({ ...base, status: 'failed', reason: errEn });
      continue;
    }

    // A relay portal whose phone owner has not answered an earlier code request
    // → wait with the others (same rule as the ad sweep).
    let parked = false;
    if (portal.otp_whatsapp_relay) {
      const { data: parkedRows, error: parkErr } = await svc
        .from('portal_registration_jobs').select('id')
        .eq('portal_record_id', portal.id).not('parked_at', 'is', null).eq('status', 'queued').limit(1);
      if (parkErr) console.error(`[portal-interest] parked check failed: ${parkErr.message}`);
      parked = (parkedRows ?? []).length > 0;
    }

    const { data: jobId, error: enqErr } = await svc.rpc('portal_registration_job_enqueue', {
      p_portal_record_id: portal.id,
      p_client_record_id: args.clientId,
      p_project_record_id: args.projectId,
      p_user_id: jobOwner,
      p_lead_data: lead,
      p_login_phone: portal.login_phone,
      p_origin: 'auto',
      p_attribution_id: null,
      p_parked: parked,
    });
    if (isAlreadyRegisteredError(enqErr)) { out.push({ ...base, status: 'covered' }); continue; }
    if (enqErr || !jobId) throw new Error(`enqueue failed: ${enqErr?.message ?? 'no job id'}`);
    // interest_id is bookkeeping only (the worker never reads it), so setting it
    // after the insert cannot change how the run behaves.
    const { error: tagErr } = await svc.from('portal_registration_jobs').update({ interest_id: args.interestId }).eq('id', jobId as string);
    if (tagErr) console.error(`[portal-interest] could not tag job ${jobId} with interest ${args.interestId}: ${tagErr.message}`);

    console.log(`[portal-interest] ${parked ? 'parked' : 'queued'} job=${jobId} portal=${portal.id} client=${args.clientId} project=${args.projectId}`);
    out.push({ ...base, status: 'queued', job_id: jobId as string, parked });
    if (!parked) void wakeWorker(jobId as string);
  }
  return { status: 'done', portals: out };
}
