/**
 * Browser-side helpers for the Data Migration wizard.
 *
 * Uploads go to the private `wassel-migrations` bucket under
 *   <authUid>/<recordId>/uploads/<ts>_<name>
 * (RLS scopes read/write to the owner). The file-heavy AI steps (extract / plan
 * / discuss) are ENQUEUE-ONLY now: the browser POSTs /api/migrate, which inserts
 * a `data_migration_jobs` row and returns 202 fast; the Fly worker runs the long
 * vision call (no timeout) and streams progress onto the record via Realtime. The
 * browser never holds a multi-minute HTTP request and NEVER writes the migration
 * record during a job (that would suppress the worker's updates via the realtime
 * echo-dedup — see CLAUDE.md). The worker mints its own signed URLs from the
 * record's persisted source_files, so the browser no longer signs files here.
 *
 * The fast text-only actions (suggest_mappings / standardize) stay synchronous.
 *
 * Every call throws on failure (no silent failure — see CLAUDE.md); callers
 * surface the message via addToast + a retry affordance.
 */

import { supabase } from '@/lib/supabase';
import { markMigrationJobEnqueued } from './jobPending';
import type { ColumnMappingSuggestion, AnsweredQuestion } from './types';
import type { TargetFieldLite } from './targetFields';

const MIGRATIONS_BUCKET = 'wassel-migrations';

/** Per-file cap — matches the bucket's file_size_limit + the Anthropic
 * per-file limit so we never accept something extraction can't forward. */
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

