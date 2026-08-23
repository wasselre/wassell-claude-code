import type { AppModel, AppRecord, MapsConfig, ModelField } from '@/types';
import { resolveMirror } from './mirrorResolver';
import { collectViewFields, readExpandedValue, VIRTUAL_FIELD_SEPARATOR } from './sectionMirrorExpand';

export const DEFAULT_MAP_CENTER = { lat: 24.7136, lng: 46.6753 } as const;
export const DEFAULT_MAP_ZOOM = 11;

/**
 * The official Wassel-branded Google Maps theme — a warm, unmistakably-Wassel
 * canvas: soft cream land, sand parks (NO Google green), gold-sand water (NO
 * Google blue), copper highways, sand arterials, terracotta/chocolate borders.
 * This is the canonical map look used across every model's map. It becomes the
 * DEFAULT for any model whose `maps_config.map_style_json` is null/empty (see
 * `resolveMapStyles`), so the All Projects map and every other model's map
 * render identically out of the box.
 *
 * GEOMETRY ONLY — deliberately no label rules. The app draws its OWN place names
 * (the useGeoBoundaryLayer overlay + the district picker), and Google's basemap
 * text is turned OFF entirely by GEO_LABEL_SUPPRESSION (appended by every geo
 * surface). Keeping this style label-free means there is no colour rule left for
 * a future Google styler-resolution change to un-hide (the 2026-08-16 incident:
 * a specific `labels.text.fill` colour rule started winning over a broad
 * `labels` off and Google's names reappeared, doubling every name we draw).
 * With no label colour here and a global label-off there, Google text cannot
 * come back.
 *
 * A model can still override per-map by pasting its own style JSON in the Map
 * Builder, or paste `[]` to fall back to Google's stock theme. Label suppression
 * is appended to custom palettes too (see resolveGeoMapStyles).
 *
 * NOTE: the `all_projects` model USED to carry an older copy in its stored
 * `maps_config.map_style_json`. It was cleared to null (migration
 * 2026-08-23_wassel_map_palette) so this constant is the single source of truth.
 */
