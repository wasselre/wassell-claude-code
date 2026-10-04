-- Client interest is more than links (operator, 2026-10-04):
--   "If a customer visits a project or books an appointment for a project, that
--    would add to their degree of interest … if the customer asks a lot of
--    questions and shows actual interest in the project, that should also add."
--
-- v_client_project_interest — ONE score per (client, project), 0–100:
--   link score (v_project_interest, highest across the client's chats)
--   + an appointment booked for the project, OR a visit done (the larger, not both)
--   + what the customer's own messages say about it (the outcome agent's reading:
--     asked real questions / said it suits them)
--   A project the customer said does not suit them scores 0.
-- The weights are DATA (ai_automation_settings.interest_weights).
--
-- client_interest_detect_links() — the 5-minute high-interest detector — now
-- reads this score instead of the link score alone (same name, so the deployed
-- cron keeps working). A booked appointment (40) alone is high interest, which
-- registers the client in the developer's portal BEFORE the visit. A pair that
-- already has an interest event (any source) never gets a second one.
--
-- Projects: appointments point at all_projects; visits point at our_projects,
-- mapped back through our_projects.data.project. Options' source_id is the
-- all_projects id, so everything keys on all_projects.
--
-- security_invoker=true on the view (RLS of the reader applies everywhere).
-- No 40001/40P01.

BEGIN;

-- 1. What the customer's messages say about a project (written by the outcome agent).
CREATE TABLE IF NOT EXISTS public.client_project_message_signals (
  client_id  uuid NOT NULL,
  project_id uuid NOT NULL,
  level      text NOT NULL CHECK (level IN ('asked', 'wants', 'rejected')),
  quote      text,
  source     text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, project_id)
);
ALTER TABLE public.client_project_message_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cpms_select ON public.client_project_message_signals;
-- Visible to whoever can see the client (records RLS decides).
CREATE POLICY cpms_select ON public.client_project_message_signals
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.records r WHERE r.id = client_id));
REVOKE ALL ON public.client_project_message_signals FROM anon;
GRANT SELECT ON public.client_project_message_signals TO authenticated;

