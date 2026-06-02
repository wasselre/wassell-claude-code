/**
 * Browser-side helpers for the Data Migration wizard.
 *
 * Uploads go to the private `wassel-migrations` bucket under
 *   <authUid>/<recordId>/uploads/<ts>_<name>
 * (RLS scopes read/write to the owner). For the AI EXTRACT step the client
 * mints a short-lived signed URL per file and passes it to POST /api/migrate
 * — no service-role, the function just fetches the URL. Excel/CSV never hit
 * the AI (parsed client-side by readExcelFile).
 *
 * Every call throws on failure (no silent failure — see CLAUDE.md); callers
 * surface the message via addToast + a retry affordance.
 */

import { supabase } from '@/lib/supabase';
import type { RawTable, ColumnMappingSuggestion } from './types';
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
      throw new Error('Request timed out — try again, or split the input into smaller files.');
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

/** Best-effort removal of an uploaded file (when the user de-selects it). */
export async function deleteMigrationFile(path: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured — cannot remove file.');
  const { error } = await supabase.storage.from(MIGRATIONS_BUCKET).remove([path]);
  if (error) throw new Error(`Remove failed: ${error.message}`);
}

export interface ExtractResult extends RawTable {
  files_processed: number;
  files_skipped: { name: string; reason: string }[];
}

/**
 * Run AI extraction over the given uploaded files. Mints a fresh signed URL
 * per file, then POSTs to /api/migrate (action=extract). Returns the unified
 * raw table. Throws on failure.
 */
export async function extractRawTable(
  uploads: MigrationUpload[],
  language: 'ar' | 'en' = 'ar',
): Promise<ExtractResult> {
  if (!supabase) throw new Error('Supabase is not configured.');
  if (uploads.length === 0) throw new Error('No files to extract.');

  const files: { name: string; mimeType: string; url: string }[] = [];
  for (const u of uploads) {
    const { data, error } = await supabase.storage
      .from(MIGRATIONS_BUCKET)
      .createSignedUrl(u.path, 600);
    if (error || !data?.signedUrl) {
      throw new Error(`Could not read "${u.name}": ${error?.message ?? 'no signed URL'}`);
    }
    files.push({ name: u.name, mimeType: u.mimeType, url: data.signedUrl });
  }

  const res = await fetchWithTimeout('/api/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'extract', files, language }),
  }, 300_000);
  const body = (await res.json().catch(() => ({}))) as Partial<ExtractResult> & {
    ok?: boolean;
    error?: string;
  };
  if (!res.ok || !body.ok || !Array.isArray(body.headers)) {
    throw new Error(body.error ?? `Extraction failed (${res.status})`);
  }
  return {
    headers: body.headers,
    rows: Array.isArray(body.rows) ? body.rows : [],
    notes: body.notes,
    truncated: Boolean(body.truncated),
    source: 'ai_extract',
    files_processed: body.files_processed ?? uploads.length,
    files_skipped: body.files_skipped ?? [],
  };
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

export interface CountResultRow {
  rowIndex: number;
  count: number;
  reason: string;
}

/** Ask the AI to count a per-unit total (e.g. total bathrooms) from each row's
 * description. Throws on failure. */
export async function countField(input: {
  fieldLabel: string;
  rows: { rowIndex: number; text: string }[];
  language?: 'ar' | 'en';
}): Promise<CountResultRow[]> {
  const res = await fetchWithTimeout('/api/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      action: 'count_field',
      fieldLabel: input.fieldLabel,
      countRows: input.rows,
      language: input.language ?? 'ar',
    }),
  }, 120_000);
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    counts?: CountResultRow[];
    error?: string;
  };
  if (!res.ok || !body.ok || !Array.isArray(body.counts)) {
    throw new Error(body.error ?? `Counting failed (${res.status})`);
  }
  return body.counts;
}
