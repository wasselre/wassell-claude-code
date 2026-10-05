/**
 * Per-client portal registrations — the durable "this client, in this portal,
 * is in state X" records behind the client's «البوابات» tab.
 *
 * Tables (supabase/migrations/2026-09-29_client_portal_registrations.sql):
 *   client_portal_registrations        one row per (client, portal)
 *   client_portal_registration_events  its history (runs, checks, edits)
 * Both are service-role only; every function here is called from
 * api/portal-registration.ts AFTER assertCanAccessRecord on the client.
 *
 * Rows are kept current by a DB trigger on every registration run and by the
 * status-check jobs (portal_status_sync_apply); this module only adds the
 * human side: reading them, manual edits, manual entries, and "check now".
 */

import { type Svc, type Rec, str, wakeWorker, LEAD_PORTALS_MODEL_ID } from './leadPortals.js';

export const OUR_STATUSES = ['not_registered', 'registering', 'registered', 'already_registered', 'failed'] as const;
export type OurStatus = (typeof OUR_STATUSES)[number];

const OUR_STATUS_AR: Record<OurStatus, string> = {
  not_registered: 'غير مسجّل',
  registering: 'جارٍ التسجيل',
  registered: 'مسجّل',
  already_registered: 'لدى وسيط آخر',
  failed: 'فشل',
};
const OUR_STATUS_EN: Record<OurStatus, string> = {
  not_registered: 'Not registered',
  registering: 'Registering',
  registered: 'Registered',
  already_registered: "Another broker's",
  failed: 'Failed',
};

