# UAE administrative geography — build report

- Generated: 2026-07-30T16:00:59.821Z
- Source: OpenStreetMap via Overpass (© OpenStreetMap contributors, ODbL)
- **Regions (emirates): 7 · Cities: 38 · Districts: 1947 · Boundaries: 1651**

## Per emirate

| code | emirate | cities | districts | with boundary |
|------|---------|-------:|----------:|--------------:|
| AUH | Abu Dhabi | 16 | 463 | 389 |
| DXB | Dubai | 3 | 1076 | 954 |
| SHJ | Sharjah | 7 | 216 | 164 |
| AJM | Ajman | 2 | 36 | 30 |
| UAQ | Umm al-Quwain | 1 | 36 | 34 |
| RAK | Ras al-Khaimah | 4 | 69 | 60 |
| FUJ | Fujairah | 5 | 51 | 20 |

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
- Pruned **114** cities that hold no district and carry no `place=city` tag — OSM tags UAE hamlets as towns, and they would be dead ends in the cascade's city step.
- Merged **701** duplicate district candidates (same emirate + normalized name).
- Districts with no polygon: **296** (point-only in OSM, or geometry not yet fetched).

## Warnings

- none

## Names missing a language

- No Arabic name: 761 districts, 0 cities
- No English name: 19 districts, 0 cities
