import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Map as MlMap, NavigationControl, AttributionControl, type ControlPosition,
} from '@/lib/map/maplibre';
import { ESRI_ATTRIBUTION, loadWasselStyle } from '@/lib/map/esriBasemap';
import { interactionsFor } from '@/lib/map/interactions';
import { toMapLibreZoom, type LatLng } from '@/lib/map/geo';
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from '@/lib/locationUtils';

/**
 * THE map surface — every map in the app renders through this (it replaces
 * `<GoogleMap>` + `useJsApiLoader`). It owns:
 *   • creating the MapLibre map on the Esri basemap (Wassel-repainted, no basemap
 *     text — see esriBasemap.ts),
 *   • the loading spinner until the style is ready and a loud error state if the
 *     basemap fails (never a silent blank box),
 *   • keeping the canvas sized to its container (modals, tabs, fullscreen —
 *     MapLibre only watches the window by default),
 *   • zoom controls + the Esri attribution Esri's terms require.
 *
 * `onLoad(map)` fires once the style is loaded, i.e. when layers/sources can be
 * added — the equivalent of GoogleMap's `onLoad`. `onUnmount` fires before the
 * map is destroyed. Center/zoom props are INITIAL only (like GoogleMap's
 * uncontrolled defaults) and zoom is on the CLASSIC scale (see geo.ts).
 *
 * `children` render absolutely over the map (layer panels, buttons, cards) once
 * it has loaded.
 */

interface Props {
  isAr: boolean;
  center?: LatLng;
  /** CLASSIC-scale zoom (Google-equivalent). */
  zoom?: number;
  onLoad?: (map: MlMap) => void;
  onUnmount?: () => void;
  /** Outer box classes — give it a height (e.g. `h-[70vh]`, `h-full`). */
  className?: string;
  style?: CSSProperties;
  /** Ctrl/⌘+scroll to zoom and two-finger pan (Google's "cooperative"). Default false. */
  cooperativeGestures?: boolean;
  /** Zoom +/- control position, or false for none. Default 'bottom-right'. */
  navigationControl?: ControlPosition | false;
  /** false = static map (no pan/zoom/click). Default true. */
  interactive?: boolean;
  /** CLASSIC-scale zoom limits. */
  minZoom?: number;
  maxZoom?: number;
  children?: ReactNode;
}

export default function MapCanvas({
  isAr,
  center = DEFAULT_MAP_CENTER,
  zoom = DEFAULT_MAP_ZOOM,
  onLoad,
  onUnmount,
  className = 'h-full w-full',
  style,
  cooperativeGestures = false,
  navigationControl = 'bottom-right',
  interactive = true,
  minZoom,
  maxZoom,
  children,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Latest callbacks via refs: the map is created once per mount, never re-created
  // because a parent passed a fresh closure.
  const onLoadRef = useRef(onLoad);
  const onUnmountRef = useRef(onUnmount);
  useEffect(() => { onLoadRef.current = onLoad; }, [onLoad]);
  useEffect(() => { onUnmountRef.current = onUnmount; }, [onUnmount]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let map: MlMap | null = null;
    let loaded = false;
    let cancelled = false;
    const ro = new ResizeObserver(() => map?.resize());
    ro.observe(el);

    loadWasselStyle(isAr ? 'ar' : 'en')
      .then((basemap) => {
        if (cancelled) return;
        const m = new MlMap({
          container: el,
          style: basemap,
          center: [center.lng, center.lat],
          zoom: toMapLibreZoom(zoom),
          minZoom: minZoom != null ? toMapLibreZoom(minZoom) : undefined,
          maxZoom: maxZoom != null ? toMapLibreZoom(maxZoom) : 19,
          interactive,
          cooperativeGestures,
          attributionControl: false,
          // Flat 2-D map, like the Google maps it replaces: no tilt, no rotation.
          pitchWithRotate: false,
          dragRotate: false,
        });
        map = m;
        // The pointer dispatcher must exist before any overlay registers, and must
        // see the map's 'remove' event (overlay teardown guards rely on it).
        interactionsFor(m);
        m.touchZoomRotate.disableRotation();
        m.keyboard.disableRotation();
        m.addControl(new AttributionControl({ compact: true, customAttribution: ESRI_ATTRIBUTION }), 'bottom-left');
        if (navigationControl) m.addControl(new NavigationControl({ showCompass: false }), navigationControl);

        m.once('load', () => {
          loaded = true;
          setReady(true);
          onLoadRef.current?.(m);
        });
        m.on('error', (e) => {
          // Loud, per the repo's silent-failure rule. A tile hiccup after load is
          // logged only (the map keeps working); a failure BEFORE load means no
          // basemap at all, so the user sees an explicit error, not a blank box.
          console.error('[MapCanvas] map error:', e.error?.message ?? e);
          if (!loaded) setError(e.error?.message ?? 'map failed to load');
        });
      })
      // .catch (not a second .then arg) so a THROW while constructing the map — e.g.
      // the browser refusing a WebGL context — lands here too. Otherwise it became an
      // unhandled rejection and the box spun forever with no error shown.
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[MapCanvas] map failed to start:', err);
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      ro.disconnect();
      if (loaded) onUnmountRef.current?.();
      map?.remove();
    };
    // Created ONCE per mount — props are initial values (see header).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`relative ${className}`} style={style}>
      <div ref={containerRef} className="absolute inset-0" />
      {!ready && !error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-cream">
          <Loader2 className="animate-spin text-copper" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-cream p-6 text-center text-sm text-red-600">
          {isAr ? 'تعذّر تحميل الخريطة.' : 'Failed to load the map.'}
        </div>
      )}
      {ready && children}
    </div>
  );
}
