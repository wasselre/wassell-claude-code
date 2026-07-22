/**
 * Browser-side wrapper around `/api/whatsapp/session` — the admin-only WAHA
 * session lifecycle + pairing endpoint. Mirrors the haberchat client posture:
 * never talks to the WAHA host directly (URL + API key live server-side);
 * every request carries the Supabase session JWT.
 */

import { supabase } from '@/lib/supabase';

export class WahaClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface WahaSessionState {
  status: string; // WORKING | STARTING | SCAN_QR_CODE | FAILED | STOPPED | ...
  me: { id: string; pushName: string | null } | null;
  activityTs: number | null;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readError(res: Response, path: string): Promise<never> {
  const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
  throw new WahaClientError(res.status, body?.error ?? `Request to ${path} failed (${res.status})`);
}

export async function getWahaSessionState(session: string): Promise<WahaSessionState> {
  const path = `/api/whatsapp/session?session=${encodeURIComponent(session)}&mode=status`;
  const res = await fetch(path, { headers: await authHeader() });
  if (!res.ok) return readError(res, path);
  return (await res.json()) as WahaSessionState;
}

export async function restartWahaSession(session: string): Promise<WahaSessionState> {
  const path = '/api/whatsapp/session';
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ session, action: 'restart' }),
  });
  if (!res.ok) return readError(res, path);
  return (await res.json()) as WahaSessionState;
}

/**
 * Fetch the pairing QR as a Blob (image/png). Only valid while the session is
 * in SCAN_QR_CODE; the server 422s otherwise. Callers own the object URL
 * lifecycle (create + revoke).
 */
export async function getWahaQrBlob(session: string): Promise<Blob> {
  const path = `/api/whatsapp/session?session=${encodeURIComponent(session)}&mode=qr`;
  const res = await fetch(path, { headers: await authHeader() });
  if (!res.ok) return readError(res, path);
  return await res.blob();
}
