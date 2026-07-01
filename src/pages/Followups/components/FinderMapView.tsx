import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer';
import { Loader2, MapPin, X } from 'lucide-react';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { DEFAULT_MAP_CENTER, WASSEL_MAP_STYLE, buildColoredPinIcon, buildClusterIcon } from '@/lib/locationUtils';
import type { FinderMatch, FinderSource } from '@/lib/matching/projectFinder';

/**
 * MAP view for the Project Finder results — the alternative to the card list.
 * Plots every match that carries coordinates (facts.latitude/longitude, added by
 * scoreProject) as a brand-colored pin on the branded WASSEL_MAP_STYLE basemap,
 * clustered by density. Pins are colored by SOURCE (our projects / market / all
 * projects). Clicking a pin opens the SAME `FinderCard` as the list view — full
 * actions and all — in a floating panel over the map (the parent supplies it via
 * `renderSelectedCard`, so the action wiring is identical to a list card).
 *
 * Shared by the standalone Project Finder page and the Follow-up finder.
 */

interface Props {
  /** The matches to plot (typically pinned our-projects + the active tab's items). */
  matches: FinderMatch[];
  isAr: boolean;
  /** Fallback pin action when no card renderer is supplied (opens the record). */
  onOpenDetails: (item: FinderMatch) => void;
  /** Render the clicked match as a full card (the parent's own wired FinderCard).
   *  When provided, a pin click shows this card in a panel instead of navigating. */
  renderSelectedCard?: (match: FinderMatch) => ReactNode;
  /** Tailwind height for the map container. Default h-[70vh]. */
  heightClass?: string;
}

// Pin color by source — mirrors the card SourcePill so map & list read the same.
const SOURCE_COLOR: Record<FinderSource, string> = {
  our_projects: '#16A34A',   // green — our portfolio
  market_listings: '#4A2C2A', // chocolate — external market ads
  all_projects: '#4A4E54',   // charcoal — the listings DB
};
const SOURCE_LABEL: Record<FinderSource, { ar: string; en: string }> = {
  our_projects: { ar: 'مشاريعنا', en: 'Our Projects' },
  market_listings: { ar: 'إعلانات السوق', en: 'Market' },
  all_projects: { ar: 'كل المشاريع', en: 'Listings DB' },
};

const asCoord = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

interface Plotted { match: FinderMatch; lat: number; lng: number }

