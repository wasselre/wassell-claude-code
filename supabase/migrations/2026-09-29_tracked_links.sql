-- Tracked project links (2026-09-29).
--
-- Instead of uploading photos / videos / the brochure into WhatsApp, a project
-- message carries per-customer links to our own light page:
--   app.wassel.re/v/<token>/photos | /videos | /brochure | /location
-- One token per SENT MESSAGE (a customer who gets the same project twice, on
-- different days, has two tokens — each message's engagement is separate). The
-- page reports what the customer does (opens, photos, videos watched and how
-- far, seconds on each section, brochure pages, the map tap); the CRM reads it
-- back as engagement per message and an interest score per customer × project.
--
-- Operator decisions: links live on app.wassel.re; a message = card + one cover
-- photo + the links; applies to every project message (agent, bot, reps, bulk).
--
-- Privacy posture: no IP address and no raw user-agent is stored. Events come
-- only from the page's own script — a link-preview crawler (WhatsApp fetches
-- the URL to draw the preview) runs no script and records nothing.
--
-- Writes: service role only (the public endpoint validates the token). Reads:
-- whoever may see the chat (same rule as chat_messages).

CREATE TABLE IF NOT EXISTS public.tracked_links (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token                   text NOT NULL UNIQUE,
  project_id              uuid NOT NULL,                -- all_projects master
  chat_wid                text,
  conversation_record_id  uuid,                         -- the chats record (for RLS)
  client_id               uuid,
  device_id               text,
  sent_via                text NOT NULL DEFAULT 'rep' CHECK (sent_via IN ('agent', 'bot', 'rep', 'bulk', 'broker', 'other')),
  sections                text[] NOT NULL DEFAULT '{}', -- the links offered in the message
  created_by_user_id      uuid,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracked_links_chat_idx ON public.tracked_links (chat_wid, created_at DESC);
CREATE INDEX IF NOT EXISTS tracked_links_project_idx ON public.tracked_links (project_id);
CREATE INDEX IF NOT EXISTS tracked_links_client_idx ON public.tracked_links (client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.tracked_link_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_id     uuid NOT NULL REFERENCES public.tracked_links(id) ON DELETE CASCADE,
  session_id  text NOT NULL,          -- one page load (random, client-made)
  kind        text NOT NULL CHECK (kind IN ('view', 'photo_open', 'video_play', 'video_progress', 'time', 'brochure_page', 'map_open')),
  section     text CHECK (section IN ('photos', 'videos', 'brochure', 'location')),
  item        text,                   -- file id / page number
  value       numeric,                -- seconds (time) or percent (video_progress)
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tracked_link_events_link_idx ON public.tracked_link_events (link_id, created_at);

ALTER TABLE public.tracked_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracked_link_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tracked_links_select ON public.tracked_links;
CREATE POLICY tracked_links_select ON public.tracked_links FOR SELECT TO authenticated USING (
  CASE wassell_chat_scope_class()
    WHEN 'all' THEN true
    WHEN 'none' THEN false
    ELSE EXISTS (SELECT 1 FROM public.records r WHERE r.id = tracked_links.conversation_record_id)
  END
);
DROP POLICY IF EXISTS tracked_link_events_select ON public.tracked_link_events;
CREATE POLICY tracked_link_events_select ON public.tracked_link_events FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.tracked_links l WHERE l.id = tracked_link_events.link_id)
);
REVOKE INSERT, UPDATE, DELETE ON public.tracked_links, public.tracked_link_events FROM anon, authenticated;
REVOKE ALL ON public.tracked_links, public.tracked_link_events FROM anon;

