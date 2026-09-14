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

export const config = { runtime: 'edge' };

const LEAD_PORTALS_MODEL_ID = '1ead0000-0000-4000-8000-000000000001';
const BUCKET = 'portal-registrations';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Svc = NonNullable<ReturnType<typeof makeServiceClient>>;
type Rec = { id: string; data: Record<string, unknown> };

export interface PortalFieldSpec {
  key: string;
  label_ar: string;
  label_en: string;
  type?: 'text' | 'phone' | 'email' | 'number' | 'select' | 'textarea';
  required?: boolean;
  /** Where the prefill comes from: client.<field> | project.<field> | user.<email|name> | literal:<text> */
  source?: string;
  options?: { value: string; label_ar: string; label_en: string }[];
  placeholder?: string;
  /** Translate the resolved source value (exact match) into what the portal
   *  wants — e.g. our unit-type slug → the portal's Arabic option, or a CRM
   *  project name → the portal's spelling of it. Applied before the options
   *  check. */
  map?: Record<string, string>;
  /** Prefill fallback when the source resolves to nothing. */
  default?: string;
  /** Not shown in the modal — sent with its prefilled/default value. A hidden
   *  REQUIRED field that resolves to nothing still blocks the run (the modal
   *  names it so the rep can fix the client record). */
  hidden?: boolean;
}

export interface PortalOption {
  id: string;
  name: string;
  login_url: string;
  login_phone: string | null;
  otp_channel: string | null;
  coverage: 'project' | 'officer' | 'developer' | 'marketer';
  fields: PortalFieldSpec[];
  prefill: Record<string, string>;
  recipe_ok: boolean;
  recipe_error: string | null;
}

/** Default customer fields when a portal declares none. */
const DEFAULT_FIELDS: PortalFieldSpec[] = [
  { key: 'name', label_ar: 'اسم العميل', label_en: 'Customer name', source: 'client.client_name', required: true },
  { key: 'phone', label_ar: 'رقم الجوال', label_en: 'Mobile', type: 'phone', source: 'client.phone_number', required: true },
];

/** Lookup values are stored as a target id string, an array of them, or {id}. */
function idList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && 'id' in x ? String((x as { id: unknown }).id) : ''))
      .filter(Boolean);
  }
  if (typeof v === 'string') return [v];
  if (typeof v === 'object' && v !== null && 'id' in v) return [String((v as { id: unknown }).id)];
  return [];
}

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** Parse the portal's `required_fields` (JSON text or array). Invalid → the
 *  defaults, with the parse error surfaced so the admin can fix the record. */
function parseFields(raw: unknown): { fields: PortalFieldSpec[]; error: string | null } {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return { fields: DEFAULT_FIELDS, error: null };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return { fields: DEFAULT_FIELDS, error: `required_fields is not valid JSON: ${(err as Error).message}` };
    }
  }
  if (!Array.isArray(value)) return { fields: DEFAULT_FIELDS, error: 'required_fields must be a JSON array' };
  const fields: PortalFieldSpec[] = [];
  for (const f of value) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const key = str(o.key).trim();
    if (!key) continue;
    fields.push({
      key,
      label_ar: str(o.label_ar) || key,
      label_en: str(o.label_en) || key,
      type: (['text', 'phone', 'email', 'number', 'select', 'textarea'] as const).find((t) => t === o.type) ?? 'text',
      required: o.required !== false,
      source: str(o.source) || undefined,
      options: Array.isArray(o.options)
        ? (o.options as unknown[])
            .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : null))
            .filter((x): x is Record<string, unknown> => !!x)
            .map((x) => ({ value: str(x.value), label_ar: str(x.label_ar) || str(x.value), label_en: str(x.label_en) || str(x.value) }))
        : undefined,
      placeholder: str(o.placeholder) || undefined,
      map:
        o.map && typeof o.map === 'object' && !Array.isArray(o.map)
          ? Object.fromEntries(Object.entries(o.map as Record<string, unknown>).map(([k, v]) => [k, str(v)]))
          : undefined,
      default: str(o.default) || undefined,
      hidden: o.hidden === true,
    });
  }
  return { fields: fields.length ? fields : DEFAULT_FIELDS, error: null };
}

