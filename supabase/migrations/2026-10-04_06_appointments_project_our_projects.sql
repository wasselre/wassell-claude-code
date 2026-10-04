-- Appointments pick from OUR projects (operator, 2026-10-04): "change the list
-- and the field from looking through all projects model to look through our
-- projects model." Same as visits already do.
--
--   1. appointments.project_id now looks up our_projects (display = the
--      project name through the mirror, copied from visits.project_id).
--   2. Existing appointments: the master (all_projects) id becomes the matching
--      Our Projects entry. The old value is kept on every converted row under
--      `project_id_all_projects` (nothing is lost). An appointment whose project
--      is not one of ours keeps its old id there and has project_id removed (it
--      would otherwise point at a record the new list does not contain).
--      Written under wassell.system_write so it fires no workflow ("No-Show
--      Recovery" is an update trigger) and no translation capture.
--   3. v_client_project_interest maps appointments through our_projects the
--      same way as visits (a legacy master id still counts while it is one of
--      ours). 2026-10-04_05's rules stand: our projects only, a "no" keeps the
--      mark.
--
-- The app follows in the same change: the appointment form's project picker
-- already stores the Our Projects entry for an our_projects field (as for
-- visits); the WhatsApp agent's book_visit saves the Our Projects entry; and
-- workflow tokens like {project_id.project_name} read through the Our Projects
-- entry's mirror to its master project (substituteFieldTokens).
--
-- security_invoker preserved + asserted. No 40001/40P01.

BEGIN;

-- 1. The field.
UPDATE public.models a
   SET schema = jsonb_set(a.schema, '{sections}', (
     SELECT jsonb_agg(
       jsonb_set(sec, '{fields}', (
         SELECT jsonb_agg(
           CASE WHEN f->>'name' = 'project_id'
                THEN f || jsonb_build_object(
                       'lookup_model_id', (SELECT id::text FROM public.models WHERE name = 'our_projects'),
                       'lookup_display_field', COALESCE(
                         (SELECT vf->>'lookup_display_field'
                            FROM public.models v,
                                 jsonb_array_elements(v.schema->'sections') vs,
                                 jsonb_array_elements(vs->'fields') vf
                           WHERE v.name = 'visits' AND vf->>'name' = 'project_id' LIMIT 1),
                         f->>'lookup_display_field'))
                ELSE f END
           ORDER BY ord)
         FROM jsonb_array_elements(sec->'fields') WITH ORDINALITY AS t(f, ord)))
       ORDER BY sord)
     FROM jsonb_array_elements(a.schema->'sections') WITH ORDINALITY AS s(sec, sord)))
 WHERE a.name = 'appointments'
   AND EXISTS (SELECT 1 FROM public.models WHERE name = 'our_projects');

-- 2. The data.
DO $data$
BEGIN
  PERFORM set_config('wassell.system_write', 'appointments_our_projects', true);

UPDATE public.records r
   SET data = (r.data - 'project_id')
              || jsonb_build_object('project_id_all_projects', r.data->>'project_id')
              || COALESCE((SELECT jsonb_build_object('project_id', op.id::text)
                             FROM public.records op
                             JOIN public.models mo ON mo.id = op.model_id AND mo.name = 'our_projects'
                            WHERE op.data->>'project' = r.data->>'project_id'
                            LIMIT 1), '{}'::jsonb)
  FROM public.models m
 WHERE m.id = r.model_id AND m.name = 'appointments'
   AND COALESCE(r.data->>'project_id', '') <> ''
   -- only rows still holding a master id (re-runnable)
   AND NOT EXISTS (SELECT 1 FROM public.records op2
                     JOIN public.models mo2 ON mo2.id = op2.model_id AND mo2.name = 'our_projects'
                    WHERE op2.id::text = r.data->>'project_id');
END $data$;

-- 3. The interest view.
DROP VIEW IF EXISTS public.v_client_project_interest;
CREATE VIEW public.v_client_project_interest WITH (security_invoker = true) AS
WITH w AS (
  SELECT COALESCE((SELECT interest_weights FROM public.ai_automation_settings WHERE id = 1),
                  '{"appointment": 40, "visit": 50, "asked": 15, "wants": 25}'::jsonb) AS w
),
ours AS (
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
         o.project_id,
         count(*) FILTER (WHERE COALESCE(r.data->>'appointment_status', '') NOT IN ('cancelled', 'no_show')) AS appointments,
         count(*) FILTER (WHERE r.data->>'appointment_status' = 'completed') AS attended,
         count(*) FILTER (WHERE r.data->>'appointment_status' = 'no_show') AS no_shows
    FROM public.records r
    JOIN public.models m ON m.id = r.model_id AND m.name = 'appointments'
    JOIN ours o ON o.our_id = CASE WHEN r.data->>'project_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                   THEN (r.data->>'project_id')::uuid END
   WHERE r.data->>'client_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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

COMMIT;
