/**
 * Browser-side helpers for the Data Migration wizard.
 *
 * Uploads go to the private `wassel-migrations` bucket under
 *   <authUid>/<recordId>/uploads/<ts>_<name>
 * (RLS scopes read/write to the owner). For the AI EXTRACT step the client
 * mints a short-lived signed URL per file and passes it to POST /api/migrate
 * — no service-role, the function just fetches the URL. Excel can go either
 * way: parsed client-side by readExcelFile (the direct fast path) OR converted
 * to per-sheet CSV text and uploaded into the AI extraction set like a PDF.
 *
 * Every call throws on failure (no silent failure — see CLAUDE.md); callers
 * surface the message via addToast + a retry affordance.
 */

import { supabase } from '@/lib/supabase';
import type {
  RawTable,
  ColumnMappingSuggestion,
  ProjectIntelligenceSection,
  DiscoveredUnit,
} from './types';
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

export interface ExtractResult extends RawTable {
  /** mode='project' only: the project-level intelligence sections. */
  intelligence?: ProjectIntelligenceSection[];
  /** mode='project' only: the Arabic Project Knowledge Document. */
  document?: string;
  files_processed: number;
  files_skipped: { name: string; reason: string }[];
}

/**
 * Run AI extraction over the given uploaded files. Mints a fresh signed URL
 * per file, then POSTs to /api/migrate (action=extract). Returns the unified
 * raw table. mode='project' (the projects-model target) returns one project
 * row + the Arabic marketing `document` instead of a per-unit table. Throws
 * on failure.
 */
export async function extractRawTable(
  uploads: MigrationUpload[],
  language: 'ar' | 'en' = 'ar',
  fields: TargetFieldLite[] = [],
  mode: 'records' | 'project' = 'records',
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
    body: JSON.stringify({ action: 'extract', files, language, fields, mode }),
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
    summary: body.summary,
    intelligence:
      Array.isArray(body.intelligence) && body.intelligence.length > 0
        ? body.intelligence
        : undefined,
    document: typeof body.document === 'string' && body.document.trim() ? body.document : undefined,
    truncated: Boolean(body.truncated),
    source: 'ai_extract',
    files_processed: body.files_processed ?? uploads.length,
    files_skipped: body.files_skipped ?? [],
  };
}

// ─── Source-fusion extraction (records mode): discover → fuse_batch ──────────

/** Mint a fresh 10-min signed URL per upload (RLS-scoped to the owner) for an
 * AI call. Minted per-call, so a multi-batch fusion run never trips URL expiry
 * even when the whole run takes longer than one URL's lifetime. */
async function signUploads(
  uploads: MigrationUpload[],
): Promise<{ name: string; mimeType: string; url: string }[]> {
  if (!supabase) throw new Error('Supabase is not configured.');
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
  return files;
}

/** Throw a loud Error carrying any server `code` (e.g. 'max_tokens') so the
 * orchestrator can react — split the batch and retry rather than fail the run. */
function migrateFailed(body: { error?: string; code?: string }, status: number, fallback: string): never {
  const err = new Error(body.error ?? `${fallback} (${status})`);
  if (body.code) (err as { code?: string }).code = body.code;
  throw err;
}

export interface DiscoverResult {
  headers: string[];
  units: DiscoveredUnit[];
  sources: { name: string; kind: string; note?: string }[];
  notes?: string;
  truncated: boolean;
  files_processed: number;
  files_skipped: { name: string; reason: string }[];
}

export interface FuseBatchResult {
  rows: { key: string; values: string[] }[];
  conflicts: {
    unitKey: string;
    header: string;
    candidates: { source: string; value: string }[];
    chosen: string;
    note: string;
  }[];
  notes?: string;
  truncated: boolean;
}

/**
 * Phase 1 — inventory the sources and discover every unit across ALL uploaded
 * files. Returns the unit index (identifiers only) + the canonical header set.
 * Throws on failure (no silent failure — see CLAUDE.md).
 */
