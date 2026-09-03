import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer';
import { Loader2, MapPin, X, Maximize2, Minimize2 } from 'lucide-react';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { DEFAULT_MAP_CENTER, GEO_MAP_STYLE, buildClusterIcon } from '@/lib/locationUtils';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';
import { useClientAreaLayer } from '@/components/map/useClientAreaLayer';
import MapLayersOverlay from '@/components/map/MapLayersOverlay';
import { useIsMobile } from '@/hooks/useIsMobile';
import type { LocationItem } from '@/lib/geo/locationItems';

/**
 * THE shared Google-map surface for the whole app's "pins on a map" views —
 * the Project Finder results map AND the Client Options map both render through
 * this. It owns every piece of map plumbing so a change made here reaches BOTH
 * maps at once (this component exists precisely because those two maps used to
 * be separate copies and kept drifting apart — one would get an update the
 * other never did).
 *
 * What lives here (shared by every caller):
 *   • Maps loader + key-missing / load-error / loading states
 *   • Marker clustering (SuperCluster), with "solo" pins that never cluster
 *   • Fit-to-pins on change (single pin → a comfortable zoom)
 *   • Administrative boundary context layer (useGeoBoundaryLayer)
 *   • The CLIENT'S SELECTED AREA highlight (useClientAreaLayer) + refit-to-area
 *   • The roads/landmarks toggle overlay (MapLayersOverlay)
 *   • The full-view button (browser Fullscreen API, top-start so the layers
 *     panel never hides it)
 *   • The clicked-pin floating card panel
 *   • External "show this pin" focus requests
 *   • The footer legend bar: pin count, the area legend, and the caller's own
 *     swatches
 *
 * What each CALLER supplies (the only things that differ between maps):
 *   • `pins` — its domain rows already mapped to {id, lat, lng, icon, …}
 *   • `legend` — its own swatch row (source colors vs. status colors)
 *   • `renderSelectedCard` — the full card for a clicked pin
 *
 * See FinderMapView (matches, colored by source) and ClientOptionsMapView
 * (options, colored by status) for the two adapters.
 */

export interface MapPin {
  /** Stable id — drives selection, focus, and the rebuild signature. */
  id: string;
  lat: number;
  lng: number;
  icon: google.maps.Icon | undefined;
  /** Hover title. */
  title: string;
  /** Higher = drawn on top (e.g. our-projects / the main option sit above the rest). */
  zIndex?: number;
  /** When true the marker is placed on the map DIRECTLY and never absorbed into a
   *  cluster (so it always shows as an individual pin). */
  solo?: boolean;
  /** Content key: anything that changes the pin's APPEARANCE (color, label) beyond
   *  its position — included in the rebuild signature so the marker is re-created
   *  when it changes. Coordinates alone aren't enough: an option's status color can
   *  change while its position stays. Default '' (position-only maps don't need it). */
  sig?: string;
}

interface Props {
  /** The pins to plot (already filtered + mapped by the caller). */
  pins: MapPin[];
  isAr: boolean;
  /** Render the clicked pin as a full card in a floating panel over the map.
   *  When provided, a pin click SELECTS + centers; when omitted, a click calls
   *  `onPinClick` instead (the "navigate to the record" fallback). */
  renderSelectedCard?: (id: string) => ReactNode;
  /** Fallback pin action when no card renderer is supplied. */
  onPinClick?: (id: string) => void;
  /** External "show on map" request — select + center this pin. The nonce
   *  re-triggers even when the same pin is asked for twice. */
  focus?: { id: string; nonce: number } | null;
  /** The client's selected area — shaded under the pins. See useClientAreaLayer. */
  areaItems?: LocationItem[] | null;
  /** The caller's own legend swatches (source / status). Shown at the footer end. */
  legend?: ReactNode;
  /** Count of rows that had no coordinates (so couldn't be plotted) — shown as a note. */
  missingCount?: number;
  /** Tailwind height for the map container. Default h-[70vh]. */
  heightClass?: string;
  /** Greedy one-finger pan on mobile (the finder wants it inside its modal). */
  mobileGreedy?: boolean;
  /** Outer container classes. Default the standard `.card`. */
  outerClassName?: string;
  /** Classes for the key-missing / error / loading state box. */
  stateBoxClassName?: string;
  /** Max-width class for the clicked-pin card panel. Default max-w-[400px]. */
  cardMaxWidthClass?: string;
  /** Fired on every marker rebuild with the pin count (perf instrumentation hook). */
  onRebuild?: (count: number) => void;
}

