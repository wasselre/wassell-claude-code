/**
 * /api/portal-registration — register an interested customer in a developer's /
 * marketer's / officer's broker portal (the "Register in portal" button next to
 * "Notify officer" in a chat).
 *
 *   GET  ?client_id=<uuid>&project_id=<uuid>
 *        → { portals: [...portals covering that project, with the customer fields
 *            each one needs + values prefilled from the client record],
 *            history: [...this client's previous registration runs] }
 *   GET  ?job_id=<uuid>
 *        → { job } — the live row + signed screenshot URLs (poll fallback; the
 *          modal normally follows the row via Realtime).
 *   POST { action:'start', portal_id, client_id, project_id?, lead:{…}, login_phone? }
 *        → 202 { job_id }   (enqueue only — the Fly worker drives Browserbase)
 *   POST { action:'input', job_id, value }   → the rep typed the OTP
 *   POST { action:'cancel', job_id }         → stop the run, close the browser
 *
 * ENQUEUE-ONLY: a registration takes 1–5 minutes (sign-in, the rep's OTP, the
 * form). Nothing here waits for the browser — same rule as every other worker
 * queue in this repo. The worker pauses on `request_input` steps and reads the
 * rep's answer off the job row; this endpoint is how the answer gets there.
 *
 * Auth: withAuth (Supabase JWT). The caller must be able to SEE the client
 * record under RLS before anything is enqueued (assertCanAccessRecord).
 * Portal records are internal configuration (like project officers) and are
 * read with the service client. Job rows are owner-scoped: input/cancel RPCs
 * check user_id = caller, and the GET reads through the owner's own RLS.
 *
 * Portal coverage rule for a project P (explicit beats inherited):
 *   P ∈ portal.projects                                   → 'project'
 *   portal.officers ∩ officers covering P ≠ ∅              → 'officer'
 *   portal.developer == P.developer                        → 'developer'
 *   portal.marketer  == P.marketer                         → 'marketer'
 */

import { withAuth, jsonOk, jsonError, assertCanAccessRecord, AuthError } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';
import {
  type Svc, type Rec,
  str, parseFields, checkRecipe, loadRecord, resolvePortals, wakeWorker,
} from './_lib/leadPortals.js';

export const config = { runtime: 'edge' };

