/**
 * Map toolkit (MapLibre GL on the Esri basemap). Import from '@/lib/map'.
 * See each module's header for the Google Maps API it replaces:
 *   geo.ts            LatLng/bounds/zoom (CLASSIC zoom scale!) + viewport events
 *   overlay.ts        GeoJsonOverlay  ← google.maps.Data / Polygon / Polyline
 *   editablePolygon   EditablePolygon ← Polygon({ editable: true })
 *   markers.ts        createIconMarker / createLabelMarker / MapTooltip ← Marker / InfoWindow
 *   cluster.ts        ClusteredMarkers ← @googlemaps/markerclusterer
 *   interactions.ts   onEmptyMapClick / setMapCursor ← map-level click + draggableCursor
 *   esriBasemap.ts    Esri style + Wassel repaint ← WASSEL_MAP_STYLE + GEO_LABEL_SUPPRESSION
 * The React map surface is src/components/map/MapCanvas.tsx (← <GoogleMap>).
 */
export type { Map as MlMap } from '@/lib/map/maplibre';
export * from '@/lib/map/geo';
export * from '@/lib/map/overlay';
export * from '@/lib/map/editablePolygon';
export * from '@/lib/map/markers';
export * from '@/lib/map/cluster';
export { onEmptyMapClick, setMapCursor, isMapRemoved, type OverlayHit } from '@/lib/map/interactions';
export { isArcgisKeyConfigured } from '@/lib/map/esriBasemap';