export interface RegistrationRow {
  id: string;
  client_record_id: string;
  portal_record_id: string;
  our_status: OurStatus;
  portal_status: string | null;
  portal_status_code: string | null;
  portal_status_changed_at: string | null;
  portal_ref: string | null;
  project_names: string[];
  registered_as: string[];
  registered_at: string | null;
  registered_via: string | null;
  registered_by_user_id: string | null;
  last_checked_at: string | null;
  last_job_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface RegistrationEvent {
  id: string;
  registration_id: string;
  kind: string;
  our_status: string | null;
  portal_status: string | null;
  summary_ar: string;
  summary_en: string;
  job_id: string | null;
  created_at: string;
}

export interface PortalSummary {
  id: string;
  name: string;
  is_active: boolean;
  /** The portal has a status-check recipe and checks are switched on. */
  can_check_status: boolean;
  /** Latest status check for this portal (any outcome), if one ever ran. */
  last_check: { status: string; finished_at: string | null; created_at: string; error_message: string | null } | null;
}

const EVENTS_PER_REGISTRATION = 30;

function canCheck(p: Rec): boolean {
  const d = p.data ?? {};
  return d.is_active !== false && d.status_sync_enabled === true && str(d.status_recipe).trim() !== '';
}

/** All active portals (for "add manually") + the client's rows with history. */
export async function listClientRegistrations(svc: Svc, clientId: string): Promise<{
  registrations: (RegistrationRow & { events: RegistrationEvent[] })[];
  portals: PortalSummary[];
}> {
  const [{ data: regs, error: regErr }, { data: portalRows, error: portalErr }] = await Promise.all([
    svc.from('client_portal_registrations').select('*').eq('client_record_id', clientId).order('created_at', { ascending: true }),
    svc.from('unified_records').select('id, data').eq('model_id', LEAD_PORTALS_MODEL_ID),
  ]);
  if (regErr) throw new Error(`registrations read failed: ${regErr.message}`);
  if (portalErr) throw new Error(`portals read failed: ${portalErr.message}`);
  const rows = (regs ?? []) as RegistrationRow[];
  const portals = (portalRows ?? []) as Rec[];

  let events: RegistrationEvent[] = [];
  if (rows.length) {
    const { data: ev, error: evErr } = await svc
      .from('client_portal_registration_events')
      .select('id, registration_id, kind, our_status, portal_status, summary_ar, summary_en, job_id, created_at')
      .in('registration_id', rows.map((r) => r.id))
      .order('created_at', { ascending: false })
      .limit(EVENTS_PER_REGISTRATION * rows.length);
    if (evErr) throw new Error(`registration events read failed: ${evErr.message}`);
    events = (ev ?? []) as RegistrationEvent[];
  }

  // Latest status check per portal the client is in (or could be added to).
  const checkable = portals.filter(canCheck).map((p) => p.id);
  const lastCheck = new Map<string, PortalSummary['last_check']>();
  if (checkable.length) {
    const { data: checks, error: chkErr } = await svc
      .from('portal_registration_jobs')
      .select('portal_record_id, status, finished_at, created_at, error_message')
      .eq('kind', 'status_check')
      .in('portal_record_id', checkable)
      .order('created_at', { ascending: false })
      .limit(checkable.length * 5);
    if (chkErr) throw new Error(`status-check read failed: ${chkErr.message}`);
    for (const c of (checks ?? []) as { portal_record_id: string; status: string; finished_at: string | null; created_at: string; error_message: string | null }[]) {
      if (!lastCheck.has(c.portal_record_id)) {
        lastCheck.set(c.portal_record_id, { status: c.status, finished_at: c.finished_at, created_at: c.created_at, error_message: c.error_message });
      }
    }
  }

  const byReg = new Map<string, RegistrationEvent[]>();
  for (const e of events) {
    const list = byReg.get(e.registration_id) ?? [];
    if (list.length < EVENTS_PER_REGISTRATION) list.push(e);
    byReg.set(e.registration_id, list);
  }

  return {
    registrations: rows.map((r) => ({ ...r, events: byReg.get(r.id) ?? [] })),
    portals: portals
      .map((p) => ({
        id: p.id,
        name: str(p.data?.name) || '—',
        is_active: p.data?.is_active !== false,
        can_check_status: canCheck(p),
        last_check: lastCheck.get(p.id) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar')),
  };
}

export class RegistrationInputError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function isOurStatus(v: unknown): v is OurStatus {
  return typeof v === 'string' && (OUR_STATUSES as readonly string[]).includes(v);
}

/** Trim to null; a manual edit that clears a field stores NULL, not ''. */
function textOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw new RegistrationInputError(400, 'text fields must be strings');
  const t = v.trim();
  return t === '' ? null : t;
}

export async function loadRegistration(svc: Svc, id: string): Promise<RegistrationRow | null> {
  const { data, error } = await svc.from('client_portal_registrations').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`registration read failed: ${error.message}`);
  return (data ?? null) as RegistrationRow | null;
}

/** A rep's edit. Every changed field is written to the row's history. */
export async function updateRegistration(
  svc: Svc,
  reg: RegistrationRow,
  patch: { our_status?: unknown; portal_status?: unknown; portal_ref?: unknown; notes?: unknown },
  actorAuthUid: string,
): Promise<RegistrationRow> {
  const set: Record<string, unknown> = {};
  const ar: string[] = [];
  const en: string[] = [];

  if (patch.our_status !== undefined) {
    if (!isOurStatus(patch.our_status)) throw new RegistrationInputError(400, `invalid our_status: ${String(patch.our_status)}`);
    if (patch.our_status !== reg.our_status) {
      set.our_status = patch.our_status;
      if (patch.our_status === 'registered' && !reg.registered_at) {
        set.registered_at = new Date().toISOString();
        set.registered_via = reg.registered_via ?? 'manual_entry';
        set.registered_by_user_id = reg.registered_by_user_id ?? actorAuthUid;
      }
      ar.push(`حالتنا: «${OUR_STATUS_AR[reg.our_status]}» ← «${OUR_STATUS_AR[patch.our_status]}»`);
      en.push(`Our status: "${OUR_STATUS_EN[reg.our_status]}" → "${OUR_STATUS_EN[patch.our_status]}"`);
    }
  }
  if (patch.portal_status !== undefined) {
    const v = textOrNull(patch.portal_status);
    if (v !== reg.portal_status) {
      set.portal_status = v;
      set.portal_status_code = null; // a hand-typed label has no portal code
      set.portal_status_changed_at = new Date().toISOString();
      ar.push(`حالة البوابة (يدوياً): «${reg.portal_status ?? '—'}» ← «${v ?? '—'}»`);
      en.push(`Portal status (by hand): "${reg.portal_status ?? '—'}" → "${v ?? '—'}"`);
    }
  }
  if (patch.portal_ref !== undefined) {
    const v = textOrNull(patch.portal_ref);
    if (v !== reg.portal_ref) {
      set.portal_ref = v;
      ar.push(`رقم البوابة: ${v ?? '—'}`);
      en.push(`Portal ref: ${v ?? '—'}`);
    }
  }
  if (patch.notes !== undefined) {
    const v = textOrNull(patch.notes);
    if (v !== reg.notes) {
      set.notes = v;
      ar.push('عُدّلت الملاحظة');
      en.push('Note edited');
    }
  }
  if (Object.keys(set).length === 0) return reg;

  set.updated_at = new Date().toISOString();
  const { data, error } = await svc.from('client_portal_registrations').update(set).eq('id', reg.id).select('*').single();
  if (error) throw new Error(`registration update failed: ${error.message}`);
  const { error: evErr } = await svc.from('client_portal_registration_events').insert({
    registration_id: reg.id,
    kind: 'manual_edit',
    our_status: (set.our_status as string | undefined) ?? reg.our_status,
    portal_status: (set.portal_status as string | null | undefined) ?? reg.portal_status,
    summary_ar: ar.join(' · '),
    summary_en: en.join(' · '),
    actor_user_id: actorAuthUid,
  });
  if (evErr) throw new Error(`registration history write failed: ${evErr.message}`);
  return data as RegistrationRow;
}

/** A registration made outside the app (by hand in the portal, by phone, …). */
export async function addRegistration(
  svc: Svc,
  input: { client_id: string; portal_id: string; our_status?: unknown; portal_status?: unknown; portal_ref?: unknown; notes?: unknown; project_name?: unknown },
  actorAuthUid: string,
): Promise<RegistrationRow> {
  const our: OurStatus = input.our_status === undefined ? 'registered' : isOurStatus(input.our_status) ? input.our_status : (() => {
    throw new RegistrationInputError(400, `invalid our_status: ${String(input.our_status)}`);
  })();
  const project = textOrNull(input.project_name);
  const now = new Date().toISOString();
  const portalStatus = textOrNull(input.portal_status);
  const { data, error } = await svc
    .from('client_portal_registrations')
    .insert({
      client_record_id: input.client_id,
      portal_record_id: input.portal_id,
      our_status: our,
      portal_status: portalStatus,
      portal_status_changed_at: portalStatus ? now : null,
      portal_ref: textOrNull(input.portal_ref),
      notes: textOrNull(input.notes),
      project_names: project ? [project] : [],
      registered_at: our === 'registered' ? now : null,
      registered_via: 'manual_entry',
      registered_by_user_id: actorAuthUid,
    })
    .select('*')
    .single();
  if (error) {
    // 23505 = the (client, portal) row already exists — edit it instead.
    if ((error as { code?: string }).code === '23505') {
      throw new RegistrationInputError(409, 'this client already has a row for this portal — edit it instead');
    }
    throw new Error(`registration insert failed: ${error.message}`);
  }
  const row = data as RegistrationRow;
  const { error: evErr } = await svc.from('client_portal_registration_events').insert({
    registration_id: row.id,
    kind: 'created',
    our_status: our,
    portal_status: portalStatus,
    summary_ar: `أُضيف يدوياً: «${OUR_STATUS_AR[our]}»${project ? ` — ${project}` : ''}`,
    summary_en: `Added by hand: "${OUR_STATUS_EN[our]}"${project ? ` — ${project}` : ''}`,
    actor_user_id: actorAuthUid,
  });
  if (evErr) throw new Error(`registration history write failed: ${evErr.message}`);
  return row;
}

/** "Check statuses now": one status check for the whole portal (one code). */
export async function requestStatusCheck(svc: Svc, portal: Rec, actorAuthUid: string | null): Promise<string> {
  if (!canCheck(portal)) {
    throw new RegistrationInputError(409, 'this portal has no automatic status check (no status recipe, or checks are switched off)');
  }
  const { data, error } = await svc.rpc('portal_status_check_enqueue', {
    p_portal_record_id: portal.id,
    p_user_id: actorAuthUid,
  });
  if (error || !data) throw new Error(`status check enqueue failed: ${error?.message ?? 'no id returned'}`);
  const jobId = data as string;
  void wakeWorker(jobId);
  return jobId;
}

export { canCheck as portalCanCheckStatus };

// ── Sales Workspace «البوابات» overview — every client × portal, every run ──

export interface OverviewRun {
  id: string;
  kind: 'register' | 'status_check';
  portal_record_id: string;
  client_record_id: string | null;
  project_name: string | null;
  status: string;
  phase_ar: string | null;
  phase_en: string | null;
  error_message: string | null;
  origin: 'manual' | 'auto';
  attempts: number;
  skip_reason: string | null;
  screenshot_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  parked_at: string | null;
  /** Who the run belongs to (the rep who pressed, or the auto run's owner). */
  owner_name: string | null;
}

export interface OverviewClient {
  id: string;
  name: string;
  phone: string;
  owner_name: string | null;
}

export interface OverviewPortal {
  id: string;
  name: string;
  is_active: boolean;
  auto_register: boolean;
  otp_channel: string | null;
  otp_whatsapp_relay: boolean;
  can_check_status: boolean;
}

const PAGE = 1000;

/** Read EVERY row (keyset over id) — never the silent first 1,000. */
async function readAll<T extends { id: string }>(
  svc: Svc,
  table: string,
  select: string,
  eq?: [column: string, value: string],
): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (;;) {
    let q = svc.from(table).select(select);
    if (eq) q = q.eq(eq[0], eq[1]);
    if (after) q = q.gt('id', after);
    const { data, error } = await q.order('id', { ascending: true }).limit(PAGE);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1]!.id;
  }
  return out;
}

