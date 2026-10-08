import type { LayerSpecification, StyleSpecification } from '@/lib/map/maplibre';

/**
 * Esri basemap for every map in the app, rendered by MapLibre GL.
 *
 * SOURCE
 *   • With `VITE_ARCGIS_API_KEY` set → Esri's Basemap Styles service
 *     (`arcgis/streets`), billed/licensed against that key. This is the
 *     production path.
 *   • Without a key → the public "World Street Map (Vector)" item style, which
 *     reads the same World Basemap v2 vector tiles. Same layer schema, same look —
 *     it exists so local dev, previews and offline-configured installs still get
 *     a real map. Production should always carry the key.
 *
 * LOOK
 *   Both styles are run through {@link wasselizeStyle} on load, which repaints
 *   every land/water/road/boundary layer in the Wassel palette (cream land, sand
 *   parks, gold-sand water, copper highways — no Esri green or blue) and DROPS
 *   every symbol layer. The app draws its own place names (useGeoBoundaryLayer,
 *   the district picker), so the basemap must carry no text at all — one name per
 *   place, ours. This is the MapLibre equivalent of the old Google
 *   WASSEL_MAP_STYLE + GEO_LABEL_SUPPRESSION pair, but it can't regress the way
 *   the Google styler did (2026-08-16 label-doubling incident): there is no label
 *   layer left in the style to un-hide.
 */

export const ARCGIS_API_KEY = (import.meta.env.VITE_ARCGIS_API_KEY as string | undefined)?.trim() ?? '';

/** Esri basemap style family used under every map. */
const STYLE_PATH = 'arcgis/streets';
/** Public World Street Map (Vector) item — the keyless fallback. */
const PUBLIC_STYLE_URL =
  'https://cdn.arcgis.com/sharing/rest/content/items/de26a3cf4cc9451298ea173c4b324736/resources/styles/root.json';

export function isArcgisKeyConfigured(): boolean {
  return Boolean(ARCGIS_API_KEY);
}

/** The style URL MapLibre loads; {@link wasselizeStyle} is applied on top. */
export function esriStyleUrl(language: 'ar' | 'en'): string {
  if (!ARCGIS_API_KEY) return PUBLIC_STYLE_URL;
  const params = new URLSearchParams({ token: ARCGIS_API_KEY, language });
  return `https://basemapstyles-api.arcgis.com/arcgis/rest/services/styles/v2/styles/${STYLE_PATH}?${params}`;
}

/** Attribution Esri's terms require on every map. */
export const ESRI_ATTRIBUTION = 'Powered by <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a>';

// ── Wassel palette (CLAUDE.md) ────────────────────────────────────────────────
const P = {
  land: '#F0E2C9',
  urban: '#E9D8BA',
  landuse: '#E4D1AC',
  park: '#D6C097',
  water: '#CBA877',
  building: '#E9D8BA',
  buildingShadow: '#DCC8A5',
  roadLocal: '#FBF4E6',
  roadLocalCasing: '#E1C99F',
  roadMajor: '#E1C99F',
  roadMajorCasing: '#C09B5F',
  highway: '#B8734F',
  highwayCasing: '#8E4E3A',
  freeway: '#A9633F',
  freewayCasing: '#4A2C2A',
  rail: '#8E4E3A',
  admin0: '#4A2C2A',
  admin1: '#8E4E3A',
  adminOther: '#C09B5F',
};

const PARK_RE = /^(Openspace or forest|Admin[01] forest or park|Zoo|Golf course|Park or farming|Cemetery|Vegetation|Special area of interest\/(Grass|Groundcover))/;
const WATER_RE = /^(Marine area|Bathymetry|Water area|Water line|Coastline|Special area of interest\/Water)/;
const SAND_RE = /^(Beach|Special area of interest\/Sand)/;

/** Pick the Wassel colour for one Esri World Basemap v2 layer, or null to leave it. */
function colorFor(layer: LayerSpecification): string | null {
  const id = layer.id;
  if (id.startsWith('Land/') || id === 'Indigenous' || id === 'Military') return P.land;
  if (id === 'Urban area') return P.urban;
  if (WATER_RE.test(id)) return P.water;
  if (PARK_RE.test(id)) return P.park;
  if (SAND_RE.test(id)) return P.urban;
  if (id.startsWith('Building/')) return id.includes('shadow') ? P.buildingShadow : P.building;
  if (id.startsWith('Railroad') || id.startsWith('Ferry')) return P.rail;

  if (id.startsWith('Road/') || id.startsWith('Road tunnel/') || id === 'Trail or path') {
    const casing = id.endsWith('/casing');
    if (id.includes('Freeway Motorway')) return casing ? P.freewayCasing : P.freeway;
    if (id.includes('/Highway/')) return casing ? P.highwayCasing : P.highway;
    if (id.includes('/Major')) return casing ? P.roadMajorCasing : P.roadMajor;
    return casing ? P.roadLocalCasing : P.roadLocal;
  }

  if (id.startsWith('Boundary line/')) {
    if (id.includes('Admin0') || id.includes('admin0')) return P.admin0;
    if (id.includes('Admin1') || id.includes('admin1')) return P.admin1;
    return P.adminOther;
  }

  // Every remaining polygon is land use (retail, education, medical, airport …).
  if (layer.type === 'fill') return P.landuse;
  return null;
}