export interface MigrationUpload {
  /** Storage path (bucket-relative). */
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

async function authUid(): Promise<string> {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user?.id;
  if (!uid) throw new Error('Not signed in.');
  return uid;
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** fetch with a hard timeout so a hung request surfaces loudly instead of
 * spinning forever (CLAUDE.md: fail loudly). */
async function fetchWithTimeout(url: string, opts: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) {
      throw new Error('Request timed out — try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Upload one source file. Throws on oversize or any storage error. */
export async function uploadMigrationFile(recordId: string, file: File): Promise<MigrationUpload> {
  if (!supabase) throw new Error('Supabase is not configured — cannot upload.');
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }
  const uid = await authUid();
  const safeName = file.name.replace(/[^\w\-. ]/g, '_');
  const path = `${uid}/${recordId}/uploads/${Date.now()}_${safeName}`;
  const { error } = await supabase.storage.from(MIGRATIONS_BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return { path, name: file.name, mimeType: file.type || '', size: file.size };
}

/** File extensions the migration extractor can actually read (PDF / images via
 * vision, CSV-text directly, Excel converted to CSV client-side). Word / PPT /
 * archives are NOT extractable, so they're shown disabled in the Files picker. */
const MIGRATION_ATTACHABLE_EXTS = new Set([
  'pdf',
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  'csv', 'tsv', 'txt',
  'xlsx', 'xls',
]);

/** True when a filename's extension is one the migration extractor can read. */
export function isMigrationAttachableName(name: string): boolean {
  const ix = name.lastIndexOf('.');
  if (ix < 0 || ix === name.length - 1) return false;
  return MIGRATION_ATTACHABLE_EXTS.has(name.slice(ix + 1).toLowerCase());
}

/**
 * Turn a file that already lives in the app's Files library (`wassel-files`)
 * into a `File` object, by fetching its bytes through a permission-checked
 * signed URL (`/api/files/sign-download-url`, which works for owned AND
 * shared-with-me files). The caller then feeds it through the same upload path
 * as a locally-picked file, so a library pick is indistinguishable from a
 * drag-drop. Throws (no silent failure — see CLAUDE.md) on oversize, a
 * permission/sign error, or a download failure.
 */
export async function downloadLibraryFileAsFile(file: {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
}): Promise<File> {
  if (file.size_bytes > MAX_UPLOAD_BYTES) {
    throw new Error(
      `"${file.original_name}" too large (${(file.size_bytes / 1024 / 1024).toFixed(1)} MB). Max is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`,
    );
  }
  const signRes = await fetch('/api/files/sign-download-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ fileId: file.id }),
  });
  const body = (await signRes.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!signRes.ok || !body.url) {
    throw new Error(body.error ?? `Could not access "${file.original_name}" in your library (${signRes.status}).`);
  }
  const dl = await fetch(body.url);
  if (!dl.ok) {
    throw new Error(`Could not download "${file.original_name}" from your library (${dl.status}).`);
  }
  const blob = await dl.blob();
  return new File([blob], file.original_name, {
    type: file.mime_type || blob.type || 'application/octet-stream',
  });
}

/** Best-effort removal of an uploaded file (when the user de-selects it). */
export async function deleteMigrationFile(path: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured — cannot remove file.');
  const { error } = await supabase.storage.from(MIGRATIONS_BUCKET).remove([path]);
  if (error) throw new Error(`Remove failed: ${error.message}`);
}

// ─── Enqueue the file-heavy AI steps onto the worker (no held-open request) ──
// Each POST returns fast (202 { job_id }). The worker runs the long vision call
// and writes status / phase / progress / results onto the record; the SPA reads
// them live via Realtime. Throws on a non-2xx (callers surface via addToast).

async function postMigrate(payload: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(
    '/api/migrate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );
  const body = (await res.json().catch(() => ({}))) as { error?: string; [k: string]: unknown };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

/** Enqueue the full extraction (records-mode source fusion OR project-mode
 * single extract — the worker decides from `mode`). Returns the job id. */
export async function enqueueExtraction(input: {
  recordId: string;
  fields: TargetFieldLite[];
  mode: 'records' | 'project';
  language: 'ar' | 'en';
  guidance?: string;
}): Promise<{ jobId: string }> {
  const body = await postMigrate({
    action: 'extract',
    recordId: input.recordId,
    fields: input.fields,
    mode: input.mode,
    language: input.language,
    guidance: input.guidance,
  });
  // Start the wizard's Realtime-independent poll (covers a blocked wss://).
  markMigrationJobEnqueued(input.recordId);
  return { jobId: String(body.job_id ?? '') };
}

/** Enqueue ONE pre-extraction PLAN turn. The endpoint appends the operator's
 * message + submitted card answers to the record first (so the chat updates via
 * Realtime); the worker writes the AI's reply + questions + structure. */
export async function enqueuePlanTurn(input: {
  recordId: string;
  userText: string;
  instructions?: string;
  answered?: AnsweredQuestion[];
  fields: TargetFieldLite[];
  language: 'ar' | 'en';
}): Promise<{ jobId: string }> {
  const body = await postMigrate({
    action: 'plan',
    recordId: input.recordId,
    userText: input.userText,
    instructions: input.instructions,
    answered: input.answered ?? [],
    fields: input.fields,
    language: input.language,
  });
  // Start the wizard's Realtime-independent poll (covers a blocked wss://).
  markMigrationJobEnqueued(input.recordId);
  return { jobId: String(body.job_id ?? '') };
}

/** Enqueue ONE post-extraction DISCUSS turn (recount / revise / explain). */
export async function enqueueDiscussTurn(input: {
  recordId: string;
  userText: string;
  fields: TargetFieldLite[];
  language: 'ar' | 'en';
}): Promise<{ jobId: string }> {
  const body = await postMigrate({
    action: 'discuss',
    recordId: input.recordId,
    userText: input.userText,
    fields: input.fields,
    language: input.language,
  });
  // Start the wizard's Realtime-independent poll (covers a blocked wss://).
  markMigrationJobEnqueued(input.recordId);
  return { jobId: String(body.job_id ?? '') };
}

/** Cancel the active extraction/plan/discuss job for a record + reset its busy
 * state. Throws on failure. */
export async function cancelMigrationJob(recordId: string): Promise<void> {
  await postMigrate({ action: 'cancel', recordId });
}

/** Ask the AI to map source columns → target fields. Throws on failure. */
export async function suggestMappings(
  headers: string[],
  sampleRows: string[][],
  fields: TargetFieldLite[],
  language: 'ar' | 'en' = 'ar',
): Promise<ColumnMappingSuggestion[]> {
  const res = await fetchWithTimeout('/api/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'suggest_mappings', headers, sampleRows, fields, language }),
  }, 90_000);
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    mappings?: ColumnMappingSuggestion[];
    error?: string;
  };
  if (!res.ok || !body.ok || !Array.isArray(body.mappings)) {
    throw new Error(body.error ?? `Mapping failed (${res.status})`);
  }
  return body.mappings;
}

/** A candidate value the AI may match a raw value against. dropdown/multiselect
 * → value + labels; lookup → id + display. */
export interface StandardizeCandidate {
  value?: string;
  label_ar?: string;
  label_en?: string;
  id?: string;
  display?: string;
}

export interface StandardizeDecision {
  rawValue: string;
  kind: 'match' | 'new' | 'unmatched';
  candidateId: string | null;
  canonical: string;
  confidence: number;
  reason: string;
}

/** Ask the AI to standardize one column's distinct values. Throws on failure. */
export async function standardizeColumn(input: {
  fieldType: 'dropdown' | 'multiselect' | 'lookup';
  fieldLabel: string;
  candidates: StandardizeCandidate[];
  rawValues: string[];
  language?: 'ar' | 'en';
}): Promise<StandardizeDecision[]> {
  const res = await fetchWithTimeout('/api/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'standardize', ...input }),
  }, 90_000);
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    decisions?: StandardizeDecision[];
    error?: string;
  };
  if (!res.ok || !body.ok || !Array.isArray(body.decisions)) {
    throw new Error(body.error ?? `Standardization failed (${res.status})`);
  }
  return body.decisions;
}

// ─── Prompt library (saved extraction-instruction templates) ────────────────
// A small SHARED library of reusable instruction prompts the operator picks from
// (or saves the current instructions into) before starting an AI analysis. Lives
// in the `migration_prompts` table (RLS: everyone reads; author edits/deletes).
// Every call throws on failure — callers surface via addToast (see CLAUDE.md).

export interface MigrationPrompt {
  id: string;
  label: string;
  body: string;
}

/** All saved prompts (shared across the team), newest first. */
export async function listMigrationPrompts(): Promise<MigrationPrompt[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('migration_prompts')
    .select('id, label, body')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Could not load the prompt library: ${error.message}`);
  return (data ?? []) as MigrationPrompt[];
}

/** Save the current instructions as a new named prompt (stamped with the author). */
export async function saveMigrationPrompt(label: string, body: string): Promise<MigrationPrompt> {
  if (!supabase) throw new Error('Supabase is not configured — cannot save the prompt.');
  const uid = await authUid();
  const { data, error } = await supabase
    .from('migration_prompts')
    .insert({ label: label.trim(), body, created_by_user_id: uid })
    .select('id, label, body')
    .single();
  if (error || !data) throw new Error(`Could not save the prompt: ${error?.message ?? 'unknown error'}`);
  return data as MigrationPrompt;
}

/** Delete a prompt (RLS allows only the author). */
export async function deleteMigrationPrompt(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured — cannot delete the prompt.');
  const { error } = await supabase.from('migration_prompts').delete().eq('id', id);
  if (error) throw new Error(`Could not delete the prompt: ${error.message}`);
}
