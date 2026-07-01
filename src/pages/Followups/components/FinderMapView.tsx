import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer';
import { Loader2, MapPin } from 'lucide-react';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { DEFAULT_MAP_CENTER, WASSEL_MAP_STYLE, buildColoredPinIcon, buildClusterIcon } from '@/lib/locationUtils';
import type { FinderMatch, FinderSource } from '@/lib/matching/projectFinder';

/**
 * MAP view for the Project Finder results — the alternative to the card list.
 * Plots every match that carries coordinates (facts.latitude/longitude, added by
 * scoreProject) as a brand-colored pin on the branded WASSEL_MAP_STYLE basemap,
 * clustered by density. Pins are colored by SOURCE (our projects / market / all
 * projects); clicking one opens an InfoWindow summary with a "Details" button that
 * runs the same onOpenDetails as the card. Read-only — the map never scores or
 * mutates; the card list stays the source of all client-option actions.
 *
 * Shared by the standalone Project Finder page and the Follow-up finder.
 */

interface Props {
  /** The matches to plot (typically pinned our-projects + the active tier's items). */
  matches: FinderMatch[];
  isAr: boolean;
  onOpenDetails: (item: FinderMatch) => void;
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Compact price-range string from a {min,max} facts value (SAR, whole numbers). */
function priceLabel(v: unknown, isAr: boolean): string | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const min = Number(o.min); const max = Number(o.max);
  const hasMin = Number.isFinite(min) && min > 0;
  const hasMax = Number.isFinite(max) && max > 0;
  const cur = isAr ? 'ر.س' : 'SAR';
  const f = (n: number) => n.toLocaleString('en-US');
  if (hasMin && hasMax) return min === max ? `${f(min)} ${cur}` : `${f(min)} – ${f(max)} ${cur}`;
  if (hasMax) return `${f(max)} ${cur}`;
  if (hasMin) return `${f(min)} ${cur}`;
  return null;
}

interface Plotted { match: FinderMatch; lat: number; lng: number }

export default function FinderMapView({ matches, isAr, onOpenDetails, heightClass = 'h-[70vh]' }: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const [map, setMap] = useState<google.maps.Map | null>(null);
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const infoRef = useRef<google.maps.InfoWindow | null>(null);
  const onOpenRef = useRef(onOpenDetails);
  useEffect(() => { onOpenRef.current = onOpenDetails; }, [onOpenDetails]);

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

  // Build the InfoWindow content as a DOM node so its "Details" button can call
  // back into React (an HTML-string onclick can't reach onOpenDetails).
  const openInfo = (p: Plotted, marker: google.maps.Marker) => {
    if (!map || !window.google) return;
    if (!infoRef.current) infoRef.current = new google.maps.InfoWindow();
    const m = p.match;
    const f = m.facts;
    const district = typeof f.district === 'string' ? f.district : '';
    const city = typeof f.city === 'string' ? f.city : '';
    const loc = [district, city].filter(Boolean).join('، ') || L('الموقع غير محدد', 'Location not set');
    const price = priceLabel(f.price_range, isAr);
    const src = SOURCE_LABEL[m.source];
    const dist = m.distance_km != null ? L(`~${m.distance_km} كم`, `~${m.distance_km} km`) : '';
    const node = document.createElement('div');
    node.setAttribute('dir', isAr ? 'rtl' : 'ltr');
    node.style.cssText = "font-family:Amiri,'Segoe UI',system-ui,sans-serif;min-width:180px;max-width:260px;color:#4A2C2A";
    node.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${SOURCE_COLOR[m.source]}"></span>
        <span style="font-size:10px;font-weight:700;color:${SOURCE_COLOR[m.source]}">${escapeHtml(isAr ? src.ar : src.en)}</span>
        <span style="font-size:10px;font-weight:700;color:#B8734F;margin-inline-start:auto">· ${m.score}</span>
      </div>
      <div style="font-weight:700;font-size:14px;line-height:1.3">${escapeHtml(m.project_name)}</div>
      <div style="font-size:11px;color:#8E4E3A;margin-top:2px">${escapeHtml(loc)}${dist ? ` · ${escapeHtml(dist)}` : ''}</div>
      ${price ? `<div style="font-size:12px;font-weight:600;margin-top:4px">${escapeHtml(price)}</div>` : ''}
      <button data-details style="margin-top:8px;width:100%;cursor:pointer;border:none;border-radius:8px;background:#B8734F;color:#fff;font-family:inherit;font-weight:700;font-size:12px;padding:6px 10px">
        ${escapeHtml(L('التفاصيل', 'Details'))}
      </button>`;
    node.querySelector('[data-details]')?.addEventListener('click', () => onOpenRef.current(m));
    infoRef.current.setContent(node);
    infoRef.current.open({ map, anchor: marker });
  };

  // (Re)build markers + clusterer + fit bounds whenever the plotted set changes.
  useEffect(() => {
    if (!map || !isLoaded || !window.google) return;
    clustererRef.current?.clearMarkers();
    infoRef.current?.close();

    const markers: google.maps.Marker[] = plotted.map((p) => {
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        icon: buildColoredPinIcon(SOURCE_COLOR[p.match.source]) as google.maps.Icon | undefined,
        title: p.match.project_name,
        // Our projects sit on top so they're never hidden under a market pin.
        zIndex: p.match.source === 'our_projects' ? 1000 : undefined,
      });
      marker.addListener('click', () => openInfo(p, marker));
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
        const once = google.maps.event.addListenerOnce(map, 'idle', () => {
          if ((map.getZoom() ?? 0) > 15) map.setZoom(15);
        });
        void once;
      }
    }

    return () => {
      clustererRef.current?.clearMarkers();
      clustererRef.current = null;
    };
    // openInfo reads refs/props via closure; isAr re-runs to refresh popup language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, plotted, isAr]);

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
      <div className={`w-full ${heightClass}`}>
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
