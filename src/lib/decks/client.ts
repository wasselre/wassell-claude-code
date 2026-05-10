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

/** Aspect ratio of the generated deck. Maps to slide_width / slide_height
 * in python-pptx on the API side. */
export type DeckSize = '16:9' | '9:16' | '4:3' | '1:1';

/** A user-uploaded attachment ready to be passed to Claude in the sandbox.
 * Lives at `<userId>/<deckId>/uploads/<storedName>` in `wassel-decks` bucket.
 * The API endpoint downloads each one with the user's JWT and forwards
 * it to the Anthropic Files API as `container.file_ids`. */
export interface DeckAttachment {
  /** Storage path (bucket-relative). */
  path: string;
  /** Original filename as the user picked it. Used for display + as the
   * filename Claude sees in `/mnt/user-data/uploads/`. */
  name: string;
  /** Browser-reported mime type. May be empty for unusual extensions
   * (HEIC on Firefox); the endpoint falls back to extension sniffing. */
  mimeType: string;
  /** Bytes — used for UI size display + per-attachment size enforcement. */
  size: number;
}

export interface GenerateDeckRequest {
  recordId: string;
  brief: string;
  language?: 'ar' | 'en' | 'mixed';
  model?: 'claude-opus-4-7' | 'claude-sonnet-4-6';
  size?: DeckSize;
  attachments?: DeckAttachment[];
}

const DECKS_BUCKET = 'wassel-decks';

/** Per-attachment cap (32 MB matches the Anthropic Files API limit so we
 * never accept something we can't forward). Total per-deck cap is enforced
 * by Supabase via the bucket's file_size_limit (100 MB). */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** Upload one attachment to the `wassel-decks` bucket under
 * `<userId>/<deckId>/uploads/<timestamp>_<safe-name>`. Returns the metadata
 * needed by the API + the UI's local list. Throws on any storage error
 * (no silent failure — see CLAUDE.md "Silent Failures"). */
export async function uploadDeckAttachment(
  userId: string,
  deckId: string,
  file: File,
): Promise<DeckAttachment> {
  if (!supabase) {
    throw new Error('Supabase is not configured — cannot upload attachment.');
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
    );
  }
  const safeName = file.name.replace(/[^\w\-. ]/g, '_');
  // Timestamp prefix prevents a same-name collision on retry. We don't
  // upsert: a fresh path per pick keeps the audit trail clean.
  const path = `${userId}/${deckId}/uploads/${Date.now()}_${safeName}`;
  const { error } = await supabase.storage.from(DECKS_BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return {
    path,
    name: file.name,
    mimeType: file.type || '',
    size: file.size,
  };
}

/** Best-effort cleanup when the user removes an attachment from the form
 * before submitting. We don't fail the UI flow if the delete fails — the
 * orphan just sits in the bucket; a follow-up GC could sweep them later.
 * Silent here is deliberate-and-scoped: we log AND surface to the caller
 * so the page can decide whether to show a toast. */
export async function deleteDeckAttachment(path: string): Promise<void> {
  if (!supabase) {
    throw new Error('Supabase is not configured — cannot remove attachment.');
  }
  const { error } = await supabase.storage.from(DECKS_BUCKET).remove([path]);
  if (error) throw new Error(`Remove failed: ${error.message}`);
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
