/**
 * Browser-side wrapper around the `/api/haberchat/*` proxy endpoints.
 *
 * Never calls api.haber.chat directly — CORS is blocked and the token lives
 * server-side. Every request attaches the current Supabase session JWT as
 * `Authorization: Bearer <token>` so the Vercel function can authenticate
 * the caller via `api/_lib/auth.ts#verifySupabaseJWT`.
 */

import { supabase } from '@/lib/supabase';
import type { HaberchatDevice, HaberchatChat } from '@/types';

export class HaberchatClientError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: await authHeader() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new HaberchatClientError(res.status, body?.error ?? `Request to ${path} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function listDevices(): Promise<HaberchatDevice[]> {
  const { devices } = await get<{ devices: HaberchatDevice[] }>('/api/haberchat/devices');
  return devices;
}

export async function listChats(deviceId: string): Promise<HaberchatChat[]> {
  const qs = new URLSearchParams({ deviceId }).toString();
  const { chats } = await get<{ chats: HaberchatChat[] }>(`/api/haberchat/chats?${qs}`);
  return chats;
}
