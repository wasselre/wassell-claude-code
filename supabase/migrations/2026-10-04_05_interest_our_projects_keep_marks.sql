-- Interest score corrections (operator, 2026-10-04):
--   1. "Both visits and appointments should only work for our projects."
--      An appointment / visit adds to the score only when its project is one of
--      OUR projects (a record in the our_projects model — 96 today; 21 of them
--      are not tagged project_type='our_projects' on the master, so the tag is
--      NOT the test).
--   2. "If the customer … says they don't like the project, we don't change the
--      mark to zero because that is not true … we change the status of the
--      project in the client options to 'not interested' … We need to not
--      remove all of the actions of interest that they have done before."
--      A 'rejected' message signal now adds 0 message points — the links,
--      appointment and visit points stay. The option's status is set to
--      not_interested by client_option_mark (unchanged).
--   The detector does not RAISE a new high-interest event for a project the
--   customer's latest message rejected (registering them in a portal for a
--   project they just turned down would be acting on a "no"); the mark itself
--   is untouched.
--
-- security_invoker preserved + asserted (CREATE VIEW after DROP). No 40001/40P01.

BEGIN;

DROP VIEW IF EXISTS public.v_client_project_interest;
CREATE VIEW public.v_client_project_interest WITH (security_invoker = true) AS
WITH w AS (
  SELECT COALESCE((SELECT interest_weights FROM public.ai_automation_settings WHERE id = 1),
                  '{"appointment": 40, "visit": 50, "asked": 15, "wants": 25}'::jsonb) AS w
),
ours AS (
  -- our_projects id → its master (all_projects) id.
  SELECT op.id AS our_id, (op.data->>'project')::uuid AS project_id
    FROM public.records op
    JOIN public.models m ON m.id = op.model_id AND m.name = 'our_projects'
   WHERE op.data->>'project' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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
     AND EXISTS (SELECT 1 FROM ours o WHERE o.project_id = (r.data->>'project_id')::uuid)
   GROUP BY 1, 2
),
visits AS (
  SELECT (r.data->>'client_id')::uuid AS client_id,
         o.project_id,
         count(*) FILTER (WHERE public.try_timestamptz(r.data->>'scheduled_datetime') IS NULL
                             OR public.try_timestamptz(r.data->>'scheduled_datetime') <= now()) AS visits,
         count(*) FILTER (WHERE public.try_timestamptz(r.data->>'scheduled_datetime') > now()) AS planned_visits
    FROM public.records r
    JOIN public.models m ON m.id = r.model_id AND m.name = 'visits'
    JOIN ours o ON o.our_id = CASE WHEN r.data->>'project_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                   THEN (r.data->>'project_id')::uuid END
   WHERE r.data->>'client_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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
       LEAST(100,
         COALESCE(l.link_score, 0)
         + GREATEST(
             CASE WHEN COALESCE(v.visits, 0) + COALESCE(a.attended, 0) > 0 THEN COALESCE((w.w->>'visit')::int, 0) ELSE 0 END,
             CASE WHEN COALESCE(a.appointments, 0) + COALESCE(v.planned_visits, 0) > 0 THEN COALESCE((w.w->>'appointment')::int, 0) ELSE 0 END)
         + CASE s.level WHEN 'wants' THEN COALESCE((w.w->>'wants')::int, 0)
                        WHEN 'asked' THEN COALESCE((w.w->>'asked')::int, 0) ELSE 0 END
       ) AS score
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
     AND i.message_level IS DISTINCT FROM 'rejected'
     AND COALESCE(cl.data->>'client_stage', '') NOT IN ('خاسر', 'مغلق ناجح', 'يريد إيجار')
     AND NOT EXISTS (SELECT 1 FROM public.client_project_interest x
                      WHERE x.client_id = i.client_id AND x.project_id = i.project_id)
  ON CONFLICT (client_id, project_id, source) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

COMMIT;
