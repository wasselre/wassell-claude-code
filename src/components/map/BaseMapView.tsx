import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2, MapPin, X, Maximize2, Minimize2 } from 'lucide-react';
import { buildClusterIcon, buildColoredPinIcon, cachedPillIcon } from '@/lib/locationUtils';
import {
  ClusteredMarkers, boundsOf, fitToBounds, getZoomLevel, onEmptyMapClick, toMapLibreZoom, unionBounds,
  type MapIcon, type MlMap,
} from '@/lib/map';
import MapCanvas from '@/components/map/MapCanvas';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';
import { useClientAreaLayer } from '@/components/map/useClientAreaLayer';
import MapLayersOverlay from '@/components/map/MapLayersOverlay';
import { useIsMobile } from '@/hooks/useIsMobile';
import type { LocationItem } from '@/lib/geo/locationItems';

/**
 * THE shared map surface for the whole app's "pins on a map" views — the
 * Project Finder results map, the Client Options map and the chat's project
 * browser all render through this. It owns every piece of map plumbing so a
 * change made here reaches every map at once (this component exists precisely
 * because those maps used to be separate copies and kept drifting apart — one
 * would get an update the other never did).
 *
 * What lives here (shared by every caller):
 *   • The map itself (MapCanvas: Esri basemap, loading + error states)
 *   • Marker clustering (Supercluster), with "solo" pins that never cluster
 *   • Fit-to-pins on change (single pin → a comfortable zoom)
 *   • Administrative boundary context layer (useGeoBoundaryLayer)
 *   • The CLIENT'S SELECTED AREA highlight (useClientAreaLayer) + refit-to-area
 *   • The roads/landmarks toggle overlay (MapLayersOverlay)
 *   • The full-view button (browser Fullscreen API, end side so the layers
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
  /** Marker image. Undefined → `pill` if given, else a copper pin. */
  icon: MapIcon | undefined;
  /** Hover title. */
  title: string;
  /** Draw the pin as a NAME PILL (the label in this color) instead of `icon`. */
  pill?: { label: string; color: string };
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
  /** One-finger pan on mobile (the finder wants it inside its modal). Otherwise
   *  mobile is "cooperative" (two fingers pan) so the page still scrolls. */
  mobileGreedy?: boolean;
  /** Outer container classes. Default the standard `.card`. */
  outerClassName?: string;
  /** @deprecated No longer used — loading/error states render inside the map box. */
  stateBoxClassName?: string;
  /** Max-width class for the clicked-pin card panel. Default max-w-[400px]. */
  cardMaxWidthClass?: string;
  /** Fired on every marker rebuild with the pin count (perf instrumentation hook). */
  onRebuild?: (count: number) => void;
}