export default function FinderMapView({ matches, isAr, onOpenDetails, renderSelectedCard, heightClass = 'h-[70vh]' }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const onOpenRef = useRef(onOpenDetails);
  useEffect(() => { onOpenRef.current = onOpenDetails; }, [onOpenDetails]);
  const hasCard = !!renderSelectedCard;
  const hasCardRef = useRef(hasCard);
  useEffect(() => { hasCardRef.current = hasCard; }, [hasCard]);

  // Only matches with real coordinates can be plotted.
  const plotted = useMemo<Plotted[]>(() => {
    const out: Plotted[] = [];
    for (const m of matches) {
      const lat = asCoord(m.facts.latitude);
      const lng = asCoord(m.facts.longitude);
      if (lat != null && lng != null) out.push({ match: m, lat, lng });
    }
    return out;
  }, [matches]);

  const missingCoords = matches.length - plotted.length;

  // The currently-open card's match (kept in sync with the plotted set — a match
  // that scrolled out of the active tab/search closes its card).
  const selectedMatch = useMemo(
    () => plotted.find((p) => p.match.project_id === selectedId)?.match ?? null,
    [plotted, selectedId],
  );

  // Dismiss the open card when the plotted set changes (tab switch / new search).
  useEffect(() => { setSelectedId(null); }, [plotted]);

  // Clicking empty map space closes the open card.
  useEffect(() => {
    if (!map || !window.google) return;
    const l = map.addListener('click', () => setSelectedId(null));
    return () => google.maps.event.removeListener(l);
  }, [map]);

  // (Re)build markers + clusterer + fit bounds whenever the plotted set changes.
  useEffect(() => {
    if (!map || !isLoaded || !window.google) return;
    clustererRef.current?.clearMarkers();

    const markers: google.maps.Marker[] = plotted.map((p) => {
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        icon: buildColoredPinIcon(SOURCE_COLOR[p.match.source]) as google.maps.Icon | undefined,
        title: p.match.project_name,
        // Our projects sit on top so they're never hidden under a market pin.
        zIndex: p.match.source === 'our_projects' ? 1000 : undefined,
      });
      marker.addListener('click', () => {
        if (hasCardRef.current) {
          setSelectedId(p.match.project_id);
          map.panTo({ lat: p.lat, lng: p.lng });
        } else {
          onOpenRef.current(p.match);
        }
      });
      return marker;
    });

    if (markers.length > 0) {
      clustererRef.current = new MarkerClusterer({
        map,
        markers,
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
      // Fit to all pins (single pin → a comfortable zoom).
      const bounds = new google.maps.LatLngBounds();
      for (const p of plotted) bounds.extend({ lat: p.lat, lng: p.lng });
      map.fitBounds(bounds, 48);
      if (plotted.length === 1) {
        google.maps.event.addListenerOnce(map, 'idle', () => {
          if ((map.getZoom() ?? 0) > 15) map.setZoom(15);
        });
      }
    }

    return () => {
      clustererRef.current?.clearMarkers();
      clustererRef.current = null;
    };
  }, [map, isLoaded, plotted]);

  if (keyMissing) {
    return (
      <div className={`card flex ${heightClass} items-center justify-center p-6 text-center text-sm text-charcoal/60`}>
        {L('خريطة العرض غير مُفعّلة (مفتاح خرائط Google غير مُهيّأ).', 'Map view is unavailable (Google Maps key not configured).')}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className={`card flex ${heightClass} items-center justify-center p-6 text-center text-sm text-red-600`}>
        {L('تعذّر تحميل الخريطة.', 'Failed to load the map.')}
      </div>
    );
  }
  if (!isLoaded) {
    return (
      <div className={`card flex ${heightClass} items-center justify-center`}>
        <Loader2 className="animate-spin text-copper" />
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className={`relative w-full ${heightClass}`}>
        <GoogleMap
          mapContainerStyle={{ width: '100%', height: '100%' }}
          center={DEFAULT_MAP_CENTER}
          zoom={11}
          onLoad={setMap}
          onUnmount={() => setMap(null)}
          options={{
            styles: WASSEL_MAP_STYLE,
            disableDefaultUI: false,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true,
            clickableIcons: false,
          }}
        />

        {/* Clicked-pin card — the SAME FinderCard as the list, full actions. */}
        {selectedMatch && renderSelectedCard && (
          <div
            className="absolute top-3 z-20 w-[92%] max-w-[360px] overflow-y-auto rounded-xl shadow-2xl ring-1 ring-black/5"
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
            {renderSelectedCard(selectedMatch)}
          </div>
        )}
      </div>

      {/* Legend + coverage note */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-sand/40 bg-cream/30 px-3 py-2 text-[11px] text-charcoal/70">
        <span className="inline-flex items-center gap-1">
          <MapPin size={12} className="text-copper" />
          {L(`${plotted.length} على الخريطة`, `${plotted.length} on the map`)}
          {missingCoords > 0 && (
            <span className="text-charcoal/45">
              {' '}· {L(`${missingCoords} بدون إحداثيات`, `${missingCoords} without coordinates`)}
            </span>
          )}
        </span>
        <span className="ms-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {(Object.keys(SOURCE_LABEL) as FinderSource[]).map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SOURCE_COLOR[s] }} />
              {isAr ? SOURCE_LABEL[s].ar : SOURCE_LABEL[s].en}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
