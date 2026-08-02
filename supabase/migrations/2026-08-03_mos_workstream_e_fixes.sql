-- Workstream E (ten-journey verification) surfaced two real engine bugs.
-- Applied to the isolated branch via scripts/apply-branch-sql.mjs; folds into
-- the MOS migration series before the single final deploy.
--
-- FIX 1 — workflow_advance_role_path: fail-OPEN authorization on unassigned
--   tasks. The guard was
--       IF NOT (admin OR manager OR role_match OR assignee_user_id = me) …
--   Every freshly-opened task has assignee_user_id IS NULL, so the comparison
--   `NULL = me` is NULL; when the first three conditions are false the whole
--   OR-chain is NULL, and `IF NOT (NULL)` never fires — so ANY user (even one
--   holding no marketing role) could advance any unassigned task. Verified live
--   2026-08-03: a user holding only `mos_montage` advanced a `writer`-role task.
--   Fix: COALESCE the assignee comparison to false so three-valued logic can no
--   longer poison the guard. (Only the assignee line changes.)
--
-- FIX 2 — mos_campaign_outcomes: was SECURITY INVOKER, so it read
--   unified_records/records with the CALLER's rights. The Marketing Staff
--   profile (campaign owners who legitimately have no row-level CRM access) hit
--   SQLSTATE 22023 in the records RLS scope evaluator, so every outcomes read —
--   and ceo_overview, which aggregates it per campaign — 400'd. The function
--   returns only campaign-level AGGREGATE counts derived from the attribution
--   ledger, exactly the ROI figure the CEO/manager surfaces need; it should
--   compute over ALL attributed CRM events regardless of the caller's CRM RLS.
--   Same rationale as recalc_project_rollups_data (definer, "count ALL … regard-
--   less of the writer's RLS"). Fix: mark it SECURITY DEFINER. Body unchanged.
--
-- FIX 3 — role-path workflow WRITES for the s17 editor. Migration 07 opened
--   role-path READ to MOS roles (workflows_role_path_read gated on
--   wassell_mos_can('read')), but INSERT/UPDATE/DELETE stayed app-admin-only
--   (wassell_is_admin), so the Marketing Manager who owns the workflow editor
--   (surface settings:full) could not save a role path — workflow_save 403'd,
--   and version-freeze (journey 6) could never be exercised. Open role_path
--   writes to the same set that manages the roles matrix (admin + Marketing
--   Manager => wassell_mos_can('manage_roles')). Non-role_path (Sales
--   automation) workflows are untouched — these policies are scoped to
--   kind='role_path' and the existing admin-only policies remain (permissive
--   policies OR together, so Sales workflows still require an app admin).

CREATE OR REPLACE FUNCTION public.workflow_advance_role_path(
  p_subject_table text,
  p_subject_id uuid,
  p_result text,
  p_note text DEFAULT NULL::text,
  p_targets jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_task      public.workflow_role_tasks%ROWTYPE;
  v_roles     text[];
  v_steps     jsonb;
  v_version   uuid;
  v_idx       integer;
  v_next      jsonb;
  v_new_id    uuid;
  v_round     integer;
  v_closed_by uuid;
BEGIN
  -- The engine is generic; only the marketing subject is wired up so far.
  IF p_subject_table <> 'mos_content' THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;

  SELECT * INTO v_task
    FROM public.workflow_role_tasks
   WHERE subject_table = p_subject_table
     AND subject_id    = p_subject_id
     AND status        = 'open'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:NO_OPEN_TASK';
  END IF;

  -- Definer rights bypass RLS, so the task-level authorization lives here:
  -- admins and the Marketing Manager may move anyone's task; otherwise the
  -- caller must HOLD the task's role or BE its assignee.
  -- NOTE: the assignee comparison MUST be COALESCE'd — an unassigned task has
  -- assignee_user_id IS NULL, and `NULL = me` is NULL, which would make the
  -- whole OR-chain NULL and `IF NOT (NULL)` fail OPEN (the 2026-08-03 bug).
  v_roles := public.wassell_mos_roles(auth.uid());
  IF NOT (
       'administrator'     = ANY(v_roles)
    OR 'marketing_manager' = ANY(v_roles)
    OR v_task.role_key     = ANY(v_roles)
    OR COALESCE(v_task.assignee_user_id = public.wassell_app_user_id(auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'MOS:NOT_YOUR_TASK' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_result NOT IN ('submitted','approved','changes_requested') THEN
    RAISE EXCEPTION 'MOS:BAD_RESULT %', p_result;
  END IF;
  -- Mirrors the reject-note CHECK so the caller gets a sentence, not a violation.
  IF p_result = 'changes_requested'
     AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED';
  END IF;

  -- The PINNED definition, never the live workflow row.
  SELECT c.workflow_version_id, v.definition->'metadata'->'steps'
    INTO v_version, v_steps
    FROM public.mos_content c
    LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
   WHERE c.id = p_subject_id;

  v_closed_by := public.wassell_app_user_id(auth.uid());

  UPDATE public.workflow_role_tasks
     SET status           = 'done',
         result           = p_result,
         note             = p_note,
         revision_targets = COALESCE(p_targets, '[]'::jsonb),
         closed_at        = now(),
         closed_by_user_id = v_closed_by
   WHERE id = v_task.id;

  -- Content not bound to a version (no workflow): close and stop — 'done'.
  IF v_steps IS NULL
     OR jsonb_typeof(v_steps) <> 'array'
     OR jsonb_array_length(v_steps) = 0 THEN
    RETURN jsonb_build_object(
      'closed_task_id', v_task.id, 'opened_task_id', NULL,
      'next_step_key', NULL, 'round', v_task.round, 'done', true);
  END IF;

  -- 0-based index of the current step within the pinned array.
  SELECT ord - 1 INTO v_idx
    FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
   WHERE elem->>'key' = v_task.step_key;

  IF p_result = 'changes_requested' THEN
    -- Back to the LAST step before the current one that creates revisions;
    -- if none does, the first step. The round increments so the loop stays
    -- visible in the task chain rather than overwriting the record it came from.
    SELECT elem INTO v_next
      FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
     WHERE ord - 1 < COALESCE(v_idx, 0)
       AND COALESCE((elem->>'creates_revision')::boolean, false)
     ORDER BY ord DESC
     LIMIT 1;
    IF v_next IS NULL THEN
      v_next := v_steps -> 0;
    END IF;
    v_round := v_task.round + 1;
  ELSE
    IF v_idx IS NOT NULL AND v_idx < jsonb_array_length(v_steps) - 1 THEN
      v_next := v_steps -> (v_idx + 1);
    ELSE
      v_next := NULL;  -- last step: no successor, the record is done
    END IF;
    v_round := v_task.round;
  END IF;

  IF v_next IS NOT NULL THEN
    INSERT INTO public.workflow_role_tasks
      (subject_table, subject_id, workflow_version_id, step_key, role_key,
       round, due_at)
    VALUES
      (p_subject_table, p_subject_id, v_version,
       v_next->>'key', v_next->>'role_key', v_round,
       now() + COALESCE((v_next->>'due_days')::int, 2) * interval '1 day')
    RETURNING id INTO v_new_id;
  END IF;

  RETURN jsonb_build_object(
    'closed_task_id', v_task.id,
    'opened_task_id', v_new_id,
    'next_step_key',  CASE WHEN v_next IS NULL THEN NULL ELSE v_next->>'key' END,
    'round',          v_round,
    'done',           v_next IS NULL);
END $function$;


CREATE OR REPLACE FUNCTION public.mos_campaign_outcomes(p_campaign_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH cfg AS (
  SELECT
    COALESCE(
      (SELECT (value->>'window_days')::int
         FROM public.mos_settings WHERE key = 'attribution'), 90)      AS window_days,
    COALESCE(
      (SELECT (value->>'exclude_cancelled')::boolean
         FROM public.mos_settings WHERE key = 'attribution'), true)    AS exclude_cancelled
),
attributed AS (
  -- Effective FIRST-touch rows for this campaign: linked to the campaign
  -- directly, to one of its executions, or to an ad of one of its executions.
  SELECT a.client_record_id, a.occurred_at
  FROM public.client_attributions_effective a
  WHERE a.touch_type = 'first'
    AND (
      a.campaign_id = p_campaign_id
      OR a.execution_id IN (
        SELECT e.id FROM public.mos_campaign_executions e
        WHERE e.campaign_id = p_campaign_id)
      OR a.ad_id IN (
        SELECT ad.id FROM public.mos_execution_ads ad
        JOIN public.mos_campaign_executions e ON e.id = ad.execution_id
        WHERE e.campaign_id = p_campaign_id)
    )
),
-- Unique attributed clients; the CRM link is data->>'client_id' = records.id::text.
clients AS (
  SELECT DISTINCT client_record_id FROM attributed
),
appt AS (
  SELECT DISTINCT r.id
  FROM public.unified_records r
  JOIN attributed a ON a.client_record_id::text = r.data->>'client_id'
  CROSS JOIN cfg
  WHERE r.model_id = 'b032a675-6237-4436-9783-a1a253855f74'::uuid
    AND public.try_timestamptz(r.data->>'appointment_date')
          BETWEEN a.occurred_at
              AND a.occurred_at + make_interval(days => cfg.window_days)
    -- Appointments honor exclude_cancelled (see header note).
    AND (NOT cfg.exclude_cancelled
         OR r.data->>'appointment_status' NOT IN ('cancelled','no_show'))
),
vis AS (
  SELECT DISTINCT r.id
  FROM public.unified_records r
  JOIN attributed a ON a.client_record_id::text = r.data->>'client_id'
  CROSS JOIN cfg
  WHERE r.model_id = '372ed642-3753-40b4-9dd7-e8390f91b1f8'::uuid
    AND public.try_timestamptz(r.data->>'scheduled_datetime')
          BETWEEN a.occurred_at
              AND a.occurred_at + make_interval(days => cfg.window_days)
),
res AS (
  SELECT DISTINCT r.id, public.try_numeric(r.data->>'reservation_amount') AS amount
  FROM public.unified_records r
  JOIN attributed a ON a.client_record_id::text = r.data->>'client_id'
  CROSS JOIN cfg
  WHERE r.model_id = '5a1e0ffe-0000-4000-8000-000000000002'::uuid
    AND public.try_timestamptz(r.data->>'reservation_date')
          BETWEEN a.occurred_at
              AND a.occurred_at + make_interval(days => cfg.window_days)
)
SELECT jsonb_build_object(
  'attributed_clients', (SELECT count(*) FROM clients),   -- unique clients
  'appointments',       (SELECT count(*) FROM appt),      -- event count
  'visits',             (SELECT count(*) FROM vis),       -- event count (no status on the model)
  'reservations',       (SELECT count(*) FROM res),       -- unique events
  'reservation_value',  (SELECT COALESCE(sum(amount), 0) FROM res),
  'window_days',        (SELECT window_days FROM cfg),
  'touch',              'first',
  'computed_at',        now()
);
$function$;

DROP POLICY IF EXISTS workflows_role_path_insert ON public.workflows;
CREATE POLICY workflows_role_path_insert ON public.workflows FOR INSERT
  WITH CHECK (kind = 'role_path' AND public.wassell_mos_can('manage_roles'));

DROP POLICY IF EXISTS workflows_role_path_update ON public.workflows;
CREATE POLICY workflows_role_path_update ON public.workflows FOR UPDATE
  USING (kind = 'role_path' AND public.wassell_mos_can('manage_roles'))
  WITH CHECK (kind = 'role_path' AND public.wassell_mos_can('manage_roles'));

DROP POLICY IF EXISTS workflows_role_path_delete ON public.workflows;
CREATE POLICY workflows_role_path_delete ON public.workflows FOR DELETE
  USING (kind = 'role_path' AND public.wassell_mos_can('manage_roles'));
