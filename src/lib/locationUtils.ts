import type { AppRecord, MapsConfig, ModelField } from '@/types';

export const DEFAULT_MAP_CENTER = { lat: 24.7136, lng: 46.6753 } as const;
export const DEFAULT_MAP_ZOOM = 11;

// localStorage key for cached server-resolved coordinates. Keyed by raw URL
// string → LatLng or null (known-unresolvable). Cached forever because a
// Google Maps short URL's target is stable.
const URL_CACHE_KEY = 'wassell_maps_url_cache';

export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * Parse lat/lng out of the common Google Maps URL shapes. Returns null for
 * shortened `maps.app.goo.gl` links (CORS-blocked redirects) — those land in
 * the Maps view's "unresolvable" side list so users can fix them.
 *
 * Supported shapes:
 *   - `/@LAT,LNG[,ZOOM]` (Google Maps path viewport)
 *   - `!3dLAT!4dLNG` (Google Maps place coords)
 *   - `?q=LAT,LNG` / `?ll=LAT,LNG` / `?query=LAT,LNG`
 *   - Bare "LAT,LNG" string
 */
export function parseGoogleMapsUrl(input: string): LatLng | null {
  if (!input || typeof input !== 'string') return null;
  const str = input.trim();
  if (!str) return null;

  const placeMatch = str.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
  if (placeMatch) {
    const p = toLatLng(placeMatch[1], placeMatch[2]);
    if (p) return p;
  }
  const atMatch = str.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (atMatch) {
    const p = toLatLng(atMatch[1], atMatch[2]);
    if (p) return p;
  }
  const qMatch = str.match(/[?&](?:q|ll|query)=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (qMatch) {
    const p = toLatLng(qMatch[1], qMatch[2]);
    if (p) return p;
  }
  // Path-based: /maps/search/LAT,+LNG/... or /maps/place/.../LAT,LNG/...
  // Google URL-encodes the space between lat and lng as `+` or `%20`.
  const pathMatch = str.match(/\/(?:search|place|dir)\/(-?\d+\.?\d*)[,\s+](?:\+|%20)?\s*(-?\d+\.?\d*)/);
  if (pathMatch) {
    const p = toLatLng(pathMatch[1], pathMatch[2]);
    if (p) return p;
  }
  const bareMatch = str.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  if (bareMatch) {
    const p = toLatLng(bareMatch[1], bareMatch[2]);
    if (p) return p;
  }
  return null;
}

function toLatLng(latStr: string | undefined, lngStr: string | undefined): LatLng | null {
  if (!latStr || !lngStr) return null;
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * Resolve a record to lat/lng using the MapsConfig's configured sources.
 * URL-parse first, then manual lat/lng number fields, else null.
 */
export function resolveLocation(
  record: AppRecord,
  cfg: MapsConfig,
  fields: ModelField[],
): LatLng | null {
  const byId = new Map(fields.map((f) => [f.id, f]));

  if (cfg.location_url_field_id) {
    const field = byId.get(cfg.location_url_field_id);
    if (field) {
      const raw = record.data[field.name];
      if (typeof raw === 'string' && raw.trim()) {
        const parsed = parseGoogleMapsUrl(raw);
        if (parsed) return parsed;
      }
    }
  }

  if (cfg.manual_lat_field_id && cfg.manual_lng_field_id) {
    const latField = byId.get(cfg.manual_lat_field_id);
    const lngField = byId.get(cfg.manual_lng_field_id);
    if (latField && lngField) {
      const latRaw = record.data[latField.name];
      const lngRaw = record.data[lngField.name];
      const p = toLatLng(
        typeof latRaw === 'number' ? String(latRaw) : typeof latRaw === 'string' ? latRaw : undefined,
        typeof lngRaw === 'number' ? String(lngRaw) : typeof lngRaw === 'string' ? lngRaw : undefined,
      );
      if (p) return p;
    }
  }

  return null;
}

/**
 * Parse a pasted Google Maps style JSON. Invalid input becomes null so callers
 * fall back to Google's default theme.
 */
export function parseMapStyleJson(raw: string | null | undefined): google.maps.MapTypeStyle[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as google.maps.MapTypeStyle[];
  } catch {
    return null;
  }
}

/**
 * Resolve a pin color from a dropdown/multiselect field's first selected option.
 * Returns `fallback` (the model color) when no option is selected or colored.
 */
export function resolvePinColor(
  record: AppRecord,
  cfg: MapsConfig,
  fields: ModelField[],
  fallback: string,
): string {
  if (!cfg.pin_color_field_id) return fallback;
  const field = fields.find((f) => f.id === cfg.pin_color_field_id);
  if (!field || !field.options?.length) return fallback;
  const raw = record.data[field.name];
  const selectedValue = Array.isArray(raw) ? raw[0] : raw;
  if (selectedValue === undefined || selectedValue === null || selectedValue === '') return fallback;
  const option = field.options.find((o) => o.value === selectedValue || o.id === selectedValue);
  return option?.color ?? fallback;
}

export interface GoogleMapsIcon {
  url: string;
  scaledSize: { width: number; height: number } | unknown;
  anchor: { x: number; y: number } | unknown;
}

/**
 * Build a colored pin SVG as a Google Maps marker icon. Uses data URL so pin
 * color can be anything without shipping custom assets.
 */
export function buildColoredPinIcon(color: string): GoogleMapsIcon | undefined {
  if (typeof window === 'undefined' || !window.google?.maps) return undefined;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="36" viewBox="0 0 28 36"><path d="M14 0C6.27 0 0 6.27 0 14c0 10.5 14 22 14 22s14-11.5 14-22C28 6.27 21.73 0 14 0z" fill="${color}" stroke="#ffffff" stroke-width="1.5"/><circle cx="14" cy="14" r="5" fill="#ffffff"/></svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new window.google.maps.Size(28, 36),
    anchor: new window.google.maps.Point(14, 36),
  };
}

