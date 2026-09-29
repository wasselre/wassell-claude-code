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
