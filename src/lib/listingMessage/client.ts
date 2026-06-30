/**
 * Browser-side helpers for the Listing Message flow.
 *
 *   generateListingMessageText  → POST /api/templates/listing-message
 *       AI-writes the bilingual message from the listing's facts + description.
 *   startListingClean / redoListingClean → POST /api/templates/clean-listing-images
 *       Create a draft + fan out per-photo text-removal jobs (start), or
 *       re-enqueue specific photos (redo). The Fly worker fills the draft's
 *       data.cleaning[] in place; the modal POLLS that draft for progress
 *       (read-only, in-flight-gated — robust when Realtime is network-blocked,
 *       same posture as the Data Migration wizard).
 */

import { supabase } from '@/lib/supabase';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type CleaningStatus = 'queued' | 'cleaning' | 'completed' | 'failed' | 'cancelled';

/** One photo's cleaning lifecycle, stored in the draft's data.cleaning[]. */
export interface CleaningEntry {
  id: string;
  image_index: number;
  source_url: string;
  status: CleaningStatus;
  output_url?: string;
  asset_id?: string;
  error?: string;
}

export interface StartCleanResponse {
  recordId: string;
  imageCount: number;
  jobIds: string[];
}

export async function startListingClean(listingId: string): Promise<StartCleanResponse> {
  const res = await fetch('/api/templates/clean-listing-images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ mode: 'start', listing_id: listingId }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(b?.error ?? `clean start failed (${res.status})`);
  }
  const j = (await res.json()) as { record_id?: string; image_count?: number; job_ids?: string[] };
  if (!j.record_id) throw new Error('clean start succeeded but record_id missing');
  return { recordId: j.record_id, imageCount: j.image_count ?? 0, jobIds: j.job_ids ?? [] };
}

export async function redoListingClean(recordId: string, entryIds: string[]): Promise<void> {
  const res = await fetch('/api/templates/clean-listing-images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ mode: 'redo', record_id: recordId, entry_ids: entryIds }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(b?.error ?? `redo failed (${res.status})`);
  }
}

export interface ListingMessageText {
  body_ar: string;
  body_en: string;
  facts?: Record<string, unknown>;
}

export async function generateListingMessageText(listingId: string): Promise<ListingMessageText> {
  const res = await fetch('/api/templates/listing-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ listing_id: listingId }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(b?.error ?? `message generation failed (${res.status})`);
  }
  const j = (await res.json()) as { body_ar?: string; body_en?: string; facts?: Record<string, unknown> };
  return { body_ar: j.body_ar ?? '', body_en: j.body_en ?? '', facts: j.facts };
}

/** Read a draft record's `data` (read-only poll for cleaning progress). */
export async function fetchDraftData(recordId: string): Promise<Record<string, unknown> | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from('records').select('data').eq('id', recordId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { data?: Record<string, unknown> } | null)?.data ?? null;
}

export function readCleaning(data: Record<string, unknown> | null | undefined): CleaningEntry[] {
  return Array.isArray(data?.cleaning) ? (data!.cleaning as CleaningEntry[]) : [];
}

/** True while at least one photo is still queued or cleaning. */
export function isCleaningInFlight(entries: CleaningEntry[]): boolean {
  return entries.some((e) => e.status === 'queued' || e.status === 'cleaning');
}
