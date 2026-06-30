-- wassell_geo_match silently timed out for authenticated users → geo gate never applied.
--
-- SYMPTOM (live, 2026-06-30): a client whose only location preference was a geo-element
-- rule ("شمال طريق الملك سلمان" / "داخل النخيل مول") saw NO geo gate — /api/project-finder
-- returned geo_filter:null and market fell back to needs_district, so the element never
-- narrowed anything (the rep's whole point).
--
-- ROOT CAUSE: wassell_geo_match scans ALL ~46.6k project_points + listing_points with a
-- per-row geometry predicate (wassell_geo_region_contains → halfplane test for direction
-- items, ST_Contains for polygon items). Measured 7.05s (EXPLAIN ANALYZE) for a
-- Riyadh-wide rule. The `authenticated` role's statement_timeout is 8s, so the call
-- intermittently TIMED OUT; the endpoint's catch left geoMatchIds null (geo_filter null).
-- Service-role (no timeout) always succeeded, which is why it looked fine in SQL.
--
-- FIX: wassell_geo_match / wassell_compile_client_geo are SECURITY DEFINER, so a
-- function-level statement_timeout overrides the caller's 8s session value for the call's
-- duration. Set 20s — comfortably above the 7s scan, far below the Edge finder's
-- wall-clock ceiling. Verified live after: geo_filter applied, the element-only client
-- now sees 489 market listings in-area (was 0). Applied to prod 2026-06-30.
--
-- FOLLOW-UP (perf): polygon/buffer items (within_radius / inside_area / district, geom
-- NOT NULL) CAN use the GiST index on the candidate points if geo_match is restructured
-- as a spatial JOIN (inc-driver, ST_Contains index lookup) — sub-second. Direction
-- (halfplane, geom NULL) items stay a scan unless compile clips them to the region
-- polygon to produce a bounded geom. Both are deferred; this timeout makes the feature
-- correct + reliable now.

alter function public.wassell_geo_match(uuid) set statement_timeout = '20s';
alter function public.wassell_compile_client_geo(uuid) set statement_timeout = '20s';
