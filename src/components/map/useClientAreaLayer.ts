import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { describeLocationItem, type LocationItem } from '@/lib/geo/locationItems';
import { clientAreaSignature } from '@/lib/geo/clientArea';
import { geojsonToPaths, geojsonToLinePaths, type GeoJsonGeometry } from '@/lib/geo/geojsonPaths';

/**
 * Draws the CLIENT'S SELECTED AREA on a finder map — the districts, geo-element
 * rules and drawn shapes the search was gated by — so the rep can see at a
 * glance which result pins fall inside it.
 *
 * The shapes come from `wassell_preview_geo_items`, the SAME compiler the
 * matcher runs (district boundaries, radius discs, road bands clipped to the
 * chosen side, zones, drawn rings). Nothing is re-derived client-side, so the
 * highlighted area is exactly the area that produced the results.
 *
 * Display only: overlays are never clickable (pins under them stay clickable,
 * and a click on empty map space still reaches the map's own listener).
 * A failed preview costs the highlight, never the map — logged, not thrown.
 */

/** Wassel palette (CLAUDE.md). Include = copper; exclude = red, like the picker chips. */
const INCLUDE = '#B8734F';
const EXCLUDE = '#B91C1C';

/** One row of `wassell_preview_geo_items` — the matcher's compiler output for a
 *  single location item. `geojson` is the matched area (Polygon/MultiPolygon);
 *  `ref_geojson` is the road reference line for directional rules. A row with
 *  neither is undrawable (needs_review / missing element). */
interface PreviewRow {
  item_id: string;
  kind: string;
  polarity: string;
  direction: string | null;
  validation_status: string;
  geojson?: GeoJsonGeometry | null;
  ref_geojson?: GeoJsonGeometry | null;
}

export interface ClientAreaLayerState {
  /** Rules whose geometry is drawn on the map. */
  drawn: number;
  /** Rules that compiled but could not be drawn (needs_review / missing element). */
  undrawable: number;
  hasInclude: boolean;
  hasExclude: boolean;
  loading: boolean;
  /** Bounds of every INCLUDE shape — null until loaded or when nothing is drawable. */
  bounds: google.maps.LatLngBounds | null;
  /** Changes whenever the drawn shapes change; use as an effect key to refit the view. */
  boundsKey: string;
}

const EMPTY: ClientAreaLayerState = {
  drawn: 0, undrawable: 0, hasInclude: false, hasExclude: false, loading: false, bounds: null, boundsKey: '',
};

/** Shared frozen empty so the "no rows" branch is identity-stable across renders —
 *  a fresh `[]` literal each render would refire the draw effect pointlessly. */
const NO_ROWS: PreviewRow[] = [];

