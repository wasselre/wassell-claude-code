# UAE Geography Dataset

The UAE counterpart to `data/source/geo/` (Riyadh) and the SPL-derived Saudi layer:
**administrative geography** (emirates → cities → districts, with PostGIS boundaries and
matcher aliases) plus the **geo-intelligence anchors** the deterministic matching engine
measures distance and containment against.

Source: **OpenStreetMap via the Overpass API** — © OpenStreetMap contributors, **ODbL**.
Retain that attribution on any public surface.

## Why OSM and not an official register

The Saudi layer came from the SPL National Address dataset, which handed us
`region_id` / `city_id` / `district_id` on every row — the tiering was given. There is no
equivalent open, bilingual, boundary-carrying register for the UAE, so OSM is the source
and **the tiering is derived here**. Every derivation is written to `report-admin.md`
rather than silently trusted, because a district attached to the wrong city disappears
from the app's location cascade (the district list is filtered by `city_lookup`).

## The pipeline

```bash
node data/source/geo-uae/fetch.mjs emirates    # pass 0 — emirate + country polygons
node data/source/geo-uae/fetch.mjs survey      # pass A — tags + centroids (bbox-scoped)
node data/source/geo-uae/verify.mjs            # acceptance test — run before importing
node data/source/geo-uae/process-admin.mjs     # classify → writes geometry-plan.json
node data/source/geo-uae/process-anchors.mjs   # classify → appends to geometry-plan.json
node data/source/geo-uae/fetch.mjs geometry    # pass B — real geometry, by id
node data/source/geo-uae/process-admin.mjs     # re-run: attaches boundaries
node data/source/geo-uae/process-anchors.mjs   # re-run: attaches geometry
```

Then import (see `scripts/geo-uae/import-uae-geography.mjs` and
`scripts/import-geo-intelligence.mjs`).

Everything is **cached and resumable**: raw Overpass responses land in `raw/` (gitignored
— reproducible and large), and the process scripts read *only* from `raw/`, never the
network. Re-running is idempotent.

### Why three passes

The public Overpass instances shaped this more than anything else:

| Approach | Result |
|---|---|
| `area(3600307763)` (the UAE country relation) | ~90–375s **per query** — Overpass recurses the whole country relation |
| country-wide `out geom;` | reliably 504s — UAE coastlines and island polygons are enormous |
| 24 small bbox queries | ~2.5 hours of wall clock, mostly per-request overhead |
| **6 fat bbox queries, `out tags center;`** | minutes — and the region/city tiers need no geometry at all |
| **`out geom;` by explicit id, chunked** | never times out |

So: pass 0 fetches the 7 emirate polygons plus the country polygon by id; pass A surveys
tags + centroids over a bounding box in a handful of grouped queries; pass B fetches real
geometry for exactly the ids that need it, from `geometry-plan.json`.

Group boundaries are chosen by **request weight, not meaning** — `process-anchors.mjs`
assigns each element's category from its own tags, so regrouping the queries never
changes the output. That's how the fattest group could be split three ways after it
exhausted all 8 retries on every mirror.

## Rejecting what isn't the UAE

Because pass A is bbox-scoped, it drags in Oman, Saudi Arabia and Qatar — 1,043 candidates
in the admin run alone. Three attempts at filtering, and the first two were wrong:

1. **bbox distance to the nearest emirate** — filed **Al Buraimi, Oman** under Abu Dhabi
   at 0.00 km, because it sits in the concave notch of Abu Dhabi's bounding box beside
   Al Ain.
2. **true polygon distance with a 3 km grace** for coastal reclamation — still claimed
   Al Buraimi, measured **2.32 km** from Abu Dhabi's edge, closer than some legitimate
   offshore land. That grace cannot be made safe: a foreign border town and reclaimed
   land are geometrically indistinguishable.
3. **the UAE national boundary as the only gate** — a point outside an emirate but inside
   the country is an inter-emirate tracing seam (keep it, assign the nearest emirate);
   outside the country it is rejected, full stop.

Nothing real is lost: Palm Jumeirah, Palm Jebel Ali, Yas, Saadiyat, Al Reem and Sir Bani
Yas all fall **inside** their emirate polygon in OSM's tracing. `verify.mjs` asserts that,
plus Dubai's Hatta enclave, Sharjah's Kalba/Khor Fakkan exclaves, all 7 capitals, and
rejection of Muscat, Sohar, Al Buraimi, Omani Musandam, Riyadh and Doha.

## Administrative tiers, as derived

Surveyed live 2026-07-30 — admin levels vary by emirate:

