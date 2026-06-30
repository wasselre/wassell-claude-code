# Riyadh Geographic Intelligence Dataset

Structured, **source-traceable** geographic anchors for Riyadh, built to power a deterministic
GIS-based project/listing matching engine (PostGIS distance/containment queries — no LLM).

**725 records · 716 from OpenStreetMap (real geometry) · 9 informal zones (flagged approximate).**
Geometry: 290 polygons · 232 points · 203 linestrings. **0 fabricated geometries.**

## How it was built (provenance)

- **Primary source: OpenStreetMap** via the Overpass API (live extract, `2026-06-30`). OSM carries
  real surveyed/traced geometry — LineStrings for roads & metro lines, Points for stations &
  POIs, Polygons for malls/campuses/parks/airports. Every OSM record links back to its element
  (`source_url` = `openstreetmap.org/<type>/<id>`).
- **Bounding box:** `24.30,46.30 → 25.20,47.20` (Riyadh metropolitan area).
- **Reproducible:** `node fetch.mjs` (caches raw Overpass JSON under `raw/`) then
  `node process.mjs` (normalizes → CSV/JSON/GeoJSON + reports). Re-running is idempotent.

### What is *not* fabricated
- Roads & metro lines are **assembled from real OSM way geometry**, grouped by name (roads) or by
  line ref across directional route relations (metro). Heavily-segmented roads (>8 segments) are
  flagged `is_approximate` because the merged geometry may include disjoint stretches sharing a name.
- Informal **zones/corridors** (north/central/east/west/south Riyadh, KAFD corridor, airport
  corridor, Olaya–Tahlia, Diplomatic Quarter) have **no official boundary**. No polygon was
  invented. They are stored as explicitly-approximate centroid points (`source_type=manual_estimate`,
  `confidence 0.35`, `is_approximate=true`) with a note explaining the approximation.

## Files (deliverables)

| File | What it is |
|------|------------|
| `riyadh-geo-intelligence.csv`     | Flat table, all 18 fields. `geometry_geojson` is an inline JSON string. For BI/spreadsheets. |
| `riyadh-geo-intelligence.json`    | Full records with `geometry_geojson` as a nested object. Best for programmatic use. |
| `riyadh-geo-intelligence.geojson` | RFC 7946 `FeatureCollection` (725 features). Drop into QGIS / Mapbox / `ogr2ogr` / `ST_GeomFromGeoJSON`. **Best for DB import.** |
| `report-missing-geometry.md`      | Records lacking the *ideal* geometry (area POIs with point-only footprint; zones with no boundary). 145 flagged. |
| `report-low-confidence.md`        | `confidence_score < 0.60` (the 9 informal zones). |
| `report-approximate-geometry.md`  | Every `is_approximate=true` record + why. 206 flagged. |
| `report-priority-review.md`       | Ranked manual-review queue (high-value anchors with weak geometry first). 242 items. |
| `db-import-structure.md`          | PostGIS table DDL, import recipes, and the matching-engine query patterns. |
| `fetch.mjs` / `process.mjs`       | The reproducible pipeline. |
| `raw/`                            | Cached Overpass responses (one JSON per category). |

## Schema (data dictionary)

| Field | Notes |
|-------|-------|
| `id` | Stable dataset id, e.g. `RUH-METR-0007`. |
| `name_ar`, `name_en` | Bilingual from OSM `name:ar` / `name:en` (one may be empty if OSM lacks it). |
| `category` | High-level group (12): roads_major, ring_roads, metro_lines, metro_stations, malls, universities, hospitals, airports_transport, parks, landmarks, business_zones, lifestyle, zones. |
| `type` | Finer label: highway, arterial_road, ring_road, metro_line, metro_station, mall, university, hospital, airport, bus_station, train_station, park, theme_park, water_park, landmark, historic_site, museum, tower, financial_district, commercial_zone, lifestyle_destination, corridor_zone. |
| `country`/`region`/`city` | Saudi Arabia / Riyadh Province / Riyadh. |
| `latitude`/`longitude` | Representative centroid — **always populated** (exact for points; bbox centre for areas/lines). |
| `geometry_type` | `point` / `linestring` / `polygon`. |
| `geometry_geojson` | The real geometry (WGS84 / EPSG:4326). Point, LineString, MultiLineString, Polygon, or MultiPolygon. |
| `source_url` | OSM element URL (or empty for manual zones). |
| `source_type` | `openstreetmap` \| `manual_estimate`. |
| `confidence_score` | 0–1. 0.9+ polygon/point POIs · 0.8–0.9 lines & most POIs · 0.6 generic commercial · 0.35 informal zones. +0.05 if the element has a Wikidata id. |
| `is_verified` | `true` ⇔ real geometry sourced from OSM. `false` ⇔ manual estimate. |
| `is_approximate` | `true` when geometry is weaker than ideal (point where a polygon is wanted, road merged from >8 segments, or an informal zone). |
| `notes` | Source tags and, for approximate rows, *why*. |

## Category counts

| category | records | approximate |
|----------|--------:|------------:|
| roads_major | 171 | 53 |
| hospitals | 103 | 63 |
| parks | 98 | 0 |
| landmarks | 91 | 63 |
| metro_stations | 84 | 0 |
| malls | 58 | 4 |
| business_zones | 42 | 0 |
| ring_roads | 20 | 8 |
| universities | 20 | 2 |
| airports_transport | 13 | 2 |
| lifestyle | 10 | 2 |
| metro_lines | 6 | 0 |
| zones | 9 | 9 |

## Known limitations / next steps (see priority-review report)

- **Point-only area POIs** (many hospitals & landmarks): OSM mapped them as nodes, so we have an
  exact point but no footprint polygon. Fine for distance matching; import building polygons later
  if containment is needed.
- **Green metro line (Line 5)** has sparse OSM way geometry (1 segment) — most of it is underground
  and lightly mapped. Verify against the official Riyadh Metro alignment if precise routing matters.
- **Zones** are centroids, not boundaries — do not use for `ST_Contains`. The Diplomatic Quarter
  has a real OSM boundary relation worth importing as a proper polygon (flagged in the report).
- **business_zones** beyond KAFD are commercial polygons named after their occupant; treat as soft
  signals, not authoritative district boundaries.

## Licensing

OSM-derived rows (716) are **© OpenStreetMap contributors, ODbL** — retain attribution on any
public surface. Manual zone rows are internal planning references.
