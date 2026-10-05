/**
 * Browser-side helpers for lead-portal registration (`/api/portal-registration`).
 *
 *   loadPortalOptions(clientId, projectId) → the portals covering that project
 *       (with the customer fields each needs, prefilled) + the client's history.
 *   startPortalRegistration(...)          → enqueues ONE portal_registration_jobs
 *       row (202). The Fly worker drives Browserbase; nothing is awaited here.
 *   submitPortalInput(jobId, value)       → the rep typed the OTP the portal asked
 *       for; the worker (polling its own row) picks it up and continues.
 *   cancelPortalRegistration(jobId)       → stop the run.
 *   subscribePortalJob(jobId, cb)         → Realtime on the job row (owner-only
 *       RLS) so the modal follows phase / awaiting_input / done live.
 *   fetchPortalJob(jobId)                 → poll fallback + signed screenshots.
 */

import { supabase } from '@/lib/supabase';

export type PortalJobStatus = 'queued' | 'running' | 'awaiting_input' | 'done' | 'failed' | 'cancelled' | 'already_registered';

export interface PortalFieldSpec {
  key: string;
  label_ar: string;
  label_en: string;
  type?: 'text' | 'phone' | 'email' | 'number' | 'select' | 'textarea';
  required?: boolean;
  source?: string;
  options?: { value: string; label_ar: string; label_en: string }[];
  placeholder?: string;
  /** Prefilled server-side and not shown in the modal. */
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

export interface PortalHistoryItem {
  id: string;
  portal_record_id: string;
  portal_name: string;
  project_record_id: string | null;
  status: PortalJobStatus;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
  mine: boolean;
  /** 'auto' = registered by the ad-lead sweep, not a rep's button press. */
  origin: 'manual' | 'auto';
}

export interface PortalInputRequest {
  key: string;
  kind: 'otp' | 'text';
  prompt_ar: string;
  prompt_en: string;
  length?: number | null;
  otp_channel?: string | null;
}

export interface PortalJob {
  id: string;
  portal_record_id: string;
  client_record_id: string;
  project_record_id: string | null;
  status: PortalJobStatus;
  phase: string | null;
  phase_ar: string | null;
  phase_en: string | null;
  input_request: PortalInputRequest | null;
  input_requested_at: string | null;
  live_view_url: string | null;
  screenshots: { path: string; label: string; at: string }[] | null;
  screenshot_urls?: { label: string; url: string; at: string }[];
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
  throw new Error(body?.error ?? `portal registration request failed (${res.status})`);
}

/** This client's row for one portal — what blocks registering again. */
export interface ClientPortalStatus {
  portal_record_id: string;
  our_status: RegistrationOurStatus;
  registered_at: string | null;
  registered_via: string | null;
  portal_status: string | null;
}

export async function loadPortalOptions(
  clientId: string,
  projectId: string | null,
): Promise<{ portals: PortalOption[]; history: PortalHistoryItem[]; registrations: ClientPortalStatus[] }> {
  const qs = new URLSearchParams({ client_id: clientId });
  if (projectId) qs.set('project_id', projectId);
  const res = await fetch(`/api/portal-registration?${qs.toString()}`, { headers: await authHeader() });
  if (!res.ok) return readError(res);
  const body = (await res.json()) as { portals?: PortalOption[]; history?: PortalHistoryItem[]; registrations?: ClientPortalStatus[] };
  return { portals: body.portals ?? [], history: body.history ?? [], registrations: body.registrations ?? [] };
}

export async function startPortalRegistration(input: {
  portalId: string;
  clientId: string;
  projectId: string | null;
  lead: Record<string, string>;
  loginPhone?: string | null;
}): Promise<{ jobId: string }> {
  const res = await fetch('/api/portal-registration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      action: 'start',
      portal_id: input.portalId,
      client_id: input.clientId,
      project_id: input.projectId,
      lead: input.lead,
      login_phone: input.loginPhone ?? null,
    }),
  });
  if (!res.ok) return readError(res);
  const j = (await res.json()) as { job_id?: string };
  if (!j.job_id) throw new Error('portal registration enqueued but job_id missing');
  return { jobId: j.job_id };
}

export async function submitPortalInput(jobId: string, value: string): Promise<void> {
  const res = await fetch('/api/portal-registration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'input', job_id: jobId, value }),
  });
  if (!res.ok) return readError(res);
}

export async function cancelPortalRegistration(jobId: string): Promise<void> {
  const res = await fetch('/api/portal-registration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'cancel', job_id: jobId }),
  });
  if (!res.ok) return readError(res);
}

export async function fetchPortalJob(jobId: string): Promise<PortalJob> {
  const res = await fetch(`/api/portal-registration?job_id=${encodeURIComponent(jobId)}`, { headers: await authHeader() });
  if (!res.ok) return readError(res);
  const body = (await res.json()) as { job: PortalJob };
  return body.job;
}

/** Follow one job row live. The SELECT policy is owner-only, so Realtime only
 *  delivers the caller's own jobs. Returns an unsubscribe function. */
export function subscribePortalJob(jobId: string, onRow: (row: PortalJob) => void): () => void {
  const client = supabase;
  if (!client) return () => { /* offline: the modal polls instead */ };
  const channel = client
    .channel(`portal-job:${jobId}`)
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'portal_registration_jobs', filter: `id=eq.${jobId}` },
      (payload) => onRow(payload.new as PortalJob),
    )
    .subscribe();
  return () => { void client.removeChannel(channel); };
}

