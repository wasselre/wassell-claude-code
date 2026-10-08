import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Check, Loader2, Map as MapIcon, MapPin, Minus, PenLine, Plus, RotateCcw, Route, Search, TriangleAlert, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { DEFAULT_MAP_CENTER, buildPillIcon } from '@/lib/locationUtils';
import MapCanvas from '@/components/map/MapCanvas';
import {
  EditablePolygon, GeoJsonOverlay, MapTooltip, boundsOf, createIconMarker, createLabelMarker, extendBounds,
  fitToBounds, geometryFeature, getViewport, getZoomLevel, isMapRemoved, lineFeature, onEmptyMapClick,
  onViewportChange, pointFeature, polygonFeature, setMapCursor, toMapLibreZoom,
  type LatLng, type MlMap, type OverlayFeature, type OverlayProps, type OverlayStyle,
} from '@/lib/map';
import type { LngLatBounds, Marker } from '@/lib/map/maplibre';
import { geojsonToPaths, geojsonToLinePaths } from '@/lib/geo/geojsonPaths';
import { pickVisibleLabels } from '@/lib/geo/labelDeclutter';
import {
  DIRECTION_DEFAULT_M, describeLocationItem, isDirectionRule, newDistrictItem, newDrawnAreaItem,
  type DistrictLocationItem, type DrawnAreaLocationItem, type ElementCondition, type ElementRuleLocationItem,
  type GeoPolarity, type LocationItem,
} from '@/lib/geo/locationItems';
import { toEnglishDisplay } from '@/lib/geo/localizedName';

const isDistrictItem = (i: LocationItem): i is DistrictLocationItem => i.kind === 'district';
const isDrawnItem = (i: LocationItem): i is DrawnAreaLocationItem => i.kind === 'drawn_area';
const isElementItem = (i: LocationItem): i is ElementRuleLocationItem => i.kind === 'element_rule';

/**
 * Map-based district picker for a client's location preferences.
 *
 * Renders EVERY district of the selected city as its real boundary polygon
 * (from `district_boundaries`, simplified server-side by the
 * `wassell_city_district_shapes` RPC — the same polygons the Finder's
 * point-in-polygon verification matches against, so what you tap is exactly
 * what matches). Tapping a district toggles it as an INCLUDE rule; districts
 * already saved as EXCLUDE rules render red and are managed from the chips
 * list, not the map. "تم" applies the changes back into `location_items`
 * (element rules and excludes untouched).
 *
 * Also on the map:
 *  • ELEMENT RULES render as their COMPILED geometry (the new
 *    `wassell_preview_geo_items` RPC runs the real matcher compiler and returns
 *    per-item GeoJSON): radius/buffer rules as terracotta areas, inside_area as
 *    the zone polygon, north/south/east/west-of as the reference road plus a
 *    shaded band on the included side. Display-only — rules are edited from
 *    the chips list.
 *  • DRAWN SHAPES are EDITABLE: drag a vertex or a midpoint handle to stretch
 *    or shrink the shape; right-click a vertex to delete it (deleting below 3
 *    points deletes the shape). Labels name the districts the shape covers
 *    ("منطقة مرسومة: النرجس، العارض") and update as the shape is edited.
 *  • Right-clicking a DISTRICT copies its official boundary into a new
 *    editable drawn shape (and clears the district selection) so its borders
 *    can be stretched or trimmed.
 */

interface DistrictShape {
  district_id: string;
  name: string;
  /** English district name (bilingual W6) — the RPC returns it alongside `name`;
   *  the derived `shapes` picks the display language into `name`. */
  name_en?: string | null;
  geojson: { type: string; coordinates: unknown };
}

/** One row of wassell_preview_geo_items — the compiled display geometry. */
interface CompiledPreviewRow {
  item_id: string;
  kind: string;
  polarity: string;
  direction: string | null;
  validation_status: string;
  geojson?: { type: string; coordinates: unknown } | null;
  ref_geojson?: { type: string; coordinates: unknown } | null;
  /** Candidate points inside the rule's area — drives the "this rule is too big" flag. */
  listing_count?: number | null;
  project_count?: number | null;
}

interface Props {
  /** The selected city's record id (cities model). */
  cityId: string;
  /** The client's CURRENT location_items (full list — only include-district rules are edited here). */
  items: LocationItem[];
  /** Called with the UPDATED full list when the user presses Apply. */
  onApply: (items: LocationItem[]) => void;
  onClose: () => void;
  isAr: boolean;
}

const COPPER = '#B8734F';
const CHARCOAL = '#4A4E54';
const RED = '#B91C1C';
const GOLD = '#C09B5F'; // drawn areas — distinct from the copper district fill
const TERRACOTTA = '#8E4E3A'; // landmark pins + element-rule areas
/** Selected-road highlight. Deliberately NOT terracotta/copper: the Wassel basemap
 *  paints highways in copper/terracotta, so those colours are invisible against
 *  it (live report 2026-07-27). Rich Chocolate Brown is the darkest brand colour
 *  and nothing else on this map comes close to it. */
const ROAD_HIGHLIGHT = '#4A2C2A';
/** Flowing-dash animation on the selected road — the standard MapLibre "animated
 *  dashes" technique: ONE dashed line layer covering every part of every selected
 *  road, whose `line-dasharray` is swapped through a precomputed sequence of
 *  phase-shifted patterns on a slow tick. Each frame is a single paint-property
 *  update for the whole layer, no matter how many line parts the road has — so
 *  the old Google-era DASH_MAX_PARTS cap (one `set()` per Polyline per frame) is
 *  gone and every part animates. The tick stays slow enough to read as flow
 *  without running a hot loop.
 *
 *  Geometry (px, matching the old Google icon sequence): a DASH_LEN_PX white dash
 *  every DASH_REPEAT_PX, DASH_WIDTH_PX wide, advancing DASH_STEP_PX per tick. */
const DASH_REPEAT_PX = 24;
const DASH_LEN_PX = 6;
const DASH_WIDTH_PX = 4;
const DASH_STEP_PX = 2;
const DASH_TICK_MS = 90;
/** One `line-dasharray` per animation frame. MapLibre dash units are multiples of
 *  the line width, and patterns are anchored at the line start, so a pattern
 *  shifted by `o` px starts at phase φ = (period − o) mod period:
 *   • φ inside the dash → [rest-of-dash, gap, φ]   (odd length: MapLibre joins the
 *     first and last dash seamlessly)
 *   • φ inside the gap  → [0, rest-of-gap, dash, φ − dash]
 *  The zero-length leading dash is why the dash layer uses butt caps — with round
 *  caps a 0-length dash renders as a dot. */
const DASH_SEQUENCE: number[][] = (() => {
  const period = DASH_REPEAT_PX / DASH_WIDTH_PX;
  const dash = DASH_LEN_PX / DASH_WIDTH_PX;
  const gap = period - dash;
  const out: number[][] = [];
  for (let o = 0; o < DASH_REPEAT_PX; o += DASH_STEP_PX) {
    const phi = ((DASH_REPEAT_PX - o) % DASH_REPEAT_PX) / DASH_WIDTH_PX;
    out.push(phi < dash ? [dash - phi, gap, phi] : [0, period - phi, dash, phi - dash]);
  }
  return out;
})();

/** Element types shown as landmark pins on the picker — the sales-relevant
 *  anchors (all curated + verified in geo_elements). Roads/metro/parks are
 *  deliberately left out: too dense to read at city zoom. */
const LANDMARK_TYPES = ['landmarks', 'malls', 'universities', 'airports_transport', 'islands'];
/** Road-like element types — SEARCHABLE but never drawn as pins (too dense to
 *  read at city zoom). Picking one from search draws its actual line so the user
 *  can see where it runs. Roads/ring roads/metro lines are all MultiLineString. */
const ROAD_TYPES = ['roads_major', 'ring_roads', 'metro_lines'];
/** District name labels + landmark pins appear from this zoom in (city-wide
 *  view stays clean). CLASSIC (Google-equivalent) zoom scale — compared against
 *  getZoomLevel(), never map.getZoom(). */
const LABELS_MIN_ZOOM = 11;
/** Zoom the map snaps to when focusing a landmark — close enough that the dots are
 *  individually distinguishable. It no longer gates NAMES: landmarks render as points
 *  only, because at UAE scale their labels buried the map. CLASSIC zoom scale. */
const LANDMARK_NAMES_MIN_ZOOM = 13;
/** Max vertices when a district boundary is copied into an editable shape —
 *  keeps the vertex handles usable (a full simplified ring can be 300+). */
const CONVERT_MAX_POINTS = 80;
/** The finder's market too_many cap (MARKET_SCAN_LIMIT server-side): a rule
 *  covering more listings than this hides ALL market ads, so the picker flags
 *  exactly which rule must shrink. Keep in sync with api/_lib/matchAgent.ts. */
const MARKET_LIMIT = 4000;
/** Stepper increment for resizing a rule's distance from the picker. */
const DIST_STEP_M = 500;

interface LandmarkRow {
  external_id: string;
  display_name: string | null;
  name_ar: string | null;
  name_en: string | null;
  element_type: string;
  latitude: number | null;
  longitude: number | null;
}

/** THE DISTRICT NAME IS THE ONLY TEXT THIS MAP OWES YOU.
 *
 *  We render every district's name ourselves at its centroid, so basemap text
 *  would show each name TWICE (live report 2026-07-13). The Esri basemap that
 *  MapCanvas loads (src/lib/map/esriBasemap.ts) has ALL basemap text turned off
 *  globally (no basemap text anywhere, per the 2026-08-23 requirement), so this
 *  map and the rest all read the same: our names only. */

/** Strip a GeoJSON ring's closing duplicate so edit handles don't stack two
 *  draggable vertices on the first point. */
const openRing = (ring: LatLng[]): LatLng[] => {
  const first = ring[0];
  const last = ring[ring.length - 1];
  return ring.length > 3 && first && last && first.lat === last.lat && first.lng === last.lng
    ? ring.slice(0, -1)
    : ring;
};

// geojsonToPaths / geojsonToLinePaths live in '@/lib/geo/geojsonPaths' (shared with
// the finder's client-area layer) — imported at the top of this file.