const PILL_FONT = '600 13px Amiri, "Segoe UI", system-ui, sans-serif';
const PILL_HEIGHT = 28;
const PILL_PAD_X = 14;
const PILL_MAX_TEXT_WIDTH = 200;
let _measureCanvas: HTMLCanvasElement | null = null;

function measureTextWidth(text: string, font: string): number {
  if (typeof document === 'undefined') return text.length * 7;
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  const ctx = _measureCanvas.getContext('2d');
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(text: string, maxWidth: number): string {
  if (measureTextWidth(text, PILL_FONT) <= maxWidth) return text;
  // Binary search for the longest prefix + ellipsis that fits.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (measureTextWidth(text.slice(0, mid) + '…', PILL_FONT) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, Math.max(lo, 1)) + '…';
}

/**
 * Build a labeled pill marker icon — rounded rectangle with the project name
 * (or any string) inside, in white text on a charcoal-or-copper background.
 *
 * Width is auto-sized to the text; text is truncated past PILL_MAX_TEXT_WIDTH.
 * Anchor is at the bottom-center so the pill sits on top of its lat/lng point.
 */
export function buildPillIcon(label: string, color: string): GoogleMapsIcon | undefined {
  if (typeof window === 'undefined' || !window.google?.maps) return undefined;
  const safeLabel = (label || '').trim() || '—';
  const truncated = truncate(safeLabel, PILL_MAX_TEXT_WIDTH);
  const textWidth = Math.ceil(measureTextWidth(truncated, PILL_FONT));
  const w = textWidth + PILL_PAD_X * 2;
  const h = PILL_HEIGHT;
  // Add room for a small downward "tail" beneath the pill so it visually
  // points at the lat/lng — same role as a pin's stem.
  const tail = 6;
  const totalH = h + tail;
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}">
    <rect x="0" y="0" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>
    <path d="M${w / 2 - 5} ${h - 1} L${w / 2} ${h + tail - 2} L${w / 2 + 5} ${h - 1} Z" fill="${color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>
    <text x="${w / 2}" y="${h / 2 + 5}" text-anchor="middle" fill="#ffffff" font-family="Amiri, 'Segoe UI', system-ui, sans-serif" font-weight="600" font-size="13">${escapeXmlText(truncated)}</text>
  </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(xml)}`,
    scaledSize: new window.google.maps.Size(w, totalH),
    anchor: new window.google.maps.Point(w / 2, totalH),
  };
}

/**
 * Build a circular cluster marker icon — copper-filled circle with the cluster
 * count in white. Diameter scales mildly with count so 100+ clusters read as
 * "big" without dwarfing the map.
 */
export function buildClusterIcon(count: number, color: string = '#B8734F'): GoogleMapsIcon | undefined {
  if (typeof window === 'undefined' || !window.google?.maps) return undefined;
  const text = String(count);
  // Diameter steps: 1–9 = 36, 10–49 = 42, 50–99 = 48, 100+ = 54.
  const d = count >= 100 ? 54 : count >= 50 ? 48 : count >= 10 ? 42 : 36;
  const r = d / 2;
  const fontSize = count >= 100 ? 14 : count >= 10 ? 15 : 16;
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}">
    <circle cx="${r}" cy="${r}" r="${r - 2}" fill="${color}" stroke="#ffffff" stroke-width="2"/>
    <text x="${r}" y="${r + fontSize / 3 + 1}" text-anchor="middle" fill="#ffffff" font-family="Amiri, 'Segoe UI', system-ui, sans-serif" font-weight="700" font-size="${fontSize}">${text}</text>
  </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(xml)}`,
    scaledSize: new window.google.maps.Size(d, d),
    anchor: new window.google.maps.Point(r, r),
  };
}

