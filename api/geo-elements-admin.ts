/**
 * POST /api/geo-elements-admin
 *
 * Admin management surface for the geo_elements dataset (the /settings/geo-elements
 * module). Action-based dispatch, every action ADMIN-ONLY: the caller's JWT is
 * verified (withAuth) and then wassell_is_admin(auth.uid()) is checked server-side
 * before any service-role RPC runs — same posture as /api/market-intelligence's
 * recompute. The underlying RPCs are locked to service_role.
 *
 * This is a MANAGEMENT surface only. It does NOT change matching semantics,
 * geoMatch.ts, the compile/match RPCs, or the client resolver
 * (wassell_search_geo_elements / GET /api/geo-elements). Geometry is read-only.
 *
 * Actions:
 *   list   { filters…, limit, offset }            → { total, rows }
 *   facets {}                                      → { categories, types, cities, … }
 *   get    { external_id }                         → full element (+ raw, geojson, aliases)
 *   update { external_id, patch }                  → updated element   (whitelisted fields)
 *   alias_add    { external_id, alias, lang? }     → aliases[]
 *   alias_remove { alias_id }                      → aliases[]
 */

import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';

export const config = { runtime: 'edge' };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const numOrNull = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); if (Number.isFinite(n)) return n; }
  return null;
};
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const intOr = (v: unknown, d: number): number => {
  const n = numOrNull(v);
  return n == null ? d : Math.trunc(n);
};

// Only these keys may be written by the admin module (no geometry editing).
const UPDATE_KEYS = ['review_status', 'is_active', 'is_searchable', 'name_ar', 'name_en', 'notes'] as const;

interface Body {
  action?: string;
  // list filters
  q?: string; category?: string; type?: string; city?: string; geometry_type?: string;
  review_status?: string; is_verified?: boolean; is_approximate?: boolean;
  is_active?: boolean; is_searchable?: boolean;
  conf_min?: number; conf_max?: number; low_confidence?: boolean;
  limit?: number; offset?: number;
  // get / update / alias
  external_id?: string;
  patch?: Record<string, unknown>;
  alias?: string; lang?: string; alias_id?: string;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: Body;
    try { body = (await req.json()) as Body; } catch { return jsonError(400, 'invalid JSON body'); }

    const svc = makeServiceClient('api:geo-elements-admin');
    if (!svc) return jsonError(500, 'service client unavailable (SUPABASE_SERVICE_ROLE_KEY missing)');

    // ADMIN GATE — every action is admin-only.
    const { data: isAdmin, error: adminErr } = await svc.rpc('wassell_is_admin', { auth_user_id: user.userId });
    if (adminErr) return jsonError(500, `admin check failed: ${adminErr.message}`);
    if (isAdmin !== true) return jsonError(403, 'Geo Elements management is admin-only');

    const action = str(body.action) ?? 'list';

    switch (action) {
      case 'list': {
        const { data, error } = await svc.rpc('wassell_admin_list_geo_elements', {
          p_q: str(body.q), p_category: str(body.category), p_type: str(body.type), p_city: str(body.city),
          p_geom_kind: str(body.geometry_type), p_review_status: str(body.review_status),
          p_is_verified: boolOrNull(body.is_verified), p_is_approximate: boolOrNull(body.is_approximate),
          p_is_active: boolOrNull(body.is_active), p_is_searchable: boolOrNull(body.is_searchable),
          p_conf_min: numOrNull(body.conf_min), p_conf_max: numOrNull(body.conf_max),
          p_low_confidence: boolOrNull(body.low_confidence),
          p_limit: Math.min(Math.max(intOr(body.limit, 50), 1), 200),
          p_offset: Math.max(intOr(body.offset, 0), 0),
        });
        if (error) return jsonError(502, `list failed: ${error.message}`);
        return jsonOk(data ?? { total: 0, rows: [] });
      }
      case 'facets': {
        const { data, error } = await svc.rpc('wassell_admin_geo_facets');
        if (error) return jsonError(502, `facets failed: ${error.message}`);
        return jsonOk(data ?? {});
      }
      case 'map': {
        // Filtered GeoJSON FeatureCollection for the map view (simplified geometry).
        const { data, error } = await svc.rpc('wassell_admin_geo_geojson', {
          p_q: str(body.q), p_category: str(body.category), p_type: str(body.type), p_city: str(body.city),
          p_geom_kind: str(body.geometry_type), p_review_status: str(body.review_status),
          p_is_verified: boolOrNull(body.is_verified), p_is_approximate: boolOrNull(body.is_approximate),
          p_is_active: boolOrNull(body.is_active), p_is_searchable: boolOrNull(body.is_searchable),
          p_conf_min: numOrNull(body.conf_min), p_conf_max: numOrNull(body.conf_max),
          p_low_confidence: boolOrNull(body.low_confidence),
          p_limit: Math.min(Math.max(intOr(body.limit, 3000), 1), 5000),
        });
        if (error) return jsonError(502, `map failed: ${error.message}`);
        return jsonOk(data ?? { type: 'FeatureCollection', count: 0, features: [] });
      }
      case 'get': {
        const id = str(body.external_id);
        if (!id) return jsonError(400, 'external_id is required');
        const { data, error } = await svc.rpc('wassell_admin_get_geo_element', { p_external_id: id });
        if (error) return jsonError(502, `get failed: ${error.message}`);
        if (!data) return jsonError(404, 'geo element not found');
        return jsonOk({ element: data });
      }
      case 'update': {
        const id = str(body.external_id);
        if (!id) return jsonError(400, 'external_id is required');
        const raw = body.patch ?? {};
        // Whitelist — drop any non-editable key (geometry can never be edited here).
        const patch: Record<string, unknown> = {};
        for (const k of UPDATE_KEYS) if (k in raw) patch[k] = raw[k];
        if (Object.keys(patch).length === 0) return jsonError(400, 'no editable fields in patch');
        const { data, error } = await svc.rpc('wassell_admin_update_geo_element', { p_external_id: id, p_patch: patch });
        if (error) return jsonError(502, `update failed: ${error.message}`);
        return jsonOk({ element: data });
      }
      case 'alias_add': {
        const id = str(body.external_id);
        const alias = str(body.alias);
        if (!id || !alias) return jsonError(400, 'external_id and alias are required');
        const { data, error } = await svc.rpc('wassell_admin_add_geo_alias', { p_external_id: id, p_alias: alias, p_lang: str(body.lang) });
        if (error) return jsonError(502, `alias_add failed: ${error.message}`);
        return jsonOk({ aliases: data ?? [] });
      }
      case 'alias_remove': {
        const aliasId = str(body.alias_id);
        if (!aliasId) return jsonError(400, 'alias_id is required');
        const { data, error } = await svc.rpc('wassell_admin_remove_geo_alias', { p_alias_id: aliasId });
        if (error) return jsonError(502, `alias_remove failed: ${error.message}`);
        return jsonOk({ aliases: data ?? [] });
      }
      default:
        return jsonError(400, `unknown action: ${action}`);
    }
  });
}