/** The worker stores RecipeError messages as "<arabic>\n<english>". */
export function pickErrorLine(message: string | null | undefined, isAr: boolean): string {
  if (!message) return '';
  const lines = message.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) return isAr ? lines[0]! : lines[1]!;
  return lines[0] ?? '';
}

// ── Per-client registrations (the client's «البوابات» tab) ────────────────────

export type RegistrationOurStatus = 'not_registered' | 'registering' | 'registered' | 'already_registered' | 'failed';
export const REGISTRATION_OUR_STATUSES: RegistrationOurStatus[] = [
  'not_registered', 'registering', 'registered', 'already_registered', 'failed',
];

export interface RegistrationEvent {
  id: string;
  registration_id: string;
  kind: 'run' | 'status_check' | 'status_change' | 'found_in_portal' | 'manual_edit' | 'created';
  our_status: string | null;
  portal_status: string | null;
  summary_ar: string;
  summary_en: string;
  job_id: string | null;
  created_at: string;
}

export interface ClientPortalRegistration {
  id: string;
  client_record_id: string;
  portal_record_id: string;
  our_status: RegistrationOurStatus;
  /** Label exactly as the portal shows it (e.g. «جديد»). */
  portal_status: string | null;
  portal_status_code: string | null;
  portal_status_changed_at: string | null;
  portal_ref: string | null;
  project_names: string[];
  /** What the portal was told (its own project names). */
  registered_as: string[];
  registered_at: string | null;
  registered_via: 'auto' | 'manual_run' | 'manual_entry' | 'portal_sync' | null;
  last_checked_at: string | null;
  notes: string | null;
  updated_at: string;
  events: RegistrationEvent[];
}

export interface RegistrationPortal {
  id: string;
  name: string;
  is_active: boolean;
  can_check_status: boolean;
  last_check: { status: string; finished_at: string | null; created_at: string; error_message: string | null } | null;
}

export async function fetchClientRegistrations(
  clientId: string,
): Promise<{ registrations: ClientPortalRegistration[]; portals: RegistrationPortal[] }> {
  const res = await fetch(`/api/portal-registration?registrations_for=${encodeURIComponent(clientId)}`, {
    headers: await authHeader(),
  });
  if (!res.ok) return readError(res);
  const body = (await res.json()) as { registrations?: ClientPortalRegistration[]; portals?: RegistrationPortal[] };
  return { registrations: body.registrations ?? [], portals: body.portals ?? [] };
}

export async function updateClientRegistration(
  registrationId: string,
  patch: { our_status?: RegistrationOurStatus; portal_status?: string | null; portal_ref?: string | null; notes?: string | null },
): Promise<void> {
  const res = await fetch('/api/portal-registration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'registration_update', registration_id: registrationId, ...patch }),
  });
  if (!res.ok) return readError(res);
}

export async function addClientRegistration(input: {
  clientId: string;
  portalId: string;
  ourStatus: RegistrationOurStatus;
  portalStatus?: string | null;
  portalRef?: string | null;
  projectName?: string | null;
  notes?: string | null;
}): Promise<void> {
  const res = await fetch('/api/portal-registration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      action: 'registration_add',
      client_id: input.clientId,
      portal_id: input.portalId,
      our_status: input.ourStatus,
      portal_status: input.portalStatus ?? null,
      portal_ref: input.portalRef ?? null,
      project_name: input.projectName ?? null,
      notes: input.notes ?? null,
    }),
  });
  if (!res.ok) return readError(res);
}

/** One status check for the whole portal — the ops WhatsApp asks for ONE code. */
export async function requestPortalStatusCheck(portalId: string): Promise<{ jobId: string }> {
  const res = await fetch('/api/portal-registration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'status_check', portal_id: portalId }),
  });
  if (!res.ok) return readError(res);
  const j = (await res.json()) as { job_id?: string };
  if (!j.job_id) throw new Error('status check enqueued but job_id missing');
  return { jobId: j.job_id };
}

/** Our record says "do not register this client in this portal again". */
export function isRegisteredByUs(s: RegistrationOurStatus | null | undefined): boolean {
  return s === 'registered' || s === 'already_registered';
}

// ── Sales Workspace «البوابات» overview ───────────────────────────────────────

export interface OverviewPortal {
  id: string;
  name: string;
  is_active: boolean;
  auto_register: boolean;
  otp_channel: string | null;
  otp_whatsapp_relay: boolean;
  can_check_status: boolean;
}

export interface OverviewClient {
  id: string;
  name: string;
  phone: string;
  owner_name: string | null;
}

export interface OverviewRun {
  id: string;
  kind: 'register' | 'status_check';
  portal_record_id: string;
  client_record_id: string | null;
  project_name: string | null;
  status: PortalJobStatus;
  phase_ar: string | null;
  phase_en: string | null;
  error_message: string | null;
  origin: 'manual' | 'auto';
  attempts: number;
  /** 'no_owner' | 'already_registered_by_us' when the run never reached a browser. */
  skip_reason: string | null;
  screenshot_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  parked_at: string | null;
  owner_name: string | null;
}

export type OverviewRegistration = Omit<ClientPortalRegistration, 'events'>;

export interface PortalsOverview {
  portals: OverviewPortal[];
  registrations: OverviewRegistration[];
  runs: OverviewRun[];
  clients: OverviewClient[];
  generated_at: string;
}

/** Every client × portal the caller can see (their RLS), plus every run. */
export async function fetchPortalsOverview(): Promise<PortalsOverview> {
  const res = await fetch('/api/portal-registration?overview=1', { headers: await authHeader() });
  if (!res.ok) return readError(res);
  return (await res.json()) as PortalsOverview;
}
