import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { DEFAULT_MAP_CENTER } from '@/lib/locationUtils';
import { adminGeoGeoJSON, type GeoListFilters, type GeoFeatureCollection } from '@/lib/geo/adminClient';

const mapContainerStyle = { width: '100%', height: '68vh' };

// One distinct color per dataset category (legend + map styling).
const CATEGORY_COLORS: Record<string, string> = {
  roads_major: '#6B7280', ring_roads: '#1F2937', metro_lines: '#7C3AED', metro_stations: '#8B5CF6',
  malls: '#DB2777', universities: '#2563EB', hospitals: '#DC2626', airports_transport: '#0891B2',
  parks: '#16A34A', landmarks: '#B8734F', business_zones: '#CA8A04', lifestyle: '#EA580C', zones: '#9333EA',
};
const catColor = (c: string | null | undefined) => (c && CATEGORY_COLORS[c]) || '#4A4E54';

interface Props {
  filters: GeoListFilters;
  isAr: boolean;
  onSelect: (externalId: string) => void;
}

/**
 * Dedicated map for the geo_elements dataset. Renders the SAME filtered set as the
 * list (points = markers, roads/metro = lines, zones/malls/parks = polygons) via
 * the Google Maps Data layer, colored + toggleable by category. Click a feature to
 * open its detail drawer. Read-only — no geometry editing.
 */
export default function GeoElementsMap({ filters, isAr, onSelect }: Props) {
  const language = useAppStore((s) => s.language);
  const addToast = useAppStore((s) => s.addToast);
  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const [fc, setFc] = useState<GeoFeatureCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Strip pagination — the map loads the whole filtered set (capped server-side).
  const mapFilters = useMemo<GeoListFilters>(() => {
    const { limit: _l, offset: _o, ...rest } = filters; void _l; void _o;
    return { ...rest, limit: 5000 };
  }, [filters]);

  // Fetch the FeatureCollection whenever filters change (debounced).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      adminGeoGeoJSON(mapFilters)
        .then((res) => {
          if (cancelled) return;
          setFc(res);
          const cats = new Set<string>();
          for (const f of res.features) if (f.properties.category) cats.add(f.properties.category);
          setEnabled(cats); // all categories on by default
        })
        .catch((e) => { if (!cancelled) addToast(e instanceof Error ? e.message : 'map load failed', 'error'); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [mapFilters, addToast]);

  // Category counts in the current set (legend).
  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of fc?.features ?? []) {
      const c = f.properties.category ?? '∅';
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [fc]);

  // Load features into the Data layer (clear previous first) + wire click.
  useEffect(() => {
    if (!map || !isLoaded || !fc) return;
    map.data.forEach((f) => map.data.remove(f));
    try {
      map.data.addGeoJson(fc as unknown as object);
    } catch (e) {
      console.error('[geo-map] addGeoJson failed:', e);
    }
    const listener = map.data.addListener('click', (e: google.maps.Data.MouseEvent) => {
      const id = e.feature.getProperty('external_id');
      if (typeof id === 'string') onSelect(id);
    });
    return () => { google.maps.event.removeListener(listener); };
  }, [map, isLoaded, fc, onSelect]);

  // Style features by category + geometry, hiding disabled categories. Re-applied
  // whenever the enabled set changes (the closure reads the live ref).
  useEffect(() => {
    if (!map || !isLoaded) return;
    map.data.setStyle((feature) => {
      const cat = (feature.getProperty('category') as string) ?? '';
      const gt = (feature.getProperty('geometry_type') as string) ?? '';
      if (!enabledRef.current.has(cat)) return { visible: false };
      const color = catColor(cat);
      if (gt === 'point') {
        return { visible: true, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: color, fillOpacity: 0.95, strokeColor: '#ffffff', strokeWeight: 1 } };
      }
      if (gt === 'linestring') {
        return { visible: true, strokeColor: color, strokeWeight: 3, strokeOpacity: 0.85 };
      }
      return { visible: true, strokeColor: color, strokeWeight: 1.5, strokeOpacity: 0.9, fillColor: color, fillOpacity: 0.18 };
    });
  }, [map, isLoaded, enabled]);

  const toggleCat = (c: string) => setEnabled((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c); else next.add(c);
    return next;
  });
  const allOn = () => setEnabled(new Set(categoryCounts.map(([c]) => c)));
  const allOff = () => setEnabled(new Set());

  if (keyMissing) return <div className="card p-6 text-sm text-charcoal/50">{isAr ? 'مفتاح خرائط جوجل غير مهيأ.' : 'Google Maps key not configured.'}</div>;
  if (loadError) return <div className="card p-6 text-sm text-red-600">{String(loadError.message ?? loadError)}</div>;
  if (!isLoaded) return <div className="card flex items-center justify-center py-20 text-charcoal/40"><Loader2 className="animate-spin" /></div>;

  return (
    <div className="card overflow-hidden">
      {/* Legend / layer toggles */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-sand/30 p-2.5">
        <span className="text-xs font-bold text-charcoal/60 me-1">
          {loading ? (isAr ? 'جارٍ التحميل…' : 'Loading…') : `${fc?.count ?? 0} ${isAr ? 'عنصر على الخريطة' : 'on map'}`}
        </span>
        {categoryCounts.map(([c, n]) => {
          const on = enabled.has(c);
          const color = catColor(c);
          return (
            <button key={c} type="button" onClick={() => toggleCat(c)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold transition ${on ? 'border-transparent text-white' : 'border-sand/50 text-charcoal/40 bg-white'}`}
              style={on ? { backgroundColor: color } : undefined}>
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: on ? '#fff' : color }} />
              {c} ({n})
            </button>
          );
        })}
        {categoryCounts.length > 1 && (
          <span className="ms-1 flex gap-1">
            <button type="button" onClick={allOn} className="text-[11px] font-semibold text-copper hover:underline">{isAr ? 'الكل' : 'all'}</button>
            <span className="text-charcoal/30">/</span>
            <button type="button" onClick={allOff} className="text-[11px] font-semibold text-copper hover:underline">{isAr ? 'لا شيء' : 'none'}</button>
          </span>
        )}
      </div>

      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={DEFAULT_MAP_CENTER}
        zoom={10}
        options={{ mapTypeControl: false, streetViewControl: false, fullscreenControl: true, clickableIcons: false }}
        onLoad={(m) => setMap(m)}
        onUnmount={() => setMap(null)}
      />
      <p className="px-3 py-1.5 text-[11px] text-charcoal/40 border-t border-sand/20">
        {isAr ? 'اضغط على عنصر لفتح تفاصيله. الهندسة مبسّطة للعرض فقط.' : 'Click a feature to open its details. Geometry is simplified for display.'} · {language}
      </p>
    </div>
  );
}
