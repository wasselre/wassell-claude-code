/**
 * Browser-side helper for the on-demand advertiser-phone lookup.
 *
 *   enqueueRegaLookup(listingRecordId) → POST /api/rega-lookup
 *       Enqueues ONE rega_lookup_jobs row. The Fly worker drives a Browserbase
 *       session → the listing's Aqar page → the official REGA advertising-license
 *       page → scrapes the advertiser name + agent mobile → writes
 *       advertiser_phone / advertiser_name (+ rega_lookup_status) onto the listing.
 *       The SPA watches the record via Realtime (the store already subscribes) and,
 *       when the phone lands, opens an in-app WhatsApp chat. Returns fast (202).
 */

import { supabase } from '@/lib/supabase';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Terminal states the worker writes to the listing's `rega_lookup_status`. */
export type RegaLookupStatus = 'running' | 'done' | 'no_license' | 'failed';

export async function enqueueRegaLookup(listingRecordId: string): Promise<{ jobId: string }> {
  const res = await fetch('/api/rega-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ recordId: listingRecordId }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(b?.error ?? `rega lookup failed (${res.status})`);
  }
  const j = (await res.json()) as { job_id?: string };
  if (!j.job_id) throw new Error('rega lookup enqueued but job_id missing');
  return { jobId: j.job_id };
}
