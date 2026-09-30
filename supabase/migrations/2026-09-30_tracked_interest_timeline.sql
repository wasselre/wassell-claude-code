-- Tracked links: the HISTORY behind a customer × project interest score.
--
-- tracked_interest_timeline(chat_wid, project_id) replays every event of every
-- link we sent that customer for that project, oldest first, through the ONE
-- scoring function (tracked_interest_score), and returns each event with the
-- points it added (after caps) and the running total. The last running total
-- equals v_project_interest.score by construction — there is no second copy of
-- the formula to drift. "sent" rows (a link going out) are included with 0
-- points so the timeline reads as a history.
--
-- SECURITY INVOKER on purpose: RLS on tracked_links / tracked_link_events
-- (which mirrors chat visibility) decides what the caller can see.

CREATE OR REPLACE FUNCTION public.tracked_interest_timeline(p_chat_wid text, p_project_id uuid)
RETURNS TABLE (
  at timestamptz, link_id uuid, focus text, sent_via text, session_id text,
  kind text, section text, item text, value numeric, points integer, running integer
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  r record;
  v_sessions text[] := '{}';
  v_days     date[] := '{}';
  v_photos   text[] := '{}';
  v_videos   text[] := '{}';
  v_pages    text[] := '{}';
  v_units    text[] := '{}';
  v_max_pct  numeric := 0;
  v_brochure numeric := 0;
  v_media    numeric := 0;
  v_units_s  numeric := 0;
  v_map      boolean := false;
  v_prev     integer := 0;
  v_now      integer;
BEGIN
  FOR r IN
    SELECT x.at, x.link_id, x.focus, x.sent_via, x.session_id, x.kind, x.section, x.item, x.value
    FROM (
      SELECT l.created_at AS at, l.id AS link_id, l.focus, l.sent_via, NULL::text AS session_id,
             'sent'::text AS kind, NULL::text AS section, l.unit_id::text AS item, NULL::numeric AS value, 0 AS ord, NULL::bigint AS eid
        FROM tracked_links l
       WHERE l.chat_wid = p_chat_wid AND l.project_id = p_project_id
      UNION ALL
      SELECT e.created_at, l.id, l.focus, l.sent_via, e.session_id, e.kind, e.section, e.item, e.value, 1, e.id
        FROM tracked_links l
        JOIN tracked_link_events e ON e.link_id = l.id
       WHERE l.chat_wid = p_chat_wid AND l.project_id = p_project_id
    ) x
    ORDER BY x.at, x.ord, x.eid
  LOOP
    -- Same definitions as v_project_interest (distinct counts ignore NULL items).
    IF r.kind = 'view' THEN
      IF NOT (r.session_id = ANY (v_sessions)) THEN v_sessions := v_sessions || r.session_id; END IF;
      IF NOT ((r.at AT TIME ZONE 'Asia/Riyadh')::date = ANY (v_days)) THEN v_days := v_days || (r.at AT TIME ZONE 'Asia/Riyadh')::date; END IF;
    ELSIF r.kind = 'photo_open' THEN
      IF r.item IS NOT NULL AND NOT (r.item = ANY (v_photos)) THEN v_photos := v_photos || r.item; END IF;
    ELSIF r.kind IN ('video_play', 'video_progress') THEN
      IF r.item IS NOT NULL AND NOT (r.item = ANY (v_videos)) THEN v_videos := v_videos || r.item; END IF;
      IF r.kind = 'video_progress' THEN v_max_pct := GREATEST(v_max_pct, coalesce(r.value, 0)); END IF;
    ELSIF r.kind = 'brochure_page' THEN
      IF r.item IS NOT NULL AND NOT (r.item = ANY (v_pages)) THEN v_pages := v_pages || r.item; END IF;
    ELSIF r.kind = 'unit_open' THEN
      IF r.item IS NOT NULL AND NOT (r.item = ANY (v_units)) THEN v_units := v_units || r.item; END IF;
    ELSIF r.kind = 'map_open' THEN
      v_map := true;
    ELSIF r.kind = 'time' THEN
      IF r.section = 'brochure' THEN v_brochure := v_brochure + coalesce(r.value, 0);
      ELSIF r.section IN ('photos', 'videos') THEN v_media := v_media + coalesce(r.value, 0);
      ELSIF r.section IN ('units', 'unit') THEN v_units_s := v_units_s + coalesce(r.value, 0);
      END IF;
    END IF;

    v_now := public.tracked_interest_score(
      coalesce(cardinality(v_sessions), 0), coalesce(cardinality(v_photos), 0), coalesce(cardinality(v_videos), 0), v_max_pct,
      v_brochure, coalesce(cardinality(v_pages), 0), v_map, coalesce(cardinality(v_days), 0), v_media,
      coalesce(cardinality(v_units), 0), v_units_s);

    at := r.at; link_id := r.link_id; focus := r.focus; sent_via := r.sent_via; session_id := r.session_id;
    kind := r.kind; section := r.section; item := r.item; value := r.value;
    points := v_now - v_prev; running := v_now;
    v_prev := v_now;
    RETURN NEXT;
  END LOOP;
END
$fn$;

REVOKE ALL ON FUNCTION public.tracked_interest_timeline(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tracked_interest_timeline(text, uuid) TO authenticated, service_role;

-- Housekeeping: the 2026-09-29 migration revoked INSERT/UPDATE/DELETE but left
-- TRUNCATE / REFERENCES / TRIGGER from Supabase's default grants. Not reachable
-- through PostgREST, but these tables are written by the service role only.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.tracked_links, public.tracked_link_events FROM anon, authenticated;
