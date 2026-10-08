-- client_pulse(client_ids): what is happening with each client, in one read —
-- the data behind the client list's interest / top project / situation / last
-- action / last contact / visit columns (operator, 2026-10-08: "one list with
-- all of the clients … hot clients … what's happening … the stage … the last
-- action … their interest level … the top project … the last time we
-- contacted them … if they want to visit").
--
-- Everything here is DERIVED from facts already recorded — no model call, no
-- stored copy that can go stale:
--   * interest signals: the customer's own reactions per project
--     (client_project_message_signals: wants / asked / rejected), tracked-link
--     activity (v_project_interest.score), the AI's interest calls
--     (client_project_interest source ai_outcome), open visit checks
--     (wa_agent_questions), appointments and visits;
--   * contact: chat_messages of the client's chats, phone calls;
--   * actions: the AI agent's runs (wa_agent_runs), follow-up results, our
--     outbound messages, calls.
--
-- Interest level (one per client, first match wins):
--   closed  — stage غير مؤهل / خاسر / مغلق ناجح / يريد إيجار
--   hot     — in the last 7 days: said they WANT a project, link score >= 40
--             (the officer-notice bar), an AI interest call, a visit check open,
--             an upcoming appointment, or a visit made
--   warm    — in the last 30 days: asked about a project / any of the above
--             older than 7 days, link score >= 15, or messaged us in 14 days
--   quiet   — we have been in contact, nothing recent
--   unknown — no contact and no signal at all (NOT "cold": we simply don't know)
--
-- SECURITY DEFINER + service_role only: it reads chats on every line and the
-- officer lines. /api/client-pulse checks which clients the CALLER may see
-- (records RLS) and passes only those ids.

CREATE OR REPLACE FUNCTION public.client_pulse(p_client_ids uuid[])
RETURNS TABLE (
  client_id       uuid,
  interest        text,
  interest_reason text,
  top_project_id  uuid,
  top_project_name text,
  last_action     jsonb,
  last_contact_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  situation       jsonb,
  visit           jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
WITH
m AS (
  SELECT
    (SELECT id FROM models WHERE name = 'clients') AS clients,
    (SELECT id FROM models WHERE name = 'chats') AS chats,
    (SELECT id FROM models WHERE name = 'phone_calls') AS calls,
    (SELECT id FROM models WHERE name = 'followups') AS followups,
    (SELECT id FROM models WHERE name = 'appointments') AS appts,
    (SELECT id FROM models WHERE name = 'visits') AS visits,
    (SELECT id FROM models WHERE name = 'our_projects') AS ours,
    (SELECT id FROM models WHERE name = 'all_projects') AS allp,
    (SELECT id FROM models WHERE name = 'client_property_options') AS opts
),
cl AS (
  SELECT r.id, r.data->>'client_stage' AS stage
    FROM records r, m
   WHERE r.model_id = m.clients AND r.id = ANY (p_client_ids)
),
-- The client's chats and their last message each way.
ch AS (
  SELECT public._link_client_id_of(r.data)::uuid AS cid, r.data->>'wid' AS wid
    FROM records r, m
   WHERE r.model_id = m.chats AND r.data->>'wid' IS NOT NULL
     AND public._link_client_id_of(r.data) IN (SELECT id::text FROM cl)
),
msg AS (
  SELECT ch.cid,
         max(li.date) AS last_in,
         max(lo.date) AS last_out,
         max(lr.date) AS last_rep_out
    FROM ch
    LEFT JOIN LATERAL (SELECT date FROM chat_messages WHERE chat_wid = ch.wid AND flow = 'in' ORDER BY date DESC LIMIT 1) li ON true
    LEFT JOIN LATERAL (SELECT date FROM chat_messages WHERE chat_wid = ch.wid AND flow = 'out' ORDER BY date DESC LIMIT 1) lo ON true
    LEFT JOIN LATERAL (SELECT date FROM chat_messages WHERE chat_wid = ch.wid AND flow = 'out' AND coalesce(send_source, '') <> 'ai'
                        ORDER BY date DESC LIMIT 1) lr ON true
   GROUP BY ch.cid
),
calls AS (
  SELECT public._link_client_id_of(r.data)::uuid AS cid, max(public.try_timestamptz(r.data->>'call_time')) AS last_call
    FROM records r, m
   WHERE r.model_id = m.calls AND public._link_client_id_of(r.data) IN (SELECT id::text FROM cl)
   GROUP BY 1
),
pname AS (
  SELECT r.id, coalesce(nullif(r.data->>'project_name', ''), r.data->>'name') AS name
    FROM records r, m WHERE r.model_id = m.allp
),
ours AS (
  SELECT r.id, nullif(r.data->>'project', '')::uuid AS project_id
    FROM records r, m WHERE r.model_id = m.ours AND (r.data->>'project') ~ '^[0-9a-f-]{36}$'
),
-- Signals, one row each: (client, project, kind, at, strength)
sig AS (
  SELECT s.client_id AS cid, s.project_id, s.level AS kind, s.updated_at AS at
    FROM client_project_message_signals s WHERE s.client_id = ANY (p_client_ids) AND s.level IN ('wants', 'asked')
  UNION ALL
  SELECT v.client_id, v.project_id, CASE WHEN v.score >= 40 THEN 'link_high' ELSE 'link' END, coalesce(v.last_activity_at, v.last_sent_at)
    FROM v_project_interest v WHERE v.client_id = ANY (p_client_ids) AND v.score >= 15
  UNION ALL
  SELECT i.client_id, i.project_id, 'ai', i.detected_at
    FROM client_project_interest i WHERE i.client_id = ANY (p_client_ids) AND i.source = 'ai_outcome'
),
qopen AS (
  SELECT DISTINCT ON (q.client_id) q.client_id AS cid, q.project_id, q.asked_to, q.visit_day, q.due_at, q.created_at, q.question
    FROM wa_agent_questions q
   WHERE q.client_id = ANY (p_client_ids) AND q.status = 'open'
   ORDER BY q.client_id, (q.visit_day IS NOT NULL) DESC, (q.asked_to = 'officer') DESC, q.created_at
),
appt AS (
  SELECT DISTINCT ON ((r.data->>'client_id')::uuid) (r.data->>'client_id')::uuid AS cid,
         public.try_timestamptz(r.data->>'appointment_date') AS at, r.data->>'appointment_date' AS at_local,
         coalesce(nullif(r.data->>'appointment_status', ''), 'scheduled') AS status, o.project_id
    FROM records r CROSS JOIN m
    LEFT JOIN ours o ON o.id::text = r.data->>'project_id'
   WHERE r.model_id = m.appts AND (r.data->>'client_id') ~ '^[0-9a-f-]{36}$'
     AND (r.data->>'client_id')::uuid = ANY (p_client_ids)
     AND coalesce(nullif(r.data->>'appointment_status', ''), 'scheduled') IN ('scheduled', 'confirmed', 'rescheduled')
     AND public.try_timestamptz(r.data->>'appointment_date') >= now() - interval '3 hours'
   ORDER BY (r.data->>'client_id')::uuid, public.try_timestamptz(r.data->>'appointment_date')
),
vis AS (
  SELECT DISTINCT ON ((r.data->>'client_id')::uuid) (r.data->>'client_id')::uuid AS cid,
         coalesce(public.try_timestamptz(r.data->>'scheduled_datetime'), r.created_at) AS at, o.project_id
    FROM records r CROSS JOIN m
    LEFT JOIN ours o ON o.id::text = r.data->>'project_id'
   WHERE r.model_id = m.visits AND (r.data->>'client_id') ~ '^[0-9a-f-]{36}$'
     AND (r.data->>'client_id')::uuid = ANY (p_client_ids)
   ORDER BY (r.data->>'client_id')::uuid, coalesce(public.try_timestamptz(r.data->>'scheduled_datetime'), r.created_at) DESC
),
mainopt AS (
  SELECT DISTINCT ON ((r.data->>'client_id')::uuid) (r.data->>'client_id')::uuid AS cid, nullif(r.data->>'source_id', '')::uuid AS project_id
    FROM records r, m
   WHERE r.model_id = m.opts AND (r.data->>'client_id') ~ '^[0-9a-f-]{36}$'
     AND (r.data->>'client_id')::uuid = ANY (p_client_ids)
     AND r.data->>'source_type' = 'project' AND (r.data->>'source_id') ~ '^[0-9a-f-]{36}$'
     AND (r.data->>'is_main' = 'true' OR r.data->>'status' = 'main_focus')
   ORDER BY (r.data->>'client_id')::uuid, r.updated_at DESC
),
-- The top project: what they are moving on first, then what they said, then activity.
topp AS (
  SELECT DISTINCT ON (cid) cid, project_id FROM (
    SELECT cid, project_id, 1 AS rk, created_at AS at FROM qopen WHERE visit_day IS NOT NULL AND project_id IS NOT NULL
    UNION ALL SELECT cid, project_id, 2, at FROM appt WHERE project_id IS NOT NULL
    UNION ALL SELECT cid, project_id, 3, at FROM sig WHERE kind = 'wants'
    UNION ALL SELECT cid, project_id, 4, now() FROM mainopt WHERE project_id IS NOT NULL
    UNION ALL SELECT cid, project_id, 5, at FROM sig WHERE kind = 'link_high'
    UNION ALL SELECT cid, project_id, 6, at FROM sig WHERE kind = 'ai'
    UNION ALL SELECT cid, project_id, 7, at FROM sig WHERE kind IN ('asked', 'link')
  ) c
  ORDER BY cid, rk, at DESC NULLS LAST
),
-- The latest thing anyone did with the client.
acts AS (
  SELECT cid, at, payload FROM (
    SELECT DISTINCT ON (w.client_id) w.client_id AS cid, w.created_at AS at,
           jsonb_build_object('by', 'ai', 'kind',
             CASE WHEN w.actions ? 'visit_requested' THEN 'visit_requested'
                  WHEN w.actions ? 'booked' THEN 'visit_booked'
                  WHEN w.actions ? 'sent_project' THEN 'sent_project'
                  WHEN w.actions ? 'sent_units' THEN 'sent_units'
                  WHEN w.actions ? 'handoff' THEN 'handoff'
                  WHEN w.actions ? 'asked' THEN 'asked'
                  ELSE 'replied' END,
             'project', coalesce(w.actions #>> '{sent_project,name}', w.actions #>> '{sent_units,name}'),
             'project_id', coalesce(w.actions #>> '{visit_requested,projectId}', w.actions #>> '{booked,projectId}', w.actions #>> '{sent_project,id}', w.actions #>> '{sent_units,project_id}')) AS payload
      FROM wa_agent_runs w
     WHERE w.client_id = ANY (p_client_ids)
       AND (w.reply_sent IS TRUE OR (w.actions IS NOT NULL AND w.actions <> '{}'::jsonb))
     ORDER BY w.client_id, w.created_at DESC
  ) a
  UNION ALL
  SELECT cid, last_rep_out, jsonb_build_object('by', 'person', 'kind', 'whatsapp') FROM msg WHERE last_rep_out IS NOT NULL
  UNION ALL
  SELECT cid, last_call, jsonb_build_object('by', 'person', 'kind', 'call') FROM calls WHERE last_call IS NOT NULL
  UNION ALL
  SELECT * FROM (
    SELECT DISTINCT ON (public._followup_client_id_of(r.data)) public._followup_client_id_of(r.data)::uuid AS cid,
           public.try_timestamptz(r.data->>'actual_datetime') AS at,
           jsonb_build_object('by', CASE WHEN nullif(r.data->>'completed_by_user', '') IS NULL AND nullif(r.data->>'completed_by_chat_id', '') IS NOT NULL THEN 'ai' ELSE 'person' END,
                              'kind', 'result', 'result', r.data->>'call_result',
                              'followup_type', CASE WHEN jsonb_typeof(r.data->'followup_type') = 'array' THEN r.data->'followup_type'->>0 ELSE r.data->>'followup_type' END) AS payload
      FROM records r, m
     WHERE r.model_id = m.followups AND r.data->>'followup_status' = 'completed'
       AND public.try_timestamptz(r.data->>'actual_datetime') IS NOT NULL
       AND public._followup_client_id_of(r.data) IN (SELECT id::text FROM cl)
     ORDER BY public._followup_client_id_of(r.data), public.try_timestamptz(r.data->>'actual_datetime') DESC
  ) f
),
lastact AS (
  SELECT DISTINCT ON (cid) cid, at, payload FROM acts WHERE at IS NOT NULL ORDER BY cid, at DESC
),
lvl AS (
  SELECT cl.id AS cid,
    CASE
      WHEN cl.stage IN ('غير مؤهل', 'خاسر', 'مغلق ناجح', 'يريد إيجار') THEN 'closed'
      WHEN EXISTS (SELECT 1 FROM qopen q WHERE q.cid = cl.id AND q.visit_day IS NOT NULL) THEN 'hot'
      WHEN EXISTS (SELECT 1 FROM appt a WHERE a.cid = cl.id) THEN 'hot'
      WHEN EXISTS (SELECT 1 FROM vis v WHERE v.cid = cl.id AND v.at > now() - interval '7 days') THEN 'hot'
      WHEN EXISTS (SELECT 1 FROM sig s WHERE s.cid = cl.id AND s.kind IN ('wants', 'link_high', 'ai') AND s.at > now() - interval '7 days') THEN 'hot'
      WHEN EXISTS (SELECT 1 FROM sig s WHERE s.cid = cl.id AND s.at > now() - interval '30 days') THEN 'warm'
      WHEN EXISTS (SELECT 1 FROM vis v WHERE v.cid = cl.id AND v.at > now() - interval '30 days') THEN 'warm'
      WHEN EXISTS (SELECT 1 FROM msg x WHERE x.cid = cl.id AND x.last_in > now() - interval '14 days') THEN 'warm'
      WHEN EXISTS (SELECT 1 FROM msg x WHERE x.cid = cl.id AND (x.last_in IS NOT NULL OR x.last_out IS NOT NULL))
        OR EXISTS (SELECT 1 FROM calls c WHERE c.cid = cl.id)
        OR EXISTS (SELECT 1 FROM sig s WHERE s.cid = cl.id) THEN 'quiet'
      ELSE 'unknown'
    END AS interest,
    CASE
      WHEN EXISTS (SELECT 1 FROM qopen q WHERE q.cid = cl.id AND q.visit_day IS NOT NULL) THEN 'visit_requested'
      WHEN EXISTS (SELECT 1 FROM appt a WHERE a.cid = cl.id) THEN 'appointment'
      WHEN EXISTS (SELECT 1 FROM vis v WHERE v.cid = cl.id AND v.at > now() - interval '30 days') THEN 'visited'
      WHEN EXISTS (SELECT 1 FROM sig s WHERE s.cid = cl.id AND s.kind = 'wants' AND s.at > now() - interval '30 days') THEN 'wants'
      WHEN EXISTS (SELECT 1 FROM sig s WHERE s.cid = cl.id AND s.kind = 'ai' AND s.at > now() - interval '30 days') THEN 'ai'
      WHEN EXISTS (SELECT 1 FROM sig s WHERE s.cid = cl.id AND s.kind IN ('link_high', 'link') AND s.at > now() - interval '30 days') THEN 'links'
      WHEN EXISTS (SELECT 1 FROM sig s WHERE s.cid = cl.id AND s.kind = 'asked' AND s.at > now() - interval '30 days') THEN 'asked'
      WHEN EXISTS (SELECT 1 FROM msg x WHERE x.cid = cl.id AND x.last_in > now() - interval '14 days') THEN 'messaged'
      ELSE NULL
    END AS reason
  FROM cl
)
SELECT
  cl.id,
  lvl.interest,
  lvl.reason,
  tp.project_id,
  pn.name,
  la.payload || jsonb_build_object('at', la.at)
    || CASE WHEN la.payload ? 'project_id' AND la.payload->>'project' IS NULL AND (la.payload->>'project_id') ~ '^[0-9a-f-]{36}$'
            THEN jsonb_build_object('project', (SELECT name FROM pname WHERE id = (la.payload->>'project_id')::uuid)) ELSE '{}'::jsonb END,
  GREATEST(x.last_in, x.last_out, c.last_call),
  x.last_in,
  x.last_out,
  CASE
    WHEN q.cid IS NOT NULL AND q.visit_day IS NOT NULL THEN jsonb_build_object('code', 'visit_check', 'waiting', q.asked_to,
           'day', q.visit_day, 'project', (SELECT name FROM pname WHERE id = q.project_id), 'overdue', coalesce(q.due_at < now(), false))
    WHEN q.cid IS NOT NULL AND q.asked_to = 'officer' THEN jsonb_build_object('code', 'officer_question',
           'project', (SELECT name FROM pname WHERE id = q.project_id), 'overdue', coalesce(q.due_at < now(), false))
    WHEN q.cid IS NOT NULL THEN jsonb_build_object('code', 'rep_question', 'since', q.created_at)
    WHEN a.cid IS NOT NULL THEN jsonb_build_object('code', 'appointment', 'at', a.at_local, 'status', a.status,
           'project', (SELECT name FROM pname WHERE id = a.project_id))
    WHEN x.last_in IS NOT NULL AND (x.last_out IS NULL OR x.last_in > x.last_out) THEN jsonb_build_object('code', 'customer_waiting', 'since', x.last_in)
    WHEN x.last_out IS NOT NULL AND x.last_out > now() - interval '30 days' THEN jsonb_build_object('code', 'waiting_customer', 'since', x.last_out)
    ELSE NULL
  END,
  CASE
    WHEN a.cid IS NOT NULL THEN jsonb_build_object('kind', 'appointment', 'at', a.at_local, 'status', a.status, 'project', (SELECT name FROM pname WHERE id = a.project_id))
    WHEN q.cid IS NOT NULL AND q.visit_day IS NOT NULL THEN jsonb_build_object('kind', 'requested', 'day', q.visit_day, 'project', (SELECT name FROM pname WHERE id = q.project_id))
    WHEN v.cid IS NOT NULL THEN jsonb_build_object('kind', 'visited', 'at', v.at, 'project', (SELECT name FROM pname WHERE id = v.project_id))
    ELSE NULL
  END
FROM cl
JOIN lvl ON lvl.cid = cl.id
LEFT JOIN topp tp ON tp.cid = cl.id
LEFT JOIN pname pn ON pn.id = tp.project_id
LEFT JOIN lastact la ON la.cid = cl.id
LEFT JOIN msg x ON x.cid = cl.id
LEFT JOIN calls c ON c.cid = cl.id
LEFT JOIN qopen q ON q.cid = cl.id
LEFT JOIN appt a ON a.cid = cl.id
LEFT JOIN vis v ON v.cid = cl.id;
$function$;

REVOKE ALL ON FUNCTION public.client_pulse(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_pulse(uuid[]) TO service_role;
