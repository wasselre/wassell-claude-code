/**
 * Demand-vs-supply district map (Phase 4, layer B).
 *
 * Renders one PIN per relevant district, keyed by the districts RECORD id —
 * the same id `location.district` uses on clients + projects — so the demand /
 * supply metric joins EXACTLY. (District polygons were attempted via
 * wassell_city_district_shapes, but that RPC keys geometry by a separate code
 * space, the records carry no boundary_geojson, and the city records are
 * fragmented — none of which can color a polygon correctly. A centroid pin from
 * the record's own center_lat/lng is the truthful, reliable visualization.)
 *
 * Pin colour = demand-vs-supply severity (covered → undersupplied); pin size
 * scales with demand. No fake data.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useJsApiLoader } from '@react-google-maps/api';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { GEO_MAP_STYLE } from '@/lib/locationUtils';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';

export interface DistrictMetric { demand: number; available: number; severity: number }
export interface DistrictPin { id: string; label: string; lat: number; lng: number; metric: DistrictMetric }

interface Props {
  pins: DistrictPin[];
  selectedId: string | null;
  onDistrictClick: (districtId: string) => void;
  isAr: boolean;
  language: 'ar' | 'en';
  heightClass?: string;
}

const RIYADH = { lat: 24.7136, lng: 46.6753 };
const RAMP = ['#10B981', '#84CC16', '#F59E0B', '#EF4444', '#B91C1C'];
const COVERED = '#10B981';
const NO_DEMAND = '#9CA3AF';

function severityColor(m: DistrictMetric): string {
  if (m.demand === 0) return NO_DEMAND;
  const s = m.severity;
  if (s <= 0) return COVERED;
  if (s <= 1) return RAMP[1]!;
  if (s <= 3) return RAMP[2]!;
  if (s <= 6) return RAMP[3]!;
  return RAMP[4]!;
}
const pinScale = (demand: number): number => Math.min(22, 6 + demand * 1.6);

export default function DemandSupplyMap({ pins, selectedId, onDistrictClick, isAr, language, heightClass = 'h-[28rem]' }: Props) {
  const { isLoaded } = useJsApiLoader(getMapsLoaderOptions(language));
  const divRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);
  const [hover, setHover] = useState<DistrictPin | null>(null);
  useGeoBoundaryLayer(mapInstance, { boundaries: true });

  const onClickRef = useRef(onDistrictClick);
  useEffect(() => { onClickRef.current = onDistrictClick; }, [onDistrictClick]);

  const validPins = useMemo(() => pins.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat !== 0 || p.lng !== 0)), [pins]);

  // Map init (once).
  useEffect(() => {
    if (!isLoaded || !divRef.current || mapRef.current) return;
    const map = new google.maps.Map(divRef.current, {
      center: RIYADH, zoom: 6, styles: GEO_MAP_STYLE,
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false,
    });
    mapRef.current = map;
    setMapInstance(map);
  }, [isLoaded]);

  // Draw pins + fit bounds when the set changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
    const bounds = new google.maps.LatLngBounds();
    for (const p of validPins) {
      const sel = p.id === selectedId;
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng }, map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: pinScale(p.metric.demand) * (sel ? 1.3 : 1),
          fillColor: severityColor(p.metric), fillOpacity: 0.82,
          strokeColor: sel ? '#4A2C2A' : '#FFFFFF', strokeWeight: sel ? 2.5 : 1,
        },
        zIndex: sel ? 1000 : Math.round(p.metric.demand),
      });
      marker.addListener('click', () => onClickRef.current(p.id));
      marker.addListener('mouseover', () => setHover(p));
      marker.addListener('mouseout', () => setHover(null));
      markersRef.current.push(marker);
      bounds.extend({ lat: p.lat, lng: p.lng });
    }
    if (validPins.length > 0 && !bounds.isEmpty()) {
      map.fitBounds(bounds);
      if (validPins.length === 1) map.setZoom(12);
    }
  }, [validPins, selectedId]);

  if (!isMapsKeyConfigured()) return <div className={`grid ${heightClass} place-items-center rounded-xl bg-cream text-sm text-charcoal/50`}>{isAr ? 'مفتاح خرائط Google غير مُعد' : 'Google Maps key not configured'}</div>;
  if (!isLoaded) return <div className={`grid ${heightClass} place-items-center rounded-xl bg-cream text-sm text-charcoal/40`}>{isAr ? 'جارٍ تحميل الخريطة…' : 'Loading map…'}</div>;

  return (
    <div className={`relative ${heightClass} w-full overflow-hidden rounded-xl`}>
      <div ref={divRef} className="h-full w-full" />
      {validPins.length === 0 && <div className="absolute inset-0 grid place-items-center bg-cream/60 text-sm text-charcoal/40">{isAr ? 'لا توجد أحياء بإحداثيات لعرضها' : 'No districts with coordinates to plot'}</div>}
      {/* Legend */}
      <div className="absolute bottom-3 start-3 rounded-lg bg-white/95 px-3 py-2 text-[11px] shadow-sm">
        <div className="mb-1 font-bold text-charcoal">{isAr ? 'فجوة الطلب مقابل المعروض' : 'Demand vs supply'}</div>
        <div className="flex items-center gap-1">
          <span className="text-charcoal/50">{isAr ? 'مغطّى' : 'Covered'}</span>
          {RAMP.map((c) => <span key={c} className="h-3 w-4 rounded-[2px]" style={{ background: c }} />)}
          <span className="text-charcoal/50">{isAr ? 'نقص' : 'Undersupplied'}</span>
        </div>
        <div className="mt-1 flex items-center gap-1 text-charcoal/45"><span className="h-3 w-3 rounded-full" style={{ background: NO_DEMAND }} /> {isAr ? 'معروض بلا طلب مسجّل' : 'Supply, no recorded demand'}</div>
      </div>
      {/* Hover card */}
      {hover && (
        <div className="pointer-events-none absolute top-3 end-3 max-w-[220px] rounded-lg bg-white/97 px-3 py-2 text-[12px] shadow-md">
          <div className="font-bold text-charcoal">{hover.label}</div>
          <div className="mt-1 text-charcoal/70">{isAr ? `${hover.metric.demand} طلب · ${hover.metric.available} متاحة` : `${hover.metric.demand} demand · ${hover.metric.available} available`}</div>
          {hover.metric.severity > 0 && <div className="text-charcoal/50">{isAr ? `${hover.metric.severity} بلا مخزون مناسب` : `${hover.metric.severity} unmet`}</div>}
        </div>
      )}
    </div>
  );
}
