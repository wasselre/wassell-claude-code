-- Stronger Wassel-branded map palette + kill ALL Google basemap text.
--
-- The branded theme + label suppression now live entirely in
-- src/lib/locationUtils.ts (WASSEL_MAP_STYLE = geometry only; GEO_LABEL_SUPPRESSION
-- = global label-off). The only DB-side leftover was the `all_projects` model's
-- stored copy of the OLD palette in maps_config.map_style_json, set before the code
-- default existed. While present it overrides the code palette (resolveMapStyles
-- prefers a stored style), so the All Projects map would keep the old, weaker look.
--
-- Drop just that one key. resolveMapStyles(null) then falls back to the code
-- WASSEL_MAP_STYLE, making the code the single source of truth for every map.
-- All other maps_config keys (location fields, pin config, center/zoom) are kept.

UPDATE public.models
SET maps_config = maps_config - 'map_style_json'
WHERE name = 'all_projects'
  AND maps_config ? 'map_style_json';
