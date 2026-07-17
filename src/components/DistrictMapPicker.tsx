import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { Ban, Check, Loader2, Map as MapIcon, PenLine, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { DEFAULT_MAP_CENTER, WASSEL_MAP_STYLE } from '@/lib/locationUtils';
import {
  newDistrictItem, newDrawnAreaItem,
  type DistrictLocationItem, type DrawnAreaLocationItem, type GeoPolarity, type LocationItem,
} from '@/lib/geo/locationItems';

const isDistrictItem = (i: LocationItem): i is DistrictLocationItem => i.kind === 'district';
const isDrawnItem = (i: LocationItem): i is DrawnAreaLocationItem => i.kind === 'drawn_area';

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
 */

interface DistrictShape {
  district_id: string;
  name: string;
  geojson: { type: string; coordinates: unknown };
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
const TERRACOTTA = '#8E4E3A'; // landmark pins

/** Element types shown as landmark pins on the picker — the sales-relevant
 *  anchors (all curated + verified in geo_elements). Roads/metro/parks are
 *  deliberately left out: too dense to read at city zoom. */
const LANDMARK_TYPES = ['landmarks', 'malls', 'universities', 'airports_transport'];
/** District name labels + landmark pins appear from this zoom in (city-wide
 *  view stays clean); landmark NAMES appear once close enough to read. */
const LABELS_MIN_ZOOM = 11;
const LANDMARK_NAMES_MIN_ZOOM = 13;

interface LandmarkRow {
  external_id: string;
  display_name: string | null;
  name_ar: string | null;
  element_type: string;
  latitude: number | null;
  longitude: number | null;
}

/** Picker map style = the brand style MINUS Google's own neighborhood labels —
 *  we render every district's name ourselves at its centroid, so the basemap
 *  copy showed each name TWICE (live report 2026-07-13). Only the picker hides
 *  them; other maps keep Google's labels (they draw no labels of their own). */
const PICKER_MAP_STYLE: google.maps.MapTypeStyle[] = [
  ...WASSEL_MAP_STYLE,
  { featureType: 'administrative.neighborhood', elementType: 'labels', stylers: [{ visibility: 'off' }] },
];

/** GeoJSON Polygon/MultiPolygon → google.maps paths (outer + hole rings). */
function geojsonToPaths(g: { type: string; coordinates: unknown }): google.maps.LatLngLiteral[][] {
  const ringToPath = (ring: unknown): google.maps.LatLngLiteral[] =>
    (Array.isArray(ring) ? ring : [])
      .filter((c): c is [number, number] => Array.isArray(c) && c.length >= 2)
      .map((c) => ({ lat: c[1], lng: c[0] }));
  if (g.type === 'Polygon') return ((g.coordinates as unknown[]) ?? []).map(ringToPath);
  if (g.type === 'MultiPolygon') {
    return ((g.coordinates as unknown[]) ?? []).flatMap((poly) => ((poly as unknown[]) ?? []).map(ringToPath));
  }
  return [];
}

export default function DistrictMapPicker({ cityId, items, onApply, onClose, isAr }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [shapes, setShapes] = useState<DistrictShape[] | null>(null);
  const [shapesError, setShapesError] = useState<string | null>(null);
  const [hoverName, setHoverName] = useState<string | null>(null);

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
  // items load for review/delete, new ones are added in draw mode. Each shape
  // is one independent OR-union item (the client can have several).
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
    setShapes(null);
    setShapesError(null);
    supabase
      .rpc('wassell_city_district_shapes', { p_city_id: cityId })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) { setShapesError(error.message); return; }
        setShapes(Array.isArray(data) ? (data as DistrictShape[]) : []);
      });
    return () => { cancelled = true; };
  }, [cityId]);

  // Names for the footer chips (id → name) from the loaded shapes.
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of shapes ?? []) m.set(s.district_id, s.name);
    return m;
  }, [shapes]);

  // Important landmarks/elements (curated types, all Riyadh today). RLS allows
  // authenticated SELECT on geo_elements — same posture as /api/geo-elements.
  const [landmarks, setLandmarks] = useState<LandmarkRow[]>([]);
  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    supabase
      .from('geo_elements')
      .select('external_id, display_name, name_ar, element_type, latitude, longitude')
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

  // (Re)build the polygons when the map + shapes are ready. Selection changes
  // restyle IN PLACE (no rebuild) via the polygonsRef.
  const polygonsRef = useRef<Map<string, google.maps.Polygon>>(new Map());
  const styleFor = (id: string, isSelected: boolean): google.maps.PolygonOptions =>
    excludedIds.has(id)
      ? { fillColor: RED, fillOpacity: 0.22, strokeColor: RED, strokeOpacity: 0.8, strokeWeight: 2, zIndex: 2 }
      : isSelected
        ? { fillColor: COPPER, fillOpacity: 0.38, strokeColor: COPPER, strokeOpacity: 1, strokeWeight: 2.5, zIndex: 3 }
        : { fillColor: CHARCOAL, fillOpacity: 0.06, strokeColor: CHARCOAL, strokeOpacity: 0.65, strokeWeight: 1.5, zIndex: 1 };

  useEffect(() => {
    if (!map || !isLoaded || !shapes || !window.google) return;
    const polys = polygonsRef.current;
    const bounds = new google.maps.LatLngBounds();

    for (const s of shapes) {
      const paths = geojsonToPaths(s.geojson);
      if (!paths.length) continue;
      const poly = new google.maps.Polygon({
        paths,
        map,
        clickable: true,
        ...styleFor(s.district_id, selectedRef.current.has(s.district_id)),
      });
      poly.addListener('click', () => {
        if (excludedIds.has(s.district_id)) return; // exclude rules are managed from the chips
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(s.district_id)) next.delete(s.district_id);
          else next.add(s.district_id);
          poly.setOptions(styleFor(s.district_id, next.has(s.district_id)));
          return next;
        });
      });
      poly.addListener('mouseover', () => setHoverName(s.name));
      poly.addListener('mouseout', () => setHoverName((n) => (n === s.name ? null : n)));
      polys.set(s.district_id, poly);
      for (const path of paths) for (const p of path) bounds.extend(p);
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, 24);

    return () => {
      polys.forEach((p) => p.setMap(null));
      polys.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, shapes]);

  // District NAME labels on every polygon + landmark pins, both zoom-gated so
  // the city-wide view stays readable: labels + pins from LABELS_MIN_ZOOM in,
  // landmark names once close enough (LANDMARK_NAMES_MIN_ZOOM). Labels are
  // transparent-icon markers at each district's largest-ring centroid.
  const landmarkMarkersRef = useRef<google.maps.Marker[]>([]);
  useEffect(() => {
    if (!map || !isLoaded || !shapes || !window.google) return;
    const invisible: google.maps.Symbol = { path: google.maps.SymbolPath.CIRCLE, scale: 0 };
    const labelMarkers: google.maps.Marker[] = [];
    for (const s of shapes) {
      let ring: google.maps.LatLngLiteral[] = [];
      for (const p of geojsonToPaths(s.geojson)) if (p.length > ring.length) ring = p;
      if (ring.length < 3) continue;
      const lat = ring.reduce((a, p) => a + p.lat, 0) / ring.length;
      const lng = ring.reduce((a, p) => a + p.lng, 0) / ring.length;
      labelMarkers.push(new google.maps.Marker({
        position: { lat, lng },
        icon: invisible,
        clickable: false,
        label: { text: s.name, color: CHARCOAL, fontSize: '11px', fontWeight: '700' },
      }));
    }
    const lmMarkers = landmarks
      .filter((l) => l.latitude != null && l.longitude != null)
      .map((l) => {
        const name = (isAr ? l.name_ar || l.display_name : l.display_name || l.name_ar) ?? '';
        const marker = new google.maps.Marker({
          position: { lat: l.latitude!, lng: l.longitude! },
          icon: {
            path: google.maps.SymbolPath.CIRCLE, scale: 4.5,
            fillColor: TERRACOTTA, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5,
            labelOrigin: new google.maps.Point(0, 3),
          },
          title: name,
          clickable: true, // hover shows the name even below the label zoom
          zIndex: 5,
        });
        return { marker, name };
      });
    landmarkMarkersRef.current = lmMarkers.map((x) => x.marker);
    const applyZoom = () => {
      const z = map.getZoom() ?? 0;
      const show = z >= LABELS_MIN_ZOOM;
      labelMarkers.forEach((m) => m.setMap(show ? map : null));
      lmMarkers.forEach(({ marker, name }) => {
        marker.setMap(show ? map : null);
        marker.setLabel(z >= LANDMARK_NAMES_MIN_ZOOM && name
          ? { text: name, color: TERRACOTTA, fontSize: '10px', fontWeight: '700' }
          : null);
      });
    };
    applyZoom();
    const zl = map.addListener('zoom_changed', applyZoom);
    return () => {
      google.maps.event.removeListener(zl);
      labelMarkers.forEach((m) => m.setMap(null));
      lmMarkers.forEach(({ marker }) => marker.setMap(null));
      landmarkMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, shapes, landmarks, isAr]);

  // Render the drawn shapes (few — rebuild on change is cheap). Gold = include,
  // red = a saved exclude drawn area. Not clickable: managed via footer chips.
  useEffect(() => {
    if (!map || !isLoaded || !window.google) return;
    const polys = drawnItems.map((d) => {
      const c = d.polarity === 'exclude' ? RED : GOLD;
      return new google.maps.Polygon({
        map,
        paths: (d.coordinates ?? []).map(([lng, lat]) => ({ lat, lng })),
        fillColor: c,
        fillOpacity: 0.3,
        strokeColor: c,
        strokeOpacity: 0.95,
        strokeWeight: 2,
        zIndex: 4,
        clickable: false,
      });
    });
    return () => polys.forEach((p) => p.setMap(null));
  }, [map, isLoaded, drawnItems]);

  // Draw mode — MANUAL polygon drawing (Google REMOVED DrawingManager in Maps
  // JS v3.65; instantiating it throws — live incident 2026-07-13). Each map
  // click adds a vertex to a gold preview polyline; double-click (or the
  // "إنهاء الشكل" button) closes the shape into ONE drawn_area item. Draw mode
  // stays armed so several separate shapes can be drawn in a row. District
  // polygons are made unclickable while drawing so vertex clicks over them
  // register on the map instead of toggling a district.
  const [draftCount, setDraftCount] = useState(0);
  const draftPathRef = useRef<google.maps.LatLngLiteral[]>([]);
  const finishDraftRef = useRef<() => void>(() => {});
  const previewRef = useRef<google.maps.Polyline | null>(null);
  useEffect(() => {
    polygonsRef.current.forEach((p) => p.setOptions({ clickable: !drawMode }));
    // Landmark pins must not swallow vertex clicks while drawing.
    landmarkMarkersRef.current.forEach((m) => m.setClickable(!drawMode));
    if (!drawMode) setHoverName(null);
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
        const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
        const ring = path.map((p) => [round6(p.lng), round6(p.lat)] as [number, number]);
        ring.push(ring[0]!);
        const polarity = drawPolarityRef.current;
        setDrawnItems((prev) => {
          const nth = prev.filter((d) => d.polarity === polarity).length + 1;
          const label = polarity === 'exclude'
            ? `${isAr ? 'منطقة مستثناة' : 'Excluded area'} ${nth}`
            : `${isAr ? 'منطقة مرسومة' : 'Drawn area'} ${nth}`;
          return [...prev, newDrawnAreaItem(ring, label, polarity)];
        });
      }
      draftPathRef.current = [];
      preview.setPath([]);
      clearDots();
      setDraftCount(0);
    };
    finishDraftRef.current = finishDraft;

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

    return () => {
      google.maps.event.removeListener(clickL);
      google.maps.event.removeListener(dblL);
      preview.setMap(null);
      previewRef.current = null;
      clearDots();
      draftPathRef.current = [];
      setDraftCount(0);
      finishDraftRef.current = () => {};
      map.setOptions({ disableDoubleClickZoom: false, draggableCursor: undefined, draggable: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, drawMode]);

  // Apply: element rules + exclude districts pass through untouched; the
  // include-district set is rebuilt from the map selection (existing rules keep
  // their ids/labels); drawn areas are re-emitted from the picker's working list
  // (existing items verbatim, new shapes appended, deleted ones dropped).
  const apply = () => {
    const keep = items.filter((i) => {
      if (isDrawnItem(i)) return false; // re-emitted from drawnItems below
      return !(isDistrictItem(i) && i.polarity === 'include' && !selected.has(i.district_id));
    });
    const have = new Set(keep.filter(isDistrictItem).filter((i) => i.polarity === 'include').map((i) => i.district_id));
    const added = [...selected]
      .filter((id) => !have.has(id))
      .map((id) => newDistrictItem(id, nameById.get(id) ?? id, 'include'));
    onApply([...keep, ...added, ...drawnItems]);
    onClose();
  };

  const selectedNames = [...selected].map((id) => nameById.get(id) ?? null).filter((n): n is string => !!n);

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
                  ? L('منطقة استثناء: لن تظهر النتائج داخل هذا الشكل. الخريطة مثبّتة أثناء الرسم — انقر لإضافة النقاط، ثم نقراً مزدوجاً (أو «إنهاء الشكل») لإغلاقه.', 'Exclusion zone: no results will show inside this shape. The map is pinned while drawing — click to add points, then double-click (or "Finish shape") to close it.')
                  : L('الخريطة مثبّتة أثناء الرسم — انقر لإضافة نقاط الشكل، ثم نقراً مزدوجاً (أو «إنهاء الشكل») لإغلاقه. يمكنك رسم عدة أشكال متفرقة.', 'The map is pinned while drawing — click to add the shape’s points, then double-click (or "Finish shape") to close it. You can draw several separate shapes.')
                : L('اضغط على حي لتضمينه أو لإزالته. الأحياء الحمراء مستثناة (تُدار من القائمة). قرّب الخريطة لرؤية أسماء الأحياء والمعالم.', 'Tap a district to include or remove it. Red districts are excludes (managed from the list). Zoom in to see district names and landmarks.')}
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
              {/* Hovered district name */}
              {hoverName && (
                <div className="pointer-events-none absolute top-3 z-10 rounded-lg bg-white/95 px-3 py-1.5 text-sm font-bold text-chocolate shadow ring-1 ring-black/5" style={{ insetInlineStart: '0.75rem' }}>
                  {hoverName}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer: selection summary + drawn-shape chips + apply */}
        <div className="flex shrink-0 items-center gap-3 border-t border-sand/40 bg-white px-4 py-3">
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold text-charcoal/70">
              {L(`${selected.size} حي مختار`, `${selected.size} district(s) selected`)}
              {drawnItems.length > 0 && (
                <span className="text-charcoal/50"> · {L(`${drawnItems.length} منطقة مرسومة`, `${drawnItems.length} drawn area(s)`)}</span>
              )}
            </span>
            {selectedNames.length > 0 && (
              <p className="truncate text-[11px] text-charcoal/50">{selectedNames.join(' · ')}</p>
            )}
            {drawnItems.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {drawnItems.map((d) => (
                  <span
                    key={d.id}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
                    style={{ backgroundColor: `${d.polarity === 'exclude' ? RED : GOLD}1F`, color: d.polarity === 'exclude' ? RED : '#8a6a38' }}
                  >
                    {d.label || L('منطقة مرسومة', 'Drawn area')}
                    <button
                      type="button"
                      onClick={() => setDrawnItems((prev) => prev.filter((x) => x.id !== d.id))}
                      className="hover:opacity-60"
                      aria-label={L('حذف', 'Delete')}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
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
