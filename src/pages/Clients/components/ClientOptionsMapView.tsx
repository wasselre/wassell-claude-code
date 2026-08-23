import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer';
import { Loader2, MapPin, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';
import MapLayersOverlay from '@/components/map/MapLayersOverlay';
import {
  DEFAULT_MAP_CENTER, GEO_MAP_STYLE,
  buildColoredPinIcon, buildPillIcon, buildClusterIcon,
} from '@/lib/locationUtils';
import {
  CLIENT_OPTION_STATUS_META, CLIENT_OPTION_STATUS_ORDER,
  type ClientOptionStatus, type ClientOptionSourceType,
} from '@/lib/matching/clientOptions';
import type { AppRecord } from '@/types';

/**
 * MAP view for the Client Options tab — the alternative to the card list.
 * Plots every visible option that carries coordinates as a pin colored by its
 * option STATUS (same colors as the status badges), so the rep reads the map
 * and the list the same way. The main option renders as a named pill that is
 * never absorbed into a cluster. Clicking a pin opens the SAME option card as
 * the list view — full actions and all — in a floating panel over the map
 * (the parent supplies it via `renderCard`).
 *
 * Coordinates come from the option's saved facts snapshot (facts.latitude /
 * facts.longitude, written by the Project Finder at save time); options saved
 * before that snapshot existed — or added manually — fall back to the source
 * record's own latitude/longitude in the store.
 */

interface Props {
  /** The options to plot (the tab's already-filtered `visible` list). */
  options: AppRecord[];
  isAr: boolean;
  /** Render the clicked option as the full list card (identical action wiring). */
  renderCard: (option: AppRecord) => ReactNode;
  /** Tailwind height for the map container. Default h-[65vh]. */
  heightClass?: string;
}

const asCoord = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

const SOURCE_MODEL: Record<ClientOptionSourceType, string> = {
  project: 'all_projects',
  unit: 'units',
  market_listing: 'market_listings',
};

interface Plotted { option: AppRecord; lat: number; lng: number }

export default function ClientOptionsMapView({ options, isAr, renderCard, heightClass = 'h-[65vh]' }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const [map, setMap] = useState<google.maps.Map | null>(null);
  // Administrative context under the option pins (boundaries only). Roads +
  // landmarks are user-toggled context layers now (MapLayersOverlay below), so the
  // map opens clean. See useGeoBoundaryLayer.
  useGeoBoundaryLayer(map, { roads: false, landmarks: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const clustererRef = useRef<MarkerClusterer | null>(null);
  // The MAIN option's pill marker is placed on the map directly (never in the
  // clusterer) so it always shows as an individual pin; kept here for teardown.
  const mainMarkersRef = useRef<google.maps.Marker[]>([]);

  // facts snapshot first; source record's own coordinates as the fallback.
  const plotted = useMemo<Plotted[]>(() => {
    const modelIdByName = new Map(models.map((m) => [m.name, m.id]));
    const out: Plotted[] = [];
    for (const r of options) {
      const d = r.data as Record<string, unknown>;
      const f = (d.facts ?? {}) as Record<string, unknown>;
      let lat = asCoord(f.latitude);
      let lng = asCoord(f.longitude);
      if (lat == null || lng == null) {
        const modelName = SOURCE_MODEL[d.source_type as ClientOptionSourceType];
        const mid = modelName ? modelIdByName.get(modelName) : undefined;
        const src = mid ? (records[mid] ?? []).find((x) => x.id === d.source_id) : undefined;
        if (src) {
          lat = asCoord((src.data as Record<string, unknown>).latitude);
          lng = asCoord((src.data as Record<string, unknown>).longitude);
        }
      }
      if (lat != null && lng != null) out.push({ option: r, lat, lng });
    }
    return out;
  }, [options, models, records]);

  const missingCoords = options.length - plotted.length;

  const selectedOption = useMemo(
    () => plotted.find((p) => p.option.id === selectedId)?.option ?? null,
    [plotted, selectedId],
  );

  // Dismiss the open card when the plotted set changes (filter change).
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
    mainMarkersRef.current.forEach((m) => m.setMap(null));
    mainMarkersRef.current = [];

    // One icon per status color, reused across markers.
    const iconByStatus = new Map<string, google.maps.Icon | undefined>();
    const iconFor = (status: ClientOptionStatus) => {
      const color = (CLIENT_OPTION_STATUS_META[status] ?? CLIENT_OPTION_STATUS_META.suitable).color;
      if (!iconByStatus.has(color)) iconByStatus.set(color, buildColoredPinIcon(color) as google.maps.Icon | undefined);
      return iconByStatus.get(color);
    };

    const clustered: google.maps.Marker[] = [];
    for (const p of plotted) {
      const d = p.option.data as Record<string, unknown>;
      const status = d.status as ClientOptionStatus;
      const isMain = d.is_main === true;
      const name = typeof d.source_name === 'string' && d.source_name ? d.source_name : L('بدون اسم', 'Untitled');
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        icon: isMain
          ? (buildPillIcon(name, CLIENT_OPTION_STATUS_META.main_focus.color) as google.maps.Icon | undefined)
          : iconFor(status),
        title: name,
        // The main option sits on top so it's never hidden under another pin.
        zIndex: isMain ? 1000 : undefined,
      });
      marker.addListener('click', () => {
        setSelectedId(p.option.id);
        map.panTo({ lat: p.lat, lng: p.lng });
      });
      if (isMain) {
        marker.setMap(map);
        mainMarkersRef.current.push(marker);
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

    if (plotted.length > 0) {
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
      mainMarkersRef.current.forEach((m) => m.setMap(null));
      mainMarkersRef.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, plotted]);

  const statusesPresent = useMemo(() => {
    const present = new Set<string>();
    for (const p of plotted) present.add(String((p.option.data as Record<string, unknown>).status));
    return CLIENT_OPTION_STATUS_ORDER.filter((s) => present.has(s));
  }, [plotted]);

  if (keyMissing) {
    return (
      <div className={`flex ${heightClass} items-center justify-center rounded-2xl border border-sand/30 bg-white p-6 text-center text-sm text-charcoal/60`}>
        {L('خريطة العرض غير مُفعّلة (مفتاح خرائط Google غير مُهيّأ).', 'Map view is unavailable (Google Maps key not configured).')}
      </div>
    );
  }
  if (loadError) {
    return (
      <div className={`flex ${heightClass} items-center justify-center rounded-2xl border border-sand/30 bg-white p-6 text-center text-sm text-red-600`}>
        {L('تعذّر تحميل الخريطة.', 'Failed to load the map.')}
      </div>
    );
  }
  if (!isLoaded) {
    return (
      <div className={`flex ${heightClass} items-center justify-center rounded-2xl border border-sand/30 bg-white`}>
        <Loader2 className="animate-spin text-copper" />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-sand/30 bg-white">
      <div className={`relative w-full ${heightClass}`}>
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
            fullscreenControl: true,
            clickableIcons: false,
          }}
        />

        <MapLayersOverlay map={map} isAr={isAr} />

        {/* Clicked-pin card — the SAME option card as the list, full actions. */}
        {selectedOption && (
          <div
            className="absolute top-3 z-20 w-[92%] max-w-[400px] overflow-y-auto rounded-xl shadow-2xl ring-1 ring-black/5"
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
            {renderCard(selectedOption)}
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
          {statusesPresent.map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CLIENT_OPTION_STATUS_META[s].color }} />
              {isAr ? CLIENT_OPTION_STATUS_META[s].ar : CLIENT_OPTION_STATUS_META[s].en}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
