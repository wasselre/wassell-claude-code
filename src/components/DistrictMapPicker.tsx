import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { Ban, Check, Loader2, Map as MapIcon, MapPin, Minus, PenLine, Plus, RotateCcw, Route, Search, TriangleAlert, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { DEFAULT_MAP_CENTER, WASSEL_MAP_STYLE, GEO_LABEL_SUPPRESSION, buildPillIcon } from '@/lib/locationUtils';
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
/** Selected-road highlight. Deliberately NOT terracotta/copper: WASSEL_MAP_STYLE
 *  paints highway fills #B8734F and their casings #8E4E3A, so those colours are
 *  invisible against the basemap (live report 2026-07-27). Rich Chocolate Brown
 *  is the darkest brand colour and nothing else on this map comes close to it. */
const ROAD_HIGHLIGHT = '#4A2C2A';
/** Flowing-dash animation on the selected road. Google Maps can only draw dashes
 *  as repeated `icons` on a Polyline (Data layers can't dash at all), and each
 *  frame costs one `set()` PER line part — so this is deliberately bounded:
 *  only the longest DASH_MAX_PARTS parts animate (the static core still covers
 *  the whole road), and the tick is slow enough to read as flow without running
 *  a hot loop. ST_LineMerge on the road data (2026-07-27) cut the worst road
 *  from 155 parts to 57, which is what makes this affordable at all. */
const DASH_MAX_PARTS = 60;
const DASH_REPEAT_PX = 24;
const DASH_TICK_MS = 90;

/** Element types shown as landmark pins on the picker — the sales-relevant
 *  anchors (all curated + verified in geo_elements). Roads/metro/parks are
 *  deliberately left out: too dense to read at city zoom. */
const LANDMARK_TYPES = ['landmarks', 'malls', 'universities', 'airports_transport', 'islands'];
/** Road-like element types — SEARCHABLE but never drawn as pins (too dense to
 *  read at city zoom). Picking one from search draws its actual line so the user
 *  can see where it runs. Roads/ring roads/metro lines are all MultiLineString. */
const ROAD_TYPES = ['roads_major', 'ring_roads', 'metro_lines'];
/** District name labels + landmark pins appear from this zoom in (city-wide
 *  view stays clean). */
const LABELS_MIN_ZOOM = 11;
/** Zoom the map snaps to when focusing a landmark — close enough that the dots are
 *  individually distinguishable. It no longer gates NAMES: landmarks render as points
 *  only, because at UAE scale their labels buried the map. */
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
 *  Picker map style = the brand style with ALL of Google's basemap text turned
 *  off — we render every district's name ourselves at its centroid, so the
 *  basemap copy would show each name TWICE (live report 2026-07-13). The shared
 *  `GEO_LABEL_SUPPRESSION` (locationUtils) is now a GLOBAL label-off used by
 *  every geo map (no Google text anywhere, per the 2026-08-23 requirement), so
 *  this map and the rest all read the same: our names only. */
const PICKER_MAP_STYLE: google.maps.MapTypeStyle[] = [
  ...WASSEL_MAP_STYLE,
  ...GEO_LABEL_SUPPRESSION,
];

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
  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const [map, setMap] = useState<google.maps.Map | null>(null);
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
        let ring: google.maps.LatLngLiteral[] = [];
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
  // Rendered via google.maps.Data (ONE feature per road) rather than one
  // Polyline per line part: a merged road like الدائري الشمالي has 155 parts,
  // which would otherwise mean 310 Polylines for the casing + core.
  useEffect(() => {
    if (!map || !isLoaded || !window.google || selectedRoads.length === 0) return;
    const layers: google.maps.Data[] = [];
    const markers: google.maps.Marker[] = [];
    const bounds = new google.maps.LatLngBounds();
    /** Every line part across all selected roads, ranked later for the dash layer. */
    const dashCandidates: Array<{ path: google.maps.LatLngLiteral[]; len: number }> = [];

    for (const r of selectedRoads) {
      const feature = { type: 'Feature' as const, geometry: r.geojson, properties: {} };
      const casing = new google.maps.Data({ map });
      casing.addGeoJson(feature);
      casing.setStyle({ strokeColor: '#FFFFFF', strokeWeight: 13, strokeOpacity: 1, zIndex: 7, clickable: false });
      const core = new google.maps.Data({ map });
      core.addGeoJson(feature);
      core.setStyle({ strokeColor: ROAD_HIGHLIGHT, strokeWeight: 6, strokeOpacity: 1, zIndex: 8, clickable: false });
      layers.push(casing, core);

      // Label the LONGEST part's midpoint — on a many-part road the first part
      // can be a stub anywhere along it.
      let longest: google.maps.LatLngLiteral[] = [];
      for (const line of geojsonToLinePaths(r.geojson)) {
        if (line.length < 2) continue;
        for (const p of line) bounds.extend(p);
        if (line.length > longest.length) longest = line;
        // rough planar length, only ever used to RANK parts for the dash layer
        let len = 0;
        for (let i = 1; i < line.length; i++) {
          len += Math.abs(line[i]!.lat - line[i - 1]!.lat) + Math.abs(line[i]!.lng - line[i - 1]!.lng);
        }
        dashCandidates.push({ path: line, len });
      }
      if (longest.length && r.name) {
        markers.push(new google.maps.Marker({
          map,
          position: longest[Math.floor(longest.length / 2)]!,
          icon: buildPillIcon(r.name, ROAD_HIGHLIGHT) as google.maps.Icon | undefined,
          clickable: false,
          zIndex: 9,
        }));
      }
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, 80);

    // Flowing white dashes along the road — the "this one is live" cue. Bounded
    // to the longest DASH_MAX_PARTS parts; the static core below already covers
    // every part, so an un-dashed stub is invisible in practice.
    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dashLines: google.maps.Polyline[] = [];
    if (!reduceMotion) {
      const chosen = dashCandidates.sort((a, b) => b.len - a.len).slice(0, DASH_MAX_PARTS);
      for (const { path } of chosen) {
        dashLines.push(new google.maps.Polyline({
          map,
          path,
          strokeOpacity: 0, // the line itself is invisible — only the dashes show
          zIndex: 9,
          clickable: false,
          icons: [{
            icon: {
              path: 'M 0,-1 0,1',
              strokeColor: '#FFFFFF',
              strokeOpacity: 0.95,
              strokeWeight: 4,
              scale: 3,
            },
            offset: '0px',
            repeat: `${DASH_REPEAT_PX}px`,
          }],
        }));
      }
    }
    let step = 0;
    const timer = dashLines.length
      ? setInterval(() => {
          step = (step + 2) % DASH_REPEAT_PX;
          for (const pl of dashLines) {
            const icons = pl.get('icons') as google.maps.IconSequence[];
            if (!icons?.[0]) continue;
            icons[0].offset = `${step}px`;
            pl.set('icons', icons); // set() is what triggers the redraw
          }
        }, DASH_TICK_MS)
      : null;

    return () => {
      if (timer) clearInterval(timer);
      dashLines.forEach((l) => l.setMap(null));
      layers.forEach((l) => l.setMap(null));
      markers.forEach((m) => m.setMap(null));
    };
  }, [map, isLoaded, selectedRoads]);

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

  // (Re)build the polygons when the map + shapes are ready. Selection changes
  // restyle IN PLACE (no rebuild) via the polygonsRef.
  //
  // A SELECTED district is EDITABLE (user decision 2026-07-18): its polygon
  // swaps to a decimated ring (≤80 handles) with vertex/midpoint handles — the
  // moment a handle is dragged (or a vertex right-click-deleted) the edited
  // ring CONVERTS into a drawn_area item ("منطقة مرسومة: <الحي>") and the
  // district rule is replaced by the custom shape. Untouched selections stay
  // ordinary district rules with the official boundary.
  const polygonsRef = useRef<Map<string, google.maps.Polygon>>(new Map());
  interface DistrictMeta {
    poly: google.maps.Polygon;
    fullPaths: google.maps.LatLngLiteral[][];
    decimated: google.maps.LatLngLiteral[];
    pathListeners: google.maps.MapsEventListener[];
    editTimer?: ReturnType<typeof setTimeout>;
    /** Precomputed extent, so viewport culling is O(1) per district per pan. */
    bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number };
    /** Whether the polygon is currently attached to the map (culling state). */
    shown?: boolean;
  }
  const districtMetaRef = useRef<Map<string, DistrictMeta>>(new Map());
  const drawModeRef = useRef(false);
  const styleFor = (id: string, isSelected: boolean): google.maps.PolygonOptions =>
    excludedIds.has(id)
      ? { fillColor: RED, fillOpacity: 0.22, strokeColor: RED, strokeOpacity: 0.8, strokeWeight: 2, zIndex: 2 }
      : isSelected
        ? { fillColor: COPPER, fillOpacity: 0.38, strokeColor: COPPER, strokeOpacity: 1, strokeWeight: 2.5, zIndex: 3 }
        : { fillColor: CHARCOAL, fillOpacity: 0.06, strokeColor: CHARCOAL, strokeOpacity: 0.65, strokeWeight: 1.5, zIndex: 1 };

  useEffect(() => {
    if (!map || !isLoaded || !shapes || !window.google) return;
    const polys = polygonsRef.current;
    const metas = districtMetaRef.current;
    const bounds = new google.maps.LatLngBounds();

    const clearPathListeners = (m: DistrictMeta) => {
      m.pathListeners.forEach((l) => google.maps.event.removeListener(l));
      m.pathListeners = [];
      if (m.editTimer) { clearTimeout(m.editTimer); m.editTimer = undefined; }
    };

    // The edited ring becomes a drawn_area; the district rule is dropped and
    // its polygon returns to the official (unselected) rendering.
    const convertEdited = (s: DistrictShape, m: DistrictMeta) => {
      const pts = m.poly.getPath().getArray().map((ll) => [round6(ll.lng()), round6(ll.lat())] as [number, number]);
      exitEditable(s, m, false);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(s.district_id);
        return next;
      });
      if (pts.length < 3) return;
      const ring = [...pts, pts[0]!];
      setDrawnItems((prev) => [
        ...prev,
        newDrawnAreaItem(
          ring,
          coverageLabelRef.current(ring, 'include') ?? `${drawnBaseRef.current('include')}: ${s.name}`,
          'include',
        ),
      ]);
    };

    const wireEditListeners = (s: DistrictShape, m: DistrictMeta) => {
      clearPathListeners(m);
      const gPath = m.poly.getPath();
      // Debounced: a handle drag can fire set_at repeatedly — convert once,
      // from the final geometry.
      const onEdit = () => {
        if (m.editTimer) clearTimeout(m.editTimer);
        m.editTimer = setTimeout(() => convertEdited(s, m), 400);
      };
      m.pathListeners = [
        gPath.addListener('set_at', onEdit),
        gPath.addListener('insert_at', onEdit),
        gPath.addListener('remove_at', onEdit),
      ];
    };

    const enterEditable = (s: DistrictShape, m: DistrictMeta) => {
      m.poly.setPaths([m.decimated]);
      m.poly.setOptions({ ...styleFor(s.district_id, true), editable: !drawModeRef.current });
      wireEditListeners(s, m);
    };
    const exitEditable = (s: DistrictShape, m: DistrictMeta, stillSelected: boolean) => {
      clearPathListeners(m);
      m.poly.setPaths(m.fullPaths);
      m.poly.setOptions({ ...styleFor(s.district_id, stillSelected), editable: false });
    };

    for (const s of shapes) {
      const paths = geojsonToPaths(s.geojson);
      if (!paths.length) continue;
      let largest: google.maps.LatLngLiteral[] = [];
      for (const p of paths) if (p.length > largest.length) largest = p;
      const step = Math.max(1, Math.ceil(largest.length / CONVERT_MAX_POINTS));
      const decimated = largest.filter((_, i) => i % step === 0);
      const poly = new google.maps.Polygon({
        paths,
        map,
        clickable: true,
        ...styleFor(s.district_id, false),
      });
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
      for (const path of paths) for (const pt of path) {
        if (pt.lat < minLat) minLat = pt.lat; if (pt.lat > maxLat) maxLat = pt.lat;
        if (pt.lng < minLng) minLng = pt.lng; if (pt.lng > maxLng) maxLng = pt.lng;
      }
      const meta: DistrictMeta = {
        poly, fullPaths: paths, decimated, pathListeners: [],
        bbox: { minLat, maxLat, minLng, maxLng }, shown: true,
      };
      metas.set(s.district_id, meta);

      poly.addListener('click', () => {
        if (excludedIds.has(s.district_id)) return; // exclude rules are managed from the chips
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(s.district_id)) {
            next.delete(s.district_id);
            exitEditable(s, meta, false);
          } else {
            next.add(s.district_id);
            enterEditable(s, meta);
          }
          return next;
        });
      });
      // Right-click: on a SELECTED district's vertex → delete that vertex
      // (flows into the edit→convert path); anywhere else → copy the official
      // boundary into a NEW editable drawn shape without selecting it.
      poly.addListener('rightclick', (e: google.maps.PolyMouseEvent) => {
        if (excludedIds.has(s.district_id) || drawModeRef.current) return;
        if (selectedRef.current.has(s.district_id) && e.vertex != null) {
          const gPath = meta.poly.getPath();
          if (gPath.getLength() > 3) gPath.removeAt(e.vertex);
          return;
        }
        const lngLat = meta.decimated.map((p) => [round6(p.lng), round6(p.lat)] as [number, number]);
        if (lngLat.length < 3) return;
        lngLat.push(lngLat[0]!);
        setDrawnItems((prev) => [
          ...prev,
          newDrawnAreaItem(lngLat, `${drawnBaseRef.current('include')}: ${s.name}`, 'include'),
        ]);
      });
      poly.addListener('mouseover', () => setHoverName(s.name));
      poly.addListener('mouseout', () => setHoverName((n) => (n === s.name ? null : n)));
      polys.set(s.district_id, poly);
      // Districts already selected (saved rules / the editor's options list)
      // open EDITABLE right away — "select it, then adjust the highlighted area".
      if (selectedRef.current.has(s.district_id)) enterEditable(s, meta);
      for (const path of paths) for (const p of path) bounds.extend(p);
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, 24);

    // Search → focus a district: zoom to its boundary and select it (same
    // enter-editable behavior as a polygon tap). Already-excluded districts are
    // only focused (they're managed from the chips, not toggled here).
    focusDistrictRef.current = (id: string) => {
      const s = shapes.find((x) => x.district_id === id);
      const meta = metas.get(id);
      if (!s || !meta) return;
      const b = new google.maps.LatLngBounds();
      for (const path of meta.fullPaths) for (const p of path) b.extend(p);
      if (!b.isEmpty()) map.fitBounds(b, 48);
      if (excludedIds.has(id)) return;
      setSelected((prev) => {
        if (prev.has(id)) return prev; // already selected — just re-centered
        const next = new Set(prev);
        next.add(id);
        enterEditable(s, meta);
        return next;
      });
    };

    // ── viewport culling ──────────────────────────────────────────────────
    //
    // Every district of the city gets its own google.maps.Polygon with click,
    // rightclick and hover listeners. That was fine at Riyadh's 189; Dubai has 513
    // and the map became an unreadable mass of overlapping outlines that lagged on
    // every zoom — reported from the live app.
    //
    // The polygons are NOT rebuilt: selection state, edit handles and listeners all
    // live on them. They are just detached from the map when they cannot be seen —
    // off-screen, or too small to make out at this zoom. A SELECTED district always
    // stays attached, because the user is working on it and it may well be off-screen
    // while they pan.
    const MIN_SPAN_PX = 8; // below this a district is a speck; drawing it only costs
    const cull = () => {
      const b = map.getBounds();
      const zoom = map.getZoom();
      if (!b || typeof zoom !== 'number') return;
      const sw = b.getSouthWest(), ne = b.getNorthEast();
      // Degrees per pixel at this zoom (world is 256 px at z0).
      const degPerPx = 360 / (256 * Math.pow(2, zoom));
      const minSpan = degPerPx * MIN_SPAN_PX;
      metas.forEach((m, id) => {
        if (!m.bbox) return;
        const keep =
          selectedRef.current.has(id) ||
          (m.bbox.maxLat >= sw.lat() && m.bbox.minLat <= ne.lat() &&
           m.bbox.maxLng >= sw.lng() && m.bbox.minLng <= ne.lng() &&
           Math.max(m.bbox.maxLat - m.bbox.minLat, m.bbox.maxLng - m.bbox.minLng) >= minSpan);
        if (keep !== m.shown) { m.poly.setMap(keep ? map : null); m.shown = keep; }
      });
    };
    let cullTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleCull = () => {
      if (cullTimer) clearTimeout(cullTimer);
      cullTimer = setTimeout(cull, 120);
    };
    // bounds_changed, not idle: idle is a render-completion event and does not fire
    // in every environment (see useGeoBoundaryLayer for the measurements).
    const cullListener = map.addListener('bounds_changed', scheduleCull);
    scheduleCull();

    return () => {
      focusDistrictRef.current = () => {};
      cullListener.remove();
      if (cullTimer) clearTimeout(cullTimer);
      metas.forEach((m) => clearPathListeners(m));
      metas.clear();
      polys.forEach((p) => p.setMap(null));
      polys.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, shapes]);

  // District NAME labels on every polygon + landmark POINTS, both zoom-gated from
  // LABELS_MIN_ZOOM so the city-wide view stays readable. The district name is the
  // only text this map draws; landmarks are dots with a hover title. Labels are
  // transparent-icon markers at each district's largest-ring centroid.
  const landmarkMarkersRef = useRef<google.maps.Marker[]>([]);
  useEffect(() => {
    if (!map || !isLoaded || !shapes || !window.google) return;
    const invisible: google.maps.Symbol = { path: google.maps.SymbolPath.CIRCLE, scale: 0 };
    /** A marker plus the state needed to attach/detach it WITHOUT redundant work. */
    interface MarkerEntry {
      marker: google.maps.Marker;
      position: google.maps.LatLngLiteral;
      name?: string;
      /** Whether it's currently attached to the map — so we only call setMap on a real change. */
      on: boolean;
      /** District extent in DEGREES — how much room the name has to live in. */
      spanLat?: number;
      spanLng?: number;
      /** True for district names; landmarks are points and never compete for label space. */
      isLabel?: boolean;
      /** District this label belongs to — lets a SELECTED district keep its name. */
      districtId?: string;
    }
    const labelEntries: MarkerEntry[] = [];
    for (const s of shapes) {
      let ring: google.maps.LatLngLiteral[] = [];
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
        marker: new google.maps.Marker({
          position: { lat, lng },
          icon: invisible,
          clickable: false,
          label: { text: s.name, color: CHARCOAL, fontSize: '11px', fontWeight: '700' },
        }),
        position: { lat, lng },
        on: false,
        spanLat: rMaxLat - rMinLat,
        spanLng: rMaxLng - rMinLng,
        isLabel: true,
        districtId: s.district_id,
      });
    }
    const lmEntries: MarkerEntry[] = landmarks
      .filter((l) => l.latitude != null && l.longitude != null)
      .map((l) => {
        const name = (isAr ? l.name_ar || l.display_name : l.name_en || l.display_name || l.name_ar) ?? '';
        const position = { lat: l.latitude!, lng: l.longitude! };
        return {
          marker: new google.maps.Marker({
            // A LANDMARK IS A POINT HERE, NOT A LABEL.
            //
            // These used to carry their name as a rendered label above
            // LANDMARK_NAMES_MIN_ZOOM. That read fine against Riyadh's 725 anchors and
            // became the single worst thing on the map once the UAE import pushed the
            // set to ~3,900: hundreds of overlapping terracotta names on top of the
            // district mesh. Small dot only, at the same scale the shared map layer
            // uses (useGeoBoundaryLayer), so every map draws landmarks alike. The name
            // still arrives on hover via `title`.
            position,
            icon: {
              path: google.maps.SymbolPath.CIRCLE, scale: 3.2,
              fillColor: TERRACOTTA, fillOpacity: 0.95, strokeColor: '#fff', strokeWeight: 1,
            },
            title: name,
            clickable: true, // hover shows the name
            zIndex: 5,
          }),
          position,
          name,
          on: false,
        };
      });
    const entries = [...labelEntries, ...lmEntries];
    landmarkMarkersRef.current = lmEntries.map((e) => e.marker);

    // PERF (2026-07-24): this used to run on every `zoom_changed` and blindly
    // setMap() all ~400 markers (+ setLabel() on every landmark) — ~580 marker
    // ops per zoom tick, and Google fires zoom_changed repeatedly through a
    // single scroll/pinch zoom. That made zooming stutter and panning feel
    // heavy. Two fixes:
    //   1. Drive off `idle` (fires ONCE after a pan/zoom settles) instead of
    //      every zoom tick.
    //   2. Only attach markers inside the PADDED viewport, and only call
    //      setMap/setLabel when the value actually changes — so a settle that
    //      changes nothing costs zero marker ops.
    // Labels only show at zoom >= LABELS_MIN_ZOOM, where a handful of districts
    // are on screen; we were attaching all 219 regardless.
    const syncMarkers = () => {
      const z = map.getZoom() ?? 0;
      if (z < LABELS_MIN_ZOOM) {
        for (const e of entries) if (e.on) { e.marker.setMap(null); e.on = false; }
        return;
      }
      // Pad the viewport by 25% so markers are already attached just before
      // they scroll into view (no pop-in at the edges).
      let south = -90, north = 90, west = -180, east = 180;
      const b = map.getBounds();
      if (b) {
        const ne = b.getNorthEast(), sw = b.getSouthWest();
        const padLat = (ne.lat() - sw.lat()) * 0.25;
        const padLng = (ne.lng() - sw.lng()) * 0.25;
        south = sw.lat() - padLat; north = ne.lat() + padLat;
        west = sw.lng() - padLng; east = ne.lng() + padLng;
      }
      // Decluttered district names — shared with every other map via
      // `pickVisibleLabels`, so a dense city reads the same way everywhere.
      // A SELECTED district gets priority: you asked for it, so it keeps its name
      // however small it is and whoever it would collide with.
      const inView = (e: MarkerEntry) =>
        e.position.lat >= south && e.position.lat <= north
        && e.position.lng >= west && e.position.lng <= east;

      const candidates = entries
        .filter((e) => e.isLabel && inView(e))
        .map((e, i) => {
          const raw = e.marker.getLabel();
          return {
            id: String(i),
            text: typeof raw === 'string' ? raw : (raw?.text ?? ''),
            lat: e.position.lat, lng: e.position.lng,
            spanLat: e.spanLat ?? 0, spanLng: e.spanLng ?? 0,
            priority: e.districtId && selectedRef.current.has(e.districtId) ? 1 : 0,
            entry: e,
          };
        });
      const keep = pickVisibleLabels(candidates, {
        zoom: z, centerLat: map.getCenter()?.lat() ?? 25,
      });
      for (const c of candidates) {
        const show = keep.has(c.id);
        if (show !== c.entry.on) { c.entry.marker.setMap(show ? map : null); c.entry.on = show; }
      }
      // Labels that scrolled out of view still need detaching.
      for (const e of entries) {
        if (e.isLabel) { if (!inView(e) && e.on) { e.marker.setMap(null); e.on = false; } continue; }
        const on = inView(e);
        if (on !== e.on) { e.marker.setMap(on ? map : null); e.on = on; }
      }
    };
    syncMarkers();
    const il = map.addListener('idle', syncMarkers);
    return () => {
      google.maps.event.removeListener(il);
      entries.forEach((e) => e.marker.setMap(null));
      landmarkMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, shapes, landmarks, isAr]);

  // ELEMENT-RULE overlays: every rule's COMPILED area (radius circle, road-side
  // band, road buffer, zone) as a terracotta polygon — direction rules arrive
  // already clipped to the matched side by the preview RPC. Roads additionally
  // draw their reference line. Labeled with the same chip text as the editor.
  //
  // Element areas are EDITABLE like selected districts (user decision
  // 2026-07-18): the largest ring renders with drag handles (decimated to ≤80);
  // dragging a handle — or right-click-deleting a vertex — converts the edited
  // ring into a drawn_area of the SAME polarity, replacing the element rule
  // with the custom shape. Untouched rules keep following the element + km
  // (the chip steppers resize without converting).
  useEffect(() => {
    if (!map || !isLoaded || !window.google || previews.length === 0) return;
    const overlays: Array<google.maps.Polygon | google.maps.Polyline | google.maps.Marker> = [];
    const listeners: google.maps.MapsEventListener[] = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const invisible: google.maps.Symbol = { path: google.maps.SymbolPath.CIRCLE, scale: 0 };

    const convertEdited = (item: ElementRuleLocationItem, poly: google.maps.Polygon) => {
      const pts = poly.getPath().getArray().map((ll) => [round6(ll.lng()), round6(ll.lat())] as [number, number]);
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
        let largest: google.maps.LatLngLiteral[] = [];
        for (const p of paths) if (p.length > largest.length) largest = p;
        if (largest.length >= 3) {
          const step = Math.max(1, Math.ceil(largest.length / CONVERT_MAX_POINTS));
          const decimated = largest.filter((_, i) => i % step === 0);
          const poly = new google.maps.Polygon({
            map,
            paths: [decimated],
            fillColor: c, fillOpacity: 0.14, strokeColor: c, strokeOpacity: 0.85, strokeWeight: 2,
            zIndex: 2,
            editable: !drawMode,
            clickable: !drawMode,
          });
          overlays.push(poly);
          // Clipped direction bands can be MultiPolygon — draw the remaining
          // pieces as display-only fills so the area still reads complete.
          for (const p of paths) {
            if (p === largest || p.length < 3) continue;
            overlays.push(new google.maps.Polygon({
              map, paths: [p],
              fillColor: c, fillOpacity: 0.14, strokeColor: c, strokeOpacity: 0.85, strokeWeight: 2,
              zIndex: 2, clickable: false,
            }));
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onEdit = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => convertEdited(item, poly), 400);
            timers.push(timer);
          };
          const gPath = poly.getPath();
          listeners.push(
            gPath.addListener('set_at', onEdit),
            gPath.addListener('insert_at', onEdit),
            gPath.addListener('remove_at', onEdit),
            poly.addListener('rightclick', (e: google.maps.PolyMouseEvent) => {
              if (e.vertex == null || drawMode) return;
              if (gPath.getLength() > 3) gPath.removeAt(e.vertex); // remove_at → convert
            }),
          );
          if (text) {
            overlays.push(new google.maps.Marker({
              map,
              position: {
                lat: largest.reduce((a, p) => a + p.lat, 0) / largest.length,
                lng: largest.reduce((a, p) => a + p.lng, 0) / largest.length,
              },
              icon: invisible,
              clickable: false,
              label: { text, color: c, fontSize: '11px', fontWeight: '700' },
            }));
          }
        }
      }
      if (row.ref_geojson) {
        for (const line of geojsonToLinePaths(row.ref_geojson)) {
          overlays.push(new google.maps.Polyline({
            map, path: line, strokeColor: c, strokeOpacity: 0.95, strokeWeight: 4, zIndex: 3, clickable: false,
          }));
        }
      }
    }
    return () => {
      timers.forEach((t) => clearTimeout(t));
      listeners.forEach((l) => google.maps.event.removeListener(l));
      overlays.forEach((o) => o.setMap(null));
    };
  }, [map, isLoaded, previews, elemItems, isAr, drawMode]);

  // Render the drawn shapes as EDITABLE polygons (outside draw mode): drag a
  // vertex or midpoint handle to reshape; right-click a vertex to delete it
  // (below 3 points → the shape is deleted). Edits debounce back into
  // drawnItems with a recomputed coverage label. Gold = include, red = a saved
  // exclude drawn area. Whole-shape delete stays on the footer chips.
  useEffect(() => {
    if (!map || !isLoaded || !window.google) return;
    const cleanups: Array<() => void> = [];
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
      const poly = new google.maps.Polygon({
        map,
        paths: path,
        fillColor: c, fillOpacity: 0.3, strokeColor: c, strokeOpacity: 0.95, strokeWeight: 2,
        zIndex: 4,
        editable: !drawMode,
        clickable: !drawMode,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const commit = () => {
        const pts = poly.getPath().getArray().map((ll) => [round6(ll.lng()), round6(ll.lat())] as [number, number]);
        if (pts.length < 3) return;
        const ring = [...pts, pts[0]!];
        setDrawnItems((prev) => prev.map((x) => x.id === d.id
          ? { ...x, coordinates: ring, label: coverageLabelRef.current(ring, x.polarity) ?? x.label }
          : x));
      };
      const debounced = () => { if (timer) clearTimeout(timer); timer = setTimeout(commit, 500); };
      const gPath = poly.getPath();
      const ls = [
        gPath.addListener('set_at', debounced),
        gPath.addListener('insert_at', debounced),
        gPath.addListener('remove_at', debounced),
        poly.addListener('rightclick', (e: google.maps.PolyMouseEvent) => {
          if (e.vertex == null) return;
          if (gPath.getLength() > 3) gPath.removeAt(e.vertex);
          else setDrawnItems((prev) => prev.filter((x) => x.id !== d.id));
        }),
      ];
      cleanups.push(() => {
        ls.forEach((l) => google.maps.event.removeListener(l));
        if (timer) clearTimeout(timer);
        poly.setMap(null);
      });
    }
    return () => cleanups.forEach((f) => f());
  }, [map, isLoaded, drawnItems, drawMode]);

  // Draw mode — MANUAL polygon drawing (Google REMOVED DrawingManager in Maps
  // JS v3.65; instantiating it throws — live incident 2026-07-13). Each map
  // click adds a vertex to a gold preview polyline; double-click (or the
  // "إنهاء الشكل" button) closes the shape into ONE drawn_area item. A wrong
  // point is undone with the "تراجع" button or a right-click. Draw mode stays
  // armed so several separate shapes can be drawn in a row. District polygons
  // are made unclickable while drawing so vertex clicks over them register on
  // the map instead of toggling a district.
  const [draftCount, setDraftCount] = useState(0);
  const draftPathRef = useRef<google.maps.LatLngLiteral[]>([]);
  const finishDraftRef = useRef<() => void>(() => {});
  const undoLastRef = useRef<() => void>(() => {});
  const previewRef = useRef<google.maps.Polyline | null>(null);
  useEffect(() => {
    drawModeRef.current = drawMode;
    polygonsRef.current.forEach((p, id) => p.setOptions({
      clickable: !drawMode,
      // Selected districts keep their edit handles OUTSIDE draw mode only —
      // handles would swallow the draw clicks.
      editable: !drawMode && selectedRef.current.has(id) && !excludedIds.has(id),
    }));
    // Landmark pins must not swallow vertex clicks while drawing.
    landmarkMarkersRef.current.forEach((m) => m.setClickable(!drawMode));
    if (!drawMode) setHoverName(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawMode]);
  // The preview line follows the chosen polarity color, even mid-draft.
  useEffect(() => {
    previewRef.current?.setOptions({ strokeColor: drawPolarity === 'exclude' ? RED : GOLD });
  }, [drawPolarity]);
  useEffect(() => {
    if (!map || !isLoaded || !drawMode || !window.google) return;
    // draggable:false is the CLICK FIX for trackpads: with panning on, the
    // few-pixel wobble between mousedown and mouseup reads as a drag, so the
    // map pans and 'click' never fires — "I click but it just moves around"
    // (live report 2026-07-13). While drawing the map is pinned; zoom controls
    // still work, and toggling draw off restores panning.
    map.setOptions({ disableDoubleClickZoom: true, draggableCursor: 'crosshair', draggable: false });
    const preview = new google.maps.Polyline({
      map, path: [], strokeColor: drawPolarityRef.current === 'exclude' ? RED : GOLD,
      strokeOpacity: 0.95, strokeWeight: 2.5, zIndex: 6, clickable: false,
    });
    previewRef.current = preview;
    draftPathRef.current = [];
    setDraftCount(0);
    // A visible DOT per clicked vertex — without it the FIRST click draws
    // nothing (a 1-point line is invisible) and reads as "clicking does
    // nothing" (live report 2026-07-16).
    const dots: google.maps.Marker[] = [];
    const clearDots = () => { dots.forEach((m) => m.setMap(null)); dots.length = 0; };

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
      preview.setPath([]);
      clearDots();
      setDraftCount(0);
    };
    finishDraftRef.current = finishDraft;

    // Undo the LAST clicked point (button + right-click) so a misplaced
    // segment can be redrawn without starting the whole shape over.
    const undoLast = () => {
      if (draftPathRef.current.length === 0) return;
      draftPathRef.current = draftPathRef.current.slice(0, -1);
      preview.setPath(draftPathRef.current);
      dots.pop()?.setMap(null);
      setDraftCount(draftPathRef.current.length);
    };
    undoLastRef.current = undoLast;

    const clickL = map.addListener('click', (e: google.maps.MapMouseEvent) => {
      if (!e.latLng) return;
      draftPathRef.current = [...draftPathRef.current, { lat: e.latLng.lat(), lng: e.latLng.lng() }];
      preview.setPath(draftPathRef.current);
      const c = drawPolarityRef.current === 'exclude' ? RED : GOLD;
      dots.push(new google.maps.Marker({
        map,
        position: e.latLng,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: c, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
        clickable: false,
        zIndex: 7,
      }));
      setDraftCount(draftPathRef.current.length);
    });
    const dblL = map.addListener('dblclick', () => finishDraft());
    const rightL = map.addListener('rightclick', () => undoLast());

    return () => {
      google.maps.event.removeListener(clickL);
      google.maps.event.removeListener(dblL);
      google.maps.event.removeListener(rightL);
      preview.setMap(null);
      previewRef.current = null;
      clearDots();
      draftPathRef.current = [];
      setDraftCount(0);
      finishDraftRef.current = () => {};
      undoLastRef.current = () => {};
      map.setOptions({ disableDoubleClickZoom: false, draggableCursor: undefined, draggable: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, drawMode]);

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
      map.panTo({ lat: hit.lat, lng: hit.lng });
      map.setZoom(Math.max(map.getZoom() ?? 0, LANDMARK_NAMES_MIN_ZOOM));
    } else if (hit.type === 'road' && hit.externalId) {
      const extId = hit.externalId;
      // Pan to the road's representative point right away for responsiveness;
      // the selection effect reframes to the full line(s) once geometry loads.
      if (map && hit.lat != null && hit.lng != null) {
        map.panTo({ lat: hit.lat, lng: hit.lng });
        map.setZoom(Math.max(map.getZoom() ?? 0, LANDMARK_NAMES_MIN_ZOOM));
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
            <div className="flex shrink-0 items-center gap-1">
              {(['include', 'exclude'] as GeoPolarity[]).map((p) => {
                const active = drawPolarity === p;
                const isInc = p === 'include';
                const c = isInc ? GOLD : RED;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setDrawPolarity(p)}
                    className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-2 text-xs font-bold transition"
                    style={active
                      ? { backgroundColor: c, borderColor: c, color: '#fff' }
                      : { backgroundColor: '#fff', borderColor: `${c}66`, color: isInc ? '#8a6a38' : c }}
                  >
                    {isInc ? <Check size={13} /> : <Ban size={13} />}
                    {isInc ? L('أريدها', 'Include') : L('استثناء', 'Exclude')}
                  </button>
                );
              })}
            </div>
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
          {keyMissing ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-charcoal/60">
              {L('الخريطة غير مُفعّلة (مفتاح خرائط Google غير مُهيّأ).', 'Map is unavailable (Google Maps key not configured).')}
            </div>
          ) : loadError || shapesError ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-red-600">
              {L('تعذّر تحميل الخريطة أو حدود الأحياء.', 'Failed to load the map or district boundaries.')}
              {shapesError && <span className="ms-1 text-charcoal/40">({shapesError})</span>}
            </div>
          ) : !isLoaded || !shapes ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="animate-spin text-copper" />
            </div>
          ) : (
            <>
              <GoogleMap
                mapContainerStyle={{ width: '100%', height: '100%' }}
                center={DEFAULT_MAP_CENTER}
                zoom={10}
                onLoad={setMap}
                onUnmount={() => setMap(null)}
                options={{
                  styles: PICKER_MAP_STYLE,
                  disableDefaultUI: true,
                  zoomControl: true,
                  gestureHandling: 'greedy',
                  clickableIcons: false,
                }}
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
