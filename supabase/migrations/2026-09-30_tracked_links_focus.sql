-- Tracked links: say WHAT each link was — a project message, a units list, or
-- a single unit — so the per customer × project interest can show how its
-- total was made up. The score already sums every link of the project
-- (verified 2026-09-30); this only makes the mix visible.
-- Backward compatible: a defaulted column + three appended view columns.

ALTER TABLE public.tracked_links
  ADD COLUMN IF NOT EXISTS focus text NOT NULL DEFAULT 'project'
  CHECK (focus IN ('project', 'units', 'unit'));
UPDATE public.tracked_links SET focus = 'unit' WHERE unit_id IS NOT NULL AND focus <> 'unit';

-- CREATE OR REPLACE VIEW replaces reloptions: security_invoker is re-asserted below.
CREATE OR REPLACE VIEW public.v_project_interest WITH (security_invoker = true) AS
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
    coalesce(bool_or(e.kind = 'map_open'), false)                                            AS opened_map,
    count(DISTINCT l.id) FILTER (WHERE l.focus = 'project')                                  AS project_messages,
    count(DISTINCT l.id) FILTER (WHERE l.focus = 'units')                                    AS units_links,
    count(DISTINCT l.id) FILTER (WHERE l.focus = 'unit')                                     AS unit_links
  FROM public.tracked_links l
  LEFT JOIN public.tracked_link_events e ON e.link_id = l.id
  WHERE l.chat_wid IS NOT NULL
  GROUP BY l.chat_wid, l.project_id
)
SELECT chat_wid, project_id, client_id, conversation_record_id, messages, last_sent_at, sessions, open_days, last_activity_at, photos_opened, videos_played, max_video_pct, media_seconds, brochure_seconds, units_seconds, brochure_pages, units_opened, opened_map,
  public.tracked_interest_score(sessions::int, photos_opened::int, videos_played::int, max_video_pct,
    brochure_seconds, brochure_pages::int, opened_map, open_days::int, media_seconds,
    units_opened::int, units_seconds) AS score,
  project_messages, units_links, unit_links
FROM agg;

ALTER VIEW public.v_project_interest SET (security_invoker = true);
REVOKE ALL ON public.v_project_interest FROM anon;
GRANT SELECT ON public.v_project_interest TO authenticated;

DO $assert$
DECLARE v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_project_interest';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST v_project_interest — options are %', v_opts;
  END IF;
END $assert$;