export default function BaseMapView({
  pins,
  isAr,
  renderSelectedCard,
  onPinClick,
  focus,
  areaItems,
  legend,
  missingCount = 0,
  heightClass = 'h-[70vh]',
  mobileGreedy = false,
  outerClassName = 'card overflow-hidden',
  stateBoxClassName = 'card',
  cardMaxWidthClass = 'max-w-[400px]',
  onRebuild,
}: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const isMobile = useIsMobile();
  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const [map, setMap] = useState<google.maps.Map | null>(null);
  // Administrative context under the pins — country/region/city/district by zoom.
  // Roads + landmarks are user-toggled context layers owned by MapLayersOverlay
  // (below), so the map opens clean. See useGeoBoundaryLayer.
  useGeoBoundaryLayer(map, { roads: false, landmarks: false });
  // The client's selected area (compiled by the matcher's own preview RPC) shaded
  // under the pins — include rules in copper, exclude rules in red.
  const area = useClientAreaLayer(map, areaItems, isAr);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Full-view: the map wrapper enters the browser Fullscreen API (our own button
  // on the start side, since Google's default control sits top-right behind the
  // layers panel). isFs tracks it so the button flips between enter/exit.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  const toggleFs = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const clustererRef = useRef<MarkerClusterer | null>(null);
  // Solo markers are placed on the map directly (NEVER in the clusterer); kept for teardown.
  const soloMarkersRef = useRef<google.maps.Marker[]>([]);
  // Latest callbacks read through refs so the marker effect (keyed on the pin
  // signature) doesn't rebuild every marker just because a parent passed a fresh
  // closure.
  const onPinClickRef = useRef(onPinClick);
  useEffect(() => { onPinClickRef.current = onPinClick; }, [onPinClick]);
  const onRebuildRef = useRef(onRebuild);
  useEffect(() => { onRebuildRef.current = onRebuild; }, [onRebuild]);
  const hasCard = !!renderSelectedCard;
  const hasCardRef = useRef(hasCard);
  useEffect(() => { hasCardRef.current = hasCard; }, [hasCard]);

  const missing = Math.max(0, missingCount);

  // Stable CONTENT signature of the pin set. Parents rebuild the pins array every
  // render, so keying the marker/cluster/fitBounds effect on the array identity
  // would tear down + rebuild every marker (pins flickering) and refit the viewport
  // (the user's zoom snapping back) on every parent re-render. Keyed on this string,
  // the effect only reacts when the pins actually change.
  const pinsSig = useMemo(
    () => pins
      .map((p) => `${p.id}:${p.lat.toFixed(5)}:${p.lng.toFixed(5)}:${p.zIndex ?? ''}:${p.solo ? 1 : 0}:${p.sig ?? ''}`)
      .join('|'),
    [pins],
  );

  const selectedPin = useMemo(() => pins.find((p) => p.id === selectedId) ?? null, [pins, selectedId]);

  // Dismiss the open card when the pin set changes (tab switch / new search /
  // filter). Keyed on the content signature, not the array identity, so an
  // identical re-render doesn't close the card the user just opened.
  useEffect(() => { setSelectedId(null); }, [pinsSig]);

  // Clicking empty map space closes the open card.
  useEffect(() => {
    if (!map || !window.google) return;
    const l = map.addListener('click', () => setSelectedId(null));
    return () => google.maps.event.removeListener(l);
  }, [map]);

  // (Re)build markers + clusterer + fit bounds whenever the pin set changes.
  useEffect(() => {
    if (!map || !isLoaded || !window.google) return;
    onRebuildRef.current?.(pins.length);
    clustererRef.current?.clearMarkers();
    soloMarkersRef.current.forEach((m) => m.setMap(null));
    soloMarkersRef.current = [];

    const clustered: google.maps.Marker[] = [];
    for (const p of pins) {
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        icon: p.icon,
        title: p.title,
        zIndex: p.zIndex,
      });
      marker.addListener('click', () => {
        if (hasCardRef.current) {
          setSelectedId(p.id);
          map.panTo({ lat: p.lat, lng: p.lng });
        } else {
          onPinClickRef.current?.(p.id);
        }
      });
      if (p.solo) {
        marker.setMap(map);
        soloMarkersRef.current.push(marker);
      } else {
        clustered.push(marker);
      }
    }

    if (clustered.length > 0) {
      clustererRef.current = new MarkerClusterer({
        map,
        markers: clustered,
        algorithm: new SuperClusterAlgorithm({ radius: 70, maxZoom: 15 }),
        renderer: {
          render: ({ count, position }) =>
            new google.maps.Marker({
              position,
              icon: buildClusterIcon(count) as google.maps.Icon | undefined,
              zIndex: Number(google.maps.Marker.MAX_ZINDEX) + count,
            }),
        },
      });
    }

    if (pins.length > 0) {
      const bounds = new google.maps.LatLngBounds();
      for (const p of pins) bounds.extend({ lat: p.lat, lng: p.lng });
      map.fitBounds(bounds, 48);
      if (pins.length === 1) {
        google.maps.event.addListenerOnce(map, 'idle', () => {
          if ((map.getZoom() ?? 0) > 15) map.setZoom(15);
        });
      }
    }

    return () => {
      clustererRef.current?.clearMarkers();
      clustererRef.current = null;
      soloMarkersRef.current.forEach((m) => m.setMap(null));
      soloMarkersRef.current = [];
    };
    // Keyed on pinsSig (content), NOT pins (identity) — see pinsSig above. pins is
    // read from the same render as pinsSig, so the closure matches the signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, pinsSig]);

  // External "show on map" request (from a list card). Applied ONCE per nonce, as
  // soon as the map is ready AND the pin is in the current set (which may lag a tab
  // switch / fresh mount). Declared after the marker effect so its panTo lands after
  // that effect's fitBounds, and after the clear-on-change effect so it re-opens
  // rather than being cleared. Guarded by the nonce so a later rebuild can't reopen
  // a card the user has since closed.
  const appliedFocusNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || !map || !isLoaded) return;
    if (focus.nonce === appliedFocusNonce.current) return;
    const p = pins.find((x) => x.id === focus.id);
    if (!p) return; // pin not in the current set yet — re-runs when pinsSig updates
    appliedFocusNonce.current = focus.nonce;
    setSelectedId(focus.id);
    map.panTo({ lat: p.lat, lng: p.lng });
    google.maps.event.addListenerOnce(map, 'idle', () => {
      if ((map.getZoom() ?? 0) < 13) map.setZoom(15);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, map, isLoaded, pinsSig]);

  // When the client's area arrives (it compiles server-side, so it lands after the
  // pins' own fitBounds), widen the view to show the WHOLE area plus every pin — the
  // point is to see which pins sit inside it. Keyed on the area's drawn-shape key so
  // panning/zooming afterwards isn't yanked back; a later pin-set change refits via
  // the marker effect as before.
  useEffect(() => {
    if (!map || !isLoaded || !window.google || !area.bounds) return;
    const bounds = new google.maps.LatLngBounds();
    bounds.union(area.bounds);
    for (const p of pins) bounds.extend({ lat: p.lat, lng: p.lng });
    map.fitBounds(bounds, 48);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, area.boundsKey]);

  if (keyMissing) {
    return (
      <div className={`${stateBoxClassName} flex ${heightClass} items-center justify-center p-6 text-center text-sm text-charcoal/60`}>
        {L('خريطة العرض غير مُفعّلة (مفتاح خرائط Google غير مُهيّأ).', 'Map view is unavailable (Google Maps key not configured).')}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className={`${stateBoxClassName} flex ${heightClass} items-center justify-center p-6 text-center text-sm text-red-600`}>
        {L('تعذّر تحميل الخريطة.', 'Failed to load the map.')}
      </div>
    );
  }
  if (!isLoaded) {
    return (
      <div className={`${stateBoxClassName} flex ${heightClass} items-center justify-center`}>
        <Loader2 className="animate-spin text-copper" />
      </div>
    );
  }

  return (
    <div className={outerClassName}>
      <div ref={wrapRef} className={`relative w-full bg-cream ${isFs ? 'h-full' : heightClass}`}>
        <GoogleMap
          mapContainerStyle={{ width: '100%', height: '100%' }}
          center={DEFAULT_MAP_CENTER}
          zoom={11}
          onLoad={setMap}
          onUnmount={() => setMap(null)}
          options={{
            styles: GEO_MAP_STYLE,
            disableDefaultUI: false,
            mapTypeControl: false,
            streetViewControl: false,
            // Our own full-view button (top-start) replaces Google's default — its
            // top-right control was hidden behind the layers panel.
            fullscreenControl: false,
            clickableIcons: false,
            // MOBILE-ONLY one-finger pan: the default demands two fingers, so a
            // one-finger drag scrolls the surrounding modal instead of the map. On
            // the laptop keep the original default ('auto' → cooperative).
            gestureHandling: mobileGreedy && isMobile ? 'greedy' : 'auto',
          }}
        />

        <MapLayersOverlay map={map} isAr={isAr} />

        {/* Full view / exit — on the end side so the layers panel (top start) never
            hides it. Toggles the browser Fullscreen API. */}
        <button
          type="button"
          onClick={toggleFs}
          className="absolute top-3 end-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-sand/50 bg-white/95 text-charcoal shadow-sm backdrop-blur transition hover:bg-cream"
          aria-label={isFs ? L('إنهاء العرض الكامل', 'Exit full view') : L('عرض كامل', 'Full view')}
          title={isFs ? L('إنهاء العرض الكامل', 'Exit full view') : L('عرض كامل', 'Full view')}
        >
          {isFs ? <Minimize2 size={16} className="text-copper" /> : <Maximize2 size={16} className="text-copper" />}
        </button>

        {/* Clicked-pin card — the SAME full card as the list, full actions. */}
        {selectedPin && renderSelectedCard && (
          <div
            className={`absolute top-3 z-20 w-[92%] ${cardMaxWidthClass} overflow-y-auto rounded-xl shadow-2xl ring-1 ring-black/5`}
            style={{ insetInlineStart: '0.75rem', maxHeight: 'calc(100% - 1.5rem)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="absolute end-2 top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-charcoal/70 shadow ring-1 ring-black/5 transition hover:bg-white hover:text-charcoal"
              aria-label={L('إغلاق', 'Close')}
            >
              <X size={14} />
            </button>
            {renderSelectedCard(selectedPin.id)}
          </div>
        )}
      </div>

      {/* Legend + coverage note */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-sand/40 bg-cream/30 px-3 py-2 text-[11px] text-charcoal/70">
        <span className="inline-flex items-center gap-1">
          <MapPin size={12} className="text-copper" />
          {L(`${pins.length} على الخريطة`, `${pins.length} on the map`)}
          {missing > 0 && (
            <span className="text-charcoal/45">
              {' '}· {L(`${missing} بدون إحداثيات`, `${missing} without coordinates`)}
            </span>
          )}
        </span>
        {(area.hasInclude || area.hasExclude || area.loading || area.undrawable > 0) && (
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            {area.hasInclude && (
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm border" style={{ background: '#B8734F22', borderColor: '#B8734F' }} />
                {L('منطقة العميل', "Client's area")}
              </span>
            )}
            {area.hasExclude && (
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2.5 w-2.5 rounded-sm border" style={{ background: '#B91C1C1A', borderColor: '#B91C1C' }} />
                {L('منطقة مستثناة', 'Excluded area')}
              </span>
            )}
            {area.loading && !area.hasInclude && !area.hasExclude && (
              <span className="inline-flex items-center gap-1 text-charcoal/45">
                <Loader2 size={11} className="animate-spin" />
                {L('جارٍ رسم منطقة العميل…', "Drawing the client's area…")}
              </span>
            )}
            {area.undrawable > 0 && (
              <span className="text-amber-700">
                {L(`${area.undrawable} من قواعد الموقع لم تُرسم (تحتاج مراجعة)`, `${area.undrawable} location rule(s) not drawn (need review)`)}
              </span>
            )}
          </span>
        )}
        {legend && <span className="ms-auto flex flex-wrap items-center gap-x-3 gap-y-1">{legend}</span>}
      </div>
    </div>
  );
}
