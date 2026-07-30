# Saudi Geographic Intelligence Datasets

Structured, **source-traceable** geographic anchors, built to power a deterministic GIS-based
project/listing matching engine (PostGIS distance/containment queries — no LLM).

Two datasets, one schema, one importer:

| Dataset | Cities fetched | Anchors | Built | Id form |
|---|---|--:|---|---|
| `riyadh-geo-intelligence.json` | Riyadh | 725 (651 active) | 2026-06-30 | `RUH-<CAT>-<seq>` |
| `saudi-cities-geo-intelligence.json` | 20 further cities | 1,833 | 2026-07-30 | `<PREFIX>-<CAT>-<hash>` |

Live result after import: **2,484 active Saudi anchors across 41 cities**, 3,983 aliases, 0 unlinked.
41 rather than 21 because polygon containment reassigns anchors to their *true* city — Al Mubarraz
next to Hafuf, Yanbu Al Sinaiyah, the Qatif-area towns (Sayhat, Safwa, Tarut, Darin). The 74
inactive Riyadh rows are the road-merge losers retired by `2026-07-27_merge_fragmented_roads.sql`.

Import with `node scripts/import-geo-intelligence.mjs [file|--all]`. It upserts by `external_id`,
rebuilds aliases, **and** calls `wassell_link_geo_elements_geography()` to attach `city_id`/`region_id`
by polygon containment and sync the text city label — all idempotent, so re-running is safe.

> `geo_elements` is SHARED with the UAE dataset (`data/source/geo-uae/`, 3,237 anchors). Rows carry
> `country_code`; pass `p_country` / `?country=` when searching or you will mix Riyadh and Dubai.

> **The `fetch.mjs` / `process.mjs` in this folder are a 2026-07-30 reconstruction.** The original
> pair that produced `riyadh-geo-intelligence.json` was never committed — only its outputs were —
> so re-running the current scripts will **not** reproduce the Riyadh file byte-for-byte. The
> taxonomy, confidence rules and 18-field schema were rebuilt from this README; the id scheme
> deliberately differs (see "Stable ids" below). Riyadh's file is treated as immutable history:
> its sequential ids are already referenced by live client rules.

## The multi-city build (2026-07-30)

`cities.json` drives everything — 20 cities, each with an SPL city id, bilingual names, an Overpass
bbox and a stable id prefix. The bboxes are **derived from the live database**, not hand-drawn: each
is the 2nd–98th percentile extent of that city's own `district_boundaries` centroids, padded 0.06°.
Percentiles rather than `ST_Extent` because several SPL cities own far-flung outlying districts —
Madinah's raw extent is ~200 km across, which would have made a needlessly enormous extract.

**Stable ids.** New anchors use `<PREFIX>-<CAT>-<6 hex of sha1(identity)>`, where identity is the
immutable OSM `type/id` (discrete features), the normalized name (grouped roads), or the direction
(generated zones). *Not* a sequence: client element rules reference `external_id`, so renumbering on
a future OSM refresh would silently break live rules by compiling them to `needs_review`.
`process.mjs` aborts on any id collision rather than letting one anchor overwrite another.

**One element, one city.** The Eastern Province bboxes (Dammam / Khobar / Dhahran / Qatif) overlap
heavily, so the same OSM feature comes back for several cities. Features are deduped by OSM identity
and assigned to the nearest city centre (the median district centroid from the DB).

**Deliberate gaps, not oversights:**
- **`lifestyle` is empty** for the new cities. Riyadh's 10 were hand-curated; no OSM tag reliably
  means "lifestyle destination", and inventing one would put noise in a curated dataset.
- **`office=*` is excluded** from `business_zones`. It marks a single office building, not a business
  district — including it filled the category with government departments (31 of Jazan's first 77
  anchors were things like the labour office and the tax authority). A business zone must be a named
  commercial/retail *land use* area.
- **Metro is Riyadh-only in reality.** The queries run everywhere; most cities return nothing because
  they have no metro. Empty is the honest answer, not a bug.

## Riyadh dataset (2026-06-30)

**725 records · 716 from OpenStreetMap (real geometry) · 9 informal zones (flagged approximate).**

**725 records · 716 from OpenStreetMap (real geometry) · 9 informal zones (flagged approximate).**
Geometry: 290 polygons · 232 points · 203 linestrings. **0 fabricated geometries.**

## How it was built (provenance)

- **Primary source: OpenStreetMap** via the Overpass API (live extract, `2026-06-30`). OSM carries
  real surveyed/traced geometry — LineStrings for roads & metro lines, Points for stations &
  POIs, Polygons for malls/campuses/parks/airports. Every OSM record links back to its element
  (`source_url` = `openstreetmap.org/<type>/<id>`).
- **Bounding box:** `24.30,46.30 → 25.20,47.20` (Riyadh metropolitan area).
- **Originally reproducible via** `node fetch.mjs` then `node process.mjs`. Those original scripts
  were never committed and are lost — the current `fetch.mjs`/`process.mjs` are the 2026-07-30
  reconstruction described at the top of this file, and they target `cities.json` (which does **not**
  include Riyadh). Treat `riyadh-geo-intelligence.json` as immutable history; to refresh Riyadh,
  add it to `cities.json` and accept the new hashed id scheme, which means re-pointing any live
  client element rule that references an `RUH-<CAT>-<seq>` id.

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
