/**
 * GET /api/geo-elements — resolver for the client location UI.
 *
 * Lightweight search over the geo-intelligence anchors (geo_elements): by
 * name_ar / name_en / aliases / category / type / city. Returns ONLY
 * active + searchable + approved anchors by default, each with its
 * verified / approximate / confidence flags for display. Districts and geo
 * elements are picked in the SAME client location section; a chosen anchor's
 * `external_id` is what a within_radius location item references.
 *
 * Query params (all optional):
 *   q        free-text term (matched against names + aliases)
 *   category dataset category (e.g. malls, metro_stations, hospitals)
 *   type     finer type (e.g. metro_station, mall, ring_road)
 *   city     English city label, e.g. 'Riyadh' / 'Jeddah' / 'Dammam'. Anchors are
 *            NATIONWIDE since 2026-07-30 (41 cities), so callers should pass this
 *            whenever a city is known — `limit` is a single budget shared across
 *            every city, and an unscoped search spends it on the whole country.
 *   country  ISO-3166-1 alpha-2 ('SA' / 'AE'). geo_elements holds BOTH Saudi and
 *            UAE anchors, so without this an unscoped search can offer a Dubai
 *            mall for a Riyadh client. Omit only for a deliberate cross-border browse.
 *   limit    1..100 (default 30)
 *   include_unapproved=1  admin curation view (returns pending/non-searchable too)
 *
 * Deterministic, no AI. Auth: the caller's Supabase JWT (RLS-scoped). The search
 * RPC is SECURITY INVOKER — geo_elements RLS already allows authenticated SELECT.
 */

import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';

export const config = { runtime: 'edge' };

const str = (v: string | null): string | null => (v && v.trim() !== '' ? v.trim() : null);

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async () => {
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) return jsonError(500, 'Supabase env vars missing');

    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const u = new URL(req.url);
    const limitRaw = Number(u.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 30;
    const includeUnapproved = ['1', 'true', 'yes'].includes((u.searchParams.get('include_unapproved') ?? '').toLowerCase());

    const { data, error } = await supabase.rpc('wassell_search_geo_elements', {
      p_q: str(u.searchParams.get('q')),
      p_category: str(u.searchParams.get('category')),
      p_type: str(u.searchParams.get('type')),
      p_city: str(u.searchParams.get('city')),
      p_limit: limit,
      p_include_unapproved: includeUnapproved,
      p_country: str(u.searchParams.get('country')),
    });

    if (error) {
      console.error('[geo-elements] search failed:', error.message);
      return jsonError(502, `geo element search failed: ${error.message}`);
    }

    return jsonOk({ elements: data ?? [], count: (data ?? []).length });
  });
}
