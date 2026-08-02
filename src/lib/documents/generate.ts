/**
 * Browser-side helpers for the document-generation endpoints.
 *
 * Generation runs on the Fly worker (document_jobs queue) — these are thin HTTP
 * POSTs that enqueue + poll, never holding a request open for the render (same
 * posture as decks / office-preview). The panel polls pollDocumentJob until the
 * job reaches ready/failed.
 */

import { supabase } from '@/lib/supabase';

export async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Enqueue a generation job. Returns the job id to poll. `language` picks the
 *  render language of the PDF (W4) — callers pass the current UI language. */
export async function enqueueGenerateDocument(input: {
  recordId: string;
  modelId: string;
  templateId: string;
  language?: 'ar' | 'en';
}): Promise<{ jobId: string }> {
  const res = await fetch('/api/generate-document', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ ...input, language: input.language === 'en' ? 'en' : 'ar' }),
  });
  const body = (await res.json().catch(() => ({}))) as { job_id?: string; error?: string };
  if (!res.ok || !body.job_id) {
    throw new Error(body.error ?? `POST /api/generate-document failed (${res.status})`);
  }
  return { jobId: body.job_id };
}

export type DocumentJobStatus =
  | { status: 'pending' }
  | { status: 'ready'; fileId: string; name: string; url: string; expiresAt?: string }
  | { status: 'failed'; error: string };

/** Poll one generation job. Structured result — the panel renders the failure
 *  state inline (no toast here), mirroring the office-preview poll. */
export async function pollDocumentJob(jobId: string): Promise<DocumentJobStatus> {
  const res = await fetch('/api/document-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ jobId }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    status?: string;
    file_id?: string;
    name?: string;
    url?: string;
    expires_at?: string;
    error?: string;
  };
  if (!res.ok) {
    return { status: 'failed', error: body.error ?? `status check failed (${res.status})` };
  }
  if (body.status === 'ready' && body.file_id && body.url) {
    return { status: 'ready', fileId: body.file_id, name: body.name ?? 'document.pdf', url: body.url, expiresAt: body.expires_at };
  }
  if (body.status === 'failed') {
    return { status: 'failed', error: body.error ?? 'generation failed' };
  }
  return { status: 'pending' };
}

export interface GeneratedDocument {
  fileId: string;
  name: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
}

/** List the PDFs already generated for a record (completed jobs). */
export async function listGeneratedDocuments(recordId: string): Promise<GeneratedDocument[]> {
  const res = await fetch('/api/document-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ recordId }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    documents?: Array<{ file_id: string; name: string; size_bytes: number; url: string; created_at: string }>;
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `POST /api/document-status failed (${res.status})`);
  return (body.documents ?? []).map((d) => ({
    fileId: d.file_id,
    name: d.name,
    sizeBytes: d.size_bytes,
    url: d.url,
    createdAt: d.created_at,
  }));
}
