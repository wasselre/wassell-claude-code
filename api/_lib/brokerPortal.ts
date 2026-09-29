/**
 * Shared by the two broker-portal endpoints (api/broker-portal.ts — edge, reads;
 * api/broker-portal-send.ts — nodejs, message preview + WhatsApp send).
 *
 * The token is the ONLY credential: it is resolved with the service role
 * against `broker_portals` (admin-only RLS, no anon grant) and scopes every
 * read to one developer. Wrong / inactive / expired all resolve to null so the
 * callers can answer the same 404.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface PortalRow {
  id: string;
  developer_id: string;
  title_ar: string | null;
  title_en: string | null;
  is_active: boolean;
  expires_at: string | null;
  send_enabled: boolean;
}

export const PORTAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolvePortal(svc: SupabaseClient, token: string): Promise<PortalRow | null> {
  if (!token || token.length > 128) return null;
  const { data, error } = await svc
    .from('broker_portals')
    .select('id, developer_id, title_ar, title_en, is_active, expires_at, send_enabled')
    .eq('token', token)
    .maybeSingle();
  if (error) throw new Error(`portal lookup failed: ${error.message}`);
  const row = data as PortalRow | null;
  if (!row || !row.is_active) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

/** The project record when it belongs to the portal's developer, else null. */
export async function portalProject(
  svc: SupabaseClient,
  portal: PortalRow,
  projectId: string,
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  if (!PORTAL_UUID_RE.test(projectId)) return null;
  const { data: model, error: mErr } = await svc.from('models').select('id').eq('name', 'all_projects').maybeSingle();
  if (mErr || !model) throw new Error(`all_projects model lookup failed: ${mErr?.message ?? 'missing'}`);
  const { data, error } = await svc
    .from('records').select('id, data').eq('id', projectId).eq('model_id', model.id as string).maybeSingle();
  if (error) throw new Error(`project lookup failed: ${error.message}`);
  const row = data as { id: string; data: Record<string, unknown> } | null;
  if (!row || row.data.developer !== portal.developer_id) return null;
  return row;
}
