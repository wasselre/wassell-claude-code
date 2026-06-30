# Suggested database import structure

Target: **Supabase / PostgreSQL + PostGIS** (the project already runs PostGIS with the SPL
district boundaries — see the geography migration). This dataset is a sibling reference layer:
named geographic *anchors* (roads, metro, malls, landmarks, zones…) that the deterministic
project/listing matching engine measures distance/containment against.

## 1. Table

```sql
create extension if not exists postgis;

create table public.geo_anchors (
  id                text primary key,          -- e.g. RUH-METR-0007 (stable, from the dataset)
  name_ar           text,
  name_en           text,
  category          text not null,             -- roads_major | ring_roads | metro_lines | metro_stations
                                               -- | malls | universities | hospitals | airports_transport
                                               -- | parks | landmarks | business_zones | lifestyle | zones
  type              text not null,             -- finer label: highway, ring_road, metro_line, metro_station,
                                               -- mall, university, hospital, airport, bus_station, train_station,
                                               -- park, landmark, historic_site, museum, tower,
                                               -- financial_district, commercial_zone, lifestyle_destination,
                                               -- corridor_zone
  country           text not null default 'Saudi Arabia',
  region            text not null default 'Riyadh Province',
  city              text not null default 'Riyadh',
  latitude          double precision,          -- representative centroid (always populated)
  longitude         double precision,
  geometry_type     text not null,             -- point | linestring | polygon
  geom              geometry(Geometry, 4326),  -- the real geometry (WGS84). NULL only for "missing geometry"
  source_url        text,
  source_type       text not null,             -- openstreetmap | manual_estimate
  confidence_score  numeric(3,2) not null,     -- 0.00–1.00
  is_verified       boolean not null,          -- true = sourced from OSM with real geometry
  is_approximate    boolean not null,          -- true = geometry weaker than ideal / informal zone
  notes             text,
  created_at        timestamptz not null default now()
);

-- Spatial + filter indexes the matching engine will lean on
create index geo_anchors_geom_gix   on public.geo_anchors using gist (geom);
create index geo_anchors_cat_idx    on public.geo_anchors (category);
create index geo_anchors_type_idx   on public.geo_anchors (type);
create index geo_anchors_geog_gix   on public.geo_anchors using gist ((geom::geography));  -- for metric distance
```

`geom` stores `Geometry` (mixed) so points, linestrings and polygons live in one column.
Cast to `geography` for true-metre distances (`ST_DWithin(geom::geography, $pt::geography, 1500)`).

## 2. Import (from the generated GeoJSON — recommended)

The `.geojson` is the cleanest import surface: it already carries valid WGS84 geometry plus all
attributes in `properties`. Two paths:

**a) `ogr2ogr` (one shot, keeps geometry types):**
```bash
ogr2ogr -f PostgreSQL \
  "PG:host=... dbname=postgres user=... password=..." \
  riyadh-geo-intelligence.geojson \
  -nln geo_anchors_staging -lco GEOMETRY_NAME=geom -lco FID=id -t_srs EPSG:4326
-- then INSERT ... SELECT into geo_anchors mapping property columns.
```

**b) Pure SQL (no GDAL) — load the JSON array and build geometry with PostGIS:**
```sql
-- :payload = contents of riyadh-geo-intelligence.json (jsonb)
insert into public.geo_anchors
  (id, name_ar, name_en, category, type, country, region, city,
   latitude, longitude, geometry_type, geom, source_url, source_type,
   confidence_score, is_verified, is_approximate, notes)
select
  r->>'id', r->>'name_ar', r->>'name_en', r->>'category', r->>'type',
  r->>'country', r->>'region', r->>'city',
  (r->>'latitude')::float8, (r->>'longitude')::float8, r->>'geometry_type',
  ST_SetSRID(ST_GeomFromGeoJSON(r->'geometry_geojson'), 4326),
  r->>'source_url', r->>'source_type',
  (r->>'confidence_score')::numeric, (r->>'is_verified')::bool, (r->>'is_approximate')::bool,
  r->>'notes'
from jsonb_array_elements(:payload) as r
on conflict (id) do update set
  name_ar=excluded.name_ar, name_en=excluded.name_en, geom=excluded.geom,
  confidence_score=excluded.confidence_score, is_approximate=excluded.is_approximate, notes=excluded.notes;
```

The CSV is provided for spreadsheet/BI review; for DB import prefer the GeoJSON/JSON so geometry
parses natively. (In the CSV, `geometry_geojson` is an inline JSON string — usable but you'd parse
it per row.)

## 3. How the matching engine consumes it (deterministic, no LLM)

Given a project/listing point `p` (lon/lat), all questions become PostGIS predicates:

```sql
-- Nearest metro station + walking-ish distance
select name_ar, name_en,
       ST_Distance(geom::geography, ST_MakePoint($lon,$lat)::geography) as metres
from geo_anchors where type='metro_station'
order by geom <-> ST_MakePoint($lon,$lat)::geometry limit 1;

-- Is it within 1 km of any ring road? (corridor classification)
select exists(select 1 from geo_anchors
  where type='ring_road'
  and ST_DWithin(geom::geography, ST_MakePoint($lon,$lat)::geography, 1000));

-- Count malls / universities / hospitals within 3 km (amenity score)
select type, count(*) from geo_anchors
where type in ('mall','university','hospital')
and ST_DWithin(geom::geography, ST_MakePoint($lon,$lat)::geography, 3000)
group by type;

-- Polygon containment (inside KAFD / a campus / a park)
select name_en from geo_anchors
where geometry_type='polygon'
and ST_Contains(geom, ST_SetSRID(ST_MakePoint($lon,$lat),4326));
```

**Rules for trustworthy matching:**
- Filter on `is_approximate=false` (and/or `confidence_score >= 0.7`) for any *hard* eligibility
  rule. Use approximate rows only for soft/explanatory signals.
- `zones` (corridor_zone) are point centroids, **not** boundaries — never use `ST_Contains` on
  them. Use them only as labelled reference points, or replace them with real polygons (see the
  priority-review report; the Diplomatic Quarter has a real OSM boundary worth importing).
- Distances must use `::geography` (metres). Raw `geometry` distance is in degrees.

## 4. Provenance / licensing

All `source_type='openstreetmap'` rows derive from OpenStreetMap and are **© OpenStreetMap
contributors, ODbL**. Keep that attribution wherever the data is surfaced publicly. The
`manual_estimate` zone rows are internal planning references with no surveyed boundary.
