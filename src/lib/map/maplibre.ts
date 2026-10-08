/**
 * The ONE entry point to MapLibre GL in the app. Every map module imports
 * maplibre through here (never `from 'maplibre-gl'` directly) so the two pieces
 * of global setup below always run before the first map is constructed:
 *
 *  1. The worker URL. MapLibre 6's ESM build locates its web worker relative to
 *     its own `import.meta.url` — which points into a hashed Vite chunk once
 *     bundled (and into `.vite/deps` in dev), where no worker file exists. Every
 *     tile parse would fail and the map would stay blank. Importing the worker
 *     with `?url` makes Vite emit it as a real asset and hands us its URL.
 *  2. The stylesheet (controls, markers, attribution, cooperative-gesture hint).
 */
import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);

export * from 'maplibre-gl';
