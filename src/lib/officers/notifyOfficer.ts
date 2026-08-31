/**
 * Browser-side wrapper around `/api/whatsapp/notify-officer`.
 *
 * Resolves the officer(s) covering a project and sends a message to one FROM THE
 * OPERATIONS WhatsApp line (never sales). URL + gateway key stay server-side;
 * every request carries the Supabase session JWT.
 */

import { supabase } from '@/lib/supabase';

export class NotifyOfficerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface CoveringOfficer {
  id: string;
  name: string;
  phone: string;
  /** How this officer was matched: an explicit project assignment, or the
   *  project's whole developer / whole marketer. */
  coverage: 'explicit' | 'developer' | 'marketer';
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readError(res: Response, path: string): Promise<never> {
  const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
  throw new NotifyOfficerError(res.status, body?.error ?? `Request to ${path} failed (${res.status})`);
}

/** Officers covering a given project (explicit-subset first, then whole-developer). */
export async function resolveCoveringOfficers(projectId: string): Promise<CoveringOfficer[]> {
  const path = `/api/whatsapp/notify-officer?project_id=${encodeURIComponent(projectId)}`;
  const res = await fetch(path, { headers: await authHeader() });
  if (!res.ok) return readError(res, path);
  const body = (await res.json()) as { officers?: CoveringOfficer[] };
  return body.officers ?? [];
}

/** Send a message to an officer's phone from the operations line. */
export async function notifyOfficer(input: {
  officerPhone: string;
  message: string;
  projectId?: string;
  officerId?: string;
  clientId?: string;
}): Promise<{ wid: string; deviceId: string }> {
  const path = '/api/whatsapp/notify-officer';
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      officer_phone: input.officerPhone,
      message: input.message,
      project_id: input.projectId,
      officer_id: input.officerId,
      client_id: input.clientId,
    }),
  });
  if (!res.ok) return readError(res, path);
  const body = (await res.json()) as { wid: string; deviceId: string };
  return body;
}
