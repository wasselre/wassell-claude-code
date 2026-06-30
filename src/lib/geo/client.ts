/**
 * Resolver client for the geo-intelligence anchors (GET /api/geo-elements).
 * Searches geo_elements by name / aliases / category / type / city; returns only
 * active + searchable + approved anchors with their display flags. The chosen
 * anchor's `external_id` is what a within_radius location item references.
 */
import { supabase } from '@/lib/supabase';

export interface GeoElementHit {
  external_id: string;
  name_ar: string | null;
  name_en: string | null;
  display_name: string | null;
  category: string | null;
  type: string | null;
  /** Normalized geometry kind — drives the rule UI: 'point' | 'linestring' | 'polygon'. */
  geom_kind: 'point' | 'linestring' | 'polygon' | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  confidence_score: number | null;
  is_verified: boolean;
  is_approximate: boolean;
  review_status: string;
}

export interface GeoSearchOptions {
  category?: string;
  type?: string;
  city?: string;
  limit?: number;
}

export async function searchGeoElements(q: string, opts: GeoSearchOptions = {}): Promise<GeoElementHit[]> {
  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  if (opts.category) params.set('category', opts.category);
  if (opts.type) params.set('type', opts.type);
  if (opts.city) params.set('city', opts.city);
  params.set('limit', String(opts.limit ?? 20));

  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  const res = await fetch(`/api/geo-elements?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body?.error ?? `geo search failed (${res.status})`);
  }
  const body = (await res.json()) as { elements?: GeoElementHit[] };
  return body.elements ?? [];
}
