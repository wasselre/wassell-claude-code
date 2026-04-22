import type { AppRecord, MapsConfig, ModelField } from '@/types';

export const DEFAULT_MAP_CENTER = { lat: 24.7136, lng: 46.6753 } as const;
export const DEFAULT_MAP_ZOOM = 11;

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
