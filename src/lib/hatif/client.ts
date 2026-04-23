/**
 * Browser-side helpers for reading Hatif call logs.
 *
 * Reads go directly to Supabase (with RLS letting any authenticated staff
 * read all rows). Any future write/trigger paths (IVR, outbound-bridge)
 * route through `/api/hatif/*` proxies so the Hatif client-secret stays
 * server-side.
 */

import { supabase } from '@/lib/supabase';
import type { CallLog } from '@/types';
import { normalizePhone } from '@/lib/phone';

/**
 * Fetch call history for a single phone number. Matches on `contact_phone`
 * (the normalized E.164 stored by the webhook). Most-recent first.
 * Returns [] when Supabase is not configured (offline mode).
 */
export async function listCallsForPhone(phone: string | null | undefined): Promise<CallLog[]> {
  if (!supabase) return [];
  const normalized = normalizePhone(phone);
  if (!normalized) return [];
  const { data, error } = await supabase
    .from('call_logs')
    .select('*')
    .eq('contact_phone', normalized)
    .order('creation_time', { ascending: false });
  if (error) {
    console.error('[hatif.listCallsForPhone] failed:', error.message);
    return [];
  }
  return (data ?? []) as CallLog[];
}

/**
 * Subscribe to live `call_logs` inserts/updates for a given phone number.
 * Returns an unsubscribe function; call it on unmount.
 */
export function subscribeToCallsForPhone(
  phone: string | null | undefined,
  onChange: () => void,
): () => void {
  const client = supabase;
  if (!client) return () => { /* noop */ };
  const normalized = normalizePhone(phone);
  if (!normalized) return () => { /* noop */ };
  const channel = client
    .channel(`call_logs:${normalized}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'call_logs', filter: `contact_phone=eq.${normalized}` },
      () => onChange(),
    )
    .subscribe();
  return () => { void client.removeChannel(channel); };
}