const COPPER = '#B8734F';
/** Classic-scale zoom pins stop clustering at — and the single-pin zoom cap. */
const PIN_MAX_ZOOM = 15;

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
  cardMaxWidthClass = 'max-w-[400px]',
  onRebuild,
}: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const isMobile = useIsMobile();

  const [map, setMap] = useState<MlMap | null>(null);
  // Administrative context under the pins — country/region/city/district by zoom.
  // Roads + landmarks are user-toggled context layers owned by MapLayersOverlay
  // (below), so the map opens clean. See useGeoBoundaryLayer.
  useGeoBoundaryLayer(map, { roads: false, landmarks: false, isAr });
  // The client's selected area (compiled by the matcher's own preview RPC) shaded
  // under the pins — include rules in copper, exclude rules in red.
  const area = useClientAreaLayer(map, areaItems, isAr);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Full-view: the map wrapper enters the browser Fullscreen API. isFs tracks it so
  // the button flips between enter/exit.
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

  const clusterRef = useRef<ClusteredMarkers | null>(null);
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
  // render, so keying the marker/cluster/fit effect on the array identity would
  // tear down + rebuild every marker (pins flickering) and refit the viewport (the
  // user's zoom snapping back) on every parent re-render. Keyed on this string,
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

  // Clicking empty map space closes the open card (pin + shape clicks don't count).
  useEffect(() => {
    if (!map) return;
    return onEmptyMapClick(map, () => setSelectedId(null));
  }, [map]);

  // The clusterer lives as long as the map.
  useEffect(() => {
    if (!map) return;
    const c = new ClusteredMarkers(map, {
      radius: 70,
      maxZoom: PIN_MAX_ZOOM,
      clusterIcon: (n) => buildClusterIcon(n),
      clusterZIndex: 1000, // clusters above every individual pin, like Google's MAX_ZINDEX
    });
    clusterRef.current = c;
    return () => { c.remove(); clusterRef.current = null; };
  }, [map]);

  // (Re)build markers + fit bounds whenever the pin set changes.
  useEffect(() => {
    const clusters = clusterRef.current;
    if (!map || !clusters) return;
    onRebuildRef.current?.(pins.length);

    clusters.setItems(pins.map((p) => ({
      id: p.id,
      position: { lat: p.lat, lng: p.lng },
      icon: p.icon ?? (p.pill ? cachedPillIcon(p.pill.label, p.pill.color) : buildColoredPinIcon(COPPER)),
      title: p.title,
      zIndex: p.zIndex,
      solo: p.solo,
      onClick: () => {
        if (hasCardRef.current) {
          setSelectedId(p.id);
          map.easeTo({ center: [p.lng, p.lat], duration: 400 });
        } else {
          onPinClickRef.current?.(p.id);
        }
      },
    })));

    if (pins.length > 0) {
      // A single pin would otherwise zoom to street level.
      fitToBounds(map, boundsOf(pins), { padding: 48, maxZoom: pins.length === 1 ? PIN_MAX_ZOOM : 18 });
    }
    // Keyed on pinsSig (content), NOT pins (identity) — see pinsSig above. pins is
    // read from the same render as pinsSig, so the closure matches the signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, pinsSig]);

  // External "show on map" request (from a list card). Applied ONCE per nonce, as
  // soon as the map is ready AND the pin is in the current set (which may lag a tab
  // switch / fresh mount). Declared after the marker effect so its move lands after
  // that effect's fit, and after the clear-on-change effect so it re-opens rather
  // than being cleared. Guarded by the nonce so a later rebuild can't reopen a card
  // the user has since closed.
  const appliedFocusNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || !map) return;
    if (focus.nonce === appliedFocusNonce.current) return;
    const p = pins.find((x) => x.id === focus.id);
    if (!p) return; // pin not in the current set yet — re-runs when pinsSig updates
    appliedFocusNonce.current = focus.nonce;
    setSelectedId(focus.id);
    map.easeTo({
      center: [p.lng, p.lat],
      // Zoomed out past street context → come in close enough to see the pin's block.
      zoom: getZoomLevel(map) < 13 ? toMapLibreZoom(PIN_MAX_ZOOM) : map.getZoom(),
      duration: 500,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, map, pinsSig]);

  // When the client's area arrives (it compiles server-side, so it lands after the
  // pins' own fit), widen the view to show the WHOLE area plus every pin — the
  // point is to see which pins sit inside it. Keyed on the area's drawn-shape key so
  // panning/zooming afterwards isn't yanked back; a later pin-set change refits via
  // the marker effect as before.
  useEffect(() => {
    if (!map || !area.bounds) return;
    fitToBounds(map, unionBounds(area.bounds, boundsOf(pins)), { padding: 48 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, area.boundsKey]);

  return (
    <div className={outerClassName}>
      <div ref={wrapRef} className={`relative w-full bg-cream ${isFs ? 'h-full' : heightClass}`}>
        <MapCanvas
          isAr={isAr}
          className="h-full w-full"
          onLoad={setMap}
          onUnmount={() => setMap(null)}
          // MOBILE: two-finger pan by default so a one-finger drag still scrolls the
          // page; the finder's modal opts into one-finger pan (mobileGreedy).
          cooperativeGestures={isMobile && !mobileGreedy}
        >
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
        </MapCanvas>
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
