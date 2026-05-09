/**
 * Browser-side helpers for the Decks endpoints.
 *
 * `streamGenerateDeck` opens an SSE stream against /api/generate-deck and
 * invokes per-event callbacks until `done` or `error` arrives. The endpoint
 * updates the underlying `decks` record in-band, so live state can come
 * from either the SSE events (immediate) or the store's realtime echo
 * (canonical) — UI uses SSE for the active flow and the store for past decks.
 *
 * `signDeckUrl` requests a fresh 7-day signed URL for an existing record's
 * stored .pptx, used when re-opening a deck whose URL has expired.
 */

import { supabase } from '@/lib/supabase';

export type GenerateDeckEvent =
  | {
      type: 'status';
      phase: 'calling-claude' | 'downloading' | 'uploading' | 'finalizing';
      detail?: string;
    }
  | { type: 'done'; file_url: string; file_path: string; filename: string }
  | { type: 'error'; message: string };

export interface GenerateDeckRequest {
  recordId: string;
  brief: string;
  language?: 'ar' | 'en' | 'mixed';
  model?: 'claude-opus-4-7' | 'claude-sonnet-4-6';
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function streamGenerateDeck(
  payload: GenerateDeckRequest,
  onEvent: (event: GenerateDeckEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/generate-deck', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `POST /api/generate-deck failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const raw of chunks) {
      const line = raw.replace(/^data:\s?/, '').trim();
      if (!line) continue;
      let parsed: GenerateDeckEvent;
      try {
        parsed = JSON.parse(line) as GenerateDeckEvent;
      } catch {
        continue;
      }
      onEvent(parsed);
    }
  }
}

export async function signDeckUrl(
  recordId: string,
): Promise<{ file_url: string; filename: string }> {
  const res = await fetch('/api/sign-deck-url', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify({ recordId }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    file_url?: string;
    filename?: string;
    error?: string;
  };
  if (!res.ok || !body.file_url) {
    throw new Error(body.error ?? `POST /api/sign-deck-url failed (${res.status})`);
  }
  return { file_url: body.file_url, filename: body.filename ?? 'deck.pptx' };
}