export async function discoverUnits(
  uploads: MigrationUpload[],
  language: 'ar' | 'en' = 'ar',
  fields: TargetFieldLite[] = [],
): Promise<DiscoverResult> {
  if (uploads.length === 0) throw new Error('No files to analyze.');
  const files = await signUploads(uploads);
  const res = await fetchWithTimeout('/api/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'discover', files, language, fields }),
  }, 300_000);
  const body = (await res.json().catch(() => ({}))) as Partial<DiscoverResult> & {
    ok?: boolean;
    error?: string;
    code?: string;
  };
  if (!res.ok || !body.ok || !Array.isArray(body.headers) || !Array.isArray(body.units)) {
    migrateFailed(body, res.status, 'Discovery failed');
  }
  return {
    headers: body.headers,
    units: body.units,
    sources: Array.isArray(body.sources) ? body.sources : [],
    notes: body.notes,
    truncated: Boolean(body.truncated),
    files_processed: body.files_processed ?? uploads.length,
    files_skipped: body.files_skipped ?? [],
  };
}

/**
 * Phase 2 — resolve ONE batch of units by fusing facts across every source.
 * On a truncation the thrown Error carries `code:'max_tokens'` so the caller
 * can split the batch in half and retry. Throws on failure.
 */
export async function fuseUnitBatch(
  uploads: MigrationUpload[],
  language: 'ar' | 'en',
  fields: TargetFieldLite[],
  headers: string[],
  units: DiscoveredUnit[],
): Promise<FuseBatchResult> {
  const files = await signUploads(uploads);
  const res = await fetchWithTimeout('/api/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'fuse_batch', files, language, fields, headers, units }),
  }, 300_000);
  const body = (await res.json().catch(() => ({}))) as Partial<FuseBatchResult> & {
    ok?: boolean;
    error?: string;
    code?: string;
  };
  if (!res.ok || !body.ok || !Array.isArray(body.rows)) {
    migrateFailed(body, res.status, 'Fusion failed');
  }
  return {
    rows: body.rows,
    conflicts: Array.isArray(body.conflicts) ? body.conflicts : [],
    notes: body.notes,
    truncated: Boolean(body.truncated),
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

export interface EnrichColumnResult {
  header: string;
  values: string[];
}

/**
 * Post-extraction discussion — a multi-turn chat about the extracted table.
 * The AI explains its work (especially how it derived numbers from the floor
 * plans + text) and can revise the table (add / fill / recount a column, by
 * re-reading the brochure). Returns its `reply` plus any column edits the
 * caller merges into the table. Throws on failure.
 */
export async function discussExtraction(input: {
  messages: { role: 'user' | 'assistant'; content: string }[];
  headers: string[];
  rows: string[][];
  /** the migration's uploaded source files — minted into signed URLs so the AI
   * can re-read the brochure + floor plans. */
  uploads?: MigrationUpload[];
  /** the target model's fields (context only — never used to coerce values). */
  fields?: TargetFieldLite[];
  language?: 'ar' | 'en';
}): Promise<{ reply: string; columns: EnrichColumnResult[]; truncated: boolean }> {
  const files: { name: string; mimeType: string; url: string }[] = [];
  if (input.uploads && input.uploads.length > 0 && supabase) {
    for (const u of input.uploads) {
      const { data } = await supabase.storage.from(MIGRATIONS_BUCKET).createSignedUrl(u.path, 600);
      if (data?.signedUrl) files.push({ name: u.name, mimeType: u.mimeType, url: data.signedUrl });
    }
  }
  const res = await fetchWithTimeout('/api/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      action: 'discuss',
      messages: input.messages,
      headers: input.headers,
      rows: input.rows,
      files,
      fields: input.fields,
      language: input.language ?? 'ar',
    }),
  }, 300_000);
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    reply?: string;
    columns?: EnrichColumnResult[];
    truncated?: boolean;
    error?: string;
  };
  if (!res.ok || !body.ok || typeof body.reply !== 'string') {
    throw new Error(body.error ?? `Discuss failed (${res.status})`);
  }
  return {
    reply: body.reply,
    columns: Array.isArray(body.columns) ? body.columns : [],
    truncated: Boolean(body.truncated),
  };
}