-- The interest score (0–100), ONE definition used by every view. Each part is
-- capped so no single behaviour dominates:
--   opened at all 10 · photos 2 each up to 20 · videos 5 each up to 10, +10 for
--   watching one to ≥75% · brochure 1 per 6 s up to 15, +1 per page up to 5 ·
--   the map tap 15 · coming back on another day 5 each up to 10 · time on
--   photos/videos 1 per 30 s up to 5.
CREATE OR REPLACE FUNCTION public.tracked_interest_score(
  p_sessions int, p_photos int, p_videos int, p_max_video_pct numeric,
  p_brochure_seconds numeric, p_brochure_pages int, p_map boolean, p_open_days int, p_media_seconds numeric
) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT LEAST(100,
      (CASE WHEN coalesce(p_sessions, 0) > 0 THEN 10 ELSE 0 END)
    + LEAST(coalesce(p_photos, 0), 10) * 2
    + LEAST(coalesce(p_videos, 0), 2) * 5 + (CASE WHEN coalesce(p_max_video_pct, 0) >= 75 THEN 10 ELSE 0 END)
    + LEAST(floor(coalesce(p_brochure_seconds, 0) / 6), 15)::int + LEAST(coalesce(p_brochure_pages, 0), 5)
    + (CASE WHEN coalesce(p_map, false) THEN 15 ELSE 0 END)
    + LEAST(GREATEST(coalesce(p_open_days, 0) - 1, 0), 2) * 5
    + LEAST(floor(coalesce(p_media_seconds, 0) / 30), 5)::int
  )::int
$$;

-- Engagement per SENT MESSAGE (one tracked link).
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
    count(DISTINCT e.item) FILTER (WHERE e.kind = 'brochure_page')                           AS brochure_pages,
    bool_or(e.kind = 'map_open')                                                             AS opened_map,
    array_remove(array_agg(DISTINCT e.section) FILTER (WHERE e.kind = 'view'), NULL)         AS sections_opened
  FROM public.tracked_link_events e
  GROUP BY e.link_id
)
SELECT
  l.id AS link_id, l.token, l.project_id, l.chat_wid, l.conversation_record_id, l.client_id,
  l.sent_via, l.sections, l.created_at,
  coalesce(a.sessions, 0) AS sessions, coalesce(a.open_days, 0) AS open_days,
  a.first_open_at, a.last_activity_at,
  coalesce(a.photos_opened, 0) AS photos_opened, coalesce(a.videos_played, 0) AS videos_played,
  coalesce(a.max_video_pct, 0) AS max_video_pct,
  coalesce(a.photos_seconds, 0) AS photos_seconds, coalesce(a.videos_seconds, 0) AS videos_seconds,
  coalesce(a.brochure_seconds, 0) AS brochure_seconds, coalesce(a.brochure_pages, 0) AS brochure_pages,
  coalesce(a.opened_map, false) AS opened_map, coalesce(a.sections_opened, '{}') AS sections_opened,
  public.tracked_interest_score(a.sessions::int, a.photos_opened::int, a.videos_played::int, a.max_video_pct,
    a.brochure_seconds, a.brochure_pages::int, a.opened_map, a.open_days::int, a.photos_seconds + a.videos_seconds) AS score
FROM public.tracked_links l
LEFT JOIN agg a ON a.link_id = l.id;

-- Interest per CUSTOMER × PROJECT, across every message about that project.
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
    count(DISTINCT e.item) FILTER (WHERE e.kind = 'brochure_page')                           AS brochure_pages,
    coalesce(bool_or(e.kind = 'map_open'), false)                                            AS opened_map
  FROM public.tracked_links l
  LEFT JOIN public.tracked_link_events e ON e.link_id = l.id
  WHERE l.chat_wid IS NOT NULL
  GROUP BY l.chat_wid, l.project_id
)
SELECT agg.*,
  public.tracked_interest_score(sessions::int, photos_opened::int, videos_played::int, max_video_pct,
    brochure_seconds, brochure_pages::int, opened_map, open_days::int, media_seconds) AS score
FROM agg;

REVOKE ALL ON public.v_tracked_link_engagement, public.v_project_interest FROM anon;
GRANT SELECT ON public.v_tracked_link_engagement, public.v_project_interest TO authenticated;

DO $assert$
DECLARE v text[];
BEGIN
  SELECT c.reloptions INTO v FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_tracked_link_engagement';
  IF v IS NULL OR NOT ('security_invoker=true' = ANY(v)) THEN
    RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST v_tracked_link_engagement — %', v;
  END IF;
  SELECT c.reloptions INTO v FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_project_interest';
  IF v IS NULL OR NOT ('security_invoker=true' = ANY(v)) THEN
    RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST v_project_interest — %', v;
  END IF;
END $assert$;
