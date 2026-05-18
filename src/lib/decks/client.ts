/**
 * Browser-side helpers for the Decks endpoints.
 *
 * As of 2026-05-17 the generation pipeline runs on a Fly.io worker that
 * polls the `deck_jobs` queue — no more SSE stream held open from the
 * browser. `enqueueGenerateDeck` is a thin HTTP POST that returns
 * immediately with a `job_id`; the SPA observes progress by watching
 * the deck record itself via Supabase Realtime (already wired in
 * appStore). All UI status (calling-claude / downloading / uploading /
 * finalizing / ready / failed) is read from `record.data` fields:
 *   - `status`       : queued | generating | ready | failed
 *   - `phase`        : calling-claude | downloading | uploading | finalizing  (during 'generating')
 *   - `phase_detail` : optional one-line detail under the phase
 *   - `error_message`: failure reason (when status='failed')
 *   - `file_url` / `file_path` / `filename` : populated when status='ready'
 *
 * `signDeckUrl`, `uploadDeckAttachment`, and `deleteDeckAttachment`
 * are unchanged from the SSE era.
 */

import { supabase } from '@/lib/supabase';

/** Aspect ratio of the generated deck. Maps to slide_width / slide_height
 * in python-pptx on the worker side. */
export type DeckSize = '16:9' | '9:16' | '4:3' | '1:1';

/** A user-uploaded attachment ready to be passed to Claude in the sandbox.
 * Lives at `<userId>/<deckId>/uploads/<storedName>` in `wassel-decks` bucket.
 * The worker downloads each one with the service-role key and forwards
 * it to the Anthropic Files API as a `container_upload` content block. */
export interface DeckAttachment {
  /** Storage path (bucket-relative). */
  path: string;
  /** Original filename as the user picked it. Used for display + as the
   * filename Claude sees in `/mnt/user-data/uploads/`. */
  name: string;
  /** Browser-reported mime type. May be empty for unusual extensions
   * (HEIC on Firefox); the worker falls back to extension sniffing. */
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

/**
 * Enqueue a deck generation job. Returns immediately with the assigned
 * job_id (the Fly.io worker picks it up within ~3 seconds). Throws on
 * a 4xx/5xx response — the caller surfaces the error via the deck
 * record's `error_message` (the worker writes it) or via a toast on
 * this direct error path (network failure / auth bounce / 400).
 */
export async function enqueueGenerateDeck(
  payload: GenerateDeckRequest,
): Promise<{ jobId: string }> {
  const res = await fetch('/api/generate-deck', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(await authHeader()),
    },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as { job_id?: string; error?: string };
  if (!res.ok || !body.job_id) {
    throw new Error(body.error ?? `POST /api/generate-deck failed (${res.status})`);
  }
  return { jobId: body.job_id };
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
