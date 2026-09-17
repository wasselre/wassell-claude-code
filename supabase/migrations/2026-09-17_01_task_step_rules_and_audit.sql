-- ============================================================================
-- Marketing OS task rules, part 1 of 2: the rules as DATA, and a check that
-- lists every task breaking them. 2026-09-17.
--
-- Operator rules (agreed 2026-09-17, after an independent review):
--   · Capacity decides WHEN work is handed out; each step's deadline counts
--     from the moment that person receives work they can actually do.
--   · Writing:  24h allowance, max 10 units per writer in any rolling 24 hours.
--   · Design:   24h allowance, max 4 units per designer in any rolling 24 hours.
--   · Writing review, design check by writer, final approval: 12h, no limit.
--   · A row of 3 posts counts as 3 units; a single item counts as 1.
--   · Earliest possible: confirmed work starts as soon as capacity allows,
--     in publish-date order. "A post in a day" is a target, not a guarantee.
--   · Rolling windows, not calendar days: no working hours exist here.
--   · Being allowed to do a role and receiving its routine tasks are separate.
--
-- This part adds NO behaviour change. It adds the rule tables, the helpers the
-- dispatcher (part 2) uses, and `mos_task_rules_audit()`, which was run against
-- production BEFORE part 2 to prove it catches the known defects.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------- the rules
CREATE TABLE IF NOT EXISTS public.mos_step_rules (
  step_key         text PRIMARY KEY,
  sort_order       int     NOT NULL,
  allowance_hours  numeric NOT NULL CHECK (allowance_hours > 0),
  -- Steps sharing a capacity_key share one per-person rolling limit.
  -- NULL = uncapped (approvals).
  capacity_key     text,
  daily_limit      int     CHECK (daily_limit IS NULL OR daily_limit > 0),
  label_ar         text    NOT NULL,
  label_en         text    NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((capacity_key IS NULL) = (daily_limit IS NULL))
);

INSERT INTO public.mos_step_rules
  (step_key, sort_order, allowance_hours, capacity_key, daily_limit, label_ar, label_en)
VALUES
  ('writing',              10, 24, 'writing', 10, 'كتابة',          'Writing'),
  ('writing_review',       20, 12, NULL,     NULL, 'مراجعة الكتابة', 'Writing review'),
  ('design',               30, 24, 'design',   4, 'تصميم',          'Design'),
  ('design_writer_review', 40, 12, NULL,     NULL, 'مراجعة الكاتب',  'Design check by writer'),
  ('design_review',        50, 12, NULL,     NULL, 'مراجعة التصميم', 'Final approval')
ON CONFLICT (step_key) DO UPDATE
  SET sort_order = EXCLUDED.sort_order, allowance_hours = EXCLUDED.allowance_hours,
      capacity_key = EXCLUDED.capacity_key, daily_limit = EXCLUDED.daily_limit,
      label_ar = EXCLUDED.label_ar, label_en = EXCLUDED.label_en, updated_at = now();

ALTER TABLE public.mos_step_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mos_step_rules_read ON public.mos_step_rules;
CREATE POLICY mos_step_rules_read ON public.mos_step_rules
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.mos_step_rules FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.mos_step_rules FROM authenticated;

-- ------------------------------------------ allowed-to vs receives-routine
-- Presence = this person holds the role (and may act on its tasks) but is
-- never picked automatically for it.
CREATE TABLE IF NOT EXISTS public.mos_auto_assign_opt_out (
  user_id    uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_key   text NOT NULL,            -- stripped key: 'writer', 'montage', …
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_key)
);
ALTER TABLE public.mos_auto_assign_opt_out ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mos_auto_assign_opt_out_read ON public.mos_auto_assign_opt_out;
CREATE POLICY mos_auto_assign_opt_out_read ON public.mos_auto_assign_opt_out
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.mos_auto_assign_opt_out FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.mos_auto_assign_opt_out FROM authenticated;

-- ------------------------------------------------- task bookkeeping columns
ALTER TABLE public.workflow_role_tasks
  ADD COLUMN IF NOT EXISTS assigned_at    timestamptz,
  ADD COLUMN IF NOT EXISTS units          numeric,
  ADD COLUMN IF NOT EXISTS waiting_since  timestamptz,
  ADD COLUMN IF NOT EXISTS waiting_reason text;

