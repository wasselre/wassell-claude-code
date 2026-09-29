-- Tracked links: units (2026-09-29, same day as the base migration).
--
-- Operator: "Even for project units, instead of sending PDFs, we want to send
-- links… a new link called Project Units that only shows the project units…
-- The same thing for units: links per unit… a detailed page link with the unit
-- details. Again, we track everything they do on that page."
--
--   /v/<token>/units — the project's units only (name + main image + the list);
--                      each unit the customer opens is recorded (unit_open).
--   /v/<token>       — a UNIT link (tracked_links.unit_id set): that unit's page.
-- Opening a unit is the strongest interest signal we have, so it now counts in
-- the score. The score function gains two inputs (DROP + CREATE; the views are
-- recreated with it, still security_invoker, asserted).

ALTER TABLE public.tracked_links ADD COLUMN IF NOT EXISTS unit_id uuid;
CREATE INDEX IF NOT EXISTS tracked_links_unit_idx ON public.tracked_links (unit_id) WHERE unit_id IS NOT NULL;

ALTER TABLE public.tracked_link_events DROP CONSTRAINT IF EXISTS tracked_link_events_kind_check;
ALTER TABLE public.tracked_link_events ADD CONSTRAINT tracked_link_events_kind_check
  CHECK (kind IN ('view', 'photo_open', 'video_play', 'video_progress', 'time', 'brochure_page', 'map_open', 'unit_open'));
ALTER TABLE public.tracked_link_events DROP CONSTRAINT IF EXISTS tracked_link_events_section_check;
ALTER TABLE public.tracked_link_events ADD CONSTRAINT tracked_link_events_section_check
  CHECK (section IN ('photos', 'videos', 'brochure', 'location', 'units', 'unit'));

DROP VIEW IF EXISTS public.v_project_interest;
DROP VIEW IF EXISTS public.v_tracked_link_engagement;
DROP FUNCTION IF EXISTS public.tracked_interest_score(int, int, int, numeric, numeric, int, boolean, int, numeric);

-- Interest score 0–100. Every part is capped so no single behaviour dominates:
--   opened at all 10 · photos 2 each up to 14 · videos 5 each up to 10, +10 for
--   one watched to ≥75% · brochure 1 per 6 s up to 10, +1 per page up to 5 ·
--   units opened 4 each up to 16, +1 per 20 s on units up to 5 · the map tap 10
--   · back on another day 5 each up to 10 · time on photos/videos 1 per 30 s up to 5.
CREATE OR REPLACE FUNCTION public.tracked_interest_score(
  p_sessions int, p_photos int, p_videos int, p_max_video_pct numeric,
  p_brochure_seconds numeric, p_brochure_pages int, p_map boolean, p_open_days int, p_media_seconds numeric,
  p_units int, p_units_seconds numeric
) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT LEAST(100,
      (CASE WHEN coalesce(p_sessions, 0) > 0 THEN 10 ELSE 0 END)
    + LEAST(coalesce(p_photos, 0), 7) * 2
    + LEAST(coalesce(p_videos, 0), 2) * 5 + (CASE WHEN coalesce(p_max_video_pct, 0) >= 75 THEN 10 ELSE 0 END)
    + LEAST(floor(coalesce(p_brochure_seconds, 0) / 6), 10)::int + LEAST(coalesce(p_brochure_pages, 0), 5)
    + LEAST(coalesce(p_units, 0), 4) * 4 + LEAST(floor(coalesce(p_units_seconds, 0) / 20), 5)::int
    + (CASE WHEN coalesce(p_map, false) THEN 10 ELSE 0 END)
    + LEAST(GREATEST(coalesce(p_open_days, 0) - 1, 0), 2) * 5
    + LEAST(floor(coalesce(p_media_seconds, 0) / 30), 5)::int
  )::int
$$;

CREATE VIEW public.v_tracked_link_engagement WITH (security_invoker = true) AS
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
    array_remove(array_agg(DISTINCT e.section) FILTER (WHERE e.kind = 'view'), NULL)         AS sections_opened
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
    a.units_opened::int, a.units_seconds) AS score
FROM public.tracked_links l
LEFT JOIN agg a ON a.link_id = l.id;

CREATE VIEW public.v_project_interest WITH (security_invoker = true) AS
WITH agg AS (
  SELECT
    l.chat_wid, l.project_id,
    (array_agg(l.client_id ORDER BY l.created_at DESC) FILTER (WHERE l.client_id IS NOT NULL))[1] AS client_id,
    (array_agg(l.conversation_record_id ORDER BY l.created_at DESC))[1]                            AS conversation_record_id,
    count(DISTINCT l.id)                                                                     AS messages,
    max(l.created_at)                                                                        AS last_sent_at,
    count(DISTINCT e.session_id) FILTER (WHERE e.kind = 'view')                              AS sessions,
    count(DISTINCT (e.created_at AT TIME ZONE 'Asia/Riyadh')::date) FILTER (WHERE e.kind = 'view') AS open_days,
    max(e.created_at)                                                                        AS last_activity_at,
    count(DISTINCT e.item) FILTER (WHERE e.kind = 'photo_open')                              AS photos_opened,
    count(DISTINCT e.item) FILTER (WHERE e.kind IN ('video_play', 'video_progress'))         AS videos_played,
    coalesce(max(e.value) FILTER (WHERE e.kind = 'video_progress'), 0)                       AS max_video_pct,
    coalesce(sum(e.value) FILTER (WHERE e.kind = 'time' AND e.section IN ('photos', 'videos')), 0) AS media_seconds,
    coalesce(sum(e.value) FILTER (WHERE e.kind = 'time' AND e.section = 'brochure'), 0)      AS brochure_seconds,
    coalesce(sum(e.value) FILTER (WHERE e.kind = 'time' AND e.section IN ('units', 'unit')), 0) AS units_seconds,
    count(DISTINCT e.item) FILTER (WHERE e.kind = 'brochure_page')                           AS brochure_pages,
    count(DISTINCT e.item) FILTER (WHERE e.kind = 'unit_open')                               AS units_opened,
    coalesce(bool_or(e.kind = 'map_open'), false)                                            AS opened_map
  FROM public.tracked_links l
  LEFT JOIN public.tracked_link_events e ON e.link_id = l.id
  WHERE l.chat_wid IS NOT NULL
  GROUP BY l.chat_wid, l.project_id
)
SELECT agg.*,
  public.tracked_interest_score(sessions::int, photos_opened::int, videos_played::int, max_video_pct,
    brochure_seconds, brochure_pages::int, opened_map, open_days::int, media_seconds,
    units_opened::int, units_seconds) AS score
FROM agg;

REVOKE ALL ON public.v_tracked_link_engagement, public.v_project_interest FROM anon;
GRANT SELECT ON public.v_tracked_link_engagement, public.v_project_interest TO authenticated;

DO $assert$
DECLARE v text[]; n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['v_tracked_link_engagement', 'v_project_interest'] LOOP
    SELECT c.reloptions INTO v FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public' AND c.relname = n;
    IF v IS NULL OR NOT ('security_invoker=true' = ANY(v)) THEN
      RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST % — %', n, v;
    END IF;
  END LOOP;
END $assert$;
