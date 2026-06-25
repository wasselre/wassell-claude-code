# Saudi Geography Layer + District Lookup Migration — Execution Report

**Date:** 2026-06-25 · **Target:** wassell-prod (`zhqqsxwealdwqzrbpwyv`) · **Status:** Data + engine shipped; map UI layer is the one documented follow-up.

## Source files used
`.claude/worktrees/objective-turing-410d0c/saudi-districts/output/` — `summary.json`, `saudi_city_districts.json` (3,732 rows), `saudi_districts.geojson` (3,732 features, 24 MB), plus the city-less / failed / missing-EN reports. Source: **SPL National Address** (open dataset homaily/Saudi-Arabia-Regions-Cities-and-Districts), extraction 2026-06-25.

## Validation gate (Gate 1) — all 28 checks passed
13 regions · 3,732 districts (3,732 distinct, 0 dups) · 152 cities-with-districts · every JSON row has all required fields + a KSA-bbox centroid · every GeoJSON feature has a district_id present in the JSON · coords in `[lng,lat]` order · exactly one boundary per district · 0 missing English names.

## What was imported
| Object | Count | Storage |
|---|---|---|
| Regions | 13 | records-model `regions` (Geography group) |
| Cities | 152 | records-model `cities` |
| Districts | 3,732 | records-model `districts` (expanded; SPL set) |
| District boundaries | 3,732 | **physical** `public.district_boundaries` (PostGIS `geometry`, GiST index) |
| District aliases | 10,597 | **physical** `public.district_aliases` |
| Import run | 1 | **physical** `public.geography_import_runs` |

PostGIS 3.3.7 enabled. 33 invalid boundary geometries were repaired with `ST_MakeValid` (0 invalid now). Boundaries are fetched on demand via `district_boundaries_for_city(city_id)` / `district_boundaries_in_bbox(...)` — deliberately NOT loaded into the SPA (would bloat `unified_records`).

## Existing 189 Riyadh districts — reconciled
All 189 legacy districts matched an SPL district by normalized Arabic name (0 unmatched). As safely-resolved duplicates they were **deleted** (backed up in `_backup_geo_20260625_records`; nothing referenced them). The SPL set is now the single district source.

## Models changed (fields ADDED; legacy preserved)
- **all_projects** (+7): `district_lookup`, `district_name`, `city_lookup`, `region_lookup`, `district_match_status`, `district_migration_notes`, `location_verified_at`.
- **clients** Client Preferences (+8): `preferred_districts` (multi), `preferred_regions`, `preferred_cities`, `location_priority`, `max_distance_km`, `preferred_location_notes`, migration status/notes.
- **units** (+2 mirrors): `project_district_lookup`, `project_district_name` (from project via `project_id`).
- **districts** (+17): SPL ids, display_name, city/region lookups + denormalized names, centroid_lat/lng, source, is_active, legacy_status, migration_notes; fixed the mislabeled `city` field (`label_en` "Region"→"City").
- **marketing_operations**: `mirror_district` repointed `preferred_neighborhoods` → `district_name`.
- **our_projects / followups / unanswered_requests / sales_valuation_reviews**: inherit the new fields automatically via their `field_mode:'all'` section-mirrors (no schema edit needed).
- View permission on regions/cities/districts granted to all 5 profiles.

## Project district backfill — 847 / 1,064 linked (polygon-first ladder)
| Method | Count |
|---|---|
| matched_by_polygon (PostGIS ST_Contains) | 567 |
| matched_by_normalized_name | 278 |
| matched_by_nearest_centroid (≤5 km) | 2 |
| **Linked total** | **847** |
| missing_coordinates (no coords + no legacy district) | 120 |
| needs_manual_review (legacy district, no SPL name match) | 83 |
| outside_known_boundary | 8 |
| ambiguous_match (name in multiple cities) | 6 |

Every project carries a `district_match_status`. **Review queue** = staging table `public._geo_proj_match` (query `WHERE method IN ('needs_manual_review','ambiguous_match','outside_known_boundary')`). Most unmatched are non-Riyadh or free-text legacy values; they keep matching on legacy text under dual-read.

## Client preference backfill — 7 / 17 linked
17 clients have legacy preferred neighborhoods; 7 got `preferred_districts` lookups, 16 flagged `needs_manual_review` (sparse/free-text values). Legacy preserved.

## Matching engine — lookup-first dual-read (`api/_lib/matchAgent.ts`)
- New `resolveRequestedDistrict()` resolves the requested district to the authoritative `districts` record (id + real centroid; city-aware).
- `scoreProject` location: a project whose `district_lookup` equals the resolved id is an **exact** match (relational); text fuzzy-match on `preferred_neighborhoods` is the **fallback**. Nearby tier now uses the district's authoritative centroid (falls back to the legacy averaged centroid when a district can't be resolved).
- New geo helpers in `src/lib/locationUtils.ts`: `pointInPolygon`, `pointInDistrict`, `distanceBetweenCentroids`, `haversineKm`, `normalizeArabicDistrictName`, `normalizeEnglishDistrictName`.
- **Live-verified:** requesting "النرجس" resolves to `حي النرجس - الرياض`; 121 projects link to it via `district_lookup` (→ exact); boundary RPC returns 189 Riyadh polygons.

## Code files changed
- `api/_lib/matchAgent.ts` (resolver + dual-read scoring) — typechecks clean.
- `src/lib/locationUtils.ts` (6 geo/normalize helpers).
- `src/lib/__tests__/districtGeo.test.ts` (new — 14 cases). Tests: **28 passed** (districtGeo + existing projectMatchScoring + sectionMirrorLocation).
- Migrations: `supabase/migrations/2026-06-25_geography_physical_tables.sql`, `2026-06-25_geography_models.sql`. Apply/import scripts: `scripts/geo-migration/01..05`.
- PRDs updated: `data-storage.md`, `record-management.md`, `project-matching-assistant.md`, `README.md`.

## Tests run
- `npx vitest run` on districtGeo + projectMatchScoring + sectionMirrorLocation → 28/28 pass.
- `tsc` on `matchAgent.ts` + `locationUtils.ts` → clean (other api/* errors are pre-existing in untouched files).
- Live SQL validation of the resolver→lookup→boundary chain on prod.

## Known limitations / follow-ups
1. **Map polygon UI layer not yet wired.** The data + on-demand RPCs are ready (`district_boundaries_for_city`, `district_boundaries_in_bbox`); `MapsView.tsx` still plots lat/lng pins only. Rendering district polygons by viewport/city is the remaining UI task.
2. **Cities:** only the 152 district-bearing cities imported; the 4,429 city-less cities are logged in `summary.json` only (no city records minted without districts).
3. **Manual review:** 83 needs-review + 6 ambiguous projects + 10 clients await human district assignment (queue in `_geo_proj_match`). They keep working on legacy text meanwhile.
4. **Engine cutover:** dual-read is live (lookup-primary, text-fallback). No hard cutover performed — legacy fields remain; flipping to lookup-only is a later, separate decision once review queue is cleared.

## Rollback
See `migration-backups/geography-migration-20260625/ROLLBACK.md`. Backups: `_backup_geo_20260625_models` / `_profiles` / `_records`. All changes additive; legacy fields intact; reverting the engine is a one-commit change.

## Audit artifacts kept (drop when confirmed unneeded)
`public._geo_proj_match` (backfill decisions / review queue), `public._geo_norm_ar(text)` (normalizer), `_backup_geo_20260625_*` (snapshots).