/** A record value → the string a form wants. Arrays (multiselect / multi
 *  lookup) → their first string; {min,max} ranges → "min - max" with thousands
 *  separators (the shape portals ask budgets in); scalars → as-is. */
function valueToText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === 'string' && x.trim()) ?? v[0];
    return typeof first === 'string' ? first : str(first);
  }
  if (typeof v === 'object') {
    const o = v as { min?: unknown; max?: unknown };
    if ('min' in o || 'max' in o) {
      const fmt = (n: unknown) => (typeof n === 'number' ? n.toLocaleString('en-US') : str(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
      const lo = o.min != null && o.min !== '' ? fmt(o.min) : '';
      const hi = o.max != null && o.max !== '' ? fmt(o.max) : '';
      return lo && hi ? `${lo} - ${hi}` : lo || hi;
    }
    return '';
  }
  return str(v);
}

/** Prefill one field: source → map → (select) option match → default. */
function prefillField(
  f: PortalFieldSpec,
  ctx: { client: Record<string, unknown>; project: Record<string, unknown>; user: { email: string; name: string; phone: string } },
): string {
  let v = resolveSource(f.source, ctx);
  if (v && f.map && f.map[v] != null) v = f.map[v]!;
  if (f.type === 'select' && f.options?.length) {
    if (v && !f.options.some((o) => o.value === v)) {
      const byLabel = f.options.find((o) => o.label_ar === v || o.label_en === v);
      v = byLabel ? byLabel.value : '';
    }
  }
  return v || f.default || '';
}

/** Light recipe check (the worker does the deep one): non-empty JSON array of
 *  objects with a string `do`. Lets the modal grey out a portal whose recipe is
 *  missing/broken instead of burning a Browserbase session to find out. */
function checkRecipe(raw: unknown): { ok: boolean; error: string | null } {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return { ok: false, error: 'no recipe yet' };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `recipe is not valid JSON: ${(err as Error).message}` };
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { steps?: unknown }).steps)) {
    value = (value as { steps: unknown[] }).steps;
  }
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'recipe must be a non-empty array of steps' };
  const bad = value.findIndex((s) => !s || typeof s !== 'object' || typeof (s as { do?: unknown }).do !== 'string');
  if (bad >= 0) return { ok: false, error: `step ${bad} has no "do"` };
  return { ok: true, error: null };
}

/** Resolve a prefill `source` against the client / project / caller. */
function resolveSource(
  source: string | undefined,
  ctx: { client: Record<string, unknown>; project: Record<string, unknown>; user: { email: string; name: string; phone: string } },
): string {
  if (!source) return '';
  if (source.startsWith('literal:')) return source.slice('literal:'.length);
  const [root, ...rest] = source.split('.');
  const path = rest.join('.');
  if (root === 'client') return valueToText(ctx.client[path]);
  if (root === 'project') return valueToText(ctx.project[path]);
  if (root === 'user') return path === 'email' ? ctx.user.email : path === 'name' ? ctx.user.name : path === 'phone' ? ctx.user.phone : '';
  return '';
}

async function loadRecord(svc: Svc, id: string | null): Promise<Rec | null> {
  if (!id) return null;
  const { data, error } = await svc.from('unified_records').select('id, data').eq('id', id).maybeSingle();
  if (error) throw new Error(`record load failed: ${error.message}`);
  return (data as Rec | null) ?? null;
}

