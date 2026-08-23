import { supabase } from '@/lib/supabase';

/**
 * One resolved acquisition touch for a client — a `client_attributions` row
 * resolved LIVE through the Ad to the marketing hierarchy. Nothing here is
 * stored on the client record; it is retrieved on demand via the relationship
 * (see the `mos_client_acquisition` SQL function).
 */
export interface AcquisitionTouch {
  id: string;
  occurred_at: string;
  touch_type: 'first' | 'last';
  channel: string;
  source: string;
  note: string | null;
  platform: string | null;
  ad_id: string | null;
  ad_name: string | null;
  ad_set_name: string | null;
  execution_id: string | null;
  execution_label: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  offer: string | null;
  project_id: string | null;
  project_name: string | null;
  content_id: string | null;
  content_title: string | null;
}

/**
 * Fetch a client's acquisition timeline. The RPC is SECURITY DEFINER and gates
 * on the caller being allowed to VIEW the client (not on a marketing role), so a
 * sales rep with no Marketing-OS capability still sees where their lead came
 * from. Returns [] on any failure or when Supabase is offline — the panel just
 * self-hides, it never blocks the form.
 */
export async function fetchClientAcquisition(clientRecordId: string): Promise<AcquisitionTouch[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('mos_client_acquisition', {
    p_client_record_id: clientRecordId,
  });
  if (error) {
    console.error('[acquisition] mos_client_acquisition failed:', error.message);
    return [];
  }
  return Array.isArray(data) ? (data as AcquisitionTouch[]) : [];
}
