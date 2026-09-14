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

export type PortalJobStatus = 'queued' | 'running' | 'awaiting_input' | 'done' | 'failed' | 'cancelled';

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

export async function loadPortalOptions(
  clientId: string,
  projectId: string | null,
): Promise<{ portals: PortalOption[]; history: PortalHistoryItem[] }> {
  const qs = new URLSearchParams({ client_id: clientId });
  if (projectId) qs.set('project_id', projectId);
  const res = await fetch(`/api/portal-registration?${qs.toString()}`, { headers: await authHeader() });
  if (!res.ok) return readError(res);
  const body = (await res.json()) as { portals?: PortalOption[]; history?: PortalHistoryItem[] };
  return { portals: body.portals ?? [], history: body.history ?? [] };
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
