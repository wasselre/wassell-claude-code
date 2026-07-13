import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { Check, Loader2, Map as MapIcon, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { DEFAULT_MAP_CENTER, WASSEL_MAP_STYLE } from '@/lib/locationUtils';
import { newDistrictItem, type DistrictLocationItem, type LocationItem } from '@/lib/geo/locationItems';

const isDistrictItem = (i: LocationItem): i is DistrictLocationItem => i.kind === 'district';

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

  // (Re)build the polygons when the map + shapes are ready. Selection changes
  // restyle IN PLACE (no rebuild) via the polygonsRef.
  const polygonsRef = useRef<Map<string, google.maps.Polygon>>(new Map());
  const styleFor = (id: string, isSelected: boolean): google.maps.PolygonOptions =>
    excludedIds.has(id)
      ? { fillColor: RED, fillOpacity: 0.22, strokeColor: RED, strokeOpacity: 0.7, strokeWeight: 1.5, zIndex: 2 }
      : isSelected
        ? { fillColor: COPPER, fillOpacity: 0.38, strokeColor: COPPER, strokeOpacity: 0.95, strokeWeight: 2, zIndex: 3 }
        : { fillColor: CHARCOAL, fillOpacity: 0.05, strokeColor: CHARCOAL, strokeOpacity: 0.35, strokeWeight: 1, zIndex: 1 };

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

  // Apply: keep every non-include-district item as-is; rebuild the include-district
  // set from the map selection (existing rules keep their ids/labels; new ones get
  // fresh items with the shape's name stashed as the display label).
  const apply = () => {
    const keep = items.filter((i) => !(isDistrictItem(i) && i.polarity === 'include' && !selected.has(i.district_id)));
    const have = new Set(keep.filter(isDistrictItem).filter((i) => i.polarity === 'include').map((i) => i.district_id));
    const added = [...selected]
      .filter((id) => !have.has(id))
      .map((id) => newDistrictItem(id, nameById.get(id) ?? id, 'include'));
    onApply([...keep, ...added]);
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
            <h2 className="truncate text-base font-bold text-chocolate">{L('اختيار الأحياء من الخريطة', 'Pick districts on the map')}</h2>
            <p className="truncate text-[11px] text-charcoal/60">
              {L('اضغط على حي لتضمينه أو لإزالته. الأحياء الحمراء مستثناة (تُدار من القائمة).', 'Tap a district to include or remove it. Red districts are excludes (managed from the list).')}
            </p>
          </div>
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
                  styles: WASSEL_MAP_STYLE,
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

        {/* Footer: selection summary + apply */}
        <div className="flex shrink-0 items-center gap-3 border-t border-sand/40 bg-white px-4 py-3">
          <div className="min-w-0 flex-1">
            <span className="text-xs font-bold text-charcoal/70">
              {L(`${selected.size} حي مختار`, `${selected.size} district(s) selected`)}
            </span>
            {selectedNames.length > 0 && (
              <p className="truncate text-[11px] text-charcoal/50">{selectedNames.join(' · ')}</p>
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
