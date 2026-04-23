/**
 * Browser-side wrapper around the `/api/haberchat/*` proxy endpoints.
 *
 * Never calls api.haber.chat directly — CORS is blocked and the token lives
 * server-side. Every request attaches the current Supabase session JWT as
 * `Authorization: Bearer <token>` so the Vercel function can authenticate
 * the caller via `api/_lib/auth.ts#verifySupabaseJWT`.
 */

import { supabase } from '@/lib/supabase';
import type { HaberchatDevice, HaberchatChat, ChatMessage } from '@/types';

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

export async function listMessages(
  deviceId: string,
  chatWid: string,
  opts: { size?: number; before?: string } = {},
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  const qs = new URLSearchParams({ deviceId });
  if (opts.size) qs.set('size', String(opts.size));
  if (opts.before) qs.set('before', opts.before);
  // The proxy returns messages in HaberchatMessage shape (camelCase). Adapt
  // to the store's ChatMessage shape here so callers don't re-map.
  const res = await get<{
    messages: Array<{
      wid: string;
      chatWid: string;
      flow: 'in' | 'out';
      kind: string;
      body: string | null;
      fromPhone: string | null;
      toPhone: string | null;
      ack: ChatMessage['ack'];
      date: string;
      mediaFileId: string | null;
      mediaMime: string | null;
      mediaSize: number | null;
      mediaCaption: string | null;
      reference: string | null;
      quoted: ChatMessage['quoted'];
    }>;
    hasMore: boolean;
  }>(`/api/haberchat/chats/${encodeURIComponent(chatWid)}/messages?${qs.toString()}`);
  const messages: ChatMessage[] = res.messages.map((m) => ({
    id: m.wid,
    chat_wid: m.chatWid,
    flow: m.flow,
    kind: m.kind,
    body: m.body,
    from_phone: m.fromPhone,
    to_phone: m.toPhone,
    ack: m.ack,
    date: m.date,
    media_file_id: m.mediaFileId,
    media_mime: m.mediaMime,
    media_size: m.mediaSize,
    media_caption: m.mediaCaption,
    reference: m.reference,
    quoted: m.quoted,
  }));
  return { messages, hasMore: res.hasMore };
}