COMMENT ON COLUMN public.workflow_role_tasks.assigned_at IS
  'When the current assignee RECEIVED actionable work. The deadline counts from here and the rolling capacity window counts it. Set by mos_task_dispatch.';
COMMENT ON COLUMN public.workflow_role_tasks.units IS
  'Capacity units: a row = its live member count, anything else = 1.';
COMMENT ON COLUMN public.workflow_role_tasks.waiting_since IS
  'Open but not handed out because nobody eligible has room (waiting_reason). Not late: nobody has received it.';

-- ------------------------------------------------------------------ helpers
CREATE OR REPLACE FUNCTION public.mos_task_units(p_subject_table text, p_subject_id uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN p_subject_table = 'mos_content_rows' THEN
           GREATEST((SELECT count(*) FROM public.mos_content c
                      WHERE c.row_id = p_subject_id AND c.archived_at IS NULL), 1)::numeric
         ELSE 1::numeric END
$$;

-- The date the work is for: a row's batch day, an item's target publish time,
-- else its plan need-date. Drives the order work is handed out in.
CREATE OR REPLACE FUNCTION public.mos_subject_publish_at(p_subject_table text, p_subject_id uuid)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN p_subject_table = 'mos_content_rows' THEN
           (SELECT (r.batch_day::timestamp AT TIME ZONE 'Asia/Riyadh')
              FROM public.mos_content_rows r WHERE r.id = p_subject_id)
         ELSE
           (SELECT COALESCE(c.target_publish_at, cp.need_at)
              FROM public.mos_content c
              LEFT JOIN public.mos_content_plan cp ON cp.content_id = c.id
             WHERE c.id = p_subject_id)
         END
$$;

-- A subject whose work must not be handed out or reassigned: archived, on
-- hold or rejected (for a row: when EVERY member is).
CREATE OR REPLACE FUNCTION public.mos_subject_inactive(p_subject_table text, p_subject_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN p_subject_table = 'mos_content_rows' THEN
           NOT EXISTS (SELECT 1 FROM public.mos_content c
                        WHERE c.row_id = p_subject_id AND c.archived_at IS NULL
                          AND c.on_hold_at IS NULL AND c.rejected_at IS NULL)
         ELSE
           NOT EXISTS (SELECT 1 FROM public.mos_content c
                        WHERE c.id = p_subject_id AND c.archived_at IS NULL
                          AND c.on_hold_at IS NULL AND c.rejected_at IS NULL)
         END
$$;

-- Units this person RECEIVED for a capacity key in the 24 hours before p_at.
-- Finishing early does not give the slot back; closed tasks still count.
CREATE OR REPLACE FUNCTION public.mos_capacity_used(p_user_id uuid, p_capacity_key text, p_at timestamptz)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(sum(COALESCE(t.units, 1)), 0)
    FROM public.workflow_role_tasks t
    JOIN public.mos_step_rules sr ON sr.step_key = t.step_key
   WHERE t.assignee_user_id = p_user_id
     AND sr.capacity_key = p_capacity_key
     AND t.assigned_at IS NOT NULL
     AND t.assigned_at >  p_at - interval '24 hours'
     AND t.assigned_at <= p_at
$$;

-- Active holders of a role who take routine work for it.
CREATE OR REPLACE FUNCTION public.mos_role_routine_holders(p_role_key text)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT u.id
    FROM public.users u
    JOIN public.roles r ON r.key = 'mos_' || p_role_key
   WHERE u.is_active
     AND jsonb_typeof(COALESCE(u.role_assignments, '[]'::jsonb)) = 'array'
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(u.role_assignments) e
                  WHERE e->>'role_id' = r.id::text)
     AND NOT EXISTS (SELECT 1 FROM public.mos_auto_assign_opt_out o
                      WHERE o.user_id = u.id AND o.role_key = p_role_key)
$$;

CREATE OR REPLACE FUNCTION public.mos_user_holds_role(p_user_id uuid, p_role_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users u JOIN public.roles r ON r.key = 'mos_' || p_role_key
     WHERE u.id = p_user_id AND u.is_active
       AND jsonb_typeof(COALESCE(u.role_assignments, '[]'::jsonb)) = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(u.role_assignments) e
                    WHERE e->>'role_id' = r.id::text))