/** Andrew's monotone-chain convex hull over [lng,lat] points → a CLOSED ring
 *  (first point repeated at the end). Used to turn the vertices of several
 *  selected roads into one polygon that spans the area between them — the shape
 *  a customer means by "projects between road A and road B". Returns [] if fewer
 *  than 3 distinct points. Collinear points are dropped (strict `<= 0`). */
function convexHull(points: [number, number][]): [number, number][] {
  const pts = points.filter((p) => Array.isArray(p) && p.length >= 2).slice()
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // De-dupe identical coords so collinear runs don't wedge the chain.
  const uniq: [number, number][] = [];
  for (const p of pts) {
    const last = uniq[uniq.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) uniq.push(p);
  }
  if (uniq.length < 3) return [];
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  if (hull.length < 3) return [];
  hull.push(hull[0]!); // close the ring
  return hull;
}

/** Ray-cast point-in-ring on [lng,lat] pairs (closed or open ring). */
function pointInRing(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersect = (yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Forgiving text normalizer for search: lowercase, strip Arabic diacritics +
 *  tatweel, unify alef/ya/ta-marbuta variants, drop the leading "ال". So typing
 *  "نرجس" matches "النرجس" and "الرياض" matches "الریاض". */
const normSearch = (s: string): string =>
  (s || '')
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '') // tashkeel + tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ىي]/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/^ال/, '')
    .trim();

export default function DistrictMapPicker({ cityId, items, onApply, onClose, isAr }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const [map, setMap] = useState<MlMap | null>(null);
  const [rawShapes, setRawShapes] = useState<DistrictShape[] | null>(null);
  const [shapesError, setShapesError] = useState<string | null>(null);
  // PERF: the hovered-district chip is written straight to the DOM instead of
  // going through React state. Panning drags the cursor across many districts,
  // and a state update per crossing re-rendered this whole component mid-drag.
  const hoverElRef = useRef<HTMLDivElement | null>(null);
  const hoverNameRef = useRef<string | null>(null);
  const setHoverName = (next: string | null | ((prev: string | null) => string | null)) => {
    const value = typeof next === 'function' ? next(hoverNameRef.current) : next;
    if (value === hoverNameRef.current) return;
    hoverNameRef.current = value;
    const el = hoverElRef.current;
    if (!el) return;
    el.textContent = value ?? '';
    el.style.display = value ? '' : 'none';
  };

  // Map search — jump to a district (and select it) or a landmark by name.
  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  /** Pan/zoom to a district AND select it (same effect as tapping its polygon);
   *  wired inside the main polygon effect where the per-district metas live. */
  const focusDistrictRef = useRef<(id: string) => void>(() => {});

  // Districts saved as EXCLUDE rules — shown red, not toggleable from the map.
  const excludedIds = useMemo(
    () => new Set(items.filter(isDistrictItem).filter((i) => i.polarity === 'exclude').map((i) => i.district_id)),
    [items],
  );
  // Working selection = the current include-district rules.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(items.filter(isDistrictItem).filter((i) => i.polarity === 'include').map((i) => i.district_id)),
  );
  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  // Free-drawn shapes — this picker is their editor of record: existing drawn
  // items load for review/edit/delete, new ones are added in draw mode. Each
  // shape is one independent OR-union item (the client can have several).
  const [drawnItems, setDrawnItems] = useState<DrawnAreaLocationItem[]>(() => items.filter(isDrawnItem));
  const [drawMode, setDrawMode] = useState(false);
  // Whether the shape being drawn is a WANTED area (include, gold) or an
  // EXCLUSION zone (exclude, red). Toggleable mid-draft — the preview recolors.
  const [drawPolarity, setDrawPolarity] = useState<GeoPolarity>('include');
  const drawPolarityRef = useRef<GeoPolarity>('include');
  useEffect(() => { drawPolarityRef.current = drawPolarity; }, [drawPolarity]);
  // Every drawing session starts as a WANTED area; «not wanted» is an explicit
  // choice per session (operator, 2026-10-05), never carried over silently.
  useEffect(() => { if (drawMode) setDrawPolarity('include'); }, [drawMode]);

  // Load the city's district shapes (one RPC, ~145 kB for Riyadh).
  useEffect(() => {
    if (!supabase) { setShapesError('offline'); return; }
    let cancelled = false;
    setRawShapes(null);
    setShapesError(null);
    supabase
      .rpc('wassell_city_district_shapes', { p_city_id: cityId })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) { setShapesError(error.message); return; }
        setRawShapes(Array.isArray(data) ? (data as DistrictShape[]) : []);
      });
    return () => { cancelled = true; };
  }, [cityId]);

  // Bilingual W6: the RPC returns both `name` (Arabic-first) and `name_en`.
  // Localize `name` to the UI language here so EVERY downstream reader (footer
  // chips, coverage labels, drawn-area names, map labels) shows the display
  // language without touching each site — and re-localizes on a language toggle.
  const shapes = useMemo(
    () => rawShapes?.map((s) => ({
      ...s,
      name: isAr ? s.name : toEnglishDisplay(s.name_en || s.name),
    })) ?? rawShapes,
    [rawShapes, isAr],
  );

  // Names for the footer chips (id → name) from the loaded shapes.
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of shapes ?? []) m.set(s.district_id, s.name);
    return m;
  }, [shapes]);

  // Largest ring ([lng,lat]) + centroid per district — powers the drawn-area
  // coverage labels ("منطقة مرسومة: النرجس، العارض").
  const districtGeoms = useMemo(() => {
    return (shapes ?? [])
      .map((s) => {
        let ring: LatLng[] = [];
        for (const p of geojsonToPaths(s.geojson)) if (p.length > ring.length) ring = p;
        if (ring.length < 3) return null;
        return {
          name: s.name,
          ring: ring.map((p) => [p.lng, p.lat] as [number, number]),
          centroid: {
            lng: ring.reduce((a, p) => a + p.lng, 0) / ring.length,
            lat: ring.reduce((a, p) => a + p.lat, 0) / ring.length,
          },
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
  }, [shapes]);

  // District names a CLOSED [lng,lat] ring covers: the district's centroid is
  // inside the ring (big shapes) OR a ring vertex falls inside the district
  // (small shapes inside one district). Cheap — ~190 districts × ring points.
  const coverageNames = (ring: [number, number][]): string[] => {
    const names: string[] = [];
    for (const d of districtGeoms) {
      const hit = pointInRing(d.centroid.lng, d.centroid.lat, ring)
        || ring.some(([lng, lat]) => pointInRing(lng, lat, d.ring));
      if (hit) names.push(d.name);
    }
    return names;
  };
  const drawnBase = (polarity: GeoPolarity) =>
    polarity === 'exclude' ? (isAr ? 'منطقة مستثناة' : 'Excluded area') : (isAr ? 'منطقة مرسومة' : 'Drawn area');
  /** "منطقة مرسومة: النرجس، العارض +2" — null when the ring covers no district. */
  const coverageLabel = (ring: [number, number][], polarity: GeoPolarity): string | null => {
    const names = coverageNames(ring);
    if (!names.length) return null;
    const head = names.slice(0, 3).join(isAr ? '، ' : ', ');
    const more = names.length > 3 ? ` +${names.length - 3}` : '';
    return `${drawnBase(polarity)}: ${head}${more}`;
  };
  const coverageLabelRef = useRef(coverageLabel);
  coverageLabelRef.current = coverageLabel;
  const drawnBaseRef = useRef(drawnBase);
  drawnBaseRef.current = drawnBase;

  // Important landmarks/elements (curated types, all Riyadh today). RLS allows
  // authenticated SELECT on geo_elements — same posture as /api/geo-elements.
  const [landmarks, setLandmarks] = useState<LandmarkRow[]>([]);
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    supabase
      .from('geo_elements')
      .select('external_id, display_name, name_ar, name_en, element_type, latitude, longitude')
      .in('element_type', LANDMARK_TYPES)
      .eq('is_active', true)
      .eq('is_searchable', true)
      .neq('review_status', 'rejected')
      .not('latitude', 'is', null)
      .limit(400)
      .then(({ data, error }) => {
        if (cancelled) return;
        // Decorative layer — a load failure only costs the pins, never the picker.
        if (error) { console.error('[DistrictMapPicker] landmarks load failed:', error.message); return; }
        setLandmarks((data ?? []) as LandmarkRow[]);
      });
    return () => { cancelled = true; };
  }, []);

  // Roads (major/ring/metro) — loaded SEARCH-ONLY (not rendered as pins). Same
  // authenticated SELECT as landmarks. Picking one from search draws its line.
  const [roads, setRoads] = useState<LandmarkRow[]>([]);
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    supabase
      .from('geo_elements')
      .select('external_id, display_name, name_ar, name_en, element_type, latitude, longitude')
      .in('element_type', ROAD_TYPES)
      .eq('is_active', true)
      .eq('is_searchable', true)
      .neq('review_status', 'rejected')
      .not('latitude', 'is', null)
      .limit(400)
      .then(({ data, error }) => {
        if (cancelled) return;
        // Search aid — a load failure only costs road search, never the picker.
        if (error) { console.error('[DistrictMapPicker] roads load failed:', error.message); return; }
        setRoads((data ?? []) as LandmarkRow[]);
      });
    return () => { cancelled = true; };
  }, []);

  // Roads picked from search, each with its FULL line geometry (from the
  // wassell_geo_element_shapes RPC — never a centroid). Selecting roads
  // accumulates them: one shows you where a road runs; two or more can be turned
  // into a single "area between the roads" polygon (convex hull) that then edits
  // like any drawn shape. Deduped by external_id.
  interface SelectedRoad { externalId: string; name: string; geojson: { type: string; coordinates: unknown } }
  const [selectedRoads, setSelectedRoads] = useState<SelectedRoad[]>([]);

  // ── overlay stacking ────────────────────────────────────────────────────
  //
  // MapLibre overlays stack in CREATION order (newest on top), but each layer
  // below is rebuilt on its own schedule (a selection change adds a district
  // editor, a drawn-shape edit rebuilds every drawn shape, …). `restack()` lifts
  // them back into the order the old per-object zIndex values encoded — district
  // fills (1–2) < element-rule areas (2–3) < selected-district editors (3) <
  // drawn shapes (4) < draft preview (6–7) < selected roads (7–9) < landmark
  // points (markers on Google, which always sat above every shape). DOM markers
  // (labels, road pills, edit handles) are above all of these regardless.
  // Every effect that creates overlays calls it once at the end.
  const districtOverlayRef = useRef<GeoJsonOverlay | null>(null);
  interface DistrictEditor { poly: EditablePolygon; editTimer?: ReturnType<typeof setTimeout> }
  const districtEditorsRef = useRef<Map<string, DistrictEditor>>(new Map());
  const elemLayersRef = useRef<GeoJsonOverlay[]>([]);
  const drawnEditorsRef = useRef<EditablePolygon[]>([]);
  const previewOverlayRef = useRef<GeoJsonOverlay | null>(null);
  const roadLayersRef = useRef<GeoJsonOverlay[]>([]);
  const landmarkOverlayRef = useRef<GeoJsonOverlay | null>(null);
  const landmarkTooltipRef = useRef<MapTooltip | null>(null);
  const restack = useCallback(() => {
    for (const o of elemLayersRef.current) o.moveToTop();
    districtEditorsRef.current.forEach((e) => e.poly.shape.moveToTop());
    for (const p of drawnEditorsRef.current) p.shape.moveToTop();
    previewOverlayRef.current?.moveToTop();
    for (const o of roadLayersRef.current) o.moveToTop();
    landmarkOverlayRef.current?.moveToTop();
  }, []);

  // Draw every selected road and fit the map to all of them (so picking a 2nd
  // road frames both). Display-only; the shape itself is created explicitly via
  // the "area between roads" button.
  //
  // HIGHLIGHT TREATMENT (2026-07-27): the old style was a TERRACOTTA line — the
  // exact colour WASSEL_MAP_STYLE paints every highway casing with
  // (road.highway geometry.stroke = #8E4E3A), so a picked road vanished into the
  // basemap. It's now drawn as a two-layer "route" treatment:
  //   • a wide WHITE casing underneath, which separates the road from its copper
  //     neighbours no matter what colour they are, and
  //   • a near-black CHOCOLATE core on top — the highest-contrast brand colour
  //     against the cream/copper basemap (nothing else on the map is this dark).
  // The name rides in a filled pill instead of bare text, so it's readable over
  // a busy city view.
  //
  // Rendered as GeoJsonOverlays with ONE feature per road (casing, core and dash
  // layers each hold every selected road) rather than one object per line part:
  // a merged road like الدائري الشمالي has 155 parts.
  useEffect(() => {
    if (!map || selectedRoads.length === 0) return;
    const features = selectedRoads.map((r) => geometryFeature(r.geojson));
    // Creation order = stacking order: casing under core under dashes.
    const casing = new GeoJsonOverlay(map, { style: { strokeColor: '#FFFFFF', strokeWeight: 13, strokeOpacity: 1 } });
    casing.setData(features);
    const core = new GeoJsonOverlay(map, { style: { strokeColor: ROAD_HIGHLIGHT, strokeWeight: 6, strokeOpacity: 1 } });
    core.setData(features);
    const layers: GeoJsonOverlay[] = [casing, core];
    const markers: Marker[] = [];
    let bounds: LngLatBounds | null = null;

    for (const r of selectedRoads) {
      // Label the LONGEST part's midpoint — on a many-part road the first part
      // can be a stub anywhere along it.
      let longest: LatLng[] = [];
      for (const line of geojsonToLinePaths(r.geojson)) {
        if (line.length < 2) continue;
        for (const p of line) bounds = extendBounds(bounds, p);
        if (line.length > longest.length) longest = line;
      }
      if (longest.length && r.name) {
        // No onClick/title → pointer-events pass through to the map.
        markers.push(createIconMarker(map, {
          position: longest[Math.floor(longest.length / 2)]!,
          icon: buildPillIcon(r.name, ROAD_HIGHLIGHT),
          zIndex: 9,
        }));
      }
    }
    fitToBounds(map, bounds, { padding: 80 });

    // Flowing white dashes along the road — the "this one is live" cue (see
    // DASH_SEQUENCE). Skipped entirely under prefers-reduced-motion; the static
    // core still shows the whole road.
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let timer: ReturnType<typeof setInterval> | null = null;
    if (!reduceMotion) {
      const dashes = new GeoJsonOverlay(map, {
        style: { strokeColor: '#FFFFFF', strokeOpacity: 0.95, strokeWeight: DASH_WIDTH_PX },
        dash: DASH_SEQUENCE[0],
        // Butt caps: the gap-phase patterns start with a 0-length dash, which round
        // caps (the overlay default) would draw as a dot every period.
        lineCap: 'butt',
      });
      dashes.setData(features);
      layers.push(dashes);
      let step = 0;
      timer = setInterval(() => {
        step = (step + 1) % DASH_SEQUENCE.length;
        dashes.setLinePaint('line-dasharray', DASH_SEQUENCE[step]);
      }, DASH_TICK_MS);
    }
    roadLayersRef.current = layers;
    restack();

    return () => {
      if (timer) clearInterval(timer);
      layers.forEach((l) => l.remove());
      markers.forEach((m) => m.remove());
      roadLayersRef.current = [];
    };
  }, [map, selectedRoads, restack]);

  // Build one editable polygon spanning the selected roads: the convex hull of
  // ALL their vertices → a drawn_area include item (same as a hand-drawn shape,
  // so it can be reshaped by dragging its handles). Clears the road selection.
  const createAreaBetweenRoads = () => {
    const pts: [number, number][] = [];
    for (const r of selectedRoads) {
      for (const line of geojsonToLinePaths(r.geojson)) {
        for (const p of line) pts.push([round6(p.lng), round6(p.lat)]);
      }
    }
    const hull = convexHull(pts);
    if (hull.length < 4) return; // degenerate (roads collinear) — nothing to build
    const names = selectedRoads.map((r) => r.name).filter(Boolean);
    const head = names.slice(0, 3).join(isAr ? '، ' : ', ');
    const more = names.length > 3 ? ` +${names.length - 3}` : '';
    const label = `${isAr ? 'منطقة بين الطرق' : 'Area between roads'}: ${head}${more}`;
    setDrawnItems((prev) => [...prev, newDrawnAreaItem(hull, label, 'include')]);
    setSelectedRoads([]);
  };

  // ELEMENT RULES — editable HERE (resize via the chip steppers, delete via the
  // chip ×; re-emitted on Apply). Their compiled shapes come from the REAL
  // matcher compiler (wassell_preview_geo_items), so the area on screen is
  // exactly the area the finder will match — with per-rule candidate counts so
  // an oversized rule is called out BY NAME.
  const [elemItems, setElemItems] = useState<ElementRuleLocationItem[]>(() => items.filter(isElementItem));
  const [previews, setPreviews] = useState<CompiledPreviewRow[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  useEffect(() => {
    if (!supabase || elemItems.length === 0) { setPreviews([]); setPreviewLoading(false); return; }
    let cancelled = false;
    setPreviewLoading(true);
    // Debounced: stepper clicks recompile server-side (~0.5-1s) — batch them.
    const t = setTimeout(() => {
      supabase!
        .rpc('wassell_preview_geo_items', { p_items: elemItems })
        .then(({ data, error }) => {
          if (cancelled) return;
          setPreviewLoading(false);
          // Decorative layer — a failure costs the rule overlays, never the picker.
          if (error) { console.error('[DistrictMapPicker] element-rule preview failed:', error.message); return; }
          setPreviews(Array.isArray(data) ? (data as CompiledPreviewRow[]) : []);
        });
    }, 450);
    return () => { cancelled = true; clearTimeout(t); };
  }, [elemItems]);

  /** Current distance of a rule (null when the rule has no distance concept). */
  const ruleDistanceM = (it: ElementRuleLocationItem): number | null => {
    const c = it.conditions?.[0];
    if (!c || c.rule === 'inside_area') return null;
    const d = (c as { distance_m?: number }).distance_m;
    if (typeof d === 'number' && d > 0) return d;
    return isDirectionRule(c.rule) ? DIRECTION_DEFAULT_M : null;
  };
  const setRuleDistanceM = (id: string, m: number) => {
    setElemItems((prev) => prev.map((it) => it.id === id
      ? {
          ...it,
          conditions: it.conditions.map((c, i) =>
            i === 0 && c.rule !== 'inside_area' ? ({ ...c, distance_m: m } as ElementCondition) : c),
        }
      : it));
  };

  // Build the district layer when the map + shapes are ready. Selection changes
  // restyle IN PLACE (no rebuild) — the overlay's style function reads
  // selectedRef / excludedIdsRef / drawModeRef.
  //
  // ALL districts live in ONE GeoJsonOverlay (one feature each — 189 for Riyadh,
  // 513 for Dubai) instead of one map object per district: one source, one draw
  // call, one style function, and the shared pointer dispatcher routes click /
  // right-click / hover to the feature under the cursor.
  //
  // A SELECTED district is EDITABLE (user decision 2026-07-18): it is drawn by
  // its own EditablePolygon on top — a decimated ring (≤80 handles) with
  // vertex/midpoint handles — and hidden in the base overlay. The moment a
  // handle is dragged (or a vertex right-click-deleted) the edited ring CONVERTS
  // into a drawn_area item ("منطقة مرسومة: <الحي>") and the district rule is
  // replaced by the custom shape. Untouched selections stay ordinary district
  // rules with the official boundary.
  interface DistrictMeta {
    shape: DistrictShape;
    fullPaths: LatLng[][];
    /** Largest ring, OPEN (no closing duplicate), decimated to ≤ CONVERT_MAX_POINTS. */
    decimated: LatLng[];
    /** Larger of the lat/lng extents in degrees — drives speck culling. */
    span: number;
  }
  const districtMetaRef = useRef<Map<string, DistrictMeta>>(new Map());
  /** Re-sync the per-district editors with the current selection (set by the
   *  district effect, called on every selection change). */
  const syncDistrictEditorsRef = useRef<() => void>(() => {});
  const drawModeRef = useRef(false);
  const excludedIdsRef = useRef(excludedIds);
  excludedIdsRef.current = excludedIds;
  const styleFor = (id: string, isSelected: boolean): OverlayStyle =>
    excludedIdsRef.current.has(id)
      ? { fillColor: RED, fillOpacity: 0.22, strokeColor: RED, strokeOpacity: 0.8, strokeWeight: 2, zIndex: 2 }
      : isSelected
        ? { fillColor: COPPER, fillOpacity: 0.38, strokeColor: COPPER, strokeOpacity: 1, strokeWeight: 2.5, zIndex: 3 }
        : { fillColor: CHARCOAL, fillOpacity: 0.06, strokeColor: CHARCOAL, strokeOpacity: 0.65, strokeWeight: 1.5, zIndex: 1 };

  useEffect(() => {
    if (!map || !shapes) return;
    const metas = districtMetaRef.current;
    const editors = districtEditorsRef.current;
    /** Districts too small to make out at the current zoom (speck culling below). */
    let specks = new Set<string>();

    const features: OverlayFeature[] = [];
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const s of shapes) {
      const paths = geojsonToPaths(s.geojson);
      if (!paths.length) continue;
      let largest: LatLng[] = [];
      for (const p of paths) if (p.length > largest.length) largest = p;
      const open = openRing(largest);
      const step = Math.max(1, Math.ceil(open.length / CONVERT_MAX_POINTS));
      const decimated = open.filter((_, i) => i % step === 0);
      let dMinLat = Infinity, dMaxLat = -Infinity, dMinLng = Infinity, dMaxLng = -Infinity;
      for (const path of paths) for (const pt of path) {
        if (pt.lat < dMinLat) dMinLat = pt.lat; if (pt.lat > dMaxLat) dMaxLat = pt.lat;
        if (pt.lng < dMinLng) dMinLng = pt.lng; if (pt.lng > dMaxLng) dMaxLng = pt.lng;
      }
      if (dMinLat < minLat) minLat = dMinLat; if (dMaxLat > maxLat) maxLat = dMaxLat;
      if (dMinLng < minLng) minLng = dMinLng; if (dMaxLng > maxLng) maxLng = dMaxLng;
      metas.set(s.district_id, {
        shape: s, fullPaths: paths, decimated,
        span: Math.max(dMaxLat - dMinLat, dMaxLng - dMinLng),
      });
      features.push(geometryFeature(s.geojson, { id: s.district_id, name: s.name }));
    }

    const overlay = new GeoJsonOverlay(map, {
      style: (props) => {
        const id = String(props.id ?? '');
        // Drawn by its EditablePolygon instead (selected + editable).
        if (editors.has(id)) return { visible: false };
        const isSelected = selectedRef.current.has(id);
        // A SELECTED district always stays drawn — the user is working on it.
        if (!isSelected && specks.has(id)) return { visible: false };
        // Unclickable while drawing so vertex clicks over a district register
        // on the map instead of toggling it.
        return { ...styleFor(id, isSelected), clickable: !drawModeRef.current };
      },
    });
    overlay.setData(features);
    districtOverlayRef.current = overlay;

    const toggleDistrict = (id: string) => {
      if (excludedIdsRef.current.has(id)) return; // exclude rules are managed from the chips
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };
    // Right-click a district (not on a vertex) → copy the official boundary
    // into a NEW editable drawn shape without selecting it.
    const copyBoundary = (id: string) => {
      if (excludedIdsRef.current.has(id) || drawModeRef.current) return;
      const m = metas.get(id);
      if (!m) return;
      const lngLat = m.decimated.map((p) => [round6(p.lng), round6(p.lat)] as [number, number]);
      if (lngLat.length < 3) return;
      lngLat.push(lngLat[0]!);
      setDrawnItems((prev) => [
        ...prev,
        newDrawnAreaItem(lngLat, `${drawnBaseRef.current('include')}: ${m.shape.name}`, 'include'),
      ]);
    };
    const hoverIn = (name: string) => setHoverName(name);
    const hoverOut = (name: string) => setHoverName((n) => (n === name ? null : n));

    overlay.on('click', (_hit, p) => toggleDistrict(String(p.id ?? '')));
    overlay.on('rightclick', (_hit, p) => copyBoundary(String(p.id ?? '')));
    overlay.on('mouseover', (_hit, p: OverlayProps) => hoverIn(String(p.name ?? '')));
    overlay.on('mouseout', (_hit, p: OverlayProps) => hoverOut(String(p.name ?? '')));

    const removeEditor = (id: string) => {
      const ed = editors.get(id);
      if (!ed) return;
      if (ed.editTimer) clearTimeout(ed.editTimer);
      ed.poly.remove();
      editors.delete(id);
    };

    // The edited ring becomes a drawn_area; the district rule is dropped and
    // the district returns to the official (unselected) rendering.
    const convertEdited = (id: string) => {
      const ed = editors.get(id);
      const m = metas.get(id);
      if (!ed || !m) return;
      const pts = ed.poly.getPath().map((ll) => [round6(ll.lng), round6(ll.lat)] as [number, number]);
      removeEditor(id);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (pts.length < 3) return;
      const ring = [...pts, pts[0]!];
      setDrawnItems((prev) => [
        ...prev,
        newDrawnAreaItem(
          ring,
          coverageLabelRef.current(ring, 'include') ?? `${drawnBaseRef.current('include')}: ${m.shape.name}`,
          'include',
        ),
      ]);
    };

    const addEditor = (id: string, m: DistrictMeta) => {
      const poly = new EditablePolygon(map, {
        path: m.decimated,
        style: { ...styleFor(id, true), clickable: !drawModeRef.current },
        // Handles OUTSIDE draw mode only — they would swallow the draw clicks.
        editable: !drawModeRef.current,
        // Debounced (kept from the per-frame Google events): convert once, from
        // the final geometry.
        onEdit: () => {
          const ed = editors.get(id);
          if (!ed) return;
          if (ed.editTimer) clearTimeout(ed.editTimer);
          ed.editTimer = setTimeout(() => convertEdited(id), 400);
        },
        // Right-click a vertex → delete it (flows into the edit→convert path).
        onVertexRightClick: (i) => {
          if (drawModeRef.current) return;
          const ed = editors.get(id);
          if (ed && ed.poly.length > 3) ed.poly.removeVertex(i);
        },
        onClick: () => toggleDistrict(id),
        onRightClick: () => copyBoundary(id),
      });
      poly.shape.on('mouseover', () => hoverIn(m.shape.name));
      poly.shape.on('mouseout', () => hoverOut(m.shape.name));
      editors.set(id, { poly });
    };

    // Selected (non-excluded) districts open EDITABLE — "select it, then adjust
    // the highlighted area". Idempotent: only adds/removes what changed.
    const syncEditors = () => {
      const sel = selectedRef.current;
      for (const id of [...editors.keys()]) {
        if (!sel.has(id) || excludedIdsRef.current.has(id)) removeEditor(id);
      }
      let added = false;
      for (const id of sel) {
        if (editors.has(id) || excludedIdsRef.current.has(id)) continue;
        const m = metas.get(id);
        if (!m || m.decimated.length < 3) continue;
        addEditor(id, m);
        added = true;
      }
      overlay.restyle();
      if (added) restack();
    };
    syncDistrictEditorsRef.current = syncEditors;
    syncEditors();
    restack();

    fitToBounds(
      map,
      boundsOf([{ lat: minLat, lng: minLng }, { lat: maxLat, lng: maxLng }]),
      { padding: 24, animate: false },
    );

    // Search → focus a district: zoom to its boundary and select it (same
    // enter-editable behavior as a tap). Already-excluded districts are only
    // focused (they're managed from the chips, not toggled here).
    focusDistrictRef.current = (id: string) => {
      const m = metas.get(id);
      if (!m) return;
      fitToBounds(map, boundsOf(m.fullPaths.flat()), { padding: 48 });
      if (excludedIdsRef.current.has(id)) return;
      setSelected((prev) => {
        if (prev.has(id)) return prev; // already selected — just re-centered
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    };

    // ── speck culling ─────────────────────────────────────────────────────
    //
    // Dubai has 513 districts, and at city zoom the tiny ones made the map an
    // unreadable mass of overlapping outlines (reported from the live app on the
    // Google version, which also had to detach OFF-SCREEN polygons because every
    // district was its own heavyweight map object and every zoom lagged).
    //
    // Off-screen culling is gone: the districts are one GeoJSON source that
    // MapLibre tiles and draws on the GPU, only rendering what's in view, so 513
    // polygons cost one draw call. What stays is the READABILITY cull: districts
    // too small to make out at this zoom are hidden via `visible: false` in the
    // style function. It depends only on zoom, so the overlay is restyled only
    // when the hidden set actually changes. A SELECTED district is never culled.
    const MIN_SPAN_PX = 8; // below this a district is a speck; drawing it only costs
    const cull = () => {
      // Degrees per pixel at this zoom (world is 256 px at CLASSIC z0).
      const degPerPx = 360 / (256 * Math.pow(2, getZoomLevel(map)));
      const minSpan = degPerPx * MIN_SPAN_PX;
      const next = new Set<string>();
      metas.forEach((m, id) => { if (m.span < minSpan) next.add(id); });
      if (next.size === specks.size && [...next].every((id) => specks.has(id))) return;
      specks = next;
      overlay.restyle();
    };
    let cullTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleCull = () => {
      if (cullTimer) clearTimeout(cullTimer);
      cullTimer = setTimeout(cull, 120);
    };
    const offViewport = onViewportChange(map, scheduleCull);
    scheduleCull();

    return () => {
      focusDistrictRef.current = () => {};
      syncDistrictEditorsRef.current = () => {};
      offViewport();
      if (cullTimer) clearTimeout(cullTimer);
      for (const id of [...editors.keys()]) removeEditor(id);
      metas.clear();
      overlay.remove();
      districtOverlayRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, shapes]);

  // Selection changed (tap, search focus, edit→convert, chips) → add/remove the
  // per-district editors and restyle the base layer in place.
  useEffect(() => {
    syncDistrictEditorsRef.current();
  }, [selected]);

  // District NAME labels on every polygon + landmark POINTS, both zoom-gated from
  // LABELS_MIN_ZOOM so the city-wide view stays readable. The district name is the
  // only text this map draws; landmarks are dots with a hover tooltip. Labels are
  // DOM text markers at each district's largest-ring centroid.
  useEffect(() => {
    if (!map || !shapes) return;
    /** A label plus the state needed to attach/detach it WITHOUT redundant work. */
    interface LabelEntry {
      /** Created lazily the first time the label is shown, then re-attached. */
      marker: Marker | null;
      position: LatLng;
      text: string;
      /** Whether it's currently attached to the map — so we only touch the DOM on a real change. */
      on: boolean;
      /** District extent in DEGREES — how much room the name has to live in. */
      spanLat: number;
      spanLng: number;
      /** District this label belongs to — lets a SELECTED district keep its name. */
      districtId: string;
    }
    const labelEntries: LabelEntry[] = [];
    for (const s of shapes) {
      let ring: LatLng[] = [];
      for (const p of geojsonToPaths(s.geojson)) if (p.length > ring.length) ring = p;
      if (ring.length < 3) continue;
      let rMinLat = Infinity, rMaxLat = -Infinity, rMinLng = Infinity, rMaxLng = -Infinity;
      for (const pt of ring) {
        if (pt.lat < rMinLat) rMinLat = pt.lat; if (pt.lat > rMaxLat) rMaxLat = pt.lat;
        if (pt.lng < rMinLng) rMinLng = pt.lng; if (pt.lng > rMaxLng) rMaxLng = pt.lng;
      }
      const lat = ring.reduce((a, p) => a + p.lat, 0) / ring.length;
      const lng = ring.reduce((a, p) => a + p.lng, 0) / ring.length;
      labelEntries.push({
        marker: null,
        position: { lat, lng },
        text: s.name,
        on: false,
        spanLat: rMaxLat - rMinLat,
        spanLng: rMaxLng - rMinLng,
        districtId: s.district_id,
      });
    }
    const showLabel = (e: LabelEntry) => {
      if (e.marker) e.marker.addTo(map);
      else e.marker = createLabelMarker(map, { position: e.position, text: e.text, color: CHARCOAL, fontSize: '11px', fontWeight: '700' });
      e.on = true;
    };
    const hideLabel = (e: LabelEntry) => {
      e.marker?.remove();
      e.on = false;
    };

    // A LANDMARK IS A POINT HERE, NOT A LABEL.
    //
    // These used to carry their name as a rendered label above
    // LANDMARK_NAMES_MIN_ZOOM. That read fine against Riyadh's 725 anchors and
    // became the single worst thing on the map once the UAE import pushed the set
    // to ~3,900: hundreds of overlapping terracotta names on top of the district
    // mesh. Small dot only, at the same scale the shared map layer uses
    // (useGeoBoundaryLayer), so every map draws landmarks alike. The name still
    // arrives on hover (MapTooltip).
    //
    // They're a GPU circle layer (one GeoJsonOverlay), NOT ~3,900 DOM markers, so
    // there is no per-pin viewport culling any more — MapLibre only draws what's
    // in view. Only the LABELS_MIN_ZOOM gate remains (`visible` in the style).
    let landmarksOn = false;
    const lmOverlay = new GeoJsonOverlay(map, {
      style: (): OverlayStyle => ({
        visible: landmarksOn,
        pointRadius: 3.2,
        pointColor: TERRACOTTA,
        pointOpacity: 0.95,
        pointStrokeColor: '#FFFFFF',
        pointStrokeWeight: 1,
        zIndex: 5,
        // Hover shows the name; never clickable while drawing (would swallow vertex clicks).
        clickable: !drawModeRef.current,
      }),
    });
    lmOverlay.setData(
      landmarks
        .filter((l) => l.latitude != null && l.longitude != null)
        .map((l) => {
          const name = (isAr ? l.name_ar || l.display_name : l.name_en || l.display_name || l.name_ar) ?? '';
          return pointFeature({ lat: l.latitude!, lng: l.longitude! }, { name, lat: l.latitude!, lng: l.longitude! });
        }),
    );
    const tooltip = new MapTooltip(map);
    lmOverlay.on('mouseover', (_hit, p) => {
      const name = String(p.name ?? '');
      if (name) tooltip.show({ lat: Number(p.lat), lng: Number(p.lng) }, name);
    });
    lmOverlay.on('mouseout', () => tooltip.hide());
    landmarkOverlayRef.current = lmOverlay;
    landmarkTooltipRef.current = tooltip;
    restack();

    // PERF (2026-07-24): this used to run on every zoom tick and blindly
    // re-attach every marker — ~580 marker ops per tick, which made zooming
    // stutter and panning feel heavy. Two fixes, both kept:
    //   1. Drive off the settled viewport (`moveend` via onViewportChange — fires
    //      ONCE after a pan/zoom settles) instead of every zoom tick.
    //   2. Only attach labels inside the PADDED viewport, and only touch the DOM
    //      when the value actually changes — so a settle that changes nothing
    //      costs zero marker ops.
    // Labels only show at zoom >= LABELS_MIN_ZOOM, where a handful of districts
    // are on screen; we were attaching all of them regardless.
    const syncMarkers = () => {
      const vp = getViewport(map);
      const z = vp.zoom; // CLASSIC scale — what LABELS_MIN_ZOOM and pickVisibleLabels speak
      const wantLandmarks = z >= LABELS_MIN_ZOOM;
      if (wantLandmarks !== landmarksOn) {
        landmarksOn = wantLandmarks;
        lmOverlay.restyle();
        if (!wantLandmarks) tooltip.hide();
      }
      if (z < LABELS_MIN_ZOOM) {
        for (const e of labelEntries) if (e.on) hideLabel(e);
        return;
      }
      // Pad the viewport by 25% so labels are already attached just before
      // they scroll into view (no pop-in at the edges).
      const padLat = (vp.maxLat - vp.minLat) * 0.25;
      const padLng = (vp.maxLng - vp.minLng) * 0.25;
      const south = vp.minLat - padLat, north = vp.maxLat + padLat;
      const west = vp.minLng - padLng, east = vp.maxLng + padLng;
      // Decluttered district names — shared with every other map via
      // `pickVisibleLabels`, so a dense city reads the same way everywhere.
      // A SELECTED district gets priority: you asked for it, so it keeps its name
      // however small it is and whoever it would collide with.
      const inView = (e: LabelEntry) =>
        e.position.lat >= south && e.position.lat <= north
        && e.position.lng >= west && e.position.lng <= east;

      const candidates = labelEntries
        .filter(inView)
        .map((e, i) => ({
          id: String(i),
          text: e.text,
          lat: e.position.lat, lng: e.position.lng,
          spanLat: e.spanLat, spanLng: e.spanLng,
          priority: selectedRef.current.has(e.districtId) ? 1 : 0,
          entry: e,
        }));
      const keep = pickVisibleLabels(candidates, { zoom: z, centerLat: vp.center.lat });
      for (const c of candidates) {
        const show = keep.has(c.id);
        if (show !== c.entry.on) { if (show) showLabel(c.entry); else hideLabel(c.entry); }
      }
      // Labels that scrolled out of view still need detaching.
      for (const e of labelEntries) if (!inView(e) && e.on) hideLabel(e);
    };
    syncMarkers();
    const offViewport = onViewportChange(map, syncMarkers);
    return () => {
      offViewport();
      labelEntries.forEach((e) => e.marker?.remove());
      tooltip.hide();
      lmOverlay.remove();
      landmarkOverlayRef.current = null;
      landmarkTooltipRef.current = null;
    };
  }, [map, shapes, landmarks, isAr, restack]);

  // ELEMENT-RULE overlays: every rule's COMPILED area (radius circle, road-side
  // band, road buffer, zone) as a terracotta polygon — direction rules arrive
  // already clipped to the matched side by the preview RPC. Roads additionally
  // draw their reference line. Labeled with the same chip text as the editor.
  //
  // Element areas are EDITABLE like selected districts (user decision
  // 2026-07-18): the largest ring renders as an EditablePolygon with drag
  // handles (decimated to ≤80); dragging a handle — or right-click-deleting a
  // vertex — converts the edited ring into a drawn_area of the SAME polarity,
  // replacing the element rule with the custom shape. Untouched rules keep
  // following the element + km (the chip steppers resize without converting).
  useEffect(() => {
    if (!map || previews.length === 0) return;
    const editors: EditablePolygon[] = [];
    const labels: Marker[] = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    /** Display-only extra pieces (MultiPolygon remainders) + reference lines. */
    const extraFeatures: OverlayFeature[] = [];

    const convertEdited = (item: ElementRuleLocationItem, poly: EditablePolygon) => {
      const pts = poly.getPath().map((ll) => [round6(ll.lng), round6(ll.lat)] as [number, number]);
      // The element rule is replaced by the custom shape either way; a
      // degenerate (<3 pt) ring just drops the rule without a shape.
      setElemItems((prev) => prev.filter((x) => x.id !== item.id));
      if (pts.length < 3) return;
      const ring = [...pts, pts[0]!];
      const fallback = `${drawnBaseRef.current(item.polarity)}: ${item.element_label ?? ''}`.replace(/: $/, '');
      setDrawnItems((prev) => [
        ...prev,
        newDrawnAreaItem(ring, coverageLabelRef.current(ring, item.polarity) ?? fallback, item.polarity),
      ]);
    };

    for (const row of previews) {
      // A rule deleted/converted client-side may still have a stale preview
      // row until the debounced refetch lands — never draw those.
      const item = elemItems.find((i) => i.id === row.item_id);
      if (!item) continue;
      const c = row.polarity === 'exclude' ? RED : TERRACOTTA;
      const text = describeLocationItem(item, isAr);
      if (row.geojson) {
        const paths = geojsonToPaths(row.geojson);
        let largest: LatLng[] = [];
        for (const p of paths) if (p.length > largest.length) largest = p;
        if (largest.length >= 3) {
          const open = openRing(largest);
          const step = Math.max(1, Math.ceil(open.length / CONVERT_MAX_POINTS));
          const decimated = open.filter((_, i) => i % step === 0);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const poly: EditablePolygon = new EditablePolygon(map, {
            path: decimated,
            style: {
              fillColor: c, fillOpacity: 0.14, strokeColor: c, strokeOpacity: 0.85, strokeWeight: 2,
              zIndex: 2,
              clickable: !drawMode,
            },
            editable: !drawMode,
            onEdit: () => {
              if (timer) clearTimeout(timer);
              timer = setTimeout(() => convertEdited(item, poly), 400);
              timers.push(timer);
            },
            onVertexRightClick: (i) => {
              if (drawMode) return;
              if (poly.length > 3) poly.removeVertex(i); // removal → onEdit → convert
            },
          });
          editors.push(poly);
          // Clipped direction bands can be MultiPolygon — draw the remaining
          // pieces as display-only fills so the area still reads complete.
          for (const p of paths) {
            if (p === largest || p.length < 3) continue;
            extraFeatures.push(polygonFeature([p], { kind: 'area', color: c }));
          }
          if (text) {
            labels.push(createLabelMarker(map, {
              position: {
                lat: largest.reduce((a, p) => a + p.lat, 0) / largest.length,
                lng: largest.reduce((a, p) => a + p.lng, 0) / largest.length,
              },
              text,
              color: c,
              fontSize: '11px',
              fontWeight: '700',
            }));
          }
        }
      }
      if (row.ref_geojson) {
        for (const line of geojsonToLinePaths(row.ref_geojson)) {
          if (line.length >= 2) extraFeatures.push(lineFeature(line, { kind: 'ref', color: c }));
        }
      }
    }
    const extras = new GeoJsonOverlay(map, {
      style: (p): OverlayStyle => {
        const color = String(p.color ?? TERRACOTTA);
        return p.kind === 'ref'
          ? { strokeColor: color, strokeOpacity: 0.95, strokeWeight: 4, zIndex: 3 }
          : { fillColor: color, fillOpacity: 0.14, strokeColor: color, strokeOpacity: 0.85, strokeWeight: 2, zIndex: 2 };
      },
    });
    extras.setData(extraFeatures);
    elemLayersRef.current = [...editors.map((e) => e.shape), extras];
    restack();

    return () => {
      timers.forEach((t) => clearTimeout(t));
      editors.forEach((e) => e.remove());
      extras.remove();
      labels.forEach((m) => m.remove());
      elemLayersRef.current = [];
    };
  }, [map, previews, elemItems, isAr, drawMode, restack]);

  // Render the drawn shapes as EDITABLE polygons (outside draw mode): drag a
  // vertex or midpoint handle to reshape; right-click a vertex to delete it
  // (below 3 points → the shape is deleted). Edits debounce back into
  // drawnItems with a recomputed coverage label. Gold = include, red = a saved
  // exclude drawn area. Whole-shape delete stays on the footer chips.
  useEffect(() => {
    if (!map) return;
    const editors: EditablePolygon[] = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    for (const d of drawnItems) {
      const c = d.polarity === 'exclude' ? RED : GOLD;
      const coords = d.coordinates ?? [];
      const isClosed = coords.length >= 2
        && coords[0]![0] === coords[coords.length - 1]![0]
        && coords[0]![1] === coords[coords.length - 1]![1];
      // OPEN path for editing — the ring-closing duplicate would render as a
      // second draggable vertex stacked on the first.
      const path = (isClosed ? coords.slice(0, -1) : coords).map(([lng, lat]) => ({ lat, lng }));
      if (path.length < 3) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const commit = () => {
        const pts = poly.getPath().map((ll) => [round6(ll.lng), round6(ll.lat)] as [number, number]);
        if (pts.length < 3) return;
        const ring = [...pts, pts[0]!];
        setDrawnItems((prev) => prev.map((x) => x.id === d.id
          ? { ...x, coordinates: ring, label: coverageLabelRef.current(ring, x.polarity) ?? x.label }
          : x));
      };
      const poly: EditablePolygon = new EditablePolygon(map, {
        path,
        style: {
          fillColor: c, fillOpacity: 0.3, strokeColor: c, strokeOpacity: 0.95, strokeWeight: 2,
          zIndex: 4,
          clickable: !drawMode,
        },
        editable: !drawMode,
        onEdit: () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(commit, 500);
          timers.push(timer);
        },
        onVertexRightClick: (i) => {
          if (poly.length > 3) poly.removeVertex(i);
          else setDrawnItems((prev) => prev.filter((x) => x.id !== d.id));
        },
      });
      editors.push(poly);
    }
    drawnEditorsRef.current = editors;
    restack();
    return () => {
      timers.forEach((t) => clearTimeout(t));
      editors.forEach((p) => p.remove());
      drawnEditorsRef.current = [];
    };
  }, [map, drawnItems, drawMode, restack]);

  // Draw mode — MANUAL polygon drawing. Each map click adds a vertex to a gold
  // preview line (plus a dot per vertex); double-click (or the "إنهاء الشكل"
  // button) closes the shape into ONE drawn_area item. A wrong point is undone
  // with the "تراجع" button or a right-click. Draw mode stays armed so several
  // separate shapes can be drawn in a row. District fills, element areas, drawn
  // shapes and landmark points are made unclickable while drawing so vertex
  // clicks over them register on the map instead of toggling a district.
  const [draftCount, setDraftCount] = useState(0);
  const draftPathRef = useRef<LatLng[]>([]);
  const finishDraftRef = useRef<() => void>(() => {});
  const undoLastRef = useRef<() => void>(() => {});
  useEffect(() => {
    drawModeRef.current = drawMode;
    districtOverlayRef.current?.restyle(); // clickable: !drawMode
    districtEditorsRef.current.forEach((ed, id) => {
      // Selected districts keep their edit handles OUTSIDE draw mode only —
      // handles would swallow the draw clicks.
      ed.poly.setEditable(!drawMode);
      ed.poly.setStyle({ ...styleFor(id, true), clickable: !drawMode });
    });
    // Landmark points must not swallow vertex clicks while drawing.
    landmarkOverlayRef.current?.restyle();
    if (drawMode) landmarkTooltipRef.current?.hide();
    if (!drawMode) setHoverName(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawMode]);
  // The preview line follows the chosen polarity color, even mid-draft.
  useEffect(() => {
    previewOverlayRef.current?.restyle();
  }, [drawPolarity]);
  useEffect(() => {
    if (!map || !drawMode) return;
    // Pinning the map is the CLICK FIX for trackpads: with panning on, the
    // few-pixel wobble between mousedown and mouseup reads as a drag, so the
    // map pans and 'click' never fires — "I click but it just moves around"
    // (live report 2026-07-13). While drawing the map is pinned; zoom controls
    // still work, and toggling draw off restores panning.
    map.dragPan.disable();
    map.doubleClickZoom.disable();
    setMapCursor(map, 'crosshair');
    // One overlay for the draft: the preview line (recolours with the polarity)
    // plus a visible DOT per clicked vertex — without the dot the FIRST click
    // draws nothing (a 1-point line is invisible) and reads as "clicking does
    // nothing" (live report 2026-07-16). A dot keeps the colour it was placed in.
    const preview = new GeoJsonOverlay(map, {
      style: (p): OverlayStyle => p.kind === 'dot'
        ? {
            pointRadius: 5, pointColor: String(p.color ?? GOLD), pointOpacity: 1,
            pointStrokeColor: '#FFFFFF', pointStrokeWeight: 2, zIndex: 7,
          }
        : {
            strokeColor: drawPolarityRef.current === 'exclude' ? RED : GOLD,
            strokeOpacity: 0.95, strokeWeight: 2.5, zIndex: 6,
          },
    });
    previewOverlayRef.current = preview;
    restack();
    draftPathRef.current = [];
    setDraftCount(0);
    const dotColors: string[] = [];
    const redraw = () => {
      const path = draftPathRef.current;
      preview.setData([
        ...(path.length >= 2 ? [lineFeature(path, { kind: 'line' })] : []),
        ...path.map((p, i) => pointFeature(p, { kind: 'dot', color: dotColors[i] ?? GOLD })),
      ]);
    };

    const finishDraft = () => {
      const path = draftPathRef.current;
      if (path.length >= 3) {
        const ring = path.map((p) => [round6(p.lng), round6(p.lat)] as [number, number]);
        ring.push(ring[0]!);
        const polarity = drawPolarityRef.current;
        setDrawnItems((prev) => {
          const nth = prev.filter((d) => d.polarity === polarity).length + 1;
          const label = coverageLabelRef.current(ring, polarity) ?? `${drawnBaseRef.current(polarity)} ${nth}`;
          return [...prev, newDrawnAreaItem(ring, label, polarity)];
        });
      }
      draftPathRef.current = [];
      dotColors.length = 0;
      redraw();
      setDraftCount(0);
    };
    finishDraftRef.current = finishDraft;

    // Undo the LAST clicked point (button + right-click) so a misplaced
    // segment can be redrawn without starting the whole shape over.
    const undoLast = () => {
      if (draftPathRef.current.length === 0) return;
      draftPathRef.current = draftPathRef.current.slice(0, -1);
      dotColors.pop();
      redraw();
      setDraftCount(draftPathRef.current.length);
    };
    undoLastRef.current = undoLast;

    // Map-level clicks: nothing is clickable while drawing, so every click on
    // the map lands here (a click on a DOM marker never does).
    const offClick = onEmptyMapClick(map, (e) => {
      draftPathRef.current = [...draftPathRef.current, { lat: e.lngLat.lat, lng: e.lngLat.lng }];
      dotColors.push(drawPolarityRef.current === 'exclude' ? RED : GOLD);
      redraw();
      setDraftCount(draftPathRef.current.length);
    }, 'click');
    const offDbl = onEmptyMapClick(map, () => finishDraft(), 'dblclick');
    const offRight = onEmptyMapClick(map, () => undoLast(), 'rightclick');

    return () => {
      offClick();
      offDbl();
      offRight();
      preview.remove();
      previewOverlayRef.current = null;
      draftPathRef.current = [];
      setDraftCount(0);
      finishDraftRef.current = () => {};
      undoLastRef.current = () => {};
      // The map may already be gone (picker closing / city change unmounts it).
      if (!isMapRemoved(map)) {
        map.dragPan.enable();
        map.doubleClickZoom.enable();
        setMapCursor(map, '');
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, drawMode]);

  // Apply: exclude districts pass through untouched; the include-district set
  // is rebuilt from the map selection (existing rules keep their ids/labels);
  // drawn areas AND element rules are re-emitted from the picker's working
  // lists (resized distances + deletions included).
  const apply = () => {
    const keep = items.filter((i) => {
      if (isDrawnItem(i)) return false;   // re-emitted from drawnItems below
      if (isElementItem(i)) return false; // re-emitted from elemItems below
      return !(isDistrictItem(i) && i.polarity === 'include' && !selected.has(i.district_id));
    });
    const have = new Set(keep.filter(isDistrictItem).filter((i) => i.polarity === 'include').map((i) => i.district_id));
    const added = [...selected]
      .filter((id) => !have.has(id))
      .map((id) => newDistrictItem(id, nameById.get(id) ?? id, 'include'));
    onApply([...keep, ...added, ...drawnItems, ...elemItems]);
    onClose();
  };

  // Rules whose area alone exceeds the market cap — the "shrink THIS one" list.
  const oversizedRules = previews
    .filter((p) => typeof p.listing_count === 'number' && p.listing_count > MARKET_LIMIT)
    .map((p) => ({
      row: p,
      item: elemItems.find((i) => i.id === p.item_id) ?? null,
    }));

  const selectedNames = [...selected].map((id) => nameById.get(id) ?? null).filter((n): n is string => !!n);

  // Search results: matching districts first, then landmarks (each with a
  // resolved display name), capped so the dropdown stays readable.
  interface SearchHit {
    key: string;
    type: 'district' | 'landmark' | 'road';
    name: string;
    districtId?: string;
    externalId?: string;
    lat?: number;
    lng?: number;
  }
  const searchHits = useMemo<SearchHit[]>(() => {
    // ALL-WORDS matching, not one contiguous substring: real road names carry
    // words between the ones people type («طريق تركي» vs the official
    // «طريق الأمير تركي بن عبدالعزيز الأول»), so every query word just has to
    // appear somewhere in the normalized name, in any order.
    const tokens = normSearch(search).split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const hit = (name: string) => {
      const n = normSearch(name);
      return tokens.every((t) => n.includes(t));
    };
    const nameOf = (l: LandmarkRow) => (isAr ? l.name_ar || l.display_name : l.name_en || l.display_name || l.name_ar) ?? '';
    const districtHits: SearchHit[] = (shapes ?? [])
      .filter((s) => hit(s.name))
      .slice(0, 8)
      .map((s) => ({ key: `d:${s.district_id}`, type: 'district', name: s.name, districtId: s.district_id }));
    const roadHits: SearchHit[] = roads
      .map((l) => ({ l, name: nameOf(l) }))
      .filter(({ name }) => name && hit(name))
      .slice(0, 6)
      .map(({ l, name }) => ({ key: `r:${l.external_id}`, type: 'road' as const, name, externalId: l.external_id, lat: l.latitude ?? undefined, lng: l.longitude ?? undefined }));
    const landmarkHits: SearchHit[] = landmarks
      .filter((l) => l.latitude != null && l.longitude != null)
      .map((l) => ({ l, name: nameOf(l) }))
      .filter(({ name }) => name && hit(name))
      .slice(0, 6)
      .map(({ l, name }) => ({ key: `l:${l.external_id}`, type: 'landmark' as const, name, lat: l.latitude!, lng: l.longitude! }));
    return [...districtHits, ...roadHits, ...landmarkHits];
  }, [search, shapes, landmarks, roads, isAr]);

  const runSearchHit = (hit: SearchHit) => {
    if (hit.type === 'district' && hit.districtId) {
      focusDistrictRef.current(hit.districtId);
    } else if (hit.type === 'landmark' && map && hit.lat != null && hit.lng != null) {
      // Pan + zoom in ONE camera move (a separate setZoom would cut the pan's
      // animation short). Zoom maths on the CLASSIC scale.
      map.easeTo({
        center: [hit.lng, hit.lat],
        zoom: toMapLibreZoom(Math.max(getZoomLevel(map), LANDMARK_NAMES_MIN_ZOOM)),
        duration: 400,
      });
    } else if (hit.type === 'road' && hit.externalId) {
      const extId = hit.externalId;
      // Pan to the road's representative point right away for responsiveness;
      // the selection effect reframes to the full line(s) once geometry loads.
      if (map && hit.lat != null && hit.lng != null) {
        map.easeTo({
          center: [hit.lng, hit.lat],
          zoom: toMapLibreZoom(Math.max(getZoomLevel(map), LANDMARK_NAMES_MIN_ZOOM)),
          duration: 400,
        });
      }
      if (supabase && !selectedRoads.some((r) => r.externalId === extId)) {
        supabase
          .rpc('wassell_geo_element_shapes', { p_external_ids: [extId] })
          .then(({ data, error }) => {
            if (error) { console.error('[DistrictMapPicker] road shape fetch failed:', error.message); return; }
            const row = Array.isArray(data) ? (data[0] as { geojson?: { type: string; coordinates: unknown } | null } | undefined) : undefined;
            if (row?.geojson) {
              setSelectedRoads((prev) => prev.some((r) => r.externalId === extId)
                ? prev
                : [...prev, { externalId: extId, name: hit.name, geojson: row.geojson! }]);
            }
          });
      }
    }
    setSearch('');
    setSearchFocused(false);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-charcoal/50 p-2 sm:p-4"
      dir={isAr ? 'rtl' : 'ltr'}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-full max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-cream shadow-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2.5 border-b border-sand/40 bg-white px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-copper/10">
            <MapIcon size={18} className="text-copper" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold text-chocolate">{L('اختيار المواقع من الخريطة', 'Pick locations on the map')}</h2>
            <p className="truncate text-[11px] text-charcoal/60">
              {drawMode
                ? drawPolarity === 'exclude'
                  ? L('منطقة استثناء: لن تظهر النتائج داخل هذا الشكل. انقر لإضافة النقاط، نقرة يمنى تتراجع عن آخر نقطة، ثم نقراً مزدوجاً (أو «إنهاء الشكل») لإغلاقه.', 'Exclusion zone: no results will show inside this shape. Click to add points, right-click undoes the last point, then double-click (or "Finish shape") to close it.')
                  : L('الخريطة مثبّتة أثناء الرسم — انقر لإضافة النقاط، نقرة يمنى تتراجع عن آخر نقطة، ثم نقراً مزدوجاً (أو «إنهاء الشكل») لإغلاقه.', 'The map is pinned while drawing — click to add points, right-click undoes the last point, then double-click (or "Finish shape") to close it.')
                : L('اضغط على حي لتضمينه — تظهر عليه مقابض: اسحب أي نقطة لتعديل حدوده فيتحول لمنطقة مرسومة خاصة بك. مناطق العناصر والأشكال المرسومة تُعدَّل بالسحب أيضاً (زر يمين على نقطة يحذفها).', 'Tap a district to include it — handles appear: drag any point to adjust its borders and it becomes your own drawn area. Element areas and drawn shapes are edited by dragging too (right-click a point deletes it).')}
            </p>
          </div>
          {drawMode && (
            // One labelled dropdown (was two side-by-side toggle buttons — read as
            // confusing). Defaults to «wanted» every time drawing starts.
            <label className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-charcoal/70">
              {drawPolarity === 'exclude' ? <Ban size={14} style={{ color: RED }} /> : <Check size={14} style={{ color: GOLD }} />}
              {L('هذه المنطقة:', 'This area is:')}
              <select
                value={drawPolarity}
                onChange={(e) => setDrawPolarity(e.target.value as GeoPolarity)}
                className="rounded-lg border bg-white px-2 py-1.5 text-xs font-bold focus:outline-none"
                style={{ borderColor: drawPolarity === 'exclude' ? RED : GOLD, color: drawPolarity === 'exclude' ? RED : '#8a6a38' }}
              >
                <option value="include">{L('مرغوبة', 'Wanted')}</option>
                <option value="exclude">{L('غير مرغوبة (استثناء)', 'Not wanted (exclude)')}</option>
              </select>
            </label>
          )}
          {drawMode && draftCount > 0 && (
            <button
              type="button"
              onClick={() => undoLastRef.current()}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-sand/60 bg-white px-2.5 py-2 text-xs font-bold text-charcoal/70 transition hover:bg-cream"
              title={L('تراجع عن آخر نقطة', 'Undo last point')}
            >
              <RotateCcw size={13} /> {L('تراجع', 'Undo')}
            </button>
          )}
          {drawMode && draftCount > 0 && draftCount < 3 && (
            <span className="shrink-0 rounded-lg bg-copper/10 px-2.5 py-2 text-xs font-bold text-copper">
              {L(`${draftCount} من 3 نقاط على الأقل`, `${draftCount} of 3+ points`)}
            </span>
          )}
          {drawMode && draftCount >= 3 && (
            <button
              type="button"
              onClick={() => finishDraftRef.current()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-copper px-3 py-2 text-sm font-bold text-white transition hover:bg-terracotta"
            >
              <Check size={15} /> {L(`إنهاء الشكل (${draftCount})`, `Finish shape (${draftCount})`)}
            </button>
          )}
          <button
            type="button"
            onClick={() => setDrawMode((v) => !v)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-bold transition ${
              drawMode ? 'border-copper bg-copper text-white hover:bg-terracotta' : 'border-copper/40 bg-copper/10 text-copper hover:bg-copper/20'
            }`}
          >
            <PenLine size={15} /> {drawMode ? L('إيقاف الرسم', 'Stop drawing') : L('رسم منطقة', 'Draw an area')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-charcoal/50 transition-colors hover:bg-cream hover:text-charcoal"
            aria-label={L('إغلاق', 'Close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* Map */}
        <div className="relative min-h-0 flex-1">
          {shapesError ? (
            // Map-load failures render inside MapCanvas; this is the boundaries RPC.
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-600">
              {L('تعذّر تحميل الخريطة أو حدود الأحياء.', 'Failed to load the map or district boundaries.')}
              <span className="ms-1 text-charcoal/40">({shapesError})</span>
            </div>
          ) : !shapes ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="animate-spin text-copper" />
            </div>
          ) : (
            <>
              <MapCanvas
                isAr={isAr}
                className="h-full w-full"
                center={DEFAULT_MAP_CENTER}
                zoom={10}
                onLoad={setMap}
                onUnmount={() => setMap(null)}
              />
              {/* Hovered district name — content set imperatively (see setHoverName). */}
              <div
                ref={hoverElRef}
                className="pointer-events-none absolute top-3 z-10 rounded-lg bg-white/95 px-3 py-1.5 text-sm font-bold text-chocolate shadow ring-1 ring-black/5"
                style={{ insetInlineStart: '0.75rem', display: 'none' }}
              />
              {/* Search: jump to a district (and select it) or a landmark */}
              {!drawMode && (
                <div className="absolute top-3 left-1/2 z-20 w-[min(88%,22rem)] -translate-x-1/2">
                  <div className="flex items-center gap-2 rounded-xl border border-sand/50 bg-white/95 px-3 py-2 shadow ring-1 ring-black/5 backdrop-blur">
                    <Search size={16} className="shrink-0 text-charcoal/50" />
                    <input
                      type="text"
                      value={search}
                      // Typing ALWAYS reopens the list. Picking a result closes it
                      // via setSearchFocused(false), but the result's mousedown
                      // preventDefault keeps DOM focus on the input — so no fresh
                      // onFocus would ever fire and the list stayed stuck shut.
                      onChange={(e) => { setSearch(e.target.value); setSearchFocused(true); }}
                      onFocus={() => setSearchFocused(true)}
                      onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && searchHits[0]) { e.preventDefault(); runSearchHit(searchHits[0]); }
                        else if (e.key === 'Escape') { setSearch(''); (e.target as HTMLInputElement).blur(); }
                      }}
                      placeholder={L('ابحث عن حي أو طريق أو معلم…', 'Search a district, road, or landmark…')}
                      className="min-w-0 flex-1 bg-transparent text-sm text-charcoal outline-none placeholder:text-charcoal/40"
                    />
                    {search && (
                      <button
                        type="button"
                        onClick={() => setSearch('')}
                        className="shrink-0 text-charcoal/40 transition-colors hover:text-charcoal"
                        aria-label={L('مسح', 'Clear')}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                  {searchFocused && search.trim() && (
                    <div className="mt-1.5 max-h-64 overflow-y-auto rounded-xl border border-sand/50 bg-white/97 shadow-lg ring-1 ring-black/5 backdrop-blur">
                      {searchHits.length === 0 ? (
                        <div className="px-3 py-2.5 text-sm text-charcoal/50">{L('لا نتائج', 'No matches')}</div>
                      ) : (
                        searchHits.map((hit) => {
                          const isSelected = hit.type === 'district' && !!hit.districtId && selected.has(hit.districtId);
                          const isExcluded = hit.type === 'district' && !!hit.districtId && excludedIds.has(hit.districtId);
                          return (
                            <button
                              key={hit.key}
                              type="button"
                              // onMouseDown so it fires before the input's blur closes the list
                              onMouseDown={(e) => { e.preventDefault(); runSearchHit(hit); }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm text-charcoal transition-colors hover:bg-cream"
                            >
                              {hit.type === 'district'
                                ? <MapIcon size={14} className="shrink-0 text-copper" />
                                : hit.type === 'road'
                                  ? <Route size={14} className="shrink-0" style={{ color: TERRACOTTA }} />
                                  : <MapPin size={14} className="shrink-0" style={{ color: TERRACOTTA }} />}
                              <span className="min-w-0 flex-1 truncate font-semibold">{hit.name}</span>
                              {isExcluded && <span className="shrink-0 text-[11px] font-bold" style={{ color: RED }}>{L('مستثنى', 'Excluded')}</span>}
                              {isSelected && <Check size={14} className="shrink-0 text-copper" />}
                              {hit.type === 'road' && <span className="shrink-0 text-[11px] text-charcoal/40">{L('طريق', 'Road')}</span>}
                              {hit.type === 'landmark' && <span className="shrink-0 text-[11px] text-charcoal/40">{L('معلم', 'Landmark')}</span>}
                            </button>
                          );
                        })
                      )}
                    </div>
                  )}
                  {/* Selected roads staging: pick 2+ roads → build one editable
                      polygon spanning the area between them. */}
                  {selectedRoads.length > 0 && (
                    <div className="mt-1.5 rounded-xl border border-sand/50 bg-white/97 p-2 shadow-lg ring-1 ring-black/5 backdrop-blur">
                      <div className="mb-1.5 flex flex-wrap gap-1">
                        {selectedRoads.map((r) => (
                          <span
                            key={r.externalId}
                            className="inline-flex max-w-[200px] items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
                            style={{ backgroundColor: `${TERRACOTTA}1F`, color: TERRACOTTA }}
                          >
                            <Route size={11} className="shrink-0" />
                            <span className="truncate">{r.name}</span>
                            <button
                              type="button"
                              onClick={() => setSelectedRoads((prev) => prev.filter((x) => x.externalId !== r.externalId))}
                              className="shrink-0 hover:opacity-60"
                              aria-label={L('حذف', 'Remove')}
                            >
                              <X size={11} />
                            </button>
                          </span>
                        ))}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={createAreaBetweenRoads}
                          disabled={selectedRoads.length < 2}
                          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white transition hover:bg-terracotta disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <PenLine size={13} />
                          {L(`أنشئ منطقة بين الطرق (${selectedRoads.length})`, `Area between roads (${selectedRoads.length})`)}
                        </button>
                        <button
                          type="button"
                          onClick={() => setSelectedRoads([])}
                          className="shrink-0 rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-xs font-bold text-charcoal/60 transition hover:bg-cream"
                        >
                          {L('مسح', 'Clear')}
                        </button>
                      </div>
                      <p className="mt-1 text-[10px] leading-tight text-charcoal/50">
                        {selectedRoads.length < 2
                          ? L('اختر طريقاً آخر لإنشاء منطقة بينهما.', 'Pick another road to build an area between them.')
                          : L('تُنشأ منطقة تغطي ما بين الطرق، ثم عدّلها بسحب مقابضها.', 'Builds an area spanning the roads — then drag its handles to refine.')}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer: selection summary + drawn-shape chips + element-rule chips
            (count + resize stepper) + oversize guidance + apply */}
        <div className="flex shrink-0 items-center gap-3 border-t border-sand/40 bg-white px-4 py-3">
          <div className="min-w-0 flex-1">
            {/* "Shrink THIS rule" — named, precise, with the exact number. */}
            {oversizedRules.length > 0 && (
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] font-semibold text-red-700">
                <TriangleAlert size={13} className="shrink-0" />
                {oversizedRules.map(({ row, item }) => (
                  <span key={row.item_id}>
                    {L(
                      `«${item ? describeLocationItem(item, true) : row.item_id}» تغطي ${Number(row.listing_count).toLocaleString('en-US')} إعلان — الحد ${MARKET_LIMIT.toLocaleString('en-US')}. صغّرها بزر −.`,
                      `"${item ? describeLocationItem(item, false) : row.item_id}" covers ${Number(row.listing_count).toLocaleString('en-US')} ads — limit ${MARKET_LIMIT.toLocaleString('en-US')}. Shrink it with −.`,
                    )}
                  </span>
                ))}
              </div>
            )}
            <span className="text-xs font-bold text-charcoal/70">
              {L(`${selected.size} حي مختار`, `${selected.size} district(s) selected`)}
              {drawnItems.length > 0 && (
                <span className="text-charcoal/50"> · {L(`${drawnItems.length} منطقة مرسومة`, `${drawnItems.length} drawn area(s)`)}</span>
              )}
              {elemItems.length > 0 && (
                <span className="text-charcoal/50"> · {L(`${elemItems.length} قاعدة معلم`, `${elemItems.length} element rule(s)`)}</span>
              )}
            </span>
            {selectedNames.length > 0 && (
              <p className="truncate text-[11px] text-charcoal/50">{selectedNames.join(' · ')}</p>
            )}
            {(drawnItems.length > 0 || elemItems.length > 0) && (
              <div className="mt-1 flex flex-wrap gap-1">
                {drawnItems.map((d) => (
                  <span
                    key={d.id}
                    className="inline-flex max-w-[280px] items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
                    style={{ backgroundColor: `${d.polarity === 'exclude' ? RED : GOLD}1F`, color: d.polarity === 'exclude' ? RED : '#8a6a38' }}
                  >
                    <span className="truncate">{d.label || L('منطقة مرسومة', 'Drawn area')}</span>
                    <button
                      type="button"
                      onClick={() => setDrawnItems((prev) => prev.filter((x) => x.id !== d.id))}
                      className="shrink-0 hover:opacity-60"
                      aria-label={L('حذف', 'Delete')}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
                {/* Element-rule chips: label + covered-listings count + a −/+
                    resize stepper (recompiles + redraws the shape) + delete. */}
                {elemItems.map((it) => {
                  const row = previews.find((p) => p.item_id === it.id);
                  const count = typeof row?.listing_count === 'number' ? row.listing_count : null;
                  const over = count !== null && count > MARKET_LIMIT;
                  const dist = ruleDistanceM(it);
                  const c = over ? RED : it.polarity === 'exclude' ? RED : TERRACOTTA;
                  return (
                    <span
                      key={it.id}
                      className={`inline-flex max-w-[360px] items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ${over ? 'ring-1 ring-red-400' : ''}`}
                      style={{ backgroundColor: `${c}1F`, color: c }}
                    >
                      <span className="truncate">{describeLocationItem(it, isAr)}</span>
                      {count !== null && (
                        <span className="shrink-0 rounded-full bg-white/70 px-1.5 font-bold">
                          {count.toLocaleString('en-US')} {L('إعلان', 'ads')}
                        </span>
                      )}
                      {previewLoading && <Loader2 size={10} className="shrink-0 animate-spin" />}
                      {dist !== null && (
                        <span className="inline-flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => setRuleDistanceM(it.id, Math.max(DIST_STEP_M, dist - DIST_STEP_M))}
                            className="rounded-full bg-white/70 p-0.5 hover:opacity-70"
                            aria-label={L('تصغير المسافة', 'Shrink distance')}
                          >
                            <Minus size={10} />
                          </button>
                          <span className="min-w-[42px] text-center">{(dist / 1000).toFixed(1)} {L('كم', 'km')}</span>
                          <button
                            type="button"
                            onClick={() => setRuleDistanceM(it.id, dist + DIST_STEP_M)}
                            className="rounded-full bg-white/70 p-0.5 hover:opacity-70"
                            aria-label={L('تكبير المسافة', 'Grow distance')}
                          >
                            <Plus size={10} />
                          </button>
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setElemItems((prev) => prev.filter((x) => x.id !== it.id))}
                        className="shrink-0 hover:opacity-60"
                        aria-label={L('حذف', 'Delete')}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg border border-sand/60 bg-white px-3.5 py-2 text-sm font-bold text-charcoal/70 transition hover:bg-cream"
          >
            {L('إلغاء', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={apply}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-copper px-4 py-2 text-sm font-bold text-white transition hover:bg-terracotta"
          >
            <Check size={15} /> {L('تم', 'Apply')}
          </button>
        </div>
      </div>
    </div>
  );
}
