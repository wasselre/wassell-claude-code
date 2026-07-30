# UAE administrative geography — build report

- Generated: 2026-07-30T12:53:16.167Z
- Source: OpenStreetMap via Overpass (© OpenStreetMap contributors, ODbL)
- **Regions (emirates): 7 · Cities: 152 · Districts: 1947 · Boundaries: 0**

## Per emirate

| code | emirate | cities | districts | with boundary |
|------|---------|-------:|----------:|--------------:|
| AUH | Abu Dhabi | 59 | 463 | 0 |
| DXB | Dubai | 6 | 1076 | 0 |
| SHJ | Sharjah | 21 | 216 | 0 |
| AJM | Ajman | 6 | 36 | 0 |
| UAQ | Umm al-Quwain | 2 | 36 | 0 |
| RAK | Ras al-Khaimah | 24 | 69 | 0 |
| FUJ | Fujairah | 34 | 51 | 0 |

## District sources

- `landuse`: 853
- `place`: 510
- `admin-8`: 310
- `admin-10`: 236
- `admin-11`: 29
- `admin-7`: 6
- `admin-9`: 3

## Derivations (not source data — verify these)

- City assignment (cap 60 km, same emirate): **1861** to the nearest `place=city`, **83** to the nearest town (no city in range), **3** fell back to the emirate's principal city.
- Dropped **1043** candidates whose centroid fell outside every emirate polygon (bbox spill into Oman/Saudi).
- Dropped **99** district candidates whose name matches a city in the same emirate.
- Dropped **8** OSM mapping artifacts (leading plot numbers, "under construction", building counts).
- Merged **701** duplicate district candidates (same emirate + normalized name).
- Districts with no polygon: **1947** (point-only in OSM, or geometry not yet fetched).

## Warnings

- none

## Names missing a language

- No Arabic name: 761 districts, 2 cities
- No English name: 19 districts, 2 cities