/**
 * Repaint an Esri World Basemap v2 style in the Wassel palette and strip all
 * text/icons. Pure — returns a new style object. Passed to MapLibre as
 * `transformStyle` so it runs on whichever style (keyed or public) loaded.
 */
export function wasselizeStyle(style: StyleSpecification): StyleSpecification {
  const layers: LayerSpecification[] = [
    { id: 'wassel-background', type: 'background', paint: { 'background-color': P.land } },
  ];
  for (const layer of style.layers) {
    // No basemap text or icons — the app draws its own names.
    if (layer.type === 'symbol') continue;
    // Boundary casings are a wide halo under the admin line; on the flat cream
    // canvas they read as a smudge.
    if (layer.id.startsWith('Boundary line/') && layer.id.endsWith('/casing')) continue;

    const color = colorFor(layer);
    if (!color) { layers.push(layer); continue; }

    if (layer.type === 'fill') {
      const paint = { ...(layer.paint ?? {}) } as Record<string, unknown>;
      delete paint['fill-pattern'];
      paint['fill-color'] = color;
      paint['fill-outline-color'] = color;
      layers.push({ ...layer, paint } as LayerSpecification);
    } else if (layer.type === 'line') {
      const paint = { ...(layer.paint ?? {}) } as Record<string, unknown>;
      delete paint['line-pattern'];
      paint['line-color'] = color;
      layers.push({ ...layer, paint } as LayerSpecification);
    } else {
      layers.push(layer);
    }
  }
  // Symbol layers are gone and fill/line patterns stripped, so the sprite is
  // unused — dropping it saves a request (and a console 404 on the public item).
  const out: StyleSpecification = { ...style, layers };
  delete out.sprite;
  return out;
}

/**
 * Inline Esri vector sources as absolute tile templates.
 *
 * An Esri style's vector source is `{ url: …/VectorTileServer }`, whose metadata
 * lists RELATIVE tiles (`tile/{z}/{y}/{x}.pbf`). MapLibre resolves that against the
 * PAGE, not the server — every tile request hit the SPA and came back as
 * index.html ("Unable to parse the tile … Unimplemented type"), leaving a blank
 * cream map. So we read the metadata ourselves and hand MapLibre absolute URLs,
 * carrying the source URL's query (the API `token`, when keyed) onto each tile.
 * `maxzoom` = the server's last level of detail (16): MapLibre over-zooms from
 * there instead of requesting tiles that don't exist.
 */
async function resolveEsriVectorSources(style: StyleSpecification): Promise<StyleSpecification> {
  const sources = { ...style.sources };
  await Promise.all(Object.entries(sources).map(async ([id, src]) => {
    if (src.type !== 'vector' || !src.url || src.tiles) return;
    const u = new URL(src.url);
    const meta = new URL(u.href);
    meta.searchParams.set('f', 'json');
    const res = await fetch(meta.href);
    if (!res.ok) throw new Error(`Esri tile service metadata HTTP ${res.status}`);
    const j = (await res.json()) as {
      tiles?: string[]; minLOD?: number; maxLOD?: number; error?: { message?: string };
    };
    if (j.error || !j.tiles?.length) {
      throw new Error(`Esri tile service metadata: ${j.error?.message ?? 'no tiles listed'}`);
    }
    const base = `${u.origin}${u.pathname.replace(/\/?$/, '/')}`;
    const tiles = j.tiles.map((t) => {
      // Template braces must survive URL resolution un-encoded.
      const abs = /^https?:/i.test(t) ? t : base + t.replace(/^\//, '');
      return u.search ? `${abs}${abs.includes('?') ? '&' : '?'}${u.search.slice(1)}` : abs;
    });
    sources[id] = {
      type: 'vector',
      tiles,
      minzoom: j.minLOD ?? 0,
      maxzoom: j.maxLOD ?? 16,
      ...(src.attribution ? { attribution: src.attribution } : {}),
    };
  }));
  return { ...style, sources };
}

/** One fetch per session per language — every map after the first opens instantly. */
const styleCache = new Map<string, Promise<StyleSpecification>>();

/**
 * Fetch the Esri style and return it already Wassel-repainted, ready to hand to
 * `new Map({ style })`. Rejects (loudly — callers show an error state) when the
 * style can't be fetched; a failed fetch is evicted so the next map retries.
 */
export function loadWasselStyle(language: 'ar' | 'en'): Promise<StyleSpecification> {
  const url = esriStyleUrl(language);
  let p = styleCache.get(url);
  if (!p) {
    p = fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Esri basemap style HTTP ${res.status}`);
        const json = (await res.json()) as StyleSpecification & { error?: { message?: string } };
        // The styles service answers auth problems with HTTP 200 + an error body.
        if (json.error) throw new Error(`Esri basemap style: ${json.error.message ?? 'error'}`);
        return wasselizeStyle(await resolveEsriVectorSources(json));
      })
      .catch((err: unknown) => {
        styleCache.delete(url);
        throw err;
      });
    styleCache.set(url, p);
  }
  return p;
}
