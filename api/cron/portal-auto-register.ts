/**
 * GET / POST /api/cron/portal-auto-register — register ad leads in lead portals
 * without a rep pressing "Register in portal".
 *
 * Every five minutes:
 *   1. `portal_auto_register_candidates(since)` lists the recent ad touches
 *      (client_attributions — the same ledger the client profile's "where did
 *      they come from" panel reads) with the project their ad's campaign is for.
 *   2. For each, the portals covering that project are resolved with the SAME
 *      rule and the SAME field prefill as the button (`api/_lib/leadPortals.ts`).
 *   3. Every covering portal whose `auto_register` switch is on gets ONE
 *      portal_registration_jobs row (origin='auto'), owned by the client's
 *      owner. The Fly worker runs it exactly like a button-started run.
 *
 * Rules:
 *   - ONE attempt per (client, portal), ever. If ANY job already exists for the
 *     pair — manual or auto, done or failed — the sweep leaves it alone. A
 *     failed auto run is visible in the client's portal history and a rep can
 *     retry it from the button; the sweep never loops on a broken portal.
 *   - A portal that needs a code (otp_channel ≠ none) runs automatically ONLY
 *     when its `otp_whatsapp_relay` switch is on: the worker then asks for the
 *     code on the operations WhatsApp and the reply is fed back by the WAHA
 *     webhook (see 2026-09-24_01_portal_otp_whatsapp_relay.sql). Without the
 *     relay nobody is there to type the code — skipped + console.error.
 *   - While a relay portal has a PARKED run (the phone owner has not answered
 *     yet), new runs for it are parked on arrival: the owner's next reply
 *     restarts them all, instead of each lead pinging them again.
 *   - A lead missing a required field (e.g. no phone) gets a FAILED job row
 *     naming the field, so the gap shows in the client's history instead of
 *     the lead silently never reaching the portal.
 *   - Only touches created in the last LOOKBACK_HOURS are considered, so
 *     turning a portal on never back-fills its whole history of old leads.
 *
 * Auth: Bearer $CRON_SECRET or ?secret= for smoke tests. Always 200 once
 * authorised so Vercel never marks the cron failed; the body carries every
 * outcome and failures are also console.error-ed.
 */
import { makeServiceClient } from '../_lib/serviceClient.js';
import {
  LEAD_PORTALS_MODEL_ID, type Rec, idList, str, loadRecord, resolvePortals, wakeWorker,
} from '../_lib/leadPortals.js';

export const config = { runtime: 'edge' };

/** How far back a new ad touch is still picked up. Covers missed ticks without
 *  ever reaching back into history when a portal is first switched on. */
const LOOKBACK_HOURS = 3;
/** Jobs enqueued per tick at most — a burst drains over the next ticks. */
const MAX_ENQUEUE_PER_TICK = 20;

interface Candidate {
  attribution_id: string;
  client_record_id: string;
  project_record_id: string;
  campaign_id: string | null;
  occurred_at: string;
  created_at: string;
}