/** Ids of officers covering a project — the same rule as /api/whatsapp/notify-officer. */
async function coveringOfficerIds(svc: Svc, projectId: string, developerId: string | null, marketerId: string | null): Promise<Set<string>> {
  const { data: m } = await svc.from('models').select('id').eq('name', 'project_officers').maybeSingle();
  const officersModelId = (m as { id: string } | null)?.id;
  if (!officersModelId) return new Set();
  const { data: rows } = await svc.from('unified_records').select('id, data').eq('model_id', officersModelId);
  const out = new Set<string>();
  for (const o of (rows ?? []) as Rec[]) {
    const d = o.data ?? {};
    if (d.is_active === false) continue;
    const projs = idList(d.projects);
    const offDev = idList(d.developer)[0] ?? null;
    const offMkt = idList(d.marketer)[0] ?? null;
    if (projs.includes(projectId)) out.add(o.id);
    else if (projs.length === 0 && ((offDev && offDev === developerId) || (offMkt && offMkt === marketerId))) out.add(o.id);
  }
  return out;
}

async function resolvePortals(
  svc: Svc,
  client: Rec,
  project: Rec | null,
  user: { email: string; name: string; phone: string },
): Promise<PortalOption[]> {
  const { data: rows, error } = await svc
    .from('unified_records')
    .select('id, data')
    .eq('model_id', LEAD_PORTALS_MODEL_ID);
  if (error) throw new Error(`portals load failed: ${error.message}`);
  const portals = ((rows ?? []) as Rec[]).filter((p) => (p.data ?? {}).is_active !== false);
  if (portals.length === 0) return [];

  const pdata = project?.data ?? {};
  const developerId = idList(pdata.developer)[0] ?? null;
  const marketerId = idList(pdata.marketer)[0] ?? null;
  const officerIds = project ? await coveringOfficerIds(svc, project.id, developerId, marketerId) : new Set<string>();

  const rank: Record<PortalOption['coverage'], number> = { project: 0, officer: 1, developer: 2, marketer: 3 };
  const out: PortalOption[] = [];
  for (const p of portals) {
    const d = p.data ?? {};
    let coverage: PortalOption['coverage'] | null = null;
    if (project && idList(d.projects).includes(project.id)) coverage = 'project';
    else if (idList(d.officers).some((id) => officerIds.has(id))) coverage = 'officer';
    else if (developerId && idList(d.developer)[0] === developerId) coverage = 'developer';
    else if (marketerId && idList(d.marketer)[0] === marketerId) coverage = 'marketer';
    if (!coverage) continue;

    const { fields, error: fieldsErr } = parseFields(d.required_fields);
    const recipe = checkRecipe(d.recipe);
    const prefill: Record<string, string> = {};
    for (const f of fields) {
      const v = prefillField(f, { client: client.data ?? {}, project: pdata, user });
      if (v) prefill[f.key] = v;
    }
    out.push({
      id: p.id,
      name: str(d.name) || '—',
      login_url: str(d.login_url),
      login_phone: str(d.login_phone) || null,
      otp_channel: str(d.otp_channel) || null,
      coverage,
      fields,
      prefill,
      recipe_ok: recipe.ok && !fieldsErr,
      recipe_error: recipe.error ?? fieldsErr,
    });
  }
  out.sort((a, b) => rank[a.coverage] - rank[b.coverage] || a.name.localeCompare(b.name));
  return out;
}

/** Best-effort wake ping so the worker skips its ~3s poll. Never blocks. */
async function wakeWorker(jobId: string): Promise<void> {
  const workerUrl = process.env.WASSEL_DECK_WORKER_URL;
  if (!workerUrl) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    await fetch(`${workerUrl.replace(/\/$/, '')}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (err) {
    console.warn(`[portal-registration] wake ping failed (non-fatal): ${(err as Error).message}`);
  }
}

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
          .select('id, portal_record_id, project_record_id, status, error_message, created_at, finished_at, user_id')
          .eq('client_record_id', clientId)
          .order('created_at', { ascending: false })
          .limit(20);
        const portalNames = new Map<string, string>();
        const histRows = (hist ?? []) as { id: string; portal_record_id: string; project_record_id: string | null; status: string; error_message: string | null; created_at: string; finished_at: string | null; user_id: string }[];
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
