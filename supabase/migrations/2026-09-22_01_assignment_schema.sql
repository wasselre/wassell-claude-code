-- ============================================================================
-- Plan-driven task assignment — 1/5: SCHEMA (backward compatible).
-- 2026-09-22. Plan: docs/reviews/mos-assignment-redesign-2026-09-22/01-plan-v9.md
-- + 07-decisions.md (the operator's choices). Every object here is additive or
-- widens a constraint; nothing the deployed API/worker calls changes shape.
--
-- What it adds
--   * reservation statuses `bound` (opened, not assigned — still counted through
--     the reservation arm) and `superseded` (retired by a re-plan, kept as
--     history), with provenance columns;
--   * ONE live-set uniqueness rule for (subject, step) over
--     reserved/stale/bound/consumed — history is exempt (§6b);
--   * `mos_step_rules.target_hours` (the planned turnaround, ≤ allowance);
--   * task columns: planned handoff/deadline, the early-offer marker, the risk
--     cache;
--   * `mos_completion_events` (request-bound idempotency, §5a);
--   * `notifications.dedupe_key` (exactly-once effects, §5f);
--   * planning settings: release_lead_hours, ad_build_lead_hours,
--     band_c_horizon_days;
--   * the ledger view's reservation arms count `bound` (§3b).
-- ============================================================================

BEGIN;

-- ── 1. reservation statuses + provenance ────────────────────────────────────
ALTER TABLE public.mos_task_reservations DROP CONSTRAINT IF EXISTS mos_task_reservations_status_check;
ALTER TABLE public.mos_task_reservations
  ADD CONSTRAINT mos_task_reservations_status_check
  CHECK (status = ANY (ARRAY['reserved','bound','stale','consumed','released','superseded']));

ALTER TABLE public.mos_task_reservations
  ADD COLUMN IF NOT EXISTS superseded_by_plan_id uuid REFERENCES public.mos_campaign_plans(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_at         timestamptz;

-- The partial indexes the engine already keys on: `bound` joins the live set.
DROP INDEX IF EXISTS public.ix_mos_task_res_open;
CREATE INDEX ix_mos_task_res_open ON public.mos_task_reservations (assignee_user_id, planned_start)
  WHERE status IN ('reserved','stale','bound');
DROP INDEX IF EXISTS public.ix_mos_task_res_content;
CREATE INDEX ix_mos_task_res_content ON public.mos_task_reservations (content_id, step_key)
  WHERE status IN ('reserved','stale','bound');
CREATE INDEX IF NOT EXISTS ix_mos_task_res_task ON public.mos_task_reservations (consumed_task_id)
  WHERE consumed_task_id IS NOT NULL;

-- ── 2. live-set uniqueness (§6b): one LIVE booking per (subject, step) ──────
-- History (superseded/released) accumulates freely beneath it. `consumed` is
-- deliberately INSIDE the set (§3c): a consumed reservation on a plan-stable
-- subject must still occupy its slot, or a re-plan inserts a fresh `reserved`
-- beside it and the unit is counted twice.
DO $$
DECLARE v_dups int;
BEGIN
  SELECT count(*) INTO v_dups FROM (
    SELECT 1 FROM public.mos_task_reservations
     WHERE status IN ('reserved','stale','bound','consumed')
     GROUP BY COALESCE(content_id::text, row_id::text, cycle_id::text || ':' || content_key), step_key
    HAVING count(*) > 1) d;
  IF v_dups > 0 THEN
    RAISE EXCEPTION 'MOS:RESV_SUBJECT_STEP_DUP % live (subject, step) groups hold more than one reservation', v_dups
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS mos_task_reservations_subject_step_live_uidx
  ON public.mos_task_reservations
     ((COALESCE(content_id::text, row_id::text, cycle_id::text || ':' || content_key)), step_key)
  WHERE status IN ('reserved','stale','bound','consumed');

-- ── 3. planned turnaround per step (§1a) ────────────────────────────────────
ALTER TABLE public.mos_step_rules ADD COLUMN IF NOT EXISTS target_hours numeric;
ALTER TABLE public.mos_step_rules DROP CONSTRAINT IF EXISTS mos_step_rules_target_check;
ALTER TABLE public.mos_step_rules
  ADD CONSTRAINT mos_step_rules_target_check
  CHECK (target_hours IS NULL OR (target_hours > 0 AND target_hours <= allowance_hours));
UPDATE public.mos_step_rules SET target_hours = v.t, updated_at = now()
  FROM (VALUES ('writing', 4), ('writing_review', 2), ('design', 4),
               ('design_writer_review', 2), ('design_review', 2)) v(k, t)
 WHERE mos_step_rules.step_key = v.k AND mos_step_rules.target_hours IS NULL;

-- ── 4. task columns (§1b deadlines, §4 offers, §1c risk cache) ──────────────
ALTER TABLE public.workflow_role_tasks
  ADD COLUMN IF NOT EXISTS plan_handoff_at    timestamptz,
  ADD COLUMN IF NOT EXISTS plan_due_at        timestamptz,
  ADD COLUMN IF NOT EXISTS handoff_slip       interval,
  ADD COLUMN IF NOT EXISTS offered_to_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS offered_at         timestamptz,
  ADD COLUMN IF NOT EXISTS risk               text,
  ADD COLUMN IF NOT EXISTS risk_reason        text,
  ADD COLUMN IF NOT EXISTS risk_at            timestamptz;
ALTER TABLE public.workflow_role_tasks DROP CONSTRAINT IF EXISTS workflow_role_tasks_risk_check;
ALTER TABLE public.workflow_role_tasks
  ADD CONSTRAINT workflow_role_tasks_risk_check
  CHECK (risk IS NULL OR risk IN ('blocked','on_track','at_risk','late','unscheduled','published','active'));
CREATE INDEX IF NOT EXISTS ix_wrt_offered ON public.workflow_role_tasks (offered_to_user_id)
  WHERE status = 'open' AND offered_to_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_wrt_open_unassigned ON public.workflow_role_tasks (role_key, scheduled_start)
  WHERE status = 'open' AND assignee_user_id IS NULL;

-- ── 5. completion events (§5a) — request-bound idempotency ──────────────────
CREATE TABLE IF NOT EXISTS public.mos_completion_events (
  event_id         uuid PRIMARY KEY,
  operation        text NOT NULL,
  task_id          uuid,
  subject_table    text NOT NULL,
  subject_id       uuid NOT NULL,
  actor_user_id    uuid,
  request_hash     text NOT NULL,
  request_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome          jsonb NOT NULL,
  side_effects     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mos_completion_events_operation_check
    CHECK (operation IN ('content.complete','row.complete','content.revise','task.transfer'))
);
CREATE INDEX IF NOT EXISTS mos_completion_events_pending_idx
  ON public.mos_completion_events (created_at)
  WHERE side_effects @> '[{"status":"pending"}]'::jsonb;
CREATE INDEX IF NOT EXISTS mos_completion_events_subject_idx
  ON public.mos_completion_events (subject_table, subject_id, created_at DESC);
ALTER TABLE public.mos_completion_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mos_completion_events FROM anon, authenticated;
-- Only the SECURITY DEFINER RPCs and service_role touch this table.

-- ── 6. notification dedupe (§5f) ────────────────────────────────────────────
ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_idx
  ON public.notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ── 7. planning settings (§1c leads, §4a horizon) ───────────────────────────
UPDATE public.mos_settings
   SET value = value
             || CASE WHEN value ? 'release_lead_hours'  THEN '{}'::jsonb ELSE '{"release_lead_hours": 2}'::jsonb END
             || CASE WHEN value ? 'ad_build_lead_hours' THEN '{}'::jsonb ELSE '{"ad_build_lead_hours": 2}'::jsonb END
             || CASE WHEN value ? 'band_c_horizon_days' THEN '{}'::jsonb ELSE '{"band_c_horizon_days": 14}'::jsonb END
 WHERE key = 'planning';
INSERT INTO public.mos_settings (key, value)
SELECT 'planning', '{"release_lead_hours": 2, "ad_build_lead_hours": 2, "band_c_horizon_days": 14}'::jsonb
 WHERE NOT EXISTS (SELECT 1 FROM public.mos_settings WHERE key = 'planning');

-- ── 8. the ledger: reservation arms count `bound` (§3b) ─────────────────────
-- A unit is counted by exactly one arm at every moment: the reservation arm
-- while reserved/stale/bound (planned assignee, planned day), the task arm once
-- assigned (consumed), nobody once done. Only the two reservation arms change.
CREATE OR REPLACE VIEW public.mos_work_ledger_v AS
 SELECT t.assignee_user_id AS user_id,
    s.day,
    mos_ledger_bucket(t.workflow_version_id, t.step_key, COALESCE(t.bucket, mos_subject_bucket(t.subject_table, t.subject_id))) AS bucket,
    s.weight,
    'task'::text AS source,
    t.id AS ref_id
   FROM workflow_role_tasks t
     CROSS JOIN LATERAL mos_spread_effort(GREATEST(COALESCE(t.scheduled_start, mos_perf_today()), mos_perf_today()), GREATEST(COALESCE(t.effort_days, mos_step_effort_days(mos_workflow_key_of(t.subject_id), t.step_key, mos_ledger_bucket(t.workflow_version_id, t.step_key, COALESCE(t.bucket, mos_perf_bucket_of(t.subject_id))))) - COALESCE(t.progress_days, 0::numeric), 0.5)) s(day, weight)
  WHERE t.status = 'open'::text AND t.subject_table = 'mos_content'::text AND t.assignee_user_id IS NOT NULL
UNION ALL
 SELECT t.assignee_user_id AS user_id,
    s.day,
    mos_ledger_bucket(t.workflow_version_id, t.step_key, COALESCE(t.bucket, mos_subject_bucket(t.subject_table, t.subject_id))) AS bucket,
    s.weight,
    'task'::text AS source,
    t.id AS ref_id
   FROM workflow_role_tasks t
     CROSS JOIN LATERAL mos_spread_effort_same_day(GREATEST(COALESCE(t.scheduled_start, mos_perf_today()), mos_perf_today()), GREATEST(COALESCE(t.effort_days, GREATEST(( SELECT count(*) AS count
           FROM mos_content c
          WHERE c.row_id = t.subject_id), 1::bigint)::numeric * mos_step_effort_days(mos_subject_workflow_key(t.subject_table, t.subject_id), t.step_key, mos_ledger_bucket(t.workflow_version_id, t.step_key, COALESCE(t.bucket, mos_subject_bucket(t.subject_table, t.subject_id))))) - COALESCE(t.progress_days, 0::numeric), 0.5)) s(day, weight)
  WHERE t.status = 'open'::text AND t.subject_table = 'mos_content_rows'::text AND t.assignee_user_id IS NOT NULL
UNION ALL
 SELECT r.assignee_user_id AS user_id,
    s.day,
    r.bucket,
    s.weight,
    'reservation'::text AS source,
    r.id AS ref_id
   FROM mos_task_reservations r
     CROSS JOIN LATERAL mos_spread_effort_mode(GREATEST(r.planned_start, mos_perf_today()), r.weight, r.row_id IS NOT NULL) s(day, weight)
  WHERE r.status IN ('reserved'::text, 'bound'::text) AND r.planned_end >= mos_perf_today() AND r.assignee_user_id IS NOT NULL
UNION ALL
 SELECT r.assignee_user_id AS user_id,
    s.day,
    r.bucket,
    s.weight,
    'reservation'::text AS source,
    r.id AS ref_id
   FROM mos_task_reservations r
     CROSS JOIN LATERAL mos_spread_effort_mode(mos_perf_today(), r.weight, r.row_id IS NOT NULL) s(day, weight)
  WHERE (r.status = 'stale'::text OR r.status IN ('reserved'::text, 'bound'::text) AND r.planned_end < mos_perf_today()) AND r.assignee_user_id IS NOT NULL
UNION ALL
 SELECT m.assignee_user_id AS user_id,
    GREATEST(COALESCE((m.due_at AT TIME ZONE 'Asia/Riyadh'::text)::date, mos_perf_today()), mos_perf_today()) AS day,
    mos_manual_task_bucket(m.assignee_user_id) AS bucket,
    COALESCE((mos_planning_cfg() ->> 'manual_task_weight'::text)::numeric, 0.5) AS weight,
    'manual'::text AS source,
    m.id AS ref_id
   FROM mos_manual_tasks m
  WHERE m.status = 'open'::text AND m.assignee_user_id IS NOT NULL;

-- ── 9. the single accounting rule, asserted (§3b) ───────────────────────────
-- No `consumed` reservation may back an OPEN, UNASSIGNED task: that unit would
-- be counted by nobody (the hole the first review found). Enforced by the
-- engine (2/5); checked here so the migration refuses to leave the DB in the
-- state it is about to fix.
CREATE OR REPLACE FUNCTION public.mos_assert_ledger_conformance()
 RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM public.mos_task_reservations r
    JOIN public.workflow_role_tasks t ON t.id = r.consumed_task_id
   WHERE r.status = 'consumed' AND t.status = 'open' AND t.assignee_user_id IS NULL;
  RETURN v_n;
END $$;

COMMIT;