$$;

-- ------------------------------------------------------------------- audit
-- Every task (or booking) breaking an agreed rule, one row per violation.
-- An empty result is the acceptance bar — but only because each rule below was
-- first shown to FIRE on production data that really broke it.
CREATE OR REPLACE FUNCTION public.mos_task_rules_audit()
RETURNS TABLE (rule text, ref_id uuid, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  -- R1 ORDER: a booking for a later step starts before an earlier step's booking
  -- for the same subject (the "design booked before writing" defect).
  RETURN QUERY
  WITH b AS (
    SELECT r.id, r.step_key, r.planned_start,
           COALESCE(r.row_id::text, r.content_id::text, r.content_key) AS subj,
           sr.sort_order
      FROM public.mos_task_reservations r
      JOIN public.mos_step_rules sr ON sr.step_key = r.step_key
     WHERE r.status IN ('reserved', 'stale')
  )
  SELECT 'R1_order', later.id,
         format('%s booked %s, before %s booked %s', later.step_key, later.planned_start,
                earlier.step_key, earlier.planned_start)
    FROM b later JOIN b earlier
      ON earlier.subj = later.subj AND earlier.sort_order < later.sort_order
   WHERE later.planned_start < earlier.planned_start;

  -- R2 CAPACITY: at the moment of any assignment, the person's received units
  -- in the preceding 24 hours exceed the step's limit.
  RETURN QUERY
  SELECT 'R2_capacity', t.id,
         format('%s received %s %s units in 24h (limit %s)',
                (SELECT u.email FROM public.users u WHERE u.id = t.assignee_user_id),
                public.mos_capacity_used(t.assignee_user_id, sr.capacity_key, t.assigned_at),
                sr.capacity_key, sr.daily_limit)
    FROM public.workflow_role_tasks t
    JOIN public.mos_step_rules sr ON sr.step_key = t.step_key AND sr.capacity_key IS NOT NULL
   WHERE t.assigned_at IS NOT NULL AND t.assignee_user_id IS NOT NULL
     AND public.mos_capacity_used(t.assignee_user_id, sr.capacity_key, t.assigned_at) > sr.daily_limit
     -- one oversized subject alone in an empty window is allowed (a row wider
     -- than the limit could otherwise never be handed out)
     AND public.mos_capacity_used(t.assignee_user_id, sr.capacity_key, t.assigned_at) > COALESCE(t.units, 1);

  -- R3 DEADLINE: an open task's deadline is not "received + the step's allowance"
  -- (approved leave may only ever EXTEND it).
  RETURN QUERY
  SELECT 'R3_deadline', t.id,
         format('%s due %s; rule says %s (+%sh from receipt %s)', t.step_key,
                t.due_at AT TIME ZONE 'Asia/Riyadh',
                (COALESCE(t.assigned_at, t.opened_at) + sr.allowance_hours * interval '1 hour') AT TIME ZONE 'Asia/Riyadh',
                sr.allowance_hours, COALESCE(t.assigned_at, t.opened_at) AT TIME ZONE 'Asia/Riyadh')
    FROM public.workflow_role_tasks t
    JOIN public.mos_step_rules sr ON sr.step_key = t.step_key
   WHERE t.status = 'open' AND t.assignee_user_id IS NOT NULL
     AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
     AND (t.due_at IS NULL
          OR t.due_at < COALESCE(t.assigned_at, t.opened_at) + sr.allowance_hours * interval '1 hour' - interval '1 minute'
          OR (t.due_at > COALESCE(t.assigned_at, t.opened_at) + sr.allowance_hours * interval '1 hour' + interval '1 minute'
              AND NOT EXISTS (SELECT 1 FROM public.mos_leaves l
                               WHERE l.user_id = t.assignee_user_id AND l.status = 'approved'
                                 AND l.start_at < t.due_at AND l.end_at > COALESCE(t.assigned_at, t.opened_at))));

  -- R4 ROLE: an open, live task sits with someone who no longer holds its role.
  RETURN QUERY
  SELECT 'R4_role', t.id,
         format('%s is with %s, who does not hold %s', t.step_key,
                (SELECT u.email FROM public.users u WHERE u.id = t.assignee_user_id), t.role_key)
    FROM public.workflow_role_tasks t
   WHERE t.status = 'open' AND t.assignee_user_id IS NOT NULL
     AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
     AND NOT public.mos_user_holds_role(t.assignee_user_id, t.role_key);

  -- R5 IDLE: an open, live task is unassigned while an eligible holder has room.
  RETURN QUERY
  SELECT 'R5_waiting_with_room', t.id,
         format('%s unassigned since %s while a %s holder has room', t.step_key,
                COALESCE(t.waiting_since, t.opened_at) AT TIME ZONE 'Asia/Riyadh', t.role_key)
    FROM public.workflow_role_tasks t
    LEFT JOIN public.mos_step_rules sr ON sr.step_key = t.step_key
   WHERE t.status = 'open' AND t.assignee_user_id IS NULL
     AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
     AND EXISTS (SELECT 1 FROM public.mos_role_routine_holders(t.role_key) h(uid)
                  WHERE sr.capacity_key IS NULL
                     OR public.mos_capacity_used(h.uid, sr.capacity_key, now())
                        + COALESCE(t.units, public.mos_task_units(t.subject_table, t.subject_id)) <= sr.daily_limit
                     OR public.mos_capacity_used(h.uid, sr.capacity_key, now()) = 0);

  -- R6 EARLIEST: confirmed work not started while a writer has room for it.
  RETURN QUERY
  WITH pending AS (
    SELECT 'mos_content_rows'::text AS st, rw.id
      FROM public.mos_content_rows rw
     WHERE EXISTS (SELECT 1 FROM public.mos_task_reservations tr
                    WHERE tr.row_id = rw.id AND tr.status IN ('reserved', 'stale'))
       AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                        WHERE t.subject_table = 'mos_content_rows' AND t.subject_id = rw.id)
    UNION ALL
    SELECT 'mos_content', cp.content_id
      FROM public.mos_content_plan cp
      JOIN public.mos_content c ON c.id = cp.content_id AND c.row_id IS NULL
     WHERE cp.status = 'planned' AND cp.production_start IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                        WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id)
  )
  SELECT 'R6_not_started', p.id,
         format('%s for %s not started; a writer has room',
                p.st, public.mos_subject_publish_at(p.st, p.id) AT TIME ZONE 'Asia/Riyadh')
    FROM pending p
   WHERE NOT public.mos_subject_inactive(p.st, p.id)
     AND EXISTS (SELECT 1 FROM public.mos_role_routine_holders('writer') h(uid)
                  WHERE public.mos_capacity_used(h.uid, 'writing', now())
                        + public.mos_task_units(p.st, p.id)
                        <= (SELECT sr.daily_limit FROM public.mos_step_rules sr WHERE sr.step_key = 'writing'));

  -- R7 ROUTINE: an open task was handed to someone who opted out of that role's
  -- routine work after the opt-out existed.
  RETURN QUERY
  SELECT 'R7_opted_out', t.id,
         format('%s handed to %s, who takes no routine %s work', t.step_key,
                (SELECT u.email FROM public.users u WHERE u.id = t.assignee_user_id), t.role_key)
    FROM public.workflow_role_tasks t
    JOIN public.mos_auto_assign_opt_out o
      ON o.user_id = t.assignee_user_id AND o.role_key = t.role_key
   WHERE t.status = 'open' AND t.assigned_at IS NOT NULL AND t.assigned_at > o.created_at;
END $$;

REVOKE ALL ON FUNCTION public.mos_task_units(text, uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_subject_publish_at(text, uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_subject_inactive(text, uuid)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_capacity_used(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_role_routine_holders(text)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_user_holds_role(uuid, text)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_task_rules_audit()                FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mos_task_rules_audit() TO service_role;

COMMIT;