export const WASSEL_MAP_STYLE: google.maps.MapTypeStyle[] = [
  // Base canvas — warm sand-cream, a touch deeper than the page background so the
  // map reads as its own surface.
  { featureType: 'all', elementType: 'geometry', stylers: [{ color: '#F0E2C9' }] },
  // Land
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#F0E2C9' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#E9D8BA' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#F0E2C9' }] },
  // POI / parks — warm sand, NOT Google green
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#E4D1AC' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#D6C097' }] },
  // Water — gold-sand, NOT blue (the brand has no blue)
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#CBA877' }] },
  // Administrative borders — gold hairlines, terracotta provinces, chocolate country
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#C09B5F' }, { weight: 0.7 }] },
  { featureType: 'administrative.province', elementType: 'geometry.stroke', stylers: [{ color: '#8E4E3A' }, { weight: 1 }] },
  { featureType: 'administrative.country', elementType: 'geometry.stroke', stylers: [{ color: '#4A2C2A' }, { weight: 1.4 }] },
  // Roads — the branded backbone. Copper highways with terracotta casing carry
  // the identity; arterials in sand/gold; local streets warm-white.
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#FBF4E6' }] },
  { featureType: 'road.local', elementType: 'geometry', stylers: [{ color: '#FBF4E6' }] },
  { featureType: 'road.arterial', elementType: 'geometry.fill', stylers: [{ color: '#E1C99F' }] },
  { featureType: 'road.arterial', elementType: 'geometry.stroke', stylers: [{ color: '#C09B5F' }] },
  { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: '#B8734F' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#8E4E3A' }] },
  { featureType: 'road.highway.controlled_access', elementType: 'geometry.fill', stylers: [{ color: '#A9633F' }] },
  { featureType: 'road.highway.controlled_access', elementType: 'geometry.stroke', stylers: [{ color: '#4A2C2A' }] },
  // Transit — sand beds, terracotta lines
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#D6C097' }] },
  { featureType: 'transit.line', elementType: 'geometry', stylers: [{ color: '#8E4E3A' }] },
];

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
 * Cross-model context needed to resolve a `mirror` OR a `section_mirror` child
 * location field — the live value lives on a record in another model, reached
 * via the container's sibling lookup. Optional everywhere: when the configured
 * location field is a plain url/text field, no context is required (resolution
 * stays local to `record`).
 */
export interface LocationResolveCtx {
  allRecords: Record<string, AppRecord[]>;
  allModels: AppModel[];
}

/** First non-empty trimmed string from a scalar or (possibly nested) array, else null. */
function firstLocationString(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = firstLocationString(item);
      if (s) return s;
    }
    return null;
  }
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Read the raw location string for a record from a RESOLVED field. For a plain
 * url/text field that's just `record.data[field.name]`. For a `mirror` field
 * (e.g. a project's location mirrored from the master All Projects record) we
 * hop through the sibling lookup via `resolveMirror` — which is why mirror
 * resolution needs `ctx`. A multi-value mirror yields the first non-empty link.
 *
 * Note: this takes an already-resolved local `ModelField`. Section-mirror CHILD
 * fields aren't real fields on the model — they're handled in
 * `readConfiguredLocationString` below.
 */
function readLocationString(
  record: AppRecord,
  field: ModelField,
  ctx?: LocationResolveCtx,
): string | null {
  if (field.type === 'mirror') {
    if (!ctx) return null; // mirror needs cross-model context — caller didn't supply it
    const res = resolveMirror(field, record.data, ctx.allRecords, ctx.allModels);
    if (res.status !== 'ok') return null;
    return firstLocationString(res.value);
  }

  return firstLocationString(record.data[field.name]);
}

/**
 * Read the location string for `cfg.location_url_field_id`, resolving all three
 * field kinds the Map Builder offers:
 *   1. a plain url/text field on this model,
 *   2. a `mirror` field whose target is a url/text field on a linked model,
 *   3. a `section_mirror` CHILD field — a url/text field surfaced from another
 *      model through a section-mirror container. Its id is the compound
 *      `${containerId}::${childSlug}`, so it isn't a real field on the model;
 *      we expand the model's view fields and read through the container's
 *      sibling lookup via `readExpandedValue` (e.g. Our Projects pinning from
 *      All Projects' "موقع المشروع" url, surfaced via its بيانات المشروع mirror).
 *
 * Kinds 2 and 3 read a value off another model's record, so both require `ctx`
 * (the hook supplies it whenever the configured field is a mirror or a
 * section-mirror child). Returns null when the value is empty/unresolvable.
 */
function readConfiguredLocationString(
  record: AppRecord,
  cfg: MapsConfig,
  fields: ModelField[],
  ctx?: LocationResolveCtx,
): string | null {
  const fieldId = cfg.location_url_field_id;
  if (!fieldId) return null;

  // (3) Section-mirror child — compound `container::child` id.
  if (fieldId.includes(VIRTUAL_FIELD_SEPARATOR)) {
    if (!ctx) return null; // section-mirror child needs cross-model context
    const currentModel = ctx.allModels.find((m) => m.id === record.model_id);
    if (!currentModel) return null;
    const ef = collectViewFields(currentModel, ctx.allModels).find((e) => e.id === fieldId);
    if (!ef) return null;
    return firstLocationString(
      readExpandedValue(ef, record, ctx.allRecords, currentModel, ctx.allModels),
    );
  }

  // (1)/(2) Local url/text field, or a `mirror` whose target is url/text.
  const field = fields.find((f) => f.id === fieldId);
  if (!field) return null;
  return readLocationString(record, field, ctx);
}

/**
 * Resolve a record to lat/lng using the MapsConfig's configured sources.
 * URL-parse first (following a `mirror` field or a `section_mirror` child
 * through to its source when the location field is mirrored), then manual
 * lat/lng number fields, else null.
 */
export function resolveLocation(
  record: AppRecord,
  cfg: MapsConfig,
  fields: ModelField[],
  ctx?: LocationResolveCtx,
): LatLng | null {
  const byId = new Map(fields.map((f) => [f.id, f]));

  if (cfg.location_url_field_id) {
    const raw = readConfiguredLocationString(record, cfg, fields, ctx);
    if (raw) {
      const parsed = parseGoogleMapsUrl(raw);
      if (parsed) return parsed;
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
 * Resolve the map styles to apply for a model's map. A valid per-model style
 * JSON wins (including an explicit `[]` to opt back into Google's stock theme);
 * null/empty/invalid falls back to the shared Wassel theme so every model's map
 * matches the All Projects formatting by default.
 *
 * Always returns an array (never undefined) — pass straight to GoogleMap's
 * `options.styles`.
 */
/**
 * Silence EVERY basemap label so the app's own decluttered names are the only text
 * on the map. The user's requirement is explicit: no text from Google at all — one
 * name per place (ours), never Google's alongside it.
 *
 * This is a GLOBAL kill (no `featureType`, so it applies to every feature — roads,
 * districts, POIs, water, provinces, the lot) at all three label branches. Reasons
 * this beats the old per-featureType list:
 *
 *  · COMPLETE — the old list enumerated administrative.neighborhood/locality + POIs +
 *    transit and DELIBERATELY kept road labels, so Google's road names, province
 *    names and water names still showed and collided with our own district names
 *    (the "two names" report, 2026-08-23). A global rule leaves no gap to enumerate.
 *  · UNBEATABLE — WASSEL_MAP_STYLE now carries NO label colour rules, so there is no
 *    more-specific `labels.text.fill` for a Google styler-resolution change to let win
 *    over this off (the 2026-08-16 doubling incident). Base has no label colour; this
 *    turns every label off; nothing can un-hide them.
 *
 * TRADE-OFF: Google's road NAMES go too (they were the one thing the old list kept).
 * The app's overlay draws district/city names but not road names, so the map shows no
 * street names — a deliberate choice per "no Google text". If road names are wanted
 * back, add them to the useGeoBoundaryLayer overlay, not here.
 *
 * Append to a style array — it must come AFTER the base style to win.
 */
export const GEO_LABEL_SUPPRESSION: google.maps.MapTypeStyle[] = [
  { elementType: 'labels', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
];

/** The standard map style for any surface that draws the geography layer. */
export const GEO_MAP_STYLE: google.maps.MapTypeStyle[] = [...WASSEL_MAP_STYLE, ...GEO_LABEL_SUPPRESSION];

/**
 * A custom style from `maps_config.map_style_json` PLUS the label suppression.
 *
 * Appending rather than replacing: an operator's custom palette is theirs to choose,
 * but the app draws its own place names on top, so the basemap's competing labels have
 * to go regardless of which palette is in play. Suppression comes last so it wins.
 */
export function resolveGeoMapStyles(rawJson: string | null | undefined): google.maps.MapTypeStyle[] {
  return [...resolveMapStyles(rawJson), ...GEO_LABEL_SUPPRESSION];
}

export function resolveMapStyles(rawJson: string | null | undefined): google.maps.MapTypeStyle[] {
  const parsed = parseMapStyleJson(rawJson);
  return parsed ?? WASSEL_MAP_STYLE;
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
  ctx?: LocationResolveCtx,
): LatLng | null {
  const direct = resolveLocation(record, cfg, fields, ctx);
  if (direct) return direct;

  const raw = readConfiguredLocationString(record, cfg, fields, ctx);
  if (!raw) return null;

  const cached = getCachedResolution(raw);
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
  ctx?: LocationResolveCtx,
): string[] {
  if (!cfg.location_url_field_id) return [];

  const cache = loadUrlCache();
  const out = new Set<string>();
  for (const rec of records) {
    if (resolveLocation(rec, cfg, fields, ctx)) continue; // sync path worked
    // Follows mirror fields AND section-mirror children to the source link.
    const trimmed = readConfiguredLocationString(rec, cfg, fields, ctx);
    if (!trimmed) continue;
    if (parseGoogleMapsUrl(trimmed)) continue; // sync parse works
    if (cache[trimmed]) continue; // successfully cached — skip; null/missing retries
    out.add(trimmed);
  }
  return [...out];
}

// ───────────────────────────────────────────────────────────────────────────
// District geometry + name-normalization helpers (district lookup migration).
// Used by the district map layer and by district resolution. GeoJSON coordinate
// order is [lng, lat] throughout.
// ───────────────────────────────────────────────────────────────────────────

/** Great-circle distance in km between two points (haversine). */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Distance in km between two district centroids. */
export function distanceBetweenCentroids(a: LatLng, b: LatLng): number {
  return haversineKm(a.lat, a.lng, b.lat, b.lng);
}

/** Ray-casting point-in-ring test. `ring` is an array of [lng, lat] pairs. */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i], pj = ring[j];
    if (!pi || !pj) continue;
    const xi = pi[0]!, yi = pi[1]!, xj = pj[0]!, yj = pj[1]!;
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

type GeoJsonGeometry =
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'MultiPolygon'; coordinates: number[][][][] };

/** True if (lng,lat) is inside the GeoJSON Polygon/MultiPolygon, honoring holes. */
export function pointInPolygon(lng: number, lat: number, geometry: GeoJsonGeometry): boolean {
  if (!geometry) return false;
  const inPoly = (poly: number[][][]) => {
    const outer = poly[0];
    if (!outer || !pointInRing(lng, lat, outer)) return false; // outside outer ring
    for (let h = 1; h < poly.length; h++) {
      const hole = poly[h];
      if (hole && pointInRing(lng, lat, hole)) return false; // in a hole
    }
    return true;
  };
  if (geometry.type === 'Polygon') return inPoly(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(inPoly);
  return false;
}

/** True if a project pin (lat,lng) falls within a district boundary (GeoJSON object or string). */
export function pointInDistrict(lat: number, lng: number, boundary: GeoJsonGeometry | string | null | undefined): boolean {
  if (!boundary) return false;
  let geom: GeoJsonGeometry | null = null;
  if (typeof boundary === 'string') {
    try { geom = JSON.parse(boundary) as GeoJsonGeometry; } catch { return false; } // malformed GeoJSON → not contained
  } else {
    geom = boundary;
  }
  return pointInPolygon(lng, lat, geom);
}

/** Normalize an Arabic district name for matching: drop the "حي " prefix, strip
 *  tatweel, unify alef/teh-marbuta variants, collapse whitespace, lower-case. */
export function normalizeArabicDistrictName(name: string | null | undefined): string {
  return String(name ?? '')
    .replace(/^\s*حي\s+/, '')
    .replace(/ـ/g, '') // tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Normalize an English district name: drop the trailing "Dist." suffix, lower-case. */
export function normalizeEnglishDistrictName(name: string | null | undefined): string {
  return String(name ?? '')
    .replace(/\s*Dist\.?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