const BUCKET = 'portal-registrations';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JobRow = {
  id: string;
  portal_record_id: string;
  client_record_id: string;
  project_record_id: string | null;
  status: string;
  phase: string | null;
  phase_ar: string | null;
  phase_en: string | null;
  input_request: Record<string, unknown> | null;
  input_requested_at: string | null;
  live_view_url: string | null;
  screenshots: { path: string; label: string; at: string }[] | null;
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

/** Sign the screenshot paths so the modal can render them (private bucket). */
async function withSignedScreenshots(svc: Svc, job: JobRow): Promise<JobRow & { screenshot_urls: { label: string; url: string; at: string }[] }> {
  const shots = Array.isArray(job.screenshots) ? job.screenshots : [];
  if (shots.length === 0) return { ...job, screenshot_urls: [] };
  const { data, error } = await svc.storage.from(BUCKET).createSignedUrls(shots.map((s) => s.path), 3600);
  if (error) {
    console.error(`[portal-registration] sign screenshots failed: ${error.message}`);
    return { ...job, screenshot_urls: [] };
  }
  const byPath = new Map((data ?? []).map((d) => [d.path, d.signedUrl] as const));
  return {
    ...job,
    screenshot_urls: shots
      .map((s) => ({ label: s.label, at: s.at, url: byPath.get(s.path) ?? '' }))
      .filter((s) => !!s.url),
  };
}

export default async function handler(req: Request): Promise<Response> {
  return withAuth(req, async (user) => {
    const svc = makeServiceClient('api:portal-registration');
    if (!svc) return jsonError(500, 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    try {
      if (req.method === 'GET') {
        const url = new URL(req.url);
        const jobId = url.searchParams.get('job_id');
        if (jobId) {
          if (!UUID_RE.test(jobId)) return jsonError(400, 'invalid job_id');
          const { data, error } = await svc
            .from('portal_registration_jobs')
            .select('id, portal_record_id, client_record_id, project_record_id, status, phase, phase_ar, phase_en, input_request, input_requested_at, live_view_url, screenshots, result, error_message, created_at, started_at, finished_at, user_id')
            .eq('id', jobId)
            .maybeSingle();
          if (error) return jsonError(500, `job read failed: ${error.message}`);
          const row = data as (JobRow & { user_id: string }) | null;
          if (!row || row.user_id !== user.userId) return jsonError(404, 'job not found');
          const { user_id: _omit, ...job } = row;
          return jsonOk({ job: await withSignedScreenshots(svc, job) });
        }

        const clientId = url.searchParams.get('client_id') ?? '';
        const projectId = url.searchParams.get('project_id') ?? '';
        if (!UUID_RE.test(clientId)) return jsonError(400, 'client_id is required');
        await assertCanAccessRecord(req, clientId, 'api:portal-registration');
        const [client, project] = await Promise.all([
          loadRecord(svc, clientId),
          UUID_RE.test(projectId) ? loadRecord(svc, projectId) : Promise.resolve(null),
        ]);
        if (!client) return jsonError(404, 'client not found');

        const { data: uRow } = await svc.from('users').select('name_ar, name_en, phone').eq('auth_uid', user.userId).maybeSingle();
        const u = (uRow ?? {}) as { name_ar?: unknown; name_en?: unknown; phone?: unknown };
        const caller = { email: user.email, name: str(u.name_ar) || str(u.name_en), phone: str(u.phone) };
        const portals = project ? await resolvePortals(svc, client, project, caller) : [];

        const { data: hist } = await svc
          .from('portal_registration_jobs')
          .select('id, portal_record_id, project_record_id, status, error_message, created_at, finished_at, user_id, origin')
          .eq('client_record_id', clientId)
          .order('created_at', { ascending: false })
          .limit(20);
        const portalNames = new Map<string, string>();
        const histRows = (hist ?? []) as { id: string; portal_record_id: string; project_record_id: string | null; status: string; error_message: string | null; created_at: string; finished_at: string | null; user_id: string; origin: string | null }[];
        const missing = [...new Set(histRows.map((h) => h.portal_record_id))].filter((id) => !portals.some((p) => p.id === id));
        for (const p of portals) portalNames.set(p.id, p.name);
        if (missing.length) {
          const { data: extra } = await svc.from('unified_records').select('id, data').in('id', missing);
          for (const r of (extra ?? []) as Rec[]) portalNames.set(r.id, str(r.data?.name) || '—');
        }
        const history = histRows.map((h) => ({
          id: h.id,
          portal_record_id: h.portal_record_id,
          portal_name: portalNames.get(h.portal_record_id) ?? '—',
          project_record_id: h.project_record_id,
          status: h.status,
          error_message: h.error_message,
          created_at: h.created_at,
          finished_at: h.finished_at,
          mine: h.user_id === user.userId,
          origin: h.origin === 'auto' ? 'auto' : 'manual',
        }));

        return jsonOk({ portals, history });
      }

      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as {
          action?: string;
          portal_id?: string;
          client_id?: string;
          project_id?: string | null;
          lead?: Record<string, unknown>;
          login_phone?: string | null;
          job_id?: string;
          value?: string;
        };

        if (body.action === 'start') {
          const portalId = body.portal_id ?? '';
          const clientId = body.client_id ?? '';
          const projectId = body.project_id && UUID_RE.test(body.project_id) ? body.project_id : null;
          if (!UUID_RE.test(portalId)) return jsonError(400, 'portal_id is required');
          if (!UUID_RE.test(clientId)) return jsonError(400, 'client_id is required');
          await assertCanAccessRecord(req, clientId, 'api:portal-registration');

          const portal = await loadRecord(svc, portalId);
          if (!portal) return jsonError(404, 'portal not found');
          const pd = portal.data ?? {};
          if (pd.is_active === false) return jsonError(409, 'this portal is inactive');
          const recipe = checkRecipe(pd.recipe);
          if (!recipe.ok) return jsonError(409, `portal recipe is not runnable: ${recipe.error}`);

          // Validate the collected fields against what the portal declares.
          const { fields } = parseFields(pd.required_fields);
          const lead: Record<string, string> = {};
          for (const f of fields) {
            const v = str((body.lead ?? {})[f.key]).trim();
            if (f.required && !v) return jsonError(400, `missing required field: ${f.key}`);
            if (v) lead[f.key] = v;
          }
          // Keep any extra keys the modal sent (project_name etc.) as plain strings.
          for (const [k, v] of Object.entries(body.lead ?? {})) {
            if (!(k in lead) && typeof v === 'string' && v.trim()) lead[k] = v.trim();
          }

          const loginPhone = str(body.login_phone).trim() || str(pd.login_phone).trim() || null;

          const { data: jobId, error: enqErr } = await svc.rpc('portal_registration_job_enqueue', {
            p_portal_record_id: portalId,
            p_client_record_id: clientId,
            p_project_record_id: projectId,
            p_user_id: user.userId,
            p_lead_data: lead,
            p_login_phone: loginPhone,
          });
          if (enqErr || !jobId) return jsonError(500, `failed to enqueue: ${enqErr?.message ?? 'unknown'}`);
          console.log(`[portal-registration] queued job=${jobId} portal=${portalId} client=${clientId} user=${user.userId}`);
          void wakeWorker(jobId as string);
          return jsonOk({ job_id: jobId }, 202);
        }

        if (body.action === 'input') {
          const jobId = body.job_id ?? '';
          const value = str(body.value).trim();
          if (!UUID_RE.test(jobId)) return jsonError(400, 'job_id is required');
          if (!value) return jsonError(400, 'value is required');
          const { data: ok, error } = await svc.rpc('portal_registration_job_submit_input', {
            p_job_id: jobId, p_user_id: user.userId, p_value: value,
          });
          if (error) return jsonError(500, `submit failed: ${error.message}`);
          if (ok !== true) return jsonError(409, 'this job is not waiting for input (or is not yours)');
          return jsonOk({ ok: true });
        }

        if (body.action === 'cancel') {
          const jobId = body.job_id ?? '';
          if (!UUID_RE.test(jobId)) return jsonError(400, 'job_id is required');
          const { data: ok, error } = await svc.rpc('portal_registration_job_cancel', {
            p_job_id: jobId, p_user_id: user.userId,
          });
          if (error) return jsonError(500, `cancel failed: ${error.message}`);
          return jsonOk({ ok: ok === true });
        }

        return jsonError(400, 'unknown action');
      }

      return jsonError(405, `Method ${req.method} not allowed`);
    } catch (err) {
      if (err instanceof AuthError) return jsonError(err.status, err.message);
      return jsonError(500, err instanceof Error ? err.message : String(err));
    }
  });
}
