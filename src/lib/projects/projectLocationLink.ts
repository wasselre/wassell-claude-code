/**
 * A project's SHAREABLE map link — the one thing a rep sends when a client
 * asks «وين موقع المشروع؟».
 *
 * Resolution order (first hit wins), all read straight off the all_projects
 * record's data:
 *   1. `project_location` (the live URL field) or `location_url` — a full
 *      http(s) URL is used as-is (Google Maps short links included, so the
 *      client opens exactly what the project team saved); a bare "lat,lng" or
 *      any other parseable Maps shape becomes a `maps?q=` link.
 *   2. `latitude` / `longitude` (the geocoded coordinates every mapped project
 *      carries) → `https://www.google.com/maps?q=lat,lng`.
 *
 * Returns null when the project has no location at all — callers must degrade
 * (disable the send button and say why), never send an empty link.
 *
 * NOTE: the `location` field on the live model is the region/city/district
 * cascade OBJECT, not a link — it is deliberately not consulted here.
 */
import { parseGoogleMapsUrl } from '@/lib/locationUtils';

const LINK_SLUGS = ['project_location', 'location_url', 'map_link', 'maps_url'] as const;

function asCoord(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

function mapsQueryUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function resolveProjectLocationLink(data: Record<string, unknown> | null | undefined): string | null {
  const d = data ?? {};
  for (const slug of LINK_SLUGS) {
    const raw = d[slug];
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s) continue;
    if (/^https?:\/\//i.test(s)) return s;
    const parsed = parseGoogleMapsUrl(s);
    if (parsed) return mapsQueryUrl(parsed.lat, parsed.lng);
  }
  const lat = asCoord(d.latitude);
  const lng = asCoord(d.longitude);
  if (lat != null && lng != null) return mapsQueryUrl(lat, lng);
  return null;
}

/**
 * The WhatsApp text that carries the link: a one-line label naming the project
 * (so the link is not a naked URL in the client's thread) + the link on its
 * own line, which WhatsApp turns into a tappable map preview.
 */
export function buildLocationMessage(projectName: string | null, link: string, isAr: boolean): string {
  const name = projectName?.trim();
  const label = isAr
    ? name ? `📍 موقع مشروع ${name}` : '📍 موقع المشروع'
    : name ? `📍 Location of ${name}` : '📍 Project location';
  return `${label}\n${link}`;
}