type Outcome =
  | { status: 'queued'; job_id: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default async function handler(req: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) return json({ error: 'CRON_SECRET is not set; refusing to run' }, 500);
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) return json({ error: 'unauthorized' }, 401);

  const svc = makeServiceClient('api:cron:portal-auto-register');
  if (!svc) return json({ error: 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY' }, 500);

  const results: { attribution_id: string; client_id: string; project_id: string; portal_id?: string; outcome: Outcome }[] = [];
  try {
    // Nothing to do unless at least one active portal is switched on.
    const { data: portalRows, error: portalErr } = await svc
      .from('unified_records')
      .select('id, data')
      .eq('model_id', LEAD_PORTALS_MODEL_ID);
    if (portalErr) throw new Error(`portals load failed: ${portalErr.message}`);
    const autoPortals = ((portalRows ?? []) as Rec[]).filter(
      (p) => p.data?.auto_register === true && p.data?.is_active !== false,
    );
    if (autoPortals.length === 0) return json({ ok: true, auto_portals: 0, results }, 200);

    const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();
    const { data: candRows, error: candErr } = await svc.rpc('portal_auto_register_candidates', { p_since: since });
    if (candErr) throw new Error(`candidates failed: ${candErr.message}`);
    const candidates = (candRows ?? []) as Candidate[];

    // A client can have a first AND a last touch for the same project; handle
    // each (client, project) once per tick.
    const seen = new Set<string>();
    let enqueued = 0;

    for (const c of candidates) {
      if (enqueued >= MAX_ENQUEUE_PER_TICK) break;
      const pairKey = `${c.client_record_id}:${c.project_record_id}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const [client, project] = await Promise.all([
        loadRecord(svc, c.client_record_id),
        loadRecord(svc, c.project_record_id),
      ]);
      if (!client || !project) continue; // deleted since the touch — nothing to register

      // Owner = the client's owner (the rep the lead was assigned to), as if
      // they had pressed the button. Falls back to the user the portal signs in as.
      const ownerUsersId = idList(client.data?.client_owner)[0] ?? null;
      let owner: { auth_uid: string; name: string; email: string; phone: string } | null = null;
      if (ownerUsersId) {
        const { data: u } = await svc
          .from('users')
          .select('auth_uid, name_ar, name_en, email, phone')
          .eq('id', ownerUsersId)
          .maybeSingle();
        const row = u as { auth_uid?: string | null; name_ar?: unknown; name_en?: unknown; email?: unknown; phone?: unknown } | null;
        if (row?.auth_uid) {
          owner = { auth_uid: row.auth_uid, name: str(row.name_ar) || str(row.name_en), email: str(row.email), phone: str(row.phone) };
        }
      }

      const portals = (await resolvePortals(svc, client, project, {
        email: owner?.email ?? '',
        name: owner?.name ?? '',
        phone: owner?.phone ?? '',
      })).filter((p) => p.auto_register);

      for (const portal of portals) {
        if (enqueued >= MAX_ENQUEUE_PER_TICK) break;
        const base = { attribution_id: c.attribution_id, client_id: c.client_record_id, project_id: c.project_record_id, portal_id: portal.id };

        // One attempt per (client, portal), ever.
        const { data: existing, error: exErr } = await svc
          .from('portal_registration_jobs')
          .select('id')
          .eq('client_record_id', c.client_record_id)
          .eq('portal_record_id', portal.id)
          .limit(1);
        if (exErr) throw new Error(`existing-job check failed: ${exErr.message}`);
        if ((existing ?? []).length > 0) continue;

        if (portal.otp_channel && portal.otp_channel !== 'none' && !portal.otp_whatsapp_relay) {
          const reason = `portal "${portal.name}" needs a ${portal.otp_channel} code and has no WhatsApp code relay — it cannot run unattended; turn otp_whatsapp_relay on or auto_register off`;
          console.error(`[portal-auto-register] ${reason}`);
          results.push({ ...base, outcome: { status: 'skipped', reason } });
          continue;
        }
        if (!portal.recipe_ok) {
          const reason = `portal "${portal.name}" recipe is not runnable: ${portal.recipe_error ?? 'unknown'}`;
          console.error(`[portal-auto-register] ${reason}`);
          results.push({ ...base, outcome: { status: 'skipped', reason } });
          continue;
        }

        let jobOwner = owner?.auth_uid ?? null;
        const loginEmail = str(autoPortals.find((p) => p.id === portal.id)?.data?.login_email).trim();
        if (!jobOwner && loginEmail) {
          // No client owner yet: the CRM user the portal signs in as.
          const { data: u } = await svc.from('users').select('auth_uid').eq('email', loginEmail).maybeSingle();
          jobOwner = (u as { auth_uid?: string | null } | null)?.auth_uid ?? null;
        }
        if (!jobOwner) {
          const reason = `client ${c.client_record_id} has no owner and portal "${portal.name}" signs in as no CRM user — no one to own the run`;
          console.error(`[portal-auto-register] ${reason}`);
          results.push({ ...base, outcome: { status: 'failed', reason } });
          continue;
        }

        // Build the lead exactly as the modal would with no rep edits.
        const lead: Record<string, string> = {};
        const missing: string[] = [];
        for (const f of portal.fields) {
          const v = (portal.prefill[f.key] ?? '').trim();
          if (v) lead[f.key] = v;
          else if (f.required) missing.push(f.key);
        }
        const projectName = str(project.data?.project_name);
        if (projectName) lead.project_name = projectName;

        if (missing.length > 0) {
          // Leave a visible failed row so the gap shows in the client's portal
          // history (and so the next tick does not try again).
          const labels = portal.fields.filter((f) => missing.includes(f.key));
          const errAr = `لم يُسجَّل العميل تلقائياً — حقول ناقصة: ${labels.map((f) => f.label_ar).join('، ')}`;
          const errEn = `Automatic registration skipped — missing fields: ${labels.map((f) => f.label_en).join(', ')}`;
          const now = new Date().toISOString();
          const { error: insErr } = await svc.from('portal_registration_jobs').insert({
            portal_record_id: portal.id,
            client_record_id: c.client_record_id,
            project_record_id: c.project_record_id,
            user_id: jobOwner,
            status: 'failed',
            lead_data: lead,
            error_message: `${errAr}\n${errEn}`,
            origin: 'auto',
            attribution_id: c.attribution_id,
            finished_at: now,
          });
          if (insErr) throw new Error(`failed-row insert failed: ${insErr.message}`);
          console.error(`[portal-auto-register] client=${c.client_record_id} portal=${portal.id}: ${errEn}`);
          results.push({ ...base, outcome: { status: 'failed', reason: errEn } });
          continue;
        }

        const { data: jobId, error: enqErr } = await svc.rpc('portal_registration_job_enqueue', {
          p_portal_record_id: portal.id,
          p_client_record_id: c.client_record_id,
          p_project_record_id: c.project_record_id,
          p_user_id: jobOwner,
          p_lead_data: lead,
          p_login_phone: portal.login_phone,
        });
        if (enqErr || !jobId) throw new Error(`enqueue failed: ${enqErr?.message ?? 'no job id'}`);
        // The phone owner has not answered an earlier code request for this
        // portal → wait with the others; their next reply restarts every one.
        let parkedAt: string | null = null;
        if (portal.otp_whatsapp_relay) {
          const { data: parked, error: parkErr } = await svc
            .from('portal_registration_jobs')
            .select('id')
            .eq('portal_record_id', portal.id)
            .not('parked_at', 'is', null)
            .eq('status', 'queued')
            .limit(1);
          if (parkErr) console.error(`[portal-auto-register] parked check failed: ${parkErr.message}`);
          if ((parked ?? []).length > 0) parkedAt = new Date().toISOString();
        }
        const { error: tagErr } = await svc
          .from('portal_registration_jobs')
          .update({
            origin: 'auto',
            attribution_id: c.attribution_id,
            ...(parkedAt ? {
              parked_at: parkedAt,
              phase: 'parked',
              phase_ar: 'بانتظار الرد على واتساب العمليات لطلب رمز جديد',
              phase_en: 'Waiting for a reply on the ops WhatsApp to request a new code',
            } : {}),
          })
          .eq('id', jobId as string);
        if (tagErr) console.error(`[portal-auto-register] tagging job=${jobId} as auto failed: ${tagErr.message}`);

        console.log(`[portal-auto-register] ${parkedAt ? 'parked' : 'queued'} job=${jobId} portal=${portal.id} client=${c.client_record_id} project=${c.project_record_id}`);
        results.push({ ...base, outcome: { status: 'queued', job_id: jobId as string } });
        enqueued += 1;
        if (!parkedAt) void wakeWorker(jobId as string);
      }
    }

    return json({ ok: true, auto_portals: autoPortals.length, candidates: candidates.length, enqueued, results }, 200);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[portal-auto-register] sweep failed: ${msg}`);
    return json({ ok: false, error: msg, results }, 200);
  }
}