/**
 * Everything the Sales Workspace «البوابات» tab shows. Reads with the service
 * client, then keeps only the clients the caller can see (`visibleClients`,
 * resolved by the caller under its own RLS) — a rep sees their own book, an
 * admin sees everything. Status checks are portal-wide (no client) and shown
 * to everyone who can open the tab.
 */
export async function listPortalsOverview(
  svc: Svc,
  visibleClients: (ids: string[]) => Promise<OverviewClient[]>,
): Promise<{ portals: OverviewPortal[]; registrations: RegistrationRow[]; runs: OverviewRun[]; clients: OverviewClient[]; generated_at: string }> {
  const [regs, jobs, portalRows, users] = await Promise.all([
    readAll<RegistrationRow>(svc, 'client_portal_registrations', '*'),
    readAll<{
      id: string; kind: string; portal_record_id: string; client_record_id: string | null; status: string;
      phase_ar: string | null; phase_en: string | null; error_message: string | null; origin: string | null;
      attempts: number | null; result: Record<string, unknown> | null; screenshots: unknown[] | null;
      lead_data: Record<string, unknown> | null; user_id: string | null;
      created_at: string; started_at: string | null; finished_at: string | null; parked_at: string | null;
    }>(
      svc, 'portal_registration_jobs',
      'id, kind, portal_record_id, client_record_id, status, phase_ar, phase_en, error_message, origin, attempts, result, screenshots, lead_data, user_id, created_at, started_at, finished_at, parked_at',
    ),
    readAll<Rec>(svc, 'unified_records', 'id, data', ['model_id', LEAD_PORTALS_MODEL_ID]),
    readAll<{ id: string; auth_uid: string | null; name_ar: string | null; name_en: string | null }>(svc, 'users', 'id, auth_uid, name_ar, name_en'),
  ]);

  const clientIds = new Set<string>();
  for (const r of regs) clientIds.add(r.client_record_id);
  for (const j of jobs) if (j.client_record_id) clientIds.add(j.client_record_id);
  const clients = await visibleClients([...clientIds]);
  const visible = new Set(clients.map((c) => c.id));

  const nameByAuth = new Map<string, string>();
  for (const u of users) {
    const n = str(u.name_ar) || str(u.name_en);
    if (u.auth_uid && n) nameByAuth.set(u.auth_uid, n);
  }

  const runs: OverviewRun[] = jobs
    .filter((j) => (j.client_record_id ? visible.has(j.client_record_id) : j.kind === 'status_check'))
    .map((j) => ({
      id: j.id,
      kind: j.kind === 'status_check' ? ('status_check' as const) : ('register' as const),
      portal_record_id: j.portal_record_id,
      client_record_id: j.client_record_id,
      project_name: str(j.lead_data?.project_name) || null,
      status: j.status,
      phase_ar: j.phase_ar,
      phase_en: j.phase_en,
      error_message: j.error_message,
      origin: j.origin === 'auto' ? ('auto' as const) : ('manual' as const),
      attempts: j.attempts ?? 0,
      skip_reason: str(j.result?.skip_reason) || null,
      screenshot_count: Array.isArray(j.screenshots) ? j.screenshots.length : 0,
      created_at: j.created_at,
      started_at: j.started_at,
      finished_at: j.finished_at,
      parked_at: j.parked_at,
      owner_name: j.user_id ? nameByAuth.get(j.user_id) ?? null : null,
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return {
    portals: portalRows
      .map((p) => {
        const d = p.data ?? {};
        return {
          id: p.id,
          name: str(d.name) || '—',
          is_active: d.is_active !== false,
          auto_register: d.auto_register === true,
          otp_channel: str(d.otp_channel) || null,
          otp_whatsapp_relay: d.otp_whatsapp_relay === true,
          can_check_status: canCheck(p),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ar')),
    registrations: regs.filter((r) => visible.has(r.client_record_id)),
    runs,
    clients,
    generated_at: new Date().toISOString(),
  };
}
