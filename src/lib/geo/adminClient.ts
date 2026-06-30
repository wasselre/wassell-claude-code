/**
 * Admin client for the Geo Elements management module (/settings/geo-elements).
 * Talks to POST /api/geo-elements-admin (every action admin-gated server-side).
 * Separate from src/lib/geo/client.ts, which is the client-facing resolver.
 */
import { supabase } from '@/lib/supabase';

export interface GeoAdminRow {
  external_id: string;
  name_ar: string | null;
  name_en: string | null;
  display_name: string | null;
  category: string | null;
  type: string | null;
  city: string | null;
  geometry_type: string | null;
  confidence_score: number | null;
  is_verified: boolean;
  is_approximate: boolean;
  review_status: string;
  is_active: boolean;
  is_searchable: boolean;
  source_type: string | null;
  updated_at: string | null;
  created_at: string | null;
}

export interface GeoAlias { id: string; alias: string; lang: string | null }

export interface GeoAdminDetail extends GeoAdminRow {
  latitude: number | null;
  longitude: number | null;
  region_id: string | null;
  source_url: string | null;
  notes: string | null;
  geometry_summary: { postgis_type?: string; n_points?: number; n_geometries?: number; bbox?: string } | null;
  geojson: unknown;
  raw: unknown;
  aliases: GeoAlias[];
}

export interface GeoFacets {
  categories: string[]; types: string[]; cities: string[];
  geometry_types: string[]; review_statuses: string[]; source_types: string[];
  total: number;
}

export interface GeoListFilters {
  q?: string | null; category?: string | null; type?: string | null; city?: string | null;
  geometry_type?: string | null; review_status?: string | null;
  is_verified?: boolean | null; is_approximate?: boolean | null;
  is_active?: boolean | null; is_searchable?: boolean | null;
  low_confidence?: boolean | null; conf_min?: number | null; conf_max?: number | null;
  limit?: number; offset?: number;
}

export type GeoUpdatePatch = Partial<Pick<GeoAdminRow, 'review_status' | 'is_active' | 'is_searchable' | 'name_ar' | 'name_en'>> & { notes?: string | null };

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/geo-elements-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body?.error ?? `geo-admin ${action} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const adminListGeoElements = (f: GeoListFilters) => call<{ total: number; rows: GeoAdminRow[] }>('list', { ...f });
export const adminGeoFacets = () => call<GeoFacets>('facets');
export const adminGetGeoElement = (external_id: string) => call<{ element: GeoAdminDetail }>('get', { external_id });
export const adminUpdateGeoElement = (external_id: string, patch: GeoUpdatePatch) => call<{ element: GeoAdminDetail }>('update', { external_id, patch });
export const adminAddGeoAlias = (external_id: string, alias: string, lang?: string | null) => call<{ aliases: GeoAlias[] }>('alias_add', { external_id, alias, lang });
export const adminRemoveGeoAlias = (alias_id: string) => call<{ aliases: GeoAlias[] }>('alias_remove', { alias_id });