// ---------------------------------------------------------------------------
// Async server-side resolution (for shortened goo.gl URLs the browser can't
// follow due to CORS). Results are cached in localStorage forever.
// ---------------------------------------------------------------------------

type UrlCache = Record<string, LatLng | null>; // null = known-unresolvable

function loadUrlCache(): UrlCache {
  try {
    const raw = localStorage.getItem(URL_CACHE_KEY);
    return raw ? (JSON.parse(raw) as UrlCache) : {};
  } catch {
    return {};
  }
}

function saveUrlCache(cache: UrlCache): void {
  try {
    localStorage.setItem(URL_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // quota full — ignore, cache becomes best-effort
  }
}

export function getCachedResolution(url: string): LatLng | null | undefined {
  const cache = loadUrlCache();
  return url in cache ? cache[url] : undefined;
}

/**
 * Resolve a Google Maps URL to lat/lng, falling back to the server-side
 * `/api/resolve-maps-url` edge function for short URLs the browser can't
 * follow. Responses are cached in localStorage (forever) so each unique URL
 * only hits the server once.
 *
 * Returns null for URLs that resolve but yield no parseable coordinates
 * (treated as known-unresolvable and cached so we don't retry).
 */
export async function resolveMapsUrlAsync(url: string): Promise<LatLng | null> {
  // Fast path: client-side parse works for most long URLs.
  const sync = parseGoogleMapsUrl(url);
  if (sync) return sync;

  const cache = loadUrlCache();
  const cached = cache[url];
  // Only short-circuit on a SUCCESSFUL cached resolution. `null` means
  // "previously failed" and we always retry (in case the edge function was
  // down / mid-deploy when it was cached).
  if (cached) return cached;

  try {
    const res = await fetch(`/api/resolve-maps-url?url=${encodeURIComponent(url)}`);
    if (!res.ok) return null; // don't cache — retry on next mount
    const data = (await res.json()) as { lat: number | null; lng: number | null };
    if (typeof data.lat === 'number' && typeof data.lng === 'number') {
      const result: LatLng = { lat: data.lat, lng: data.lng };
      cache[url] = result;
      saveUrlCache(cache);
      return result;
    }
    return null; // 200 but server found no coords — don't cache, always retry
  } catch {
    return null; // network failure — don't cache, retry next mount
  }
}

/**
 * Sync version of `resolveLocation` that also consults the localStorage cache.
 * Use this in render paths; async resolution happens in the `useResolvedLocations`
 * hook before this is called.
 */
export function resolveLocationWithCache(
  record: AppRecord,
  cfg: MapsConfig,
  fields: ModelField[],
): LatLng | null {
  const direct = resolveLocation(record, cfg, fields);
  if (direct) return direct;

  if (!cfg.location_url_field_id) return null;
  const field = fields.find((f) => f.id === cfg.location_url_field_id);
  if (!field) return null;
  const raw = record.data[field.name];
  if (typeof raw !== 'string' || !raw.trim()) return null;

  const cached = getCachedResolution(raw.trim());
  return cached ?? null;
}

/**
 * Pick the records whose location URL needs server-side resolution. Skips
 * records that already resolve via the sync path (URL parse or manual lat/lng)
 * and records whose URL is SUCCESSFULLY cached. A `null` cache entry (prior
 * failed resolution) is NOT skipped — it retries so that previously-failed
 * URLs auto-recover once the edge function comes online or the deploy lands.
 */
export function collectUrlsNeedingResolution(
  records: AppRecord[],
  cfg: MapsConfig,
  fields: ModelField[],
): string[] {
  if (!cfg.location_url_field_id) return [];
  const urlField = fields.find((f) => f.id === cfg.location_url_field_id);
  if (!urlField) return [];

  const cache = loadUrlCache();
  const out = new Set<string>();
  for (const rec of records) {
    if (resolveLocation(rec, cfg, fields)) continue; // sync path worked
    const raw = rec.data[urlField.name];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (parseGoogleMapsUrl(trimmed)) continue; // sync parse works
    if (cache[trimmed]) continue; // successfully cached — skip; null/missing retries
    out.add(trimmed);
  }
  return [...out];
}