| level | what it is |
|------:|---|
| 4 | the 7 emirates → **regions** |
| 5 / 6 | Abu Dhabi's city region and its three regions (Abu Dhabi, Al Ain, Al Dhafra) |
| 7 | Dubai's rural sectors |
| 8 | the community/sector tier — the bulk of the district tier |
| 9 | unused in the UAE |
| 10 / 11 | sub-communities and named villages inside a community |

**Cities** are the named settlements (`place=city` / `place=town`). **Districts** come from
admin levels 7/8/10 plus `place=suburb|neighbourhood|quarter` (Dubai "communities", often
mapped without any administrative relation) plus named `landuse=residential` polygons —
which supply a real boundary where a community exists only as a point, and which turn out
to be the single largest source.

Two derivations to be aware of, both reported per-run:

- **City assignment**: the nearest `place=city` in the same emirate within 60 km wins;
  otherwise the nearest town; otherwise the emirate's principal city. A `place=city`
  *outranks a nearer town* deliberately — OSM tags dozens of UAE hamlets as towns, and
  pure proximity made «Qaraytaysah», a hamlet in southern Dubai, the parent of Dubai
  South, Emaar South Golf District and Urbana I–III.
- **Name filtering**: `landuse=residential` also carries plot numbers and site
  descriptions («410 VILLA COMPOUND UNDER CONSTRUCTION», «16 buildings», «52 | 42 Tower»).
  Filtered on a *leading* digit, a short descriptor blocklist, and any pipe character.
  Trailing digits are legitimate and untouched — «Al Barsha 1», «Urbana III».

## Files

| File | What it is |
|---|---|
| `fetch.mjs` | The three fetch passes. Cached, resumable, mirror-rotating. |
| `process-admin.mjs` | Region/city/district classification → `uae-geography.json` + boundaries |
| `process-anchors.mjs` | Anchor classification → `uae-geo-intelligence.{json,geojson,csv}` |
| `verify.mjs` | Acceptance test for emirate assignment. Exits non-zero on failure. |
| `lib/overpass.mjs` | Overpass client + OSM→GeoJSON ring assembly |
| `lib/classify.mjs` | Name normalization, containment, tier heuristics |
| `lib/emirates.mjs` | The 7 emirate OSM relation ids and our `AUH`/`DXB`/… codes |
| `uae-geography.json` | regions + cities + districts, with provenance per row |
| `uae-district-boundaries.geojson` | District polygons, keyed by our external id |
| `uae-geo-intelligence.{json,geojson,csv}` | Anchors, in the **same 18-field schema as the Riyadh dataset** |
| `report-admin.md` / `report-anchors.md` | Per-run counts, derivations and warnings |
| `raw/` | Cached Overpass responses (gitignored) |

`verify.mjs` is a script rather than a vitest suite on purpose: it asserts against the
real cached boundaries in `raw/`, which are gitignored. A unit test would need simplified
fixtures and would then be testing the fixtures instead of the data we ship.

## Identifiers

Ours, not OSM's — so they stay stable if OSM renumbers, and can never collide with
Saudi's numeric SPL ids:

- regions `AE-DXB` · cities `AE-DXB-C0001` · districts `AE-DXB-D0001`
- anchors `DXB-MALL-0001` — the same shape as Riyadh's `RUH-BUSI-0658`, because
  **element rules reference this handle, not the row uuid**

Row UUIDs are md5-derived from the namespaced external id (`geo-district:AE-DXB-D0001`),
so a re-import upserts the same rows instead of duplicating them.

## Anchor categories

Riyadh's 13, plus exactly one addition — **`islands`**, because in the UAE the
master-planned islands (Palm Jumeirah, Yas, Saadiyat, Al Reem, Al Maryah) are primary
real-estate anchors rather than scenery. Free zones fold into `business_zones` with
`type='free_zone'` instead of earning a category, so the admin map's colour legend keeps
working.

`secondary` roads are excluded. Over the UAE bbox, motorway + trunk + primary is 14,168
ways carrying 452 distinct road names — the same order as Riyadh's 191 road anchors —
while `secondary` alone adds 9,424 ways for anchors nobody describes a property by.
Riyadh drew the line in the same place.

## Known limits

- **Arabic coverage is incomplete.** A substantial share of districts have no `name:ar` in
  OSM; `display_name` falls back to English. That is a source limitation, recorded in
  `report-admin.md` rather than papered over — machine-translating place names would
  invent authority the data doesn't have.
- **Point-only communities.** A district mapped as an OSM node keeps its exact centroid
  and gets no boundary. The app already handles this (the Saudi layer has 3,733 boundaries
  for 3,734 districts).
- **Roads merged by name** across more than 8 segments are flagged `is_approximate`: the
  merge may join disjoint stretches that happen to share a name. Same rule as Riyadh.
- **`zones` are not boundaries** in the Riyadh dataset and the same caution applies to any
  approximate anchor here — check `is_approximate` before using one in a containment rule.