-- The one writer. 'wants' / 'rejected' replace whatever was there (the customer
-- can change their mind); 'asked' never downgrades 'wants', but does revive a
-- 'rejected' project the customer is asking about again.
CREATE OR REPLACE FUNCTION public.client_project_message_signal(
  p_client uuid, p_project uuid, p_level text, p_quote text, p_source text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_cur text;
BEGIN
  IF p_client IS NULL OR p_project IS NULL THEN RETURN 'skipped:missing_ids'; END IF;
  IF p_level NOT IN ('asked', 'wants', 'rejected') THEN RETURN 'skipped:bad_level'; END IF;
  SELECT level INTO v_cur FROM public.client_project_message_signals
   WHERE client_id = p_client AND project_id = p_project FOR UPDATE;
  IF v_cur = p_level THEN
    UPDATE public.client_project_message_signals
       SET quote = COALESCE(p_quote, quote), source = p_source, updated_at = now()
     WHERE client_id = p_client AND project_id = p_project;
    RETURN 'kept:' || v_cur;
  END IF;
  IF p_level = 'asked' AND v_cur = 'wants' THEN RETURN 'kept:wants'; END IF;
  INSERT INTO public.client_project_message_signals (client_id, project_id, level, quote, source, updated_at)
  VALUES (p_client, p_project, p_level, p_quote, p_source, now())
  ON CONFLICT (client_id, project_id) DO UPDATE
    SET level = EXCLUDED.level, quote = EXCLUDED.quote, source = EXCLUDED.source, updated_at = now();
  RETURN COALESCE(v_cur, 'none') || '->' || p_level;
END;
$function$;
REVOKE ALL ON FUNCTION public.client_project_message_signal(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_project_message_signal(uuid, uuid, text, text, text) TO service_role;

-- 2. Weights (data, not code).
ALTER TABLE public.ai_automation_settings
  ADD COLUMN IF NOT EXISTS interest_weights jsonb NOT NULL
  DEFAULT '{"appointment": 40, "visit": 50, "asked": 15, "wants": 25}'::jsonb;

-- 3. The combined score.
DROP VIEW IF EXISTS public.v_client_project_interest;
CREATE VIEW public.v_client_project_interest WITH (security_invoker = true) AS
WITH w AS (
  SELECT COALESCE((SELECT interest_weights FROM public.ai_automation_settings WHERE id = 1),
                  '{"appointment": 40, "visit": 50, "asked": 15, "wants": 25}'::jsonb) AS w
),
links AS (
  SELECT COALESCE(v.client_id,
           CASE WHEN c.data->>'client_link' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (c.data->>'client_link')::uuid END) AS client_id,
         v.project_id,
         max(v.score)::int AS link_score,
         max(v.last_activity_at) AS last_link_at
    FROM public.v_project_interest v
    LEFT JOIN public.records c ON c.id = v.conversation_record_id
   WHERE v.project_id IS NOT NULL
   GROUP BY 1, 2
),
appts AS (
  SELECT (r.data->>'client_id')::uuid AS client_id,
         (r.data->>'project_id')::uuid AS project_id,
         count(*) FILTER (WHERE COALESCE(r.data->>'appointment_status', '') NOT IN ('cancelled', 'no_show')) AS appointments,
         count(*) FILTER (WHERE r.data->>'appointment_status' = 'completed') AS attended,
         count(*) FILTER (WHERE r.data->>'appointment_status' = 'no_show') AS no_shows
    FROM public.records r
    JOIN public.models m ON m.id = r.model_id AND m.name = 'appointments'
   WHERE r.data->>'client_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND r.data->>'project_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   GROUP BY 1, 2
),
visits AS (
  SELECT (r.data->>'client_id')::uuid AS client_id,
         (op.data->>'project')::uuid AS project_id,
         count(*) FILTER (WHERE public.try_timestamptz(r.data->>'scheduled_datetime') IS NULL
                             OR public.try_timestamptz(r.data->>'scheduled_datetime') <= now()) AS visits,
         count(*) FILTER (WHERE public.try_timestamptz(r.data->>'scheduled_datetime') > now()) AS planned_visits
    FROM public.records r
    JOIN public.models m ON m.id = r.model_id AND m.name = 'visits'
    -- Looked up by id (records_pkey) — a text join here seq-scans every record.
    JOIN public.records op ON op.id = CASE WHEN r.data->>'project_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                           THEN (r.data->>'project_id')::uuid END
   WHERE r.data->>'client_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND op.data->>'project' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   GROUP BY 1, 2
),
keys AS (
  SELECT client_id, project_id FROM links WHERE client_id IS NOT NULL
  UNION SELECT client_id, project_id FROM appts
  UNION SELECT client_id, project_id FROM visits
  UNION SELECT client_id, project_id FROM public.client_project_message_signals
)
SELECT k.client_id,
       k.project_id,
       COALESCE(l.link_score, 0) AS link_score,
       l.last_link_at,
       COALESCE(a.appointments, 0) + COALESCE(v.planned_visits, 0) AS appointments,
       COALESCE(a.no_shows, 0) AS no_shows,
       COALESCE(v.visits, 0) + COALESCE(a.attended, 0) AS visits,
       s.level AS message_level,
       s.quote AS message_quote,
       CASE WHEN s.level = 'rejected' THEN 0 ELSE LEAST(100,
         COALESCE(l.link_score, 0)
         + GREATEST(
             CASE WHEN COALESCE(v.visits, 0) + COALESCE(a.attended, 0) > 0 THEN COALESCE((w.w->>'visit')::int, 0) ELSE 0 END,
             CASE WHEN COALESCE(a.appointments, 0) + COALESCE(v.planned_visits, 0) > 0 THEN COALESCE((w.w->>'appointment')::int, 0) ELSE 0 END)
         + CASE s.level WHEN 'wants' THEN COALESCE((w.w->>'wants')::int, 0)
                        WHEN 'asked' THEN COALESCE((w.w->>'asked')::int, 0) ELSE 0 END)
       END AS score
  FROM keys k
  CROSS JOIN w
  LEFT JOIN links l ON l.client_id = k.client_id AND l.project_id = k.project_id
  LEFT JOIN appts a ON a.client_id = k.client_id AND a.project_id = k.project_id
  LEFT JOIN visits v ON v.client_id = k.client_id AND v.project_id = k.project_id
  LEFT JOIN public.client_project_message_signals s ON s.client_id = k.client_id AND s.project_id = k.project_id;

ALTER VIEW public.v_client_project_interest SET (security_invoker = true);
REVOKE ALL ON public.v_client_project_interest FROM anon;
GRANT SELECT ON public.v_client_project_interest TO authenticated, service_role;

DO $assert$
DECLARE v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_client_project_interest';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST v_client_project_interest — options are %', v_opts;
  END IF;
END $assert$;

-- 4. The detector reads the combined score.
ALTER TABLE public.client_project_interest DROP CONSTRAINT IF EXISTS client_project_interest_source_check;
ALTER TABLE public.client_project_interest ADD CONSTRAINT client_project_interest_source_check
  CHECK (source IN ('link_score', 'ai_outcome', 'interest_score'));

CREATE OR REPLACE FUNCTION public.client_interest_detect_links(p_threshold integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
  INSERT INTO public.client_project_interest (client_id, project_id, source, score, chat_wid)
  SELECT i.client_id, i.project_id, 'interest_score', i.score,
         (SELECT v.chat_wid FROM public.v_project_interest v
           WHERE v.client_id = i.client_id AND v.project_id = i.project_id
           ORDER BY v.last_activity_at DESC NULLS LAST LIMIT 1)
    FROM public.v_client_project_interest i
    JOIN public.records cl ON cl.id = i.client_id
   WHERE i.score >= p_threshold
     AND COALESCE(cl.data->>'client_stage', '') NOT IN ('خاسر', 'مغلق ناجح', 'يريد إيجار')
     AND NOT EXISTS (SELECT 1 FROM public.client_project_interest x
                      WHERE x.client_id = i.client_id AND x.project_id = i.project_id)
  ON CONFLICT (client_id, project_id, source) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

COMMIT;