export function useClientAreaLayer(
  map: google.maps.Map | null,
  items: LocationItem[] | null | undefined,
  isAr: boolean,
): ClientAreaLayerState {
  const list = useMemo(() => (Array.isArray(items) ? items : []), [items]);
  const sig = useMemo(() => clientAreaSignature(list), [list]);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  // The signature the current `rows` belong to — so a stale response for an
  // older item set is never drawn over a newer one.
  const rowsSigRef = useRef('');

  // Fetch the compiled geometry (debounced; keyed on CONTENT — parents rebuild
  // the items array every render, so keying on array identity would refetch
  // constantly).
  useEffect(() => {
    // Capture the non-null client — the outer null check does not narrow
    // inside the setTimeout closure (TS18047).
    const sb = supabase;
    if (!sb || list.length === 0) {
      rowsSigRef.current = sig;
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      sb
        .rpc('wassell_preview_geo_items', { p_items: list })
        .then(({ data, error }) => {
          if (cancelled) return;
          setLoading(false);
          if (error) {
            // Decorative layer: the highlight is lost, the pins are not.
            console.error('[useClientAreaLayer] client-area preview failed:', error.message);
            rowsSigRef.current = sig;
            setRows([]);
            return;
          }
          rowsSigRef.current = sig;
          setRows(Array.isArray(data) ? (data as PreviewRow[]) : []);
        });
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
    // `list` is derived from `sig`'s source; sig is the content key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Only rows that match the CURRENT item set may drive summary/bounds/drawing.
  const current = rowsSigRef.current === sig ? rows : NO_ROWS;

  // Derived summary + bounds (bounds need the Maps API, so they're built lazily).
  const state = useMemo<ClientAreaLayerState>(() => {
    if (list.length === 0) return { ...EMPTY, loading };
    let drawn = 0;
    let undrawable = 0;
    let hasInclude = false;
    let hasExclude = false;
    let bounds: google.maps.LatLngBounds | null = null;
    const keyParts: string[] = [];
    for (const row of current) {
      const paths = row.geojson ? geojsonToPaths(row.geojson).filter((p) => p.length >= 3) : [];
      const lines = row.ref_geojson ? geojsonToLinePaths(row.ref_geojson) : [];
      if (paths.length === 0 && lines.length === 0) { undrawable += 1; continue; }
      drawn += 1;
      if (row.polarity === 'exclude') hasExclude = true; else hasInclude = true;
      keyParts.push(`${row.item_id}:${paths.reduce((a, p) => a + p.length, 0)}`);
      // Bounds cover INCLUDE shapes only — the view should frame the area the
      // client WANTS, not the ones they excluded. And they need the Maps core
      // library: the RPC can resolve BEFORE the Maps script finishes loading,
      // at which point `window.google.maps` already exists as the loader's
      // bootstrap object but `LatLngBounds` does not (live crash:
      // "google.maps.LatLngBounds is not a constructor"). A non-null `map` plus
      // a real constructor check is the only reliable "fully loaded" signal.
      if (row.polarity !== 'exclude' && map && typeof google.maps.LatLngBounds === 'function') {
        bounds ??= new google.maps.LatLngBounds();
        for (const p of paths) for (const ll of p) bounds.extend(ll);
        for (const l of lines) for (const ll of l) bounds.extend(ll);
      }
    }
    return { drawn, undrawable, hasInclude, hasExclude, loading, bounds, boundsKey: keyParts.join('|') };
  }, [current, list.length, loading, map]);

  // Draw / redraw the overlays.
  useEffect(() => {
    if (!map || !window.google || current.length === 0) return;
    const overlays: Array<google.maps.Polygon | google.maps.Polyline | google.maps.Marker> = [];
    const invisible: google.maps.Symbol = { path: google.maps.SymbolPath.CIRCLE, scale: 0 };
    for (const row of current) {
      const item = list.find((i) => i.id === row.item_id);
      const exclude = row.polarity === 'exclude';
      const color = exclude ? EXCLUDE : INCLUDE;
      if (row.geojson) {
        const paths = geojsonToPaths(row.geojson).filter((p) => p.length >= 3);
        let largest: google.maps.LatLngLiteral[] = [];
        for (const p of paths) if (p.length > largest.length) largest = p;
        for (const p of paths) {
          overlays.push(new google.maps.Polygon({
            map,
            paths: [p],
            fillColor: color,
            fillOpacity: exclude ? 0.08 : 0.13,
            strokeColor: color,
            strokeOpacity: exclude ? 0.7 : 0.9,
            strokeWeight: exclude ? 1.5 : 2,
            zIndex: 1,
            // NEVER clickable: pins under the overlay and empty-map clicks must
            // still reach their own listeners.
            clickable: false,
          }));
        }
        // A legacy district pick whose name didn't resolve has no useful label
        // (describeLocationItem would read "حي حي" / "district district") — draw
        // it unlabelled.
        const text = item && !(item.kind === 'district' && !item.district_label)
          ? describeLocationItem(item, isAr)
          : '';
        if (text && largest.length >= 3) {
          // Centroid label on the LARGEST ring: an invisible icon Marker (a
          // scale-0 circle) whose label carries the text.
          overlays.push(new google.maps.Marker({
            map,
            position: {
              lat: largest.reduce((a, p) => a + p.lat, 0) / largest.length,
              lng: largest.reduce((a, p) => a + p.lng, 0) / largest.length,
            },
            icon: invisible,
            clickable: false,
            zIndex: 2,
            label: { text, color, fontSize: '11px', fontWeight: '700' },
          }));
        }
      }
      if (row.ref_geojson) {
        for (const line of geojsonToLinePaths(row.ref_geojson)) {
          if (line.length < 2) continue;
          overlays.push(new google.maps.Polyline({
            map, path: line, strokeColor: color, strokeOpacity: 0.95, strokeWeight: 4, zIndex: 2, clickable: false,
          }));
        }
      }
    }
    return () => { overlays.forEach((o) => o.setMap(null)); };
  }, [map, current, list, isAr]);

  return state;
}
