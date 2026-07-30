# UAE administrative geography — build report

- Generated: 2026-07-30T17:24:18.982Z
- Source: OpenStreetMap via Overpass (© OpenStreetMap contributors, ODbL)
- **Regions (emirates): 7 · Cities: 38 · Districts: 1410 · Boundaries: 1114**

## Per emirate

| code | emirate | cities | districts | with boundary |
|------|---------|-------:|----------:|--------------:|
| AUH | Abu Dhabi | 16 | 397 | 323 |
| DXB | Dubai | 3 | 640 | 518 |
| SHJ | Sharjah | 7 | 211 | 159 |
| AJM | Ajman | 2 | 30 | 24 |
| UAQ | Umm al-Quwain | 1 | 33 | 31 |
| RAK | Ras al-Khaimah | 4 | 60 | 51 |
| FUJ | Fujairah | 5 | 39 | 8 |

## District sources

- `place`: 510
- `landuse`: 316
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
- Pruned **114** cities that hold no district and carry no `place=city` tag — OSM tags UAE hamlets as towns, and they would be dead ends in the cascade's city step.
- Merged **701** duplicate district candidates (same emirate + normalized name).
- Districts with no polygon: **296** (point-only in OSM, or geometry not yet fetched).

## Warnings

- none

## Names missing a language

- No Arabic name: 279 districts, 0 cities
- No English name: 9 districts, 0 cities
