-- Tracked links: record the filters a customer applies on the units page
-- ('units_filter' — item = "type=…;bed=…;max=…"), and expose the latest one
-- per message so the rep sees what the customer narrowed to.
-- Backward compatible: only widens a CHECK and appends a view column.

ALTER TABLE public.tracked_link_events DROP CONSTRAINT IF EXISTS tracked_link_events_kind_check;
ALTER TABLE public.tracked_link_events ADD CONSTRAINT tracked_link_events_kind_check
  CHECK (kind IN ('view', 'photo_open', 'video_play', 'video_progress', 'time', 'brochure_page', 'map_open', 'unit_open', 'units_filter'));

-- CREATE OR REPLACE VIEW replaces reloptions: security_invoker is re-asserted below.
CREATE OR REPLACE VIEW public.v_tracked_link_engagement WITH (security_invoker = true) AS
WITH agg AS (
  SELECT
    e.link_id,
    count(DISTINCT e.session_id) FILTER (WHERE e.kind = 'view')                              AS sessions,
    count(DISTINCT (e.created_at AT TIME ZONE 'Asia/Riyadh')::date) FILTER (WHERE e.kind = 'view') AS open_days,
    min(e.created_at)                                                                        AS first_open_at,
    max(e.created_at)                                                                        AS last_activity_at,
    count(DISTINCT e.item) FILTER (WHERE e.kind = 'photo_open')                              AS photos_opened,
    count(DISTINCT e.item) FILTER (WHERE e.kind IN ('video_play', 'video_progress'))         AS videos_played,
    coalesce(max(e.value) FILTER (WHERE e.kind = 'video_progress'), 0)                       AS max_video_pct,
    coalesce(sum(e.value) FILTER (WHERE e.kind = 'time' AND e.section = 'photos'), 0)        AS photos_seconds,
    coalesce(sum(e.value) FILTER (WHERE e.kind = 'time' AND e.section = 'videos'), 0)        AS videos_seconds,
    coalesce(sum(e.value) FILTER (WHERE e.kind = 'time' AND e.section = 'brochure'), 0)      AS brochure_seconds,
    coalesce(sum(e.value) FILTER (WHERE e.kind = 'time' AND e.section IN ('units', 'unit')), 0) AS units_seconds,
    count(DISTINCT e.item) FILTER (WHERE e.kind = 'brochure_page')                           AS brochure_pages,
    count(DISTINCT e.item) FILTER (WHERE e.kind = 'unit_open')                               AS units_opened,
    array_remove(array_agg(DISTINCT e.item) FILTER (WHERE e.kind = 'unit_open'), NULL)       AS unit_ids_opened,
    bool_or(e.kind = 'map_open')                                                             AS opened_map,
    array_remove(array_agg(DISTINCT e.section) FILTER (WHERE e.kind = 'view'), NULL)         AS sections_opened,
    (array_agg(e.item ORDER BY e.created_at DESC) FILTER (WHERE e.kind = 'units_filter' AND e.item IS NOT NULL))[1] AS last_units_filter
  FROM public.tracked_link_events e
  GROUP BY e.link_id
)
SELECT
  l.id AS link_id, l.token, l.project_id, l.unit_id, l.chat_wid, l.conversation_record_id, l.client_id,
  l.sent_via, l.sections, l.created_at,
  coalesce(a.sessions, 0) AS sessions, coalesce(a.open_days, 0) AS open_days,
  a.first_open_at, a.last_activity_at,
  coalesce(a.photos_opened, 0) AS photos_opened, coalesce(a.videos_played, 0) AS videos_played,
  coalesce(a.max_video_pct, 0) AS max_video_pct,
  coalesce(a.photos_seconds, 0) AS photos_seconds, coalesce(a.videos_seconds, 0) AS videos_seconds,
  coalesce(a.brochure_seconds, 0) AS brochure_seconds, coalesce(a.brochure_pages, 0) AS brochure_pages,
  coalesce(a.units_seconds, 0) AS units_seconds, coalesce(a.units_opened, 0) AS units_opened,
  coalesce(a.unit_ids_opened, '{}') AS unit_ids_opened,
  coalesce(a.opened_map, false) AS opened_map, coalesce(a.sections_opened, '{}') AS sections_opened,
  public.tracked_interest_score(a.sessions::int, a.photos_opened::int, a.videos_played::int, a.max_video_pct,
    a.brochure_seconds, a.brochure_pages::int, a.opened_map, a.open_days::int, a.photos_seconds + a.videos_seconds,
    a.units_opened::int, a.units_seconds) AS score,
  a.last_units_filter
FROM public.tracked_links l
LEFT JOIN agg a ON a.link_id = l.id;

ALTER VIEW public.v_tracked_link_engagement SET (security_invoker = true);
REVOKE ALL ON public.v_tracked_link_engagement FROM anon;
GRANT SELECT ON public.v_tracked_link_engagement TO authenticated;

DO $assert$
DECLARE v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_tracked_link_engagement';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST v_tracked_link_engagement — options are %', v_opts;
  END IF;
END $assert$;
